// Unified login (graph.facebook.com, a system-user token) next to Instagram login (graph.instagram.com). The fake
// follows Meta's Unified-login docs; no test here has seen a real graph.facebook.com response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApi, apiOpts, FB_API } from '../src/meta.mjs';
import { adopt, freshen, needsRefresh, isExpired, tokenLife } from '../src/token.mjs';
import { runOnce } from '../src/engine.mjs';
import { pollLocal, saveToken, loadToken, readHeartbeat } from '../src/local.mjs';
import { runWorker, TOKEN_KEY, STATE_KEY, SUBREQUESTS } from '../worker/run.mjs';
import { fakeMeta, fakeKv, memoryLedger, config, funnel, C, ME, NOW } from './fakes.mjs';

const apiFor = (m) => (token, opts) => makeApi({ token, fetchImpl: m.fetchImpl, ...opts });
const POST = funnel().post;
const UNI = { access_token: 'UNI-TOKEN', login: 'unified', userId: ME.id, username: ME.username, expiresAt: null, estimated: false, obtainedAt: '2026-11-20T00:00:00Z', refreshedAt: null };
const where = (m) => m.calls.map((c) => `${c.host} ${c.method} ${c.path}`);

test('adopt: a Unified-login token is refused by graph.instagram.com, then found on graph.facebook.com; no refresh', async () => {
  const m = fakeMeta();
  const tok = await adopt(' UNI-TOKEN \n', { account: ME.username, apiFor: apiFor(m), now: NOW });
  assert.deepEqual(tok, { userId: ME.id, username: ME.username, obtainedAt: '2026-11-20T12:00:00Z', refreshedAt: null, login: 'unified', access_token: 'UNI-TOKEN', expiresAt: null, estimated: false });
  assert.deepEqual(where(m), ['ig GET me', 'fb GET me/assigned_instagram_accounts']);
  assert.equal(m.calls[1].q.fields, 'id,username');
});

test('adopt: an Instagram-login token never touches graph.facebook.com (existing setups unchanged)', async () => {
  const m = fakeMeta();
  const tok = await adopt('IGAA-TOKEN', { account: ME.username, apiFor: apiFor(m), now: NOW });
  assert.equal(tok.login, undefined);
  assert.equal(tok.access_token, 'IGAA-TOKEN-R');
  assert.deepEqual(where(m), ['ig GET me', 'ig GET refresh_access_token']);
});

test('adopt: Unified login with several accounts takes the one config.json names, and refuses to guess', async () => {
  const other = { id: '17840000000000099', username: 'other.brand' };
  const m = fakeMeta({ accounts: [other, ME] });
  assert.equal((await adopt('UNI-T', { account: ME.username, apiFor: apiFor(m), now: NOW })).userId, ME.id);
  await assert.rejects(adopt('UNI-T', { account: null, apiFor: apiFor(m), now: NOW }), /@other\.brand, @demo\.account.*"account" in config\.json/);
  await assert.rejects(adopt('UNI-T', { account: 'someone.else', apiFor: apiFor(m), now: NOW }), /belongs to @other\.brand, @demo\.account.*someone\.else/);
  await assert.rejects(adopt('UNI-T', { account: null, apiFor: apiFor(fakeMeta({ accounts: [] })), now: NOW }), /no Instagram account assigned/);
});

test('adopt: a token both hosts refuse says so for each', async () => {
  await assert.rejects(adopt('DEAD-TOKEN', { account: null, apiFor: apiFor(fakeMeta()), now: NOW }), /Instagram-login token: .*190.*Unified-login token: .*190/);
});

test('a Unified-login token never expires here: no refresh, no expiry, said plainly', async () => {
  const m = fakeMeta();
  assert.equal(needsRefresh(UNI, NOW + 400 * 864e5), false);
  assert.equal(isExpired(UNI, NOW + 400 * 864e5), false);
  assert.deepEqual(await freshen(UNI, { apiFor: apiFor(m), now: NOW + 400 * 864e5 }), { tok: UNI, changed: false });
  assert.equal(m.calls.length, 0);
  assert.equal(tokenLife(UNI, NOW), 'does not expire (Unified login)');
  assert.equal(tokenLife({ expiresAt: '2027-01-19T12:00:00Z', estimated: true }, NOW), 'about 60 days left');
  assert.deepEqual(apiOpts(UNI), { login: 'unified', igId: ME.id });
  assert.deepEqual(apiOpts({ access_token: 'IGAA' }), {}, 'a token file from before Unified login stays Instagram login');
});

test('the Unified-login client: graph.facebook.com/v27.0, the account by ID, the same private and public replies', async () => {
  const m = fakeMeta({ comments: { [POST]: [C(1)] }, posts: [{ id: POST }] });
  const api = makeApi({ token: 'UNI-T', fetchImpl: m.fetchImpl, ...apiOpts({ ...UNI, access_token: 'UNI-T' }) });
  assert.deepEqual(await api.me(), { userId: ME.id, username: ME.username });
  assert.equal((await api.posts()).length, 1);
  assert.equal((await api.commentsPage(POST)).data.length, 1);
  assert.equal((await api.sendPrivateReply('1', 'hi')).message_id, 'm1');
  assert.equal((await api.publicReply('1', 'Sent!')).id, 'reply-1');
  assert.deepEqual(where(m), ['fb GET ' + ME.id, `fb GET ${ME.id}/media`, `fb GET ${POST}/comments`, `fb POST ${ME.id}/messages`, 'fb POST 1/replies']);
  assert.deepEqual(m.sends, [{ commentId: '1', text: 'hi' }]);
  assert.throws(() => api.nextPage('https://graph.instagram.com/x?access_token=UNI-T'), /outside https:\/\/graph\.facebook\.com/);
  await assert.rejects(makeApi({ token: 'UNI-T', login: 'unified' }).me(), /needs the Instagram account ID/);
  assert.ok(FB_API.startsWith('https://graph.facebook.com/v'));
});

test('runOnce on Unified login: pages through comments on graph.facebook.com, sends one DM and one reply', async () => {
  const comments = [...Array.from({ length: 60 }, (_, i) => C(100 + i, 'nice')), C(7, 'GUIDE', { h: 2 })];
  const m = fakeMeta({ comments: { [POST]: comments } });
  const api = makeApi({ token: 'UNI-T', fetchImpl: m.fetchImpl, login: 'unified', igId: ME.id });
  const r = await runOnce({ config: config([funnel({ replies: ['Sent!'] })]), api, ledger: memoryLedger(), userId: ME.id, now: () => NOW, sleep: async () => {} });
  assert.equal(r.sent, 1); assert.equal(r.replied, 1); assert.deepEqual(r.errors, []);
  assert.equal(m.calls.filter((c) => c.path === `${POST}/comments`).length, 2, 'the paging link on graph.facebook.com is followed');
  assert.ok(m.calls.every((c) => c.host === 'fb'));
});

test('pollLocal with a stored Unified-login token: sends, never refreshes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-dm-test-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ account: ME.username, funnels: [{ post: POST, keywords: ['GUIDE'], message: 'Here', replies: ['Sent!'] }] }));
  saveToken(dir, UNI);
  const m = fakeMeta({ comments: { [POST]: [C(1), C(2, 'cool')] } });
  assert.equal(await pollLocal({ dir, configPath, fetchImpl: m.fetchImpl, now: () => NOW, sleep: async () => {}, log: () => {}, gapMs: 0 }), 0);
  assert.deepEqual(m.sends.map((s) => s.commentId), ['1']);
  assert.equal(readHeartbeat(dir).replied, 1);
  assert.equal(m.calls.some((c) => c.path === 'refresh_access_token'), false);
  assert.deepEqual(loadToken(dir), UNI, 'the stored token is untouched');
});

test('the Worker adopts a Unified-login IG_TOKEN, sends, and stores it without an expiry', async () => {
  const kv = fakeKv();
  const m = fakeMeta({ comments: { [POST]: [C(1), C(2)] } });
  const cfg = { account: ME.username, funnels: [{ name: 'guide', post: POST, keywords: ['GUIDE'], message: 'Here', replies: ['Sent!'] }] };
  const s = await runWorker({ env: { STATE: kv, MODE: 'live', IG_TOKEN: 'UNI-SEED' }, config: cfg, fetchImpl: m.fetchImpl, now: () => NOW, sleep: async () => {}, log: () => {} });
  assert.deepEqual(s.errors, []);
  assert.equal(s.sent, 2); assert.equal(s.replied, 2);
  const tok = kv.json(TOKEN_KEY);
  assert.equal(tok.login, 'unified'); assert.equal(tok.expiresAt, null); assert.equal(tok.access_token, 'UNI-SEED');
  assert.deepEqual(kv.json(STATE_KEY).summary.token, { username: ME.username, login: 'unified', expiresAt: null, estimated: false });
  assert.ok(m.calls.length + kv.ops.length <= SUBREQUESTS);
  // the next run uses the stored token as is
  const before = m.calls.length;
  await runWorker({ env: { STATE: kv, MODE: 'live', IG_TOKEN: 'UNI-SEED' }, config: cfg, fetchImpl: m.fetchImpl, now: () => NOW + 5 * 60e3, sleep: async () => {}, log: () => {} });
  assert.deepEqual(m.calls.slice(before).map((c) => c.path), [`${POST}/comments`]);
});
