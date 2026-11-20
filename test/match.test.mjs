import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keywordMatches, flattenComments, candidates, REPLY_WINDOW_MS } from '../src/match.mjs';
import { NOW, ago } from './fakes.mjs';

test('keywordMatches: any case, whole word, any keyword of the list', () => {
  const k = ['GUIDE'];
  for (const t of ['GUIDE', 'guide', 'Guide pls 🙏', 'can I get the guide?', 'GUIDE!!', '"guide"', 'send\nguide']) assert.equal(keywordMatches(t, k), true, t);
  for (const t of ['guidelines', 'guidey', 'guid', '', null]) assert.equal(keywordMatches(t, k), false, String(t));
  assert.equal(keywordMatches('pdf please', ['GUIDE', 'PDF']), true);
});

test('keywordMatches: every letter O also matches a zero', () => {
  for (const t of ['0AUTH', '0auth2 pls', 'g0od', 'C0DE']) assert.equal(keywordMatches(t, ['OAUTH', 'OAUTH2', 'GOOD', 'CODE']), true, t);
  assert.equal(keywordMatches('4o4', ['404']), false, 'a zero in the keyword does not match the letter o');
  assert.equal(keywordMatches('0AUTHX', ['OAUTH']), false, 'still a whole word');
});

test('keywordMatches: a topic keyword needs a request, not a conversation', () => {
  const k = ['REBASE'];
  for (const t of ['Rebase', 'REBASE 🔥🔥', '@demo.account rebase', 'rebase bro, great post', 'Great explanation, could you send me the rebase one too',
    'I always mix these up at work, rebase notes would help a lot']) assert.equal(keywordMatches(t, k), true, t);
  for (const t of ['@friend.demo yes and you can turn off rebase in the settings of most tools', 'We never rebase at my company because the history gets rewritten',
    'I got a rebase conflict yesterday and lost a whole afternoon to it']) assert.equal(keywordMatches(t, k), false, t);
});

test('keywordMatches: maxWords and askWords are yours to set', () => {
  const long = 'this is a long comment about the guide and nothing else at all';
  assert.equal(keywordMatches(long, ['GUIDE']), false);
  assert.equal(keywordMatches(long, ['GUIDE'], { maxWords: 20 }), true);
  assert.equal(keywordMatches(`${long} gimme`, ['GUIDE'], { askWords: ['gimme'] }), true);
  assert.equal(keywordMatches(`${long} please`, ['GUIDE'], { askWords: [] }), false);
});

test('flattenComments: top level + replies, normalised timestamps', () => {
  const c = flattenComments([
    { id: '1', text: 'GUIDE', timestamp: '2026-11-20T10:00:00+0000', username: 'ana.demo', from: { id: '91', username: 'ana.demo' },
      replies: { data: [{ id: '2', text: 'guide too', timestamp: '2026-11-20T10:05:00+0000', username: 'ben.demo', from: { id: '92', username: 'ben.demo' } }] } },
    { id: '3', text: 'nice', timestamp: '2026-11-20T11:00:00+0000', username: 'cat.demo' },
  ]);
  assert.deepEqual(c.map((x) => x.id), ['1', '2', '3']);
  assert.equal(c[1].parentId, '1');
  assert.equal(c[0].at, Date.parse('2026-11-20T10:00:00Z'));
  assert.equal(c[2].fromId, null);
});

test('flattenComments: a reply listed top level AND nested is one entry, with its name and its parent', () => {
  const c = flattenComments([
    { id: '10', text: 'GUIDE', timestamp: '2026-11-20T10:00:00+0000', from: { id: '91', username: 'ana.demo' }, replies: { data: [{ id: '11', text: '@ana.demo sent!', timestamp: '2026-11-20T10:05:00+0000' }] } },
    { id: '11', text: '@ana.demo sent!', timestamp: '2026-11-20T10:05:00+0000', username: 'demo.account', from: { id: '178', username: 'demo.account' } },
  ]);
  assert.deepEqual(c.map((x) => x.id), ['10', '11']);
  assert.equal(c[0].username, 'ana.demo', 'from.username when the top-level username is missing');
  assert.equal(c[1].username, 'demo.account');
  assert.equal(c[1].parentId, '10');
});

test('candidates: matches, not ours, inside 7 days, not answered, one per person', () => {
  const comments = flattenComments([
    { id: '1', text: 'GUIDE', timestamp: ago(2), username: 'ana.demo', from: { id: '91' } },
    { id: '2', text: 'guide', timestamp: ago(2), username: 'demo.account', from: { id: '178' } },   // ours
    { id: '3', text: 'guide', timestamp: ago(7 * 24 - 0.5), username: 'old.demo' },                 // half an hour from the edge: too late
    { id: '4', text: 'guide', timestamp: ago(1), username: 'dup.demo' },                            // already answered
    { id: '5', text: 'great post', timestamp: ago(1), username: 'eve.demo' },                       // no keyword
    { id: '6', text: 'Guide?', timestamp: ago(6 * 24), username: 'fay.demo' },                      // 6 days: fine
  ]);
  const got = candidates({ comments, keywords: ['GUIDE'], account: 'demo.account', ownIds: ['178'], blocked: new Set(['4']), now: NOW });
  assert.deepEqual(got.map((c) => c.id), ['1', '6']);
  assert.ok(NOW - Date.parse('2026-11-13T12:30:00Z') >= REPLY_WINDOW_MS);

  const twice = flattenComments([
    { id: '7', text: 'guide', timestamp: ago(3), username: 'gus.demo' },
    { id: '8', text: 'GUIDE pls', timestamp: ago(2), username: 'Gus.Demo' },
    { id: '9', text: 'guide', timestamp: ago(1), username: 'ana.demo' },
  ]);
  assert.deepEqual(candidates({ comments: twice, keywords: ['GUIDE'], account: 'demo.account', doneUsers: new Set(['ana.demo']), now: NOW }).map((c) => c.id), ['7']);

  const nameless = flattenComments([{ id: '20', text: 'guide', timestamp: ago(1) }]);
  assert.deepEqual(candidates({ comments: nameless, keywords: ['GUIDE'], account: 'demo.account', now: NOW }), [], 'no name, no sender id: could be ours, skipped');
});
