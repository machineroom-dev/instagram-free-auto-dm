import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOnce, listComments } from '../src/engine.mjs';
import { makeApi, redact, BudgetSpent } from '../src/meta.mjs';
import { dmCounts, blockedCommentIds, haltOf } from '../src/ledger.mjs';
import { fakeMeta, memoryLedger, config, funnel, C, NOW, ME } from './fakes.mjs';

const POST = funnel().post;
function setup({ comments = [], meta = {}, records = [], funnels, budget } = {}) {
  const m = fakeMeta({ comments: { [POST]: comments }, ...meta });
  const api = makeApi({ token: 'TEST-TOKEN', fetchImpl: m.fetchImpl, budget: budget ?? { left: Infinity } });
  const ledger = memoryLedger(records);
  const run = (over = {}) => runOnce({ config: config(funnels), api, ledger, userId: ME.id, now: () => NOW, sleep: async () => {}, ...over });
  return { m, api, ledger, run };
}
const outcomes = (recs, kind) => recs.filter((r) => (kind ? r.kind === kind : !r.kind)).map((r) => `${r.commentId}:${r.outcome}`);

test('one DM per matching comment, pending recorded before each POST and the outcome after', async () => {
  const { m, ledger, run } = setup({ comments: [C(1, 'GUIDE', { h: 1 }), C(2, 'GUIDE', { h: 2 }), C(3, 'nice')], records: [{ post: 'x', commentId: 'old', outcome: 'sent', at: '2026-11-01T00:00:00Z' }] });
  const r = await run();
  assert.deepEqual(m.sends.map((s) => s.commentId), ['2', '1']);
  assert.equal(m.sends[0].text, funnel().message);
  assert.deepEqual(outcomes(ledger.records().slice(1)), ['2:pending', '2:sent', '1:pending', '1:sent'], 'oldest comment first');
  assert.equal(ledger.records().at(-1).messageId, 'm1');
  assert.equal(r.sent, 2); assert.equal(r.failed, 0); assert.equal(r.halted, 0);
});

test('our own comments, old comments and answered people are skipped; the next run sends nothing new', async () => {
  const { m, run } = setup({ comments: [C(1), C(2, 'GUIDE', { user: ME.username }), C(3, 'guide', { h: 24 * 7 })] });
  await run();
  await run();
  assert.deepEqual(m.sends.map((s) => s.commentId), ['1']);
});

test('the first DM this account ever sends failing halts the funnel', async () => {
  const { m, ledger, run } = setup({ comments: [C(1, 'GUIDE', { h: 2 }), C(2)], meta: { sendResults: ['(#10) Application does not have permission for this action'] } });
  const r = await run();
  assert.equal(m.sends.length, 1);
  assert.equal(r.halted, 1);
  assert.match(r.funnels[0].why, /first DM this account ever sent failed.*permission/);
  assert.deepEqual(outcomes(ledger.records()), ['1:pending', '1:halted']);
  assert.ok(haltOf(ledger.records(), POST));
  const again = await run();
  assert.equal(again.funnels[0].state, 'halted', 'stays halted until resume');
  assert.equal(m.sends.length, 1);
});

test('after a proven send, one failure is that commenter\'s; three in a row halts', async () => {
  const comments = [6, 5, 4, 3, 2, 1].map((i) => C(i, 'GUIDE', { h: i }));   // comment 6 is the oldest
  const { ledger, run } = setup({ comments, records: [{ post: 'x', commentId: 'p', outcome: 'sent', at: '2026-11-01T00:00:00Z' }], meta: { sendResults: ['ok', 'user unavailable', 'ok', 'e1', 'e2', 'e3'] } });
  const r = await run();
  assert.equal(r.sent, 2); assert.equal(r.failed, 3); assert.equal(r.halted, 1);
  assert.match(r.funnels[0].why, /3 DMs in a row failed, last: .*e3/);
  const last = Object.fromEntries(ledger.records().filter((x) => !x.kind && x.commentId !== 'p').map((x) => [x.commentId, x.outcome]));
  assert.deepEqual(last, { 6: 'sent', 5: 'error', 4: 'sent', 3: 'error', 2: 'error', 1: 'halted' });
});

test('a send proven earlier in the same run counts as proof', async () => {
  const { run } = setup({ comments: [C(3, 'GUIDE', { h: 1 }), C(2, 'GUIDE', { h: 2 }), C(1, 'GUIDE', { h: 3 })], meta: { sendResults: ['ok', 'blocked', 'ok'] } });
  const r = await run();
  assert.equal(r.halted, 0); assert.equal(r.sent, 2); assert.equal(r.failed, 1);
});

test('resume: the comment that halted is tried again', async () => {
  const halted = [{ post: POST, commentId: '1', outcome: 'pending', at: '2026-11-20T10:00:00Z' }, { post: POST, commentId: '1', outcome: 'halted', error: 'x', at: '2026-11-20T10:00:01Z' }];
  const { m, run } = setup({ comments: [C(1)], records: [...halted, { kind: 'resume', post: POST, at: '2026-11-20T11:00:00Z' }] });
  const r = await run();
  assert.deepEqual(m.sends.map((s) => s.commentId), ['1']);
  assert.equal(r.sent, 1);
});

test('a refused token stops the run without halting anything; the comment is tried again later', async () => {
  const { ledger, run } = setup({ comments: [C(1)], meta: { sendResults: [{ message: 'session invalidated', code: 190 }] } });
  const r = await run();
  assert.equal(r.halted, 0);
  assert.match(r.errors[0], /refused the token/);
  assert.deepEqual(outcomes(ledger.records()), ['1:pending', '1:unsent']);
  assert.equal(blockedCommentIds(ledger.records()).has('1'), false);
});

test('a refused token on read stops the run before any send', async () => {
  const { m, run } = setup({ comments: [C(1)], meta: { readError: { message: 'Error validating access token', code: 190 } } });
  const r = await run();
  assert.equal(m.sends.length, 0);
  assert.match(r.errors[0], /refused the token.*npm run auth/);
});

test('a read error on one funnel is reported and the others still run', async () => {
  const m = fakeMeta({ comments: { [POST]: [C(1)], 17900000000000002: [C(2)] } });
  const api = makeApi({ token: 'T', fetchImpl: async (url, init) => (url.includes(`/${POST}/comments`) ? new Response(JSON.stringify({ error: { message: 'boom', code: 2 } }), { status: 500 }) : m.fetchImpl(url, init)) });
  const r = await runOnce({ config: config([funnel(), funnel({ name: 'two', post: '17900000000000002' })]), api, ledger: memoryLedger(), userId: ME.id, now: () => NOW, sleep: async () => {} });
  assert.equal(r.sent, 1);
  assert.match(r.errors[0], /guide: 500 boom/);
});

test('dry run sends and records nothing, and lists what it would do', async () => {
  const { m, ledger, run } = setup({ comments: [C(1), C(2)], funnels: [funnel({ replies: ['Sent!'] })] });
  const r = await run({ dryRun: true });
  assert.equal(m.sends.length, 0); assert.equal(m.replies.length, 0); assert.equal(ledger.records().length, 0);
  assert.deepEqual(r.wouldSend.map((c) => c.commentId), ['1', '2']);
  assert.deepEqual(r.wouldReply.map((c) => c.commentId), ['1', '2']);
});

test('the per-run cap leaves the rest for the next run', async () => {
  const { m, run } = setup({ comments: Array.from({ length: 7 }, (_, i) => C(i + 1)) });
  const r = await run({ maxSends: 5 });
  assert.equal(m.sends.length, 5); assert.equal(r.capped, true);
  await run({ maxSends: 5 });
  assert.equal(m.sends.length, 7);
});

test('closed funnels (past until) do nothing', async () => {
  const { m, run } = setup({ comments: [C(1)], funnels: [funnel({ until: '2026-11-19', untilMs: Date.parse('2026-11-19T23:59:59Z') })] });
  const r = await run();
  assert.equal(r.funnels[0].state, 'closed');
  assert.equal(m.calls.length, 0);
});

// ---------- public replies ----------
test('one public reply after each sent DM, variants in turn; never after a failed DM; reply records leave DM counts alone', async () => {
  const comments = [C(3, 'GUIDE', { h: 1 }), C(2, 'GUIDE', { h: 2 }), C(1, 'GUIDE', { h: 3 })];
  const { m, ledger, run } = setup({ comments, funnels: [funnel({ replies: ['A', 'B'] })], records: [{ post: 'x', commentId: 'p', outcome: 'sent', at: '2026-11-01T00:00:00Z' }], meta: { sendResults: ['ok', 'blocked', 'ok'] } });
  const r = await run();
  assert.deepEqual(m.replies, [{ commentId: '1', message: 'A' }, { commentId: '3', message: 'B' }]);
  assert.equal(r.replied, 2);
  assert.deepEqual(dmCounts(ledger.records(), POST), { sent: 2, failed: 1 });
});

test('a DM sent before replies existed gets its reply later, once', async () => {
  const earlier = [{ post: POST, commentId: '1', outcome: 'pending', at: '2026-11-20T10:00:00Z' }, { post: POST, commentId: '1', outcome: 'sent', at: '2026-11-20T10:00:01Z' }];
  const { m, ledger, run } = setup({ comments: [C(1)], records: earlier, funnels: [funnel({ replies: ['Check your DMs'] })] });
  const r = await run();
  assert.equal(r.sent, 0); assert.deepEqual(m.replies.map((x) => x.commentId), ['1']);
  assert.deepEqual(outcomes(ledger.records(), 'reply'), ['1:pending', '1:replied']);
  await run();
  assert.equal(m.replies.length, 1, 'the reply record blocks a second one');
});

test('a failed public reply is recorded, stops replies on that post for the run, never halts DMs', async () => {
  const { ledger, run } = setup({ comments: [C(1), C(2)], funnels: [funnel({ replies: ['A'] })], meta: { replyResults: ['400 spam'] } });
  const r = await run();
  assert.equal(r.sent, 2); assert.equal(r.halted, 0); assert.equal(r.replied, 0);
  assert.equal(ledger.records().filter((x) => x.kind === 'reply' && x.outcome === 'reply-error').length, 1);
});

test('a refused token on a public reply skips it (posted later), not a reply-error', async () => {
  const { ledger, run } = setup({ comments: [C(1)], funnels: [funnel({ replies: ['A'] })], meta: { replyResults: [{ message: 'session invalidated', code: 190 }] } });
  const r = await run();
  assert.equal(r.sent, 1);
  assert.match(r.errors[0], /refused the token while replying/);
  assert.deepEqual(outcomes(ledger.records(), 'reply'), ['1:pending', '1:skipped']);
});

// ---------- the Worker's mode: batched pending records inside a call budget ----------
test('batchPending: every pending record lands in one checkpoint before the first POST, each gets an outcome', async () => {
  const comments = [C(3, 'GUIDE', { h: 1 }), C(2, 'GUIDE', { h: 2 }), C(1, 'GUIDE', { h: 3 })];
  const m = fakeMeta({ comments: { [POST]: comments }, sendResults: ['ok', 'blocked', 'ok'] });
  const ledger = memoryLedger([{ post: 'x', commentId: 'p', outcome: 'sent', at: '2026-11-01T00:00:00Z' }]);
  let atCheckpoint = null;
  ledger.checkpoint = async () => { atCheckpoint = { sends: m.sends.length, recs: ledger.records().slice(1).map((r) => `${r.kind ?? 'dm'}:${r.commentId}:${r.outcome}`) }; };
  const api = makeApi({ token: 'T', fetchImpl: m.fetchImpl });
  const r = await runOnce({ config: config([funnel({ replies: ['A'] })]), api, ledger, userId: ME.id, now: () => NOW, sleep: async () => {}, batchPending: true });
  assert.equal(atCheckpoint.sends, 0);
  assert.deepEqual(atCheckpoint.recs, ['dm:1:pending', 'reply:1:pending', 'dm:2:pending', 'reply:2:pending', 'dm:3:pending', 'reply:3:pending']);
  const last = (kind) => Object.fromEntries(ledger.records().filter((x) => (x.kind ?? 'dm') === kind && x.commentId !== 'p').map((x) => [x.commentId, x.outcome]));
  assert.deepEqual(last('dm'), { 1: 'sent', 2: 'error', 3: 'sent' });
  assert.deepEqual(last('reply'), { 1: 'replied', 2: 'skipped', 3: 'replied' });
  assert.equal(r.replied, 2);
});

test('budget: reads keep calls for the sends, sends are planned to fit, the rest waits', async () => {
  const comments = Array.from({ length: 30 }, (_, i) => C(100 + i, 'GUIDE', { h: 1 + i / 100 }));
  const budget = { left: 11 };
  const { m, run } = setup({ comments, funnels: [funnel({ replies: ['A'] })], budget, meta: { pageSize: 10 } });
  const r = await run({ batchPending: true, readReserve: 6, maxPages: 5 });
  // 30 comments, 10 a page: pages 1-3 (11 -> 8 calls left, each extra page only while more than 6 remain),
  // then 8 calls = 4 DMs + their 4 public replies; the other 26 wait for the next run.
  assert.equal(m.calls.filter((c) => c.path.endsWith('/comments')).length, 3);
  assert.equal(m.sends.length, 4);
  assert.equal(m.replies.length, 4, 'each planned DM keeps a call for its public reply');
  assert.equal(budget.left, 0);
  assert.equal(r.capped, true);
});

test('listComments follows paging, stops at the page cap, and stops once a page is past the 7-day window', async () => {
  const recent = Array.from({ length: 25 }, (_, i) => C(i + 1, 'x', { h: 1 + i }));
  const old = Array.from({ length: 25 }, (_, i) => C(100 + i, 'x', { h: 24 * 8 + i }));
  const m = fakeMeta({ comments: { [POST]: [...recent, ...old] }, pageSize: 10 });
  const api = makeApi({ token: 'T', fetchImpl: m.fetchImpl });
  const all = await listComments(api, POST, { now: NOW });
  assert.equal(all.pages, 4, 'pages 1-3 are recent, page 4 is all past the window: stop after it');
  const capped = await listComments(api, POST, { now: NOW, maxPages: 2 });
  assert.equal(capped.pages, 2);
});

test('the API client counts calls, refuses a foreign paging link, and redacts tokens from errors', async () => {
  const m = fakeMeta();
  const api = makeApi({ token: 'SECRET-123', fetchImpl: m.fetchImpl, budget: { left: 1 } });
  await api.me();
  await assert.rejects(api.me(), BudgetSpent);
  assert.throws(() => makeApi({ token: 'x' }).nextPage('https://evil.example/next?access_token=x'), /refusing/);
  const bad = makeApi({ token: 'SECRET-123', fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'nope', code: 100 } }), { status: 400 }) });
  await assert.rejects(bad.me(), (e) => !e.message.includes('SECRET-123') && /access_token=…/.test(e.message));
  assert.equal(redact('https://graph.instagram.com/x?after=Q&access_token=IGAAsecret&limit=50').includes('IGAAsecret'), false);
});
