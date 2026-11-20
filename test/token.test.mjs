import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adopt, freshen, needsRefresh, daysLeft } from '../src/token.mjs';
import { makeApi } from '../src/meta.mjs';
import { fakeMeta, NOW, ME } from './fakes.mjs';

const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const apiFor = (m) => (token) => makeApi({ token, fetchImpl: m.fetchImpl });

test('adopt: checks whose token it is, then learns the real expiry with one refresh', async () => {
  const m = fakeMeta();
  const tok = await adopt('  PASTED-TOKEN \n', { account: ME.username, apiFor: apiFor(m), now: NOW });
  assert.equal(tok.username, ME.username); assert.equal(tok.userId, ME.id);
  assert.equal(tok.access_token, 'PASTED-TOKEN-R');
  assert.equal(tok.estimated, false);
  assert.equal(daysLeft(tok, NOW), 60);
  assert.deepEqual(m.calls.map((c) => c.path), ['me', 'refresh_access_token']);
});

test('adopt: the wrong account is refused before anything is stored', async () => {
  await assert.rejects(adopt('T', { account: 'someone.else', apiFor: apiFor(fakeMeta()), now: NOW }), /belongs to @demo.account.*someone.else/);
  await assert.rejects(adopt('DEAD-TOKEN', { account: null, apiFor: apiFor(fakeMeta()), now: NOW }), /190/);
  await assert.rejects(adopt('', { apiFor: apiFor(fakeMeta()), now: NOW }), /empty/);
});

test('adopt: a refused refresh (a token under 24 h old) keeps the token with a 60-day guess', async () => {
  const tok = await adopt('FRESH', { account: ME.username, apiFor: apiFor(fakeMeta({ refresh: 'refuse' })), now: NOW });
  assert.equal(tok.access_token, 'FRESH');
  assert.equal(tok.estimated, true);
  assert.equal(needsRefresh(tok, NOW + 23 * 3600e3), false, 'not before Meta allows it');
  assert.equal(needsRefresh(tok, NOW + 25 * 3600e3), true, 'then as soon as it does, to learn the real date');
});

test('freshen: nothing above 10 days; a refresh under 10; a refusal is fine while valid; expired + refused stops', async () => {
  const tok = (days) => ({ access_token: 'T', expiresAt: iso(NOW + days * DAY), estimated: false, obtainedAt: iso(NOW - 50 * DAY), refreshedAt: null });
  const m = fakeMeta();
  assert.deepEqual(await freshen(tok(30), { apiFor: apiFor(m), now: NOW }), { tok: tok(30), changed: false });
  assert.equal(m.calls.length, 0);
  const r = await freshen(tok(9), { apiFor: apiFor(m), now: NOW });
  assert.equal(r.changed, true); assert.equal(r.tok.access_token, 'T-R'); assert.equal(daysLeft(r.tok, NOW), 60);
  const logs = [];
  const kept = await freshen(tok(5), { apiFor: apiFor(fakeMeta({ refresh: 'refuse' })), now: NOW, log: (l) => logs.push(l) });
  assert.equal(kept.changed, false); assert.match(logs[0], /refused.*still valid/);
  await assert.rejects(freshen(tok(-1), { apiFor: apiFor(fakeMeta({ refresh: 'refuse' })), now: NOW }), /expired.*npm run auth/);
});
