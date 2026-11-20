// One run: read every live funnel's comments, pick the ones that ask, send each its one DM, then reply under
// the comment so people know to check. Shared by the local runner (src/local.mjs) and the Worker (worker/run.mjs).
//
// The ledger is { records(), append(record), checkpoint() }. Locally every append lands on disk at once, so a
// `pending` record is written right before each POST. The Worker cannot afford a KV write per DM (Workers Free
// allows 1,000 writes a day and one write a second per key), so it runs with `batchPending`: every pending
// record of the run is written in one checkpoint before the first POST, and the outcomes in one write after.
import { REPLY_WINDOW_MS, candidates, flattenComments, tsMs } from './match.mjs';
import { blockedCommentIds, doneUsers, haltOf, lastDm, repliedCount, replyBlocked, unknownSends } from './ledger.mjs';
import { BudgetSpent, isAuthError } from './meta.mjs';

export const GAP_MS = 1000;              // between two sends
export const MAX_SENDS_PER_RUN = 60;     // 12 runs an hour x 60 = 720, under Meta's 750 private replies an hour
export const MAX_PAGES = 20;             // 50 comments a page
export const HALT_AFTER = 3;             // DMs in a row that fail before a funnel stops

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const short = (e) => String(e?.message ?? e).slice(0, 300);
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Meta lists comments newest first (measured), so once a whole page is older than the 7-day window the rest is
// older still and cannot be answered: stop paging there. `keepCalls` leaves room in the budget for the sends.
export async function listComments(api, postId, { maxPages = MAX_PAGES, now, keepCalls = 0 } = {}) {
  const pages = [];
  let page = await api.commentsPage(postId);
  pages.push(page);
  while (page.paging?.next && pages.length < maxPages && api.callsLeft() > keepCalls) {
    const times = (page.data ?? []).map((c) => tsMs(c.timestamp)).filter(Number.isFinite);
    if (times.length && now - Math.max(...times) >= REPLY_WINDOW_MS) break;
    page = await api.nextPage(page.paging.next);
    pages.push(page);
  }
  return { comments: flattenComments(pages.flatMap((p) => p.data ?? [])), pages: pages.length };
}

export async function runOnce({
  config, api, ledger, userId = null, now = Date.now, dryRun = false, batchPending = false,
  maxSends = MAX_SENDS_PER_RUN, maxPages = MAX_PAGES, readReserve = 0, gapMs = GAP_MS, sleep = defaultSleep, log = () => {},
}) {
  const t = now();
  const sum = { at: iso(t), dryRun, funnels: [], sent: 0, failed: 0, replied: 0, halted: 0, capped: false, errors: [], wouldSend: [], wouldReply: [], unknown: 0 };
  const brief = (f, c) => ({ funnel: f.name, post: f.post, commentId: c.id, username: c.username, timestamp: c.timestamp, text: c.text.slice(0, 80) });

  // 1. Which funnels run: inside their dates, not halted.
  const live = [];
  for (const f of config.funnels) {
    const row = { name: f.name, post: f.post, state: 'live', why: null, comments: null, matched: 0, sent: 0, failed: 0, replied: 0 };
    sum.funnels.push(row);
    if (f.untilMs != null && t > f.untilMs) { row.state = 'closed'; row.why = `ended ${f.until}`; continue; }
    const h = haltOf(ledger.records(), f.post);
    if (h) { row.state = 'halted'; row.why = `halted ${h.at}: ${h.error ?? 'send failed'}`; continue; }
    live.push({ f, row, comments: null, todo: [], backfill: [] });
  }

  // 2. Read the comments.
  for (const L of live) {
    try {
      const { comments } = await listComments(api, L.f.post, { maxPages, now: t, keepCalls: readReserve });
      L.comments = comments;
      L.row.comments = comments.length;
    } catch (e) {
      if (e instanceof BudgetSpent) { L.row.why = 'not read this run (call budget spent)'; continue; }
      if (isAuthError(e)) {
        sum.errors.push(`Instagram refused the token: ${short(e)}; generate a new one and run npm run auth (Worker: then npm run worker:seed)`);
        return finish();
      }
      sum.errors.push(`${L.f.name}: ${short(e)}`);
      L.row.why = `could not read comments: ${short(e)}`;
    }
  }
  const read = live.filter((L) => L.comments);

  // 3. Who to answer.
  const recs = ledger.records();
  const blocked = blockedCommentIds(recs);
  const replied = replyBlocked(recs);
  const dmLast = lastDm(recs);
  const match = { maxWords: config.maxWords, askWords: config.askWords };
  for (const L of read) {
    L.todo = candidates({ comments: L.comments, keywords: L.f.keywords, match, account: config.account, ownIds: userId ? [String(userId)] : [], blocked, doneUsers: doneUsers(recs, L.f.post), now: t });
    // a DM that went out earlier without its public reply (a budget cut, a crash, `replies` added later)
    L.backfill = L.f.replies.length ? L.comments.filter((c) => dmLast.get(c.id)?.outcome === 'sent' && !replied.has(c.id)) : [];
    L.row.matched = L.todo.length;
  }
  if (dryRun) {
    for (const L of read) {
      sum.wouldSend.push(...L.todo.map((c) => brief(L.f, c)));
      if (L.f.replies.length) sum.wouldReply.push(...[...L.backfill, ...L.todo].map((c) => brief(L.f, c)));
    }
    return finish();
  }

  // 4. Plan inside the caps: oldest comment first, since it is the closest to Meta's 7-day limit.
  const queue = read.flatMap((L) => L.todo.map((c) => ({ L, c }))).sort((a, b) => a.c.at - b.c.at);
  const plan = [];
  let calls = 0;
  for (const q of queue) {
    const cost = q.L.f.replies.length ? 2 : 1;
    if (plan.length >= maxSends || calls + cost > api.callsLeft()) { sum.capped = true; break; }
    plan.push(q);
    calls += cost;
  }
  const backfill = [];
  for (const L of read) for (const c of L.backfill) {
    if (calls + 1 > api.callsLeft()) { sum.capped = true; break; }
    backfill.push({ L, c });
    calls += 1;
  }
  if (!plan.length && !backfill.length) return finish();

  const base = (L, c) => ({ post: L.f.post, funnel: L.f.name, commentId: c.id, username: c.username });
  const add = (r) => ledger.append({ at: iso(now()), ...r });
  const openReplies = new Set();   // batch mode: reply records written as pending that still need an outcome
  if (batchPending) {
    for (const { L, c } of plan) {
      add({ ...base(L, c), outcome: 'pending' });
      if (L.f.replies.length) { add({ kind: 'reply', ...base(L, c), outcome: 'pending' }); openReplies.add(c.id); }
    }
    for (const { L, c } of backfill) { add({ kind: 'reply', ...base(L, c), outcome: 'pending' }); openReplies.add(c.id); }
    await ledger.checkpoint();
  }
  const settleReply = (L, c, outcome, extra = {}) => { add({ kind: 'reply', ...base(L, c), outcome, ...extra }); openReplies.delete(c.id); };

  // 5. Send. The first DM this account ever sends failing stops the funnel (it usually means a missing
  // permission or an unpublished app: report and stop), and so do HALT_AFTER failures in a row. Any other
  // failure belongs to that commenter. A refused token or a spent budget is nobody's fault: `unsent`, tried again.
  let proven = recs.some((r) => !r.kind && r.outcome === 'sent');
  const streak = new Map();
  const haltedNow = new Set();
  let stop = null;
  const sentNow = [];
  for (const { L, c } of plan) {
    const rec = base(L, c);
    if (stop || haltedNow.has(L.f.post)) {
      // batch mode wrote a pending record for it: close it so the comment is tried again later
      if (batchPending) add({ ...rec, outcome: 'unsent', error: stop ?? 'funnel halted in this run' });
      if (openReplies.has(c.id)) settleReply(L, c, 'skipped');
      continue;
    }
    if (!batchPending) add({ ...rec, outcome: 'pending' });
    try {
      const r = await api.sendPrivateReply(c.id, L.f.message);
      add({ ...rec, outcome: 'sent', messageId: r?.message_id ?? null });
      proven = true;
      streak.set(L.f.post, 0);
      L.row.sent++; sum.sent++;
      sentNow.push({ L, c });
      log(`  ${L.f.name}: DM sent to @${c.username} (comment ${c.id})`);
    } catch (e) {
      const msg = short(e);
      if (e instanceof BudgetSpent || isAuthError(e)) {
        add({ ...rec, outcome: 'unsent', error: msg });
        if (openReplies.has(c.id)) settleReply(L, c, 'skipped');
        stop = msg;
        if (isAuthError(e)) sum.errors.push(`Instagram refused the token while sending: ${msg}; generate a new one and run npm run auth (Worker: then npm run worker:seed)`);
        continue;
      }
      const n = (streak.get(L.f.post) ?? 0) + 1;
      streak.set(L.f.post, n);
      const halt = !proven ? `the first DM this account ever sent failed: ${msg}` : n >= HALT_AFTER ? `${n} DMs in a row failed, last: ${msg}` : null;
      add({ ...rec, outcome: halt ? 'halted' : 'error', error: halt ?? msg });
      if (openReplies.has(c.id)) settleReply(L, c, 'skipped');
      if (halt) {
        haltedNow.add(L.f.post);
        L.row.state = 'halted'; L.row.why = halt;
        sum.halted++;
        log(`  ${L.f.name}: HALTED: ${halt}`);
      } else {
        L.row.failed++; sum.failed++;
        log(`  ${L.f.name}: DM to @${c.username} failed: ${msg}`);
      }
    }
    await sleep(gapMs);
  }

  // 6. Public replies, once per comment, variants in turn. A failed reply is recorded and stops that funnel's
  // replies for this run; it is never retried (a second "check your DMs" under one comment reads as spam).
  const next = new Map(read.map((L) => [L.f.post, repliedCount(recs, L.f.post)]));
  const stopped = new Set();
  for (const { L, c } of [...backfill, ...sentNow]) {
    if (!L.f.replies.length) continue;
    if (stop || stopped.has(L.f.post) || haltedNow.has(L.f.post)) { if (openReplies.has(c.id)) settleReply(L, c, 'skipped'); continue; }
    const n = next.get(L.f.post);
    const message = L.f.replies[n % L.f.replies.length];
    if (!batchPending) add({ kind: 'reply', ...base(L, c), outcome: 'pending' });
    try {
      const r = await api.publicReply(c.id, message);
      settleReply(L, c, 'replied', { replyId: r?.id ?? null, message });
      next.set(L.f.post, n + 1);
      L.row.replied++; sum.replied++;
      log(`  ${L.f.name}: replied under @${c.username}'s comment: "${message}"`);
    } catch (e) {
      const spent = e instanceof BudgetSpent || isAuthError(e);   // not the comment's fault: posted on a later run
      settleReply(L, c, spent ? 'skipped' : 'reply-error', { error: short(e) });
      if (isAuthError(e)) sum.errors.push(`Instagram refused the token while replying: ${short(e)}; generate a new one and run npm run auth (Worker: then npm run worker:seed)`);
      if (spent) stop = short(e);
      else { stopped.add(L.f.post); log(`  ${L.f.name}: public reply failed (comment ${c.id}): ${short(e)}; no more replies on this post this run`); }
    }
    await sleep(gapMs);
  }
  // batch mode: anything still pending was never attempted
  for (const { L, c } of [...plan, ...backfill]) if (openReplies.has(c.id)) settleReply(L, c, 'skipped');
  return finish();

  function finish() {
    sum.unknown = unknownSends(ledger.records()).length;
    return sum;
  }
}

// What a run did, as lines for a terminal or the Worker log. Usernames and comment text are your own commenters'.
export function summaryLines(sum) {
  const out = [];
  for (const f of sum.funnels) {
    if (f.state !== 'live') { out.push(`  ${f.name}: ${f.state}${f.why ? ` (${f.why})` : ''}`); continue; }
    if (f.comments == null) { out.push(`  ${f.name}: ${f.why ?? 'not read'}`); continue; }
    out.push(`  ${f.name}: ${f.comments} comment(s), ${f.matched} to answer${sum.dryRun ? '' : `, ${f.sent} sent, ${f.failed} failed, ${f.replied} replied`}`);
  }
  for (const c of sum.wouldSend) out.push(`    would DM @${c.username} (comment ${c.commentId}, ${c.timestamp}): "${c.text}"`);
  for (const c of sum.wouldReply) out.push(`    would reply under @${c.username}'s comment ${c.commentId}`);
  if (sum.capped) out.push('  more to answer than this run allows; the rest goes next run');
  if (sum.unknown) out.push(`  ${sum.unknown} DM(s) with an unknown outcome (a run stopped mid-send): see status`);
  for (const e of sum.errors) out.push(`  error: ${e}`);
  return out;
}
