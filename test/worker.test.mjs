import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorker, sha256, META_BUDGET, SUBREQUESTS, STATE_KEY, TOKEN_KEY, SUMMARY_EVERY_MS } from '../worker/run.mjs';
import { fakeMeta, fakeKv, C, ME, NOW } from './fakes.mjs';

const POST = '17900000000000001';
const CONFIG = { account: ME.username, funnels: [{ name: 'guide', post: POST, keywords: ['GUIDE'], message: 'Here: https://example.com/guide', replies: ['Sent! Check your DMs'] }] };
const quiet = { sleep: async () => {}, log: () => {} };
const env = (kv, over = {}) => ({ STATE: kv, MODE: 'live', IG_TOKEN: 'SEED-TOKEN', ...over });
const meta = (comments = [], over = {}) => fakeMeta({ comments: { [POST]: comments }, ...over });

test('first live run: adopts the IG_TOKEN secret, sends, replies; all inside 50 subrequests', async () => {
  const kv = fakeKv();
  const m = meta([C(1, 'GUIDE', { h: 2 }), C(2), C(3, 'nice')]);
  const s = await runWorker({ env: env(kv), config: CONFIG, fetchImpl: m.fetchImpl, now: () => NOW, ...quiet });
  assert.equal(s.sent, 2); assert.equal(s.replied, 2); assert.deepEqual(s.errors, []);
  const tok = kv.json(TOKEN_KEY);
  assert.equal(tok.username, ME.username);
  assert.equal(tok.access_token, 'SEED-TOKEN-R', 'adoption refreshes once to learn the real expiry');
  assert.equal(tok.seedSha, await sha256('SEED-TOKEN'));
  assert.ok(m.calls.length + kv.ops.length <= SUBREQUESTS, `${m.calls.length} Meta calls + ${kv.ops.length} KV ops`);
  assert.equal(kv.puts(STATE_KEY), 2, 'pending before the sends, outcomes after');
  const state = kv.json(STATE_KEY);
  assert.equal(state.summary.mode, 'live');
  assert.equal(state.summary.token.username, ME.username);
  assert.equal(JSON.stringify(state).includes('SEED-TOKEN'), false, 'the state value (what worker:status reads) never holds the token');
});

test('the next runs: nothing new = no ledger write; the summary is written again only after an hour', async () => {
  const kv = fakeKv();
  const m = meta([C(1)]);
  let t = NOW;
  const run = () => runWorker({ env: env(kv), config: CONFIG, fetchImpl: m.fetchImpl, now: () => t, ...quiet });
  await run();
  const putsAfterFirst = kv.ops.filter((o) => o.startsWith('put')).length;
  t += 5 * 60e3; await run();
  t += 5 * 60e3; await run();
  assert.equal(kv.ops.filter((o) => o.startsWith('put')).length, putsAfterFirst, 'quiet runs write nothing');
  assert.equal(m.sends.length, 1);
  t += SUMMARY_EVERY_MS; await run();
  assert.equal(kv.puts(STATE_KEY), 3, 'the hourly heartbeat');
});

test('dry-run mode reads and reports, and writes no ledger and no token', async () => {
  const kv = fakeKv();
  const m = meta([C(1), C(2)]);
  const s = await runWorker({ env: env(kv, { MODE: 'dry-run' }), config: CONFIG, fetchImpl: m.fetchImpl, now: () => NOW, ...quiet });
  assert.equal(m.sends.length, 0); assert.equal(m.replies.length, 0);
  assert.deepEqual(s.wouldSend.map((c) => c.commentId), ['1', '2']);
  assert.equal(kv.json(TOKEN_KEY), null);
  assert.equal(kv.json(STATE_KEY).records.length, 0);
  assert.equal(kv.json(STATE_KEY).summary.mode, 'dry-run');
  assert.equal(m.calls.some((c) => c.path === 'refresh_access_token'), false, 'no refresh in a dry run');
});

test('a backlog bigger than one run: each run stays inside the budget and the rest goes next run', async () => {
  const kv = fakeKv();
  const comments = Array.from({ length: 60 }, (_, i) => C(1000 + i, 'GUIDE', { h: 1 + i / 100 }));
  const m = meta(comments);
  let t = NOW;
  const s1 = await runWorker({ env: env(kv), config: CONFIG, fetchImpl: m.fetchImpl, now: () => t, ...quiet });
  assert.equal(s1.capped, true);
  const first = m.calls.length;
  assert.ok(first <= META_BUDGET && first + kv.ops.length <= SUBREQUESTS, `${first} calls`);
  let runs = 1;
  while (m.sends.length < 60 && runs < 10) { t += 5 * 60e3; await runWorker({ env: env(kv), config: CONFIG, fetchImpl: m.fetchImpl, now: () => t, ...quiet }); runs++; }
  assert.equal(m.sends.length, 60);
  assert.equal(new Set(m.sends.map((s) => s.commentId)).size, 60, 'no comment twice');
  assert.equal(m.replies.length, 60);
});

test('a new secret is adopted again; an unchanged one is not; the stored token is refreshed under 10 days', async () => {
  const kv = fakeKv();
  const m = meta();
  await runWorker({ env: env(kv), config: CONFIG, fetchImpl: m.fetchImpl, now: () => NOW, ...quiet });
  const mes = () => m.calls.filter((c) => c.path === 'me').length;
  assert.equal(mes(), 1);
  await runWorker({ env: env(kv), config: CONFIG, fetchImpl: m.fetchImpl, now: () => NOW + 5 * 60e3, ...quiet });
  assert.equal(mes(), 1, 'same secret: kept the stored token');
  await runWorker({ env: env(kv, { IG_TOKEN: 'NEW-SEED' }), config: CONFIG, fetchImpl: m.fetchImpl, now: () => NOW + 10 * 60e3, ...quiet });
  assert.equal(mes(), 2);
  assert.equal(kv.json(TOKEN_KEY).access_token, 'NEW-SEED-R');
  const later = NOW + 52 * 864e5;   // 60-day token, 8 days left
  await runWorker({ env: env(kv, { IG_TOKEN: 'NEW-SEED' }), config: CONFIG, fetchImpl: m.fetchImpl, now: () => later, ...quiet });
  assert.equal(kv.json(TOKEN_KEY).access_token, 'NEW-SEED-R-R');
});

test('no token, wrong account, bad config: reported in the summary, nothing sent', async () => {
  const m = meta([C(1)]);
  const a = await runWorker({ env: env(fakeKv(), { IG_TOKEN: undefined }), config: CONFIG, fetchImpl: m.fetchImpl, now: () => NOW, ...quiet });
  assert.match(a.errors[0], /npm run worker:seed/);
  const b = await runWorker({ env: env(fakeKv()), config: { ...CONFIG, account: 'someone.else' }, fetchImpl: m.fetchImpl, now: () => NOW, ...quiet });
  assert.match(b.errors[0], /belongs to @demo.account/);
  const kv = fakeKv();
  const c = await runWorker({ env: env(kv), config: { funnels: [] }, fetchImpl: m.fetchImpl, now: () => NOW, ...quiet });
  assert.ok(c.errors.every((e) => e.startsWith('config:')));
  assert.ok(kv.json(STATE_KEY).summary.errors.length > 0);
  assert.equal(m.sends.length, 0);
});

test('two state writes in one run are at least a second apart (KV allows one write a second per key)', async () => {
  const kv = fakeKv();
  const m = meta([C(1)]);
  let clock = NOW;
  const waits = [];
  await runWorker({ env: env(kv), config: { ...CONFIG, funnels: [{ ...CONFIG.funnels[0], replies: [] }] }, fetchImpl: m.fetchImpl, now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; }, log: () => {} });
  assert.equal(kv.puts(STATE_KEY), 2);
  assert.ok(waits.reduce((a, b) => a + b, 0) >= 1000, `slept ${waits.join('+')} ms between the writes`);
});

test('the dead-token case: a 190 on read stops the run, nothing is halted', async () => {
  const kv = fakeKv({ [TOKEN_KEY]: { access_token: 'DEAD-TOKEN', userId: ME.id, username: ME.username, expiresAt: '2027-01-10T00:00:00Z', estimated: false, obtainedAt: '2026-11-10T00:00:00Z', seedSha: await sha256('SEED-TOKEN') } });
  const m = meta([C(1)]);
  const s = await runWorker({ env: env(kv), config: CONFIG, fetchImpl: m.fetchImpl, now: () => NOW, ...quiet });
  assert.match(s.errors.join(' '), /refused the token/);
  assert.equal(s.halted, 0);
  assert.equal(m.sends.length, 0);
});
