// The Cloudflare Worker's run, on a 5-minute cron. Same engine as the local runner; what differs is where state
// lives and how tight the limits are.
//
// Workers Free (developers.cloudflare.com/workers/platform/limits, kv/platform/limits):
//   50 subrequests a run, and KV calls count, so a run gets 45 Meta calls + at most 5 KV operations;
//   10 ms CPU a run (waiting on fetch or KV does not count); 15 minutes wall time for a cron run;
//   KV: 1,000 writes a day, 1 write a second to the same key, 25 MiB a value.
// A 5-minute cron is 288 runs a day. A run writes the ledger twice only when it sends something (pending before,
// outcomes after) and otherwise writes a short summary at most once an hour, so a busy day stays near 600 writes.
//
// KV keys (binding STATE):
//   state   { v, records: [...ledger], summary }   safe to read: no token in it (npm run worker:status)
//   token   the live access token + its expiry, refreshed here; never printed
// Secret IG_TOKEN = the token you pasted locally (npm run worker:seed). When it changes, the Worker adopts it.
import { validateConfig } from '../src/config.mjs';
import { makeApi } from '../src/meta.mjs';
import { adopt, freshen } from '../src/token.mjs';
import { runOnce, summaryLines } from '../src/engine.mjs';
import { pruneRecords } from '../src/ledger.mjs';

export const SUBREQUESTS = 50;
export const KV_OPS_MAX = 5;                         // get state, get token, put token, put state twice
export const META_BUDGET = SUBREQUESTS - KV_OPS_MAX;
export const MAX_PAGES = 5;                          // the newest 250 comments of a post, every run
export const READ_RESERVE = 10;                      // extra comment pages never take the last 10 calls: those are for DMs
export const SUMMARY_EVERY_MS = 3600e3;
export const STATE_KEY = 'state';
export const TOKEN_KEY = 'token';
const SAME_KEY_GAP_MS = 1100;

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function runWorker({ env, config: rawConfig, fetchImpl = (url, init) => fetch(url, init), now = Date.now, sleep = defaultSleep, log = console.log }) {
  const kv = env.STATE;
  if (!kv) throw new Error('no KV binding STATE: check kv_namespaces in wrangler.jsonc');
  const live = env.MODE === 'live';
  const t = now();
  const state = (await kv.get(STATE_KEY, 'json')) ?? { v: 1, records: [], summary: null };
  state.records ??= [];
  const prev = state.summary;
  const budget = { left: META_BUDGET };
  const errors = [];
  let sum = null;
  let tok = null;

  const { config, problems } = validateConfig(rawConfig);
  for (const p of problems) errors.push(`config: ${p}`);

  // The ledger in one KV value: appends stay in memory until a checkpoint writes the whole value.
  let lastPut = 0;
  let dirty = false;
  const putState = async () => {
    const wait = lastPut + SAME_KEY_GAP_MS - now();
    if (lastPut && wait > 0) await sleep(wait);
    await kv.put(STATE_KEY, JSON.stringify(state));
    lastPut = now();
    dirty = false;
  };
  const ledger = { records: () => state.records, append(r) { state.records.push(r); dirty = true; }, checkpoint: putState };

  if (config) {
    try {
      const apiFor = (token) => makeApi({ token, fetchImpl, budget });
      tok = await kv.get(TOKEN_KEY, 'json');
      const seed = env.IG_TOKEN ? String(env.IG_TOKEN).trim() : '';
      if (seed) {
        const seedSha = await sha256(seed);
        if (!tok || tok.seedSha !== seedSha) {
          // a dry run adopts in memory only, and skips the refresh call
          tok = { ...(await adopt(seed, { account: config.account, apiFor, now: t, refresh: live })), seedSha };
          if (live) await kv.put(TOKEN_KEY, JSON.stringify(tok));
          log(`adopted the IG_TOKEN secret for @${tok.username}${live ? '' : ' (dry run: not stored)'}`);
        }
      }
      if (!tok?.access_token) throw new Error('no token yet: run npm run worker:seed in your own terminal (SETUP.md, part D2)');
      if (tok.username !== config.account) throw new Error(`the Worker's token is @${tok.username}, but config.json says "account": "${config.account}"`);
      if (live) {
        const r = await freshen(tok, { apiFor, now: t, log });
        if (r.changed) { tok = r.tok; await kv.put(TOKEN_KEY, JSON.stringify(tok)); log(`token renewed, valid until ${tok.expiresAt}`); }
      } else if (Date.parse(tok.expiresAt) <= t) {
        throw new Error(`the token expired ${tok.expiresAt}: generate a new one, npm run auth, npm run worker:seed`);
      }
      sum = await runOnce({ config, api: apiFor(tok.access_token), ledger, userId: tok.userId, now, dryRun: !live, batchPending: true, maxPages: MAX_PAGES, readReserve: READ_RESERVE, sleep, log });
      errors.push(...sum.errors);
    } catch (e) {
      errors.push(String(e?.message ?? e).slice(0, 300));
    }
  }

  const summary = {
    at: iso(t), mode: live ? 'live' : 'dry-run',
    token: tok ? { username: tok.username, expiresAt: tok.expiresAt, estimated: !!tok.estimated } : null,
    funnels: sum?.funnels ?? [], sent: sum?.sent ?? 0, failed: sum?.failed ?? 0, replied: sum?.replied ?? 0, halted: sum?.halted ?? 0,
    capped: sum?.capped ?? false, unknown: sum?.unknown ?? 0, wouldSend: (sum?.wouldSend ?? []).slice(0, 20), errors,
    callsLeft: budget.left, records: state.records.length,
  };
  // Write when the ledger moved, when something worth seeing changed, or once an hour as a heartbeat.
  const key = (s) => JSON.stringify([s?.mode, s?.token?.expiresAt, s?.errors, s?.halted, s?.unknown, (s?.funnels ?? []).map((f) => [f.post, f.state, f.why]), (s?.wouldSend ?? []).map((c) => c.commentId)]);
  const due = !prev?.savedAt || t - Date.parse(prev.savedAt) >= SUMMARY_EVERY_MS || key(prev) !== key(summary);
  if (dirty || due) {
    if (config) state.records = pruneRecords(state.records, config.funnels.map((f) => f.post), t);
    state.summary = { ...summary, savedAt: iso(now()) };
    await putState();
  }
  if (sum) for (const line of summaryLines(sum)) log(line);
  log(`run ${summary.at} ${summary.mode}: ${summary.sent} sent, ${summary.failed} failed, ${summary.replied} replied, ${budget.left} of ${META_BUDGET} Meta calls left${errors.length ? `; errors: ${errors.join(' | ')}` : ''}`);
  return summary;
}
