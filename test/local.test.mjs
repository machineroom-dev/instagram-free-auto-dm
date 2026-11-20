import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pollLocal, readRecords, appendRecord, fileLedger, acquireLock, releaseLock, saveToken, loadToken, readHeartbeat, readSecret, LOCK_STALE_MS } from '../src/local.mjs';
import { fakeMeta, C, ME } from './fakes.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'comment-dm-test-'));
const POST = '17900000000000001';

test('the ledger round-trips through sent.jsonl, and a corrupt line stops everything', () => {
  const dir = tmp();
  appendRecord(dir, { at: '2026-11-20T12:00:00Z', post: 'p', commentId: 'a', outcome: 'pending' });
  const l = fileLedger(dir);
  l.append({ at: '2026-11-20T12:00:01Z', post: 'p', commentId: 'a', outcome: 'sent' });
  assert.deepEqual(readRecords(dir).map((r) => r.outcome), ['pending', 'sent']);
  assert.equal(l.records().length, 2);
  fs.appendFileSync(path.join(dir, 'sent.jsonl'), '{not json\n');
  assert.throws(() => readRecords(dir), /line 3 is not JSON/);
});

test('the lock: one run at a time, a stale lock is taken over', () => {
  const dir = tmp();
  const now = Date.parse('2026-11-20T12:00:00Z');
  assert.equal(acquireLock(dir, { now }), true);
  assert.equal(acquireLock(dir, { now: now + 60e3 }), false);
  assert.equal(acquireLock(dir, { now: now + LOCK_STALE_MS + 1 }), true);
  releaseLock(dir);
  assert.equal(acquireLock(dir, { now }), true);
});

test('the token file is private (mode 600)', () => {
  const dir = tmp();
  const f = saveToken(dir, { access_token: 'x', username: 'demo.account' });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(loadToken(dir).username, 'demo.account');
});

test('readSecret reads piped stdin, trimmed, without echoing it', async () => {
  const out = [];
  const v = await readSecret('> ', { input: Readable.from(['  IGAA-pasted-token \n']), output: { write: (s) => out.push(s) } });
  assert.equal(v, 'IGAA-pasted-token');
  assert.deepEqual(out, []);
});

test('pollLocal end to end: sends, replies, heartbeat; the next tick sends nothing; dry run writes nothing', async () => {
  const dir = tmp();
  const now = Date.parse('2026-11-20T12:00:00Z');
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ account: ME.username, funnels: [{ name: 'guide', post: POST, keywords: ['GUIDE'], message: 'Here: https://example.com/guide', replies: ['Sent! Check your DMs'] }] }));
  saveToken(dir, { access_token: 'T', userId: ME.id, username: ME.username, expiresAt: '2027-01-10T00:00:00Z', estimated: false, obtainedAt: '2026-11-10T00:00:00Z', refreshedAt: null });
  const m = fakeMeta({ comments: { [POST]: [C('e1', 'GUIDE please', { h: 2 }), C('e2', 'guide'), C('e3', 'guide', { user: ME.username }), C('e4', 'cool')] } });
  const logs = [];
  const opts = { dir, configPath, fetchImpl: m.fetchImpl, now: () => now, sleep: async () => {}, log: (l) => logs.push(l), gapMs: 0 };

  const dry = await pollLocal({ ...opts, dryRun: true });
  assert.equal(dry, 0);
  assert.equal(m.sends.length, 0);
  assert.equal(readRecords(dir).length, 0);
  assert.equal(readHeartbeat(dir), null);
  assert.ok(logs.some((l) => /would DM @usere1\.demo/.test(l)));

  assert.equal(await pollLocal(opts), 0);
  assert.deepEqual(m.sends.map((s) => s.commentId), ['e1', 'e2']);
  assert.deepEqual(m.replies.map((s) => s.commentId), ['e1', 'e2']);
  const beat = readHeartbeat(dir);
  assert.equal(beat.sent, 2); assert.equal(beat.replied, 2); assert.deepEqual(beat.errors, []);
  assert.equal(fs.existsSync(path.join(dir, 'lock')), false, 'the lock is released');

  assert.equal(await pollLocal(opts), 0);
  assert.equal(m.sends.length, 2, 'the next tick sends nothing new');
});

test('pollLocal refuses a token for the wrong account, a missing token and a bad config', async () => {
  const dir = tmp();
  const configPath = path.join(dir, 'config.json');
  const logs = [];
  const opts = { dir, configPath, fetchImpl: fakeMeta().fetchImpl, log: (l) => logs.push(l) };
  assert.equal(await pollLocal(opts), 1);
  assert.match(logs.at(-1), /copy config.example.json/);
  fs.writeFileSync(configPath, JSON.stringify({ account: ME.username, funnels: [{ post: POST, keywords: ['GUIDE'], message: 'x' }] }));
  assert.equal(await pollLocal(opts), 1);
  assert.match(logs.at(-1), /npm run auth/);
  saveToken(dir, { access_token: 'T', username: 'someone.else', expiresAt: '2027-01-10T00:00:00Z' });
  assert.equal(await pollLocal(opts), 1);
  assert.match(logs.at(-1), /@someone.else/);
});

test('pollLocal renews a token under 10 days and stores it', async () => {
  const dir = tmp();
  const now = Date.parse('2026-11-20T12:00:00Z');
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ account: ME.username, funnels: [{ post: POST, keywords: ['GUIDE'], message: 'x' }] }));
  saveToken(dir, { access_token: 'OLD', userId: ME.id, username: ME.username, expiresAt: '2026-11-25T00:00:00Z', estimated: false, obtainedAt: '2026-09-26T00:00:00Z', refreshedAt: null });
  const m = fakeMeta();
  assert.equal(await pollLocal({ dir, configPath, fetchImpl: m.fetchImpl, now: () => now, log: () => {} }), 0);
  assert.equal(loadToken(dir).access_token, 'OLD-R');
  assert.equal(loadToken(dir).expiresAt, '2027-01-19T12:00:00Z');
});
