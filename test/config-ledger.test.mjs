import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateConfig } from '../src/config.mjs';
import { blockedCommentIds, replyBlocked, dmCounts, haltOf, unknownSends, pruneRecords, mergeRecords, doneUsers } from '../src/ledger.mjs';

const ok = (over = {}) => ({ account: '@Demo.Account', funnels: [{ post: '17900000000000001', keywords: ['GUIDE', 'guides'], message: 'line one\nline two', ...over }] });

test('config.example.json is valid as shipped', () => {
  const { config, problems } = validateConfig(JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')));
  assert.deepEqual(problems, []);
  assert.equal(config.funnels[0].replies.length, 3);
});

test('validateConfig: normalises the account, names the funnel, reads until as the end of that UTC day', () => {
  const { config, problems } = validateConfig(ok({ until: '2026-12-31', replies: 'Sent!' }));
  assert.deepEqual(problems, []);
  assert.equal(config.account, 'demo.account');
  assert.equal(config.funnels[0].name, 'post-17900000000000001');
  assert.deepEqual(config.funnels[0].keywords, ['GUIDE', 'guides']);
  assert.deepEqual(config.funnels[0].replies, ['Sent!']);
  assert.equal(config.funnels[0].untilMs, Date.parse('2026-12-31T23:59:59Z'));
  assert.equal(validateConfig(ok({ keywords: 'GUIDE, PDF' })).config.funnels[0].keywords.length, 2, 'a comma string works too');
});

test('validateConfig names each defect', () => {
  const cases = [
    [{ keywords: [] }, /keywords/],
    [{ keywords: ['two words'] }, /one word/],
    [{ until: 'next week' }, /until/],
    [{ colour: 'red' }, /unknown key "colour"/],
    [{ message: '   ' }, /message" is empty/],
    [{ message: 'x'.repeat(1001) }, /1001 bytes/],
    [{ message: 'é'.repeat(501) }, /1002 bytes/],
    [{ replies: ['ok', ' '] }, /empty line/],
    [{ replies: ['x'.repeat(301)] }, /301 characters/],
    [{ post: 'https://www.instagram.com/reel/AbC123/' }, /numeric media ID/],
  ];
  for (const [over, re] of cases) {
    const { config, problems } = validateConfig(ok(over));
    assert.equal(config, null);
    assert.ok(problems.some((p) => re.test(p)), `${JSON.stringify(over).slice(0, 50)}: ${problems.join(' | ')}`);
  }
  const two = ok(); two.funnels.push({ ...two.funnels[0], name: 'other' });
  assert.ok(validateConfig(two).problems.some((p) => /one funnel per post/.test(p)));
  assert.ok(validateConfig({ funnels: [] }).problems.some((p) => /account/.test(p)));
  assert.ok(validateConfig({ ...ok(), extra: 1 }).problems.some((p) => /unknown key "extra"/.test(p)));
});

test('blockedCommentIds: any DM record blocks, except a last outcome of halted or unsent', () => {
  const recs = [
    { commentId: 'a', outcome: 'pending' }, { commentId: 'a', outcome: 'sent' },
    { commentId: 'b', outcome: 'pending' },                                           // unknown: blocked
    { commentId: 'c', outcome: 'pending' }, { commentId: 'c', outcome: 'error' },
    { commentId: 'd', outcome: 'pending' }, { commentId: 'd', outcome: 'halted' },     // tried again after resume
    { commentId: 'e', outcome: 'pending' }, { commentId: 'e', outcome: 'unsent' },     // never reached Meta
    { kind: 'reply', commentId: 'f', outcome: 'replied' },                             // a reply is not a DM
  ];
  assert.deepEqual([...blockedCommentIds(recs)].sort(), ['a', 'b', 'c']);
  assert.deepEqual(unknownSends(recs).map((r) => r.commentId), ['b']);
});

test('replyBlocked: one public reply per comment, a skipped one may still happen', () => {
  const recs = [
    { kind: 'reply', commentId: 'a', outcome: 'replied' }, { kind: 'reply', commentId: 'b', outcome: 'reply-error' },
    { kind: 'reply', commentId: 'c', outcome: 'pending' }, { kind: 'reply', commentId: 'd', outcome: 'pending' }, { kind: 'reply', commentId: 'd', outcome: 'skipped' },
  ];
  assert.deepEqual([...replyBlocked(recs)].sort(), ['a', 'b', 'c']);
});

test('dmCounts + doneUsers read the last outcome per comment, per post', () => {
  const recs = [
    { post: 'p', commentId: 'a', username: 'Ana.Demo', outcome: 'pending' }, { post: 'p', commentId: 'a', username: 'Ana.Demo', outcome: 'sent' },
    { post: 'p', commentId: 'b', outcome: 'pending' }, { post: 'p', commentId: 'b', outcome: 'error' },
    { post: 'p', commentId: 'c', outcome: 'pending' }, { post: 'p', commentId: 'c', outcome: 'halted' },
    { post: 'q', commentId: 'z', username: 'zed.demo', outcome: 'sent' },
  ];
  assert.deepEqual(dmCounts(recs, 'p'), { sent: 1, failed: 1 });
  assert.deepEqual([...doneUsers(recs, 'p')], ['ana.demo']);
});

test('haltOf: halted until a resume, halted again by a new halt', () => {
  const h1 = { post: 'p', commentId: 'a', outcome: 'halted', at: '2026-11-20T10:00:00Z', error: 'no permission' };
  assert.equal(haltOf([h1], 'p'), h1);
  assert.equal(haltOf([h1], 'q'), null);
  assert.equal(haltOf([h1, { kind: 'resume', post: 'p', at: '2026-11-20T11:00:00Z' }], 'p'), null);
  const h2 = { ...h1, at: '2026-11-20T12:00:00Z' };
  assert.equal(haltOf([h1, { kind: 'resume', post: 'p' }, h2], 'p'), h2);
});

test('pruneRecords keeps live posts and anything young; mergeRecords is a sorted union', () => {
  const now = Date.parse('2026-11-20T00:00:00Z');
  const recs = [
    { post: 'live', at: '2026-01-01T00:00:00Z', commentId: '1' },
    { post: 'gone', at: '2026-11-10T00:00:00Z', commentId: '2' },
    { post: 'gone', at: '2026-09-01T00:00:00Z', commentId: '3' },
  ];
  assert.deepEqual(pruneRecords(recs, ['live'], now).map((r) => r.commentId), ['1', '2']);
  const a = [{ at: '2026-11-20T10:00:00Z', commentId: 'x', outcome: 'sent' }];
  const b = [{ at: '2026-11-20T09:00:00Z', commentId: 'y', outcome: 'sent' }, { ...a[0] }];
  assert.deepEqual(mergeRecords(a, b).map((r) => r.commentId), ['y', 'x']);
});
