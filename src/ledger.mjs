// The dedupe ledger: one record per event, oldest first. It is what makes "never DM the same comment twice" true.
//
//   DM record      { at, post, funnel, commentId, username, outcome }   outcome: pending | sent | error | halted | unsent
//   reply record   { kind: 'reply', ... }                               outcome: pending | replied | reply-error | skipped
//   resume record  { kind: 'resume', at, post }                         written by `resume`, clears a halt
//
// `pending` is written before the POST and the outcome after it. A comment with any DM record is never sent
// again, except when its last outcome is `halted` or `unsent` (the send never reached the commenter: it is tried
// again on a later run). A `pending` with no outcome means the run died mid-send: the DM may or may not have gone,
// so it is never retried on its own (`status` lists it; `mark` settles it by hand).

const isDm = (r) => !r.kind;
export const RETRYABLE = new Set(['halted', 'unsent']);

export function lastDm(records) {
  const m = new Map();
  for (const r of records) if (isDm(r)) m.set(String(r.commentId), r);
  return m;
}
export function blockedCommentIds(records) {
  return new Set([...lastDm(records)].filter(([, r]) => !RETRYABLE.has(r.outcome)).map(([id]) => id));
}
// A public reply is posted once per comment: any reply record blocks another, except `skipped` (never attempted).
export function replyBlocked(records) {
  const m = new Map();
  for (const r of records) if (r.kind === 'reply') m.set(String(r.commentId), r.outcome);
  return new Set([...m].filter(([, o]) => o !== 'skipped').map(([id]) => id));
}
export function dmCounts(records, post) {
  let sent = 0, failed = 0;
  for (const r of lastDm(records.filter((x) => String(x.post) === String(post))).values()) {
    if (r.outcome === 'sent') sent++;
    else if (r.outcome === 'error') failed++;
  }
  return { sent, failed };
}
export function repliedCount(records, post) {
  return records.filter((r) => r.kind === 'reply' && String(r.post) === String(post) && r.outcome === 'replied').length;
}
export function doneUsers(records, post) {
  return new Set(records.filter((r) => isDm(r) && String(r.post) === String(post) && r.outcome === 'sent' && r.username).map((r) => r.username.toLowerCase()));
}
// A funnel is halted when its latest halt is newer than its latest resume.
export function haltOf(records, post) {
  let h = null;
  for (const r of records) {
    if (String(r.post) !== String(post)) continue;
    if (isDm(r) && r.outcome === 'halted') h = r;
    else if (r.kind === 'resume') h = null;
  }
  return h;
}
export function unknownSends(records) {
  return [...lastDm(records).values()].filter((r) => r.outcome === 'pending');
}
// The Worker keeps its ledger in one KV value: records of posts that left config.json go after `days`.
export function pruneRecords(records, keepPosts, now, days = 30) {
  const keep = new Set([...keepPosts].map(String));
  return records.filter((r) => keep.has(String(r.post)) || now - Date.parse(r.at) < days * 864e5);
}
// Merge two ledgers (moving from the local runner to the Worker): union, one copy of each identical record, by time.
export function mergeRecords(a, b) {
  const seen = new Set();
  const out = [];
  for (const r of [...a, ...b]) {
    const k = JSON.stringify(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
}
