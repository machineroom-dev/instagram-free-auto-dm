// The local runner's files, all under one data folder (default `.state/` in the repo, git-ignored):
//   sent.jsonl     the dedupe ledger, one JSON record per line, append-only
//   token.json     the access token (mode 600; never printed by any command)
//   last-run.json  the heartbeat: what the last real run did
//   lock           present while a run is going (stale after 30 minutes)
//   timer.log      what the timer's runs printed
import fs from 'node:fs';
import path from 'node:path';
import { validateConfig } from './config.mjs';
import { apiOpts, makeApi } from './meta.mjs';
import { freshen, isExpired } from './token.mjs';
import { runOnce, summaryLines } from './engine.mjs';

export const LOCK_STALE_MS = 30 * 60e3;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const files = (dir) => ({ sent: path.join(dir, 'sent.jsonl'), token: path.join(dir, 'token.json'), beat: path.join(dir, 'last-run.json'), lock: path.join(dir, 'lock') });
const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

// A corrupt line stops everything: a ledger misread as empty would DM everyone again.
export function readRecords(dir) {
  let text;
  try { text = fs.readFileSync(files(dir).sent, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`${files(dir).sent} line ${i + 1} is not JSON; fix it by hand before any run (a misread ledger would DM everyone again)`); }
  });
}
export function appendRecord(dir, r) { ensureDir(dir); fs.appendFileSync(files(dir).sent, JSON.stringify(r) + '\n'); }
export function fileLedger(dir) {
  const records = readRecords(dir);
  return {
    records: () => records,
    append(r) { appendRecord(dir, r); records.push(r); },
    async checkpoint() { /* every append is already on disk */ },
  };
}

export function loadToken(dir) { return readJson(files(dir).token); }
export function saveToken(dir, tok) {
  ensureDir(dir);
  const f = files(dir).token;
  fs.writeFileSync(f, JSON.stringify(tok, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(f, 0o600);
  return f;
}
export const readHeartbeat = (dir) => readJson(files(dir).beat);

export function acquireLock(dir, { now = Date.now(), pid = process.pid } = {}) {
  ensureDir(dir);
  const cur = readJson(files(dir).lock);
  if (cur && now - Date.parse(cur.at) < LOCK_STALE_MS) return false;
  fs.writeFileSync(files(dir).lock, JSON.stringify({ pid, at: new Date(now).toISOString() }));
  return true;
}
export function releaseLock(dir) { try { fs.unlinkSync(files(dir).lock); } catch { /* already gone */ } }

export function loadConfig(configPath) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) {
    return { config: null, problems: [e.code === 'ENOENT' ? `no ${path.basename(configPath)} yet: copy config.example.json to config.json and fill it in (SETUP.md, part C)` : `${path.basename(configPath)} is not valid JSON: ${e.message}`] };
  }
  return validateConfig(raw);
}

// The timer's entry point. Returns the exit code: 0 ok, 1 problems (a halt, a read error, a bad config).
export async function pollLocal({ dir, configPath, dryRun = false, fetchImpl, now = Date.now, sleep, log = console.log, gapMs }) {
  const { config, problems } = loadConfig(configPath);
  if (!config) { for (const p of problems) log(`config: ${p}`); return 1; }
  if (!dryRun && !acquireLock(dir, { now: now() })) { log('another run is still going (lock held); skipping this one'); return 0; }
  try {
    let tok = loadToken(dir);
    if (!tok?.access_token) { log('no token yet: run npm run auth (SETUP.md, step B6)'); return 1; }
    if (tok.username !== config.account) { log(`the stored token is @${tok.username}, but config.json says "account": "${config.account}"`); return 1; }
    const apiFor = (token, opts) => makeApi({ token, fetchImpl, ...opts });
    if (dryRun) {
      if (isExpired(tok, now())) { log(`the token expired ${tok.expiresAt}: run npm run auth`); return 1; }
    } else {
      const r = await freshen(tok, { apiFor, now: now(), log });
      if (r.changed) { saveToken(dir, r.tok); log(`token renewed, now valid until ${r.tok.expiresAt}`); }
      tok = r.tok;
    }
    const ledger = fileLedger(dir);
    log(`run ${new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z')}${dryRun ? ' (dry run: nothing is sent or written)' : ''}`);
    const sum = await runOnce({ config, api: apiFor(tok.access_token, apiOpts(tok)), ledger, userId: tok.userId, now, dryRun, sleep, log, ...(gapMs != null ? { gapMs } : {}) });
    printSummary(sum, log);
    if (!dryRun) fs.writeFileSync(files(dir).beat, JSON.stringify({ ...sum, wouldSend: undefined, wouldReply: undefined }, null, 2) + '\n');
    return sum.errors.length || sum.halted ? 1 : 0;
  } catch (e) {
    log(`error: ${e?.message ?? e}`);
    return 1;
  } finally {
    if (!dryRun) releaseLock(dir);
  }
}

export function printSummary(sum, log = console.log) { for (const line of summaryLines(sum)) log(line); }

// Reads a token without showing it: hidden typing in a terminal, or piped stdin.
export function readSecret(prompt, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    const clean = (s) => s.replace(/\s+/g, '').replace(/[^\x21-\x7e]/g, '');
    if (!input.isTTY) {
      let s = '';
      input.setEncoding('utf8');
      input.on('data', (d) => { s += d; });
      input.on('end', () => resolve(clean(s)));
      input.on('error', reject);
      return;
    }
    output.write(prompt);
    let s = '';
    const cleanup = () => { input.setRawMode(false); input.pause(); input.removeListener('data', onData); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { cleanup(); output.write('\n'); resolve(clean(s)); return; }
        if (ch === '\u0003') { cleanup(); output.write('\n'); reject(new Error('cancelled')); return; }
        if (ch === '\u007f' || ch === '\b') { s = s.slice(0, -1); continue; }
        s += ch;
      }
    };
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.on('data', onData);
    input.resume();
  });
}
