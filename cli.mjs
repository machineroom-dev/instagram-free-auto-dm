#!/usr/bin/env node
// instagram-comment-to-dm: someone comments a keyword on your post and gets one DM with your link.
//
//   node cli.mjs auth                          paste your token (hidden), check it, store it in .state/token.json
//   node cli.mjs whoami                        whose token it is and how many days it has left (never the token)
//   node cli.mjs check                         check config.json and list the funnels (no API call)
//   node cli.mjs posts [--limit 25]            your latest posts with their media IDs, for config.json
//   node cli.mjs comments <post|name>          read-only: a post's comments, which match, which are answered
//   node cli.mjs poll [--dry-run]              answer new keyword comments (the timer runs this every 5 minutes)
//   node cli.mjs status                        funnels, counts, last run, token expiry
//   node cli.mjs log [<post>]                  the dedupe ledger, oldest first
//   node cli.mjs mark <commentId> sent|error|retry   settle a DM whose outcome is unknown (a run died mid-send)
//   node cli.mjs resume <post>                 restart a halted funnel once the cause is fixed
//   node cli.mjs timer install|remove|show     launchd (macOS) or cron (Linux), every 5 minutes
//   node cli.mjs worker seed|status|import|resume <post>|mark <commentId> <outcome>   the Cloudflare Worker
//
// Exit codes: 0 ok, 1 problems, 2 usage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendRecord, loadConfig, loadToken, pollLocal, readHeartbeat, readRecords, readSecret, saveToken } from './src/local.mjs';
import { makeApi } from './src/meta.mjs';
import { adopt, daysLeft, freshen } from './src/token.mjs';
import { keywordMatches, REPLY_WINDOW_MS } from './src/match.mjs';
import { listComments } from './src/engine.mjs';
import { dmCounts, haltOf, lastDm, mergeRecords, repliedCount, unknownSends } from './src/ledger.mjs';
import { timer } from './src/timer.mjs';

export const WRANGLER = 'wrangler@4.158.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.COMMENT_DM_DATA ? path.resolve(process.env.COMMENT_DM_DATA) : path.join(HERE, '.state');
const CONFIG = process.env.COMMENT_DM_CONFIG ? path.resolve(process.env.COMMENT_DM_CONFIG) : path.join(HERE, 'config.json');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const ago = (at) => { const m = Math.round((Date.now() - Date.parse(at)) / 60e3); return m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

function die(msg, code = 2) { console.error(msg); process.exit(code); }
function parseArgs(argv) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { pos.push(argv[i]); continue; }
    const key = argv[i].slice(2);
    flags[key] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return { flags, pos };
}
function configOrDie() {
  const { config, problems } = loadConfig(CONFIG);
  if (!config) die(`config.json has problems:\n  ${problems.join('\n  ')}`, 1);
  return config;
}
async function tokenOrDie() {
  const tok = loadToken(DATA);
  if (!tok?.access_token) die('no token yet: run npm run auth (SETUP.md, step B6)', 1);
  const r = await freshen(tok, { apiFor: (token) => makeApi({ token }), now: Date.now(), log: console.error });
  if (r.changed) saveToken(DATA, r.tok);
  return r.tok;
}
const findFunnel = (config, key) => config?.funnels.find((f) => f.post === key || f.name === key) ?? null;

function funnelLines(config, records, now) {
  return config.funnels.map((f) => {
    const { sent, failed } = dmCounts(records, f.post);
    const h = haltOf(records, f.post);
    const state = f.untilMs != null && now > f.untilMs ? `ended ${f.until}` : h ? `HALTED ${h.at}: ${h.error ?? ''}` : `live${f.until ? ` until ${f.until}` : ''}`;
    return `  ${f.name} (post ${f.post}, ${f.keywords.join('/')}): ${state} · ${sent} DM(s) sent, ${failed} failed, ${repliedCount(records, f.post)} public replies`;
  });
}
function unknownLines(records, worker = false) {
  return unknownSends(records).map((r) => `  unknown: comment ${r.commentId} (@${r.username ?? '?'}, ${r.funnel ?? r.post}) since ${r.at}: look in your Instagram sent DMs, then node cli.mjs ${worker ? 'worker ' : ''}mark ${r.commentId} sent|retry`);
}

// ---------- the Worker's KV, through wrangler (state only: it never holds the token) ----------
function wrangler(args, opts = {}) {
  const r = spawnSync('npx', ['--yes', WRANGLER, ...args], { cwd: HERE, encoding: 'utf8', ...opts });
  if (r.error) die(`could not run npx ${WRANGLER}: ${r.error.message}`, 1);
  return r;
}
function remoteState() {
  const r = wrangler(['kv', 'key', 'get', 'state', '--binding', 'STATE', '--remote']);
  const out = r.stdout ?? '';
  if (r.status !== 0) die(`wrangler kv key get failed:\n${(r.stderr || out).trim()}`, 1);
  const a = out.indexOf('{'); const b = out.lastIndexOf('}');
  if (a < 0) return { v: 1, records: [], summary: null };   // "Value not found": nothing written yet
  return JSON.parse(out.slice(a, b + 1));
}
function putRemoteState(state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-dm-'));
  const file = path.join(dir, 'state.json');
  try {
    fs.writeFileSync(file, JSON.stringify(state));
    const r = wrangler(['kv', 'key', 'put', 'state', '--path', file, '--binding', 'STATE', '--remote']);
    if (r.status !== 0) die(`wrangler kv key put failed:\n${(r.stderr || r.stdout).trim()}`, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function markRecord(records, commentId, outcome) {
  if (!['sent', 'error', 'retry'].includes(outcome)) die('usage: mark <commentId> sent|error|retry');
  const prev = lastDm(records).get(String(commentId)) ?? die(`no record for comment ${commentId}`, 1);
  if (prev.outcome !== 'pending') die(`comment ${commentId} is already "${prev.outcome}"`, 1);
  return { at: iso(Date.now()), post: prev.post, funnel: prev.funnel, commentId: prev.commentId, username: prev.username,
    outcome: outcome === 'retry' ? 'unsent' : outcome, error: outcome === 'sent' ? undefined : 'settled by hand' };
}

// ---------- commands ----------
const [cmd, ...rest] = process.argv.slice(2);
const { flags, pos } = parseArgs(rest);
try {
  if (cmd === 'auth') {
    const { config } = loadConfig(CONFIG);   // optional here: SETUP stores the token before config.json exists
    const raw = await readSecret('Paste the token from the Meta dashboard (it stays hidden while you paste), then press Enter:\n> ');
    const tok = await adopt(raw, { account: config?.account ?? null, apiFor: (token) => makeApi({ token }), now: Date.now() });
    saveToken(DATA, tok);
    console.log(`Stored the token for @${tok.username}. Valid ${tok.estimated ? 'about ' : ''}${daysLeft(tok, Date.now())} days; it renews itself when under 10 days are left.`);
  } else if (cmd === 'whoami') {
    const tok = await tokenOrDie();
    const me = await makeApi({ token: tok.access_token }).me();
    console.log(`@${me.username} (Instagram user ${me.userId}); token valid ${tok.estimated ? 'about ' : ''}${daysLeft(tok, Date.now())} days, renews itself under 10`);
  } else if (cmd === 'check') {
    const config = configOrDie();
    console.log(`config.json is fine: account @${config.account}, ${config.funnels.length} funnel(s)`);
    for (const f of config.funnels) console.log(`  ${f.name}: post ${f.post}, keywords ${f.keywords.join(', ')}, DM ${new TextEncoder().encode(f.message).length}/1000 bytes, ${f.replies.length} public reply line(s)${f.until ? `, until ${f.until}` : ''}`);
  } else if (cmd === 'posts') {
    const tok = await tokenOrDie();
    const posts = await makeApi({ token: tok.access_token }).posts(Number(flags.limit) || 25);
    for (const p of posts) console.log(`${p.id}  ${String(p.timestamp ?? '').slice(0, 10)}  ${(p.media_product_type ?? '').padEnd(5)}  ${String(p.comments_count ?? '?').padStart(4)} comments  ${p.permalink ?? ''}  ${(p.caption ?? '').replace(/\s+/g, ' ').slice(0, 50)}`);
    if (!posts.length) console.log('(no posts returned)');
  } else if (cmd === 'comments') {
    const key = pos[0] || die('usage: comments <post id or funnel name>');
    const { config } = loadConfig(CONFIG);
    const f = findFunnel(config, key);
    const post = f?.post ?? (/^\d+$/.test(key) ? key : die(`no funnel named "${key}" in config.json`, 1));
    const tok = await tokenOrDie();
    const { comments } = await listComments(makeApi({ token: tok.access_token }), post, { now: Date.now() });
    const last = lastDm(readRecords(DATA));
    const match = { maxWords: config?.maxWords, askWords: config?.askWords };
    console.log(`post ${post}: ${comments.length} comment(s), replies included${f ? `; keywords ${f.keywords.join('/')}` : '; not in config.json, so nothing is matched'}`);
    for (const c of comments) {
      const ours = c.username?.toLowerCase() === tok.username || c.fromId === tok.userId;
      const hit = f && !ours && keywordMatches(c.text, f.keywords, match);
      const state = last.get(c.id)?.outcome ?? (hit ? (Date.now() - c.at < REPLY_WINDOW_MS ? 'to answer' : 'too old (over 7 days)') : '');
      console.log(`  ${c.timestamp ?? '?'}  ${c.parentId ? '  ↳ ' : ''}@${c.username ?? '?'}${ours ? ' (you)' : ''}  ${hit ? '[MATCH] ' : ''}${state ? `{${state}} ` : ''}${c.text.replace(/\s+/g, ' ').slice(0, 70)}`);
    }
    if (!comments.length) console.log('  (none returned. If the post has comments, the app is still in development mode, which hides everyone without a role on it: publish the app, SETUP.md step B8)');
  } else if (cmd === 'poll') {
    process.exitCode = await pollLocal({ dir: DATA, configPath: CONFIG, dryRun: !!flags['dry-run'] });
  } else if (cmd === 'status') {
    const config = configOrDie();
    const records = readRecords(DATA);
    const tok = loadToken(DATA);
    const beat = readHeartbeat(DATA);
    console.log(tok ? `token: @${tok.username}, ${tok.estimated ? 'about ' : ''}${daysLeft(tok, Date.now())} days left (renews itself under 10)` : 'token: none yet (npm run auth)');
    console.log(beat ? `last run: ${beat.at} (${ago(beat.at)}): ${beat.sent} sent, ${beat.failed} failed, ${beat.replied} replied${beat.errors?.length ? `; errors: ${beat.errors.join(' | ')}` : ''}` : 'last run: never (npm run poll, or npm run timer:install)');
    for (const l of funnelLines(config, records, Date.now())) console.log(l);
    for (const l of unknownLines(records)) console.log(l);
    try { console.log(`timer: ${timer('show', { cliPath: path.join(HERE, 'cli.mjs'), workDir: HERE, logPath: path.join(DATA, 'timer.log') })}`); } catch (e) { console.log(`timer: ${e.message}`); }
  } else if (cmd === 'log') {
    const recs = readRecords(DATA).filter((r) => !pos[0] || r.post === pos[0] || r.funnel === pos[0]);
    for (const r of recs) console.log(`${r.at}  ${r.funnel ?? r.post}  ${r.kind === 'reply' ? 'public reply' : r.kind === 'resume' ? 'resume' : 'DM'}  ${r.commentId ? `comment ${r.commentId}  @${r.username ?? '?'}  ` : ''}${r.outcome ?? ''}${r.error ? `  ${r.error.slice(0, 100)}` : ''}`);
    if (!recs.length) console.log('(no records)');
  } else if (cmd === 'mark') {
    const rec = markRecord(readRecords(DATA), pos[0] || die('usage: mark <commentId> sent|error|retry'), pos[1]);
    appendRecord(DATA, rec);
    console.log(`comment ${rec.commentId}: ${rec.outcome}${rec.outcome === 'unsent' ? ' (the next run tries it again)' : ''}`);
  } else if (cmd === 'resume') {
    const post = pos[0] || die('usage: resume <post>');
    const config = configOrDie();
    const f = findFunnel(config, post) ?? die(`no funnel for "${post}" in config.json`, 1);
    if (!haltOf(readRecords(DATA), f.post)) die(`${f.name} is not halted`, 1);
    appendRecord(DATA, { kind: 'resume', at: iso(Date.now()), post: f.post, funnel: f.name });
    console.log(`${f.name} resumed: the next run tries the comment that halted it again`);
  } else if (cmd === 'timer') {
    const action = pos[0];
    if (!['install', 'remove', 'show'].includes(action)) die('usage: timer install|remove|show');
    if (action === 'install') configOrDie();
    console.log(timer(action, { cliPath: path.join(HERE, 'cli.mjs'), workDir: HERE, logPath: path.join(DATA, 'timer.log') }));
  } else if (cmd === 'worker') {
    const sub = pos[0];
    if (sub === 'seed') {
      const tok = loadToken(DATA) ?? die('no local token to copy: run npm run auth first', 1);
      // the token goes to wrangler on stdin: it is never an argument, never printed, never in a file here
      const r = wrangler(['secret', 'put', 'IG_TOKEN'], { input: tok.access_token, stdio: ['pipe', 'inherit', 'inherit'] });
      if (r.status !== 0) die('wrangler secret put failed (logged in? npx wrangler login; Worker deployed? npm run worker:deploy)', 1);
      console.log(`The Worker has the token for @${tok.username}. It adopts it on its next run (within 5 minutes).`);
    } else if (sub === 'status') {
      const config = configOrDie();
      const state = remoteState();
      const s = state.summary;
      if (!s) { console.log('the Worker has not written anything yet (deployed? the cron runs every 5 minutes)'); process.exit(0); }
      console.log(`Worker, ${s.mode}: last summary ${s.savedAt ?? s.at} (${ago(s.savedAt ?? s.at)}; written on any change, else hourly)`);
      console.log(s.token ? `token: @${s.token.username}, ${s.token.estimated ? 'about ' : ''}${daysLeft(s.token, Date.now())} days left` : 'token: none adopted yet (npm run worker:seed)');
      for (const l of funnelLines(config, state.records ?? [], Date.now())) console.log(l);
      for (const c of s.wouldSend ?? []) console.log(`    dry run, would DM @${c.username} (comment ${c.commentId}): "${c.text}"`);
      for (const l of unknownLines(state.records ?? [], true)) console.log(l);
      for (const e of s.errors ?? []) console.log(`  error: ${e}`);
    } else if (sub === 'import') {
      const local = readRecords(DATA);
      const state = remoteState();
      const merged = mergeRecords(state.records ?? [], local);
      putRemoteState({ ...state, v: 1, records: merged });
      console.log(`The Worker's ledger now has ${merged.length} record(s) (${local.length} local). Comments answered here will not be tried again there.`);
    } else if (sub === 'resume' || sub === 'mark') {
      const state = remoteState();
      state.records ??= [];
      if (sub === 'resume') {
        const config = configOrDie();
        const f = findFunnel(config, pos[1] || die('usage: worker resume <post>')) ?? die(`no funnel for "${pos[1]}" in config.json`, 1);
        if (!haltOf(state.records, f.post)) die(`${f.name} is not halted in the Worker`, 1);
        state.records.push({ kind: 'resume', at: iso(Date.now()), post: f.post, funnel: f.name });
      } else {
        state.records.push(markRecord(state.records, pos[1] || die('usage: worker mark <commentId> sent|error|retry'), pos[2]));
      }
      putRemoteState(state);
      console.log('done; the Worker picks it up on its next run');
    } else die('usage: worker seed|status|import|resume <post>|mark <commentId> sent|error|retry');
  } else {
    die('usage: node cli.mjs <auth|whoami|check|posts|comments|poll|status|log|mark|resume|timer|worker> (see the top of cli.mjs or README "Commands")');
  }
} catch (e) {
  die(`error: ${e?.message ?? e}`, 1);
}
