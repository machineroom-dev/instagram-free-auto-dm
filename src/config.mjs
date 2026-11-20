// config.json: which posts answer which keywords, with what DM and what public reply, and until when.
// It is checked before every run; a file with any problem sends nothing.
import { ASK_WORDS, MAX_WORDS } from './match.mjs';

export const MESSAGE_MAX_BYTES = 1000;   // Instagram's DM text limit; an emoji counts 4
export const REPLY_MAX_CHARS = 300;      // a public reply is one short line
const WORD_RE = /^[A-Za-z0-9_-]+$/;
const TOP_KEYS = ['account', 'funnels', 'askWords', 'maxWords'];
const FUNNEL_KEYS = ['name', 'post', 'keywords', 'message', 'replies', 'until'];

const byteLength = (s) => new TextEncoder().encode(s).length;
const words = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((x) => String(x).trim()).filter(Boolean);
const endOfUtcDay = (d) => Date.parse(`${d}T23:59:59Z`);

export function validateConfig(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { config: null, problems: ['config must be a JSON object'] };
  for (const k of Object.keys(raw)) if (!TOP_KEYS.includes(k)) problems.push(`unknown key "${k}" (known: ${TOP_KEYS.join(', ')})`);

  const account = String(raw.account ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!account) problems.push('"account" is missing: your Instagram username, without the @');
  else if (!/^[a-z0-9._]{1,30}$/.test(account)) problems.push(`"account" "${raw.account}" is not an Instagram username`);

  const askWords = raw.askWords == null ? ASK_WORDS : words(raw.askWords).map((w) => w.toLowerCase());
  for (const w of askWords) if (!WORD_RE.test(w)) problems.push(`askWords: "${w}" must be one word (letters, digits, - or _)`);
  const maxWords = raw.maxWords == null ? MAX_WORDS : raw.maxWords;
  if (!Number.isInteger(maxWords) || maxWords < 1 || maxWords > 50) problems.push('"maxWords" must be a whole number from 1 to 50');

  if (!Array.isArray(raw.funnels) || !raw.funnels.length) problems.push('"funnels" must be a list with at least one funnel');
  const funnels = [];
  const posts = new Map();
  const names = new Set();
  (Array.isArray(raw.funnels) ? raw.funnels : []).forEach((f, i) => {
    const at = `funnels[${i}]`;
    if (!f || typeof f !== 'object' || Array.isArray(f)) { problems.push(`${at} must be an object`); return; }
    for (const k of Object.keys(f)) if (!FUNNEL_KEYS.includes(k)) problems.push(`${at}: unknown key "${k}" (known: ${FUNNEL_KEYS.join(', ')})`);

    const post = String(f.post ?? '').trim();
    if (!post) problems.push(`${at}: "post" is missing`);
    else if (!/^\d+$/.test(post)) problems.push(`${at}: "post" must be the post's numeric media ID, not a link (npm run posts lists yours)`);
    else if (posts.has(post)) problems.push(`${at}: post ${post} is already in funnels[${posts.get(post)}] (one funnel per post: two would race for the one DM Instagram allows per comment)`);
    else posts.set(post, i);

    const name = String(f.name ?? '').trim() || `post-${post}`;
    if (names.has(name)) problems.push(`${at}: the name "${name}" is used twice`);
    names.add(name);

    const keywords = words(f.keywords);
    if (!keywords.length) problems.push(`${at}: "keywords" is missing`);
    for (const k of keywords) if (!WORD_RE.test(k)) problems.push(`${at}: keyword "${k}" must be one word (letters, digits, - or _)`);

    const message = typeof f.message === 'string' ? f.message.trim() : '';
    if (!message) problems.push(`${at}: "message" is empty`);
    else if (byteLength(message) > MESSAGE_MAX_BYTES) problems.push(`${at}: "message" is ${byteLength(message)} bytes (max ${MESSAGE_MAX_BYTES}, Instagram's DM limit; an emoji counts 4)`);

    let replies = [];
    if (f.replies != null) {
      if (typeof f.replies === 'string') replies = [f.replies.trim()];
      else if (Array.isArray(f.replies)) replies = f.replies.map((x) => (typeof x === 'string' ? x.trim() : ''));
      else { problems.push(`${at}: "replies" must be a list of short lines`); replies = []; }
      if (replies.some((x) => !x)) problems.push(`${at}: "replies" has an empty line`);
      for (const x of replies) if (x.length > REPLY_MAX_CHARS) problems.push(`${at}: a reply is ${x.length} characters (max ${REPLY_MAX_CHARS})`);
    }

    let untilMs = null;
    if (f.until != null) {
      if (typeof f.until !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(f.until) || Number.isNaN(endOfUtcDay(f.until))) problems.push(`${at}: "until" "${f.until}" must be a date, YYYY-MM-DD`);
      else untilMs = endOfUtcDay(f.until);
    }
    funnels.push({ name, post, keywords, message, replies, until: f.until ?? null, untilMs });
  });
  return problems.length ? { config: null, problems } : { config: { account, askWords, maxWords, funnels }, problems: [] };
}
