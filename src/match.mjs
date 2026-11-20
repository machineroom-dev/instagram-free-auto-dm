// Which comments ask for the DM. Pure functions, shared by the local runner and the Worker.
//
// A comment matches a funnel when:
//   1. one of its keywords appears as a whole word, any case ("guide pls" yes, "guidelines" no),
//      and every letter O in a keyword also matches a zero ("0AUTH" for OAUTH);
//   2. the comment reads as a request: at most `maxWords` words (@mentions not counted), or longer
//      and carrying an ask word ("could you send me the guide"). Without this rule a keyword that is
//      also a topic word ("rebase" on a git post) DMs people who are just talking to each other.

export const MAX_WORDS = 6;
export const ASK_WORDS = ['note', 'notes', 'pdf', 'sheet', 'dm', 'send', 'share', 'link', 'please', 'pls', 'plz'];
// Meta allows the one private reply for 7 days after the comment; keep an hour of slack.
export const REPLY_WINDOW_MS = 7 * 864e5 - 3600e3;

const BEFORE = '(?<![\\p{L}\\p{N}_])';
const AFTER = '(?![\\p{L}\\p{N}_])';
const keywordPattern = (k) => k.replace(/[oO]/g, '[o0]');   // keywords are [A-Za-z0-9_-] only, nothing to escape

export function keywordMatches(text, keywords, { maxWords = MAX_WORDS, askWords = ASK_WORDS } = {}) {
  if (!text) return false;
  if (!keywords.some((k) => new RegExp(`${BEFORE}${keywordPattern(k)}${AFTER}`, 'iu').test(text))) return false;
  const words = text.replace(/@\S+/g, ' ').match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length <= maxWords) return true;
  return askWords.length > 0 && new RegExp(`${BEFORE}(?:${askWords.join('|')})${AFTER}`, 'iu').test(text);
}

// Meta writes timestamps as 2026-11-20T10:00:00+0000.
export const tsMs = (s) => Date.parse(String(s ?? '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));

// The comments edge lists every comment at the top level, replies included, and `replies{}` repeats each
// reply with only id/text/timestamp. Keep one entry per id: the named copy wins, the nested copy lends its parent.
export function flattenComments(data = []) {
  const one = (c, parentId) => ({
    id: String(c.id), text: c.text ?? '', at: tsMs(c.timestamp), timestamp: c.timestamp ?? null,
    username: c.username ?? c.from?.username ?? null, fromId: c.from?.id != null ? String(c.from.id) : null, parentId,
  });
  const byId = new Map();
  const add = (e) => {
    const cur = byId.get(e.id);
    if (!cur) { byId.set(e.id, e); return; }
    for (const k of ['username', 'fromId', 'parentId']) cur[k] ??= e[k];
  };
  for (const c of data) {
    add(one(c, null));
    for (const r of c.replies?.data ?? []) add(one(r, String(c.id)));
  }
  return [...byId.values()];
}

// Comments to answer now: they match, they are not ours, they are inside Meta's window, they have no record
// yet, and one per person per post (a person already sent this post's DM is skipped, so is a second comment).
export function candidates({ comments, keywords, match = {}, account, ownIds = [], blocked = new Set(), doneUsers = new Set(), now }) {
  const users = new Set([...doneUsers].map((u) => u.toLowerCase()));
  const out = [];
  for (const c of comments) {
    if (!c.username && !c.fromId) continue;   // nameless (a nested-only copy): could be ours, cannot be deduped per person
    const user = c.username ? c.username.toLowerCase() : null;
    if ((user && user === account) || (c.fromId && ownIds.includes(c.fromId))) continue;
    if (!keywordMatches(c.text, keywords, match)) continue;
    if (!Number.isFinite(c.at) || now - c.at >= REPLY_WINDOW_MS) continue;
    if (blocked.has(c.id)) continue;
    if (user && users.has(user)) continue;
    if (user) users.add(user);
    out.push(c);
  }
  return out;
}
