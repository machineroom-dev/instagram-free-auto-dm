// Test doubles: a fake Instagram Graph API behind a mocked `fetch`, an in-memory ledger, and a fake Workers KV.
// Every user and ID here is made up.
// Both of Meta's setups (src/meta.mjs): graph.instagram.com for Instagram-login tokens, graph.facebook.com/v27.0 for
// Unified-login tokens (here: any token starting with UNI). Each host refuses the other kind with code 190, as Meta
// does. The graph.facebook.com side follows Meta's Unified-login docs, not a recorded response.
import { FB_API, IG_API } from '../src/meta.mjs';

const FB_ORIGIN = new URL(FB_API).origin;
const FB_PREFIX = new URL(FB_API).pathname.replace(/^\//, '') + '/';   // v27.0/

export const ME = { id: '17840000000000001', username: 'demo.account' };
export const NOW = Date.parse('2026-11-20T12:00:00Z');
export const ago = (h, from = NOW) => new Date(from - h * 3600e3).toISOString().replace(/\.\d{3}Z$/, '+0000');

// A raw comment as Meta returns it.
export const C = (id, text = 'GUIDE', { user = `user${id}.demo`, h = 1, from = NOW, replies } = {}) =>
  ({ id: String(id), text, timestamp: ago(h, from), username: user, from: { id: `9${id}`, username: user }, ...(replies ? { replies: { data: replies } } : {}) });

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const metaErr = (message, code = 10, status = 400) => json(status, { error: { message, type: 'OAuthException', code } });
const asError = (r) => (typeof r === 'object' ? metaErr(r.message ?? 'error', r.code ?? 10, r.status ?? 400) : metaErr(r));

// comments: { [postId]: raw comments, newest first }. sendResults / replyResults: 'ok' or an error (a message,
// or { message, code }), taken in turn; the last one repeats. refresh: 'ok' | 'refuse' | 'dead'.
// accounts: what graph.facebook.com/me/assigned_instagram_accounts lists for a Unified-login token.
export function fakeMeta({ comments = {}, posts = [], pageSize = 50, sendResults = ['ok'], replyResults = ['ok'], refresh = 'ok', me = ME, readError = null, accounts = [me] } = {}) {
  const calls = [];
  const sends = [];
  const replies = [];
  let si = 0, ri = 0;
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const host = u.origin === IG_API ? 'ig' : u.origin === FB_ORIGIN ? 'fb' : null;
    if (!host) throw new TypeError(`unexpected host ${u.origin}`);
    const method = init.method ?? 'GET';
    let p = u.pathname.replace(/^\//, '');
    if (host === 'fb') {
      if (!p.startsWith(FB_PREFIX)) return metaErr(`unversioned path ${p}`, 100);
      p = p.slice(FB_PREFIX.length);
    }
    const q = Object.fromEntries(u.searchParams);
    calls.push({ host, method, path: p, q });
    if (!q.access_token) return metaErr('no token', 190, 401);
    if (q.access_token.startsWith('DEAD')) return metaErr('Error validating access token: the session has been invalidated', 190);
    if ((host === 'fb') !== q.access_token.startsWith('UNI')) return metaErr('Invalid OAuth access token - Cannot parse access token', 190);
    // the account's own paths: `me` on graph.instagram.com, its ID on graph.facebook.com (where `me` is the system user)
    const self = host === 'ig' ? 'me' : me.id;
    if (host === 'fb' && p === 'me') return json(200, { id: '61500000000000001', name: 'Demo system user' });
    if (host === 'fb' && p === 'me/assigned_instagram_accounts') return json(200, { data: accounts.map((a) => ({ id: a.id, username: a.username })) });
    if (p === self) return json(200, host === 'ig' ? { user_id: me.id, username: me.username } : { id: me.id, username: me.username });
    if (host === 'ig' && p === 'refresh_access_token') {
      if (refresh === 'refuse') return metaErr('refresh refused', 10);
      if (refresh === 'dead') return metaErr('session invalidated', 190);
      return json(200, { access_token: `${q.access_token}-R`, token_type: 'bearer', expires_in: 5184000 });
    }
    if (p === `${self}/media`) return json(200, { data: posts });
    if (p === `${self}/messages` && method === 'POST') {
      const body = JSON.parse(init.body);
      const r = sendResults[Math.min(si++, sendResults.length - 1)];
      sends.push({ commentId: body.recipient.comment_id, text: body.message.text });
      return r === 'ok' ? json(200, { recipient_id: `r${body.recipient.comment_id}`, message_id: `m${body.recipient.comment_id}` }) : asError(r);
    }
    const reply = p.match(/^(\w+)\/replies$/);
    if (reply && method === 'POST') {
      const r = replyResults[Math.min(ri++, replyResults.length - 1)];
      replies.push({ commentId: reply[1], message: q.message });
      return r === 'ok' ? json(200, { id: `reply-${reply[1]}` }) : asError(r);
    }
    const list = p.match(/^(\d+)\/comments$/);
    if (list && method === 'GET') {
      if (readError) return asError(readError);
      const all = comments[list[1]] ?? [];
      const page = Number(q.after ?? 0);
      const data = all.slice(page * pageSize, (page + 1) * pageSize);
      const more = (page + 1) * pageSize < all.length;
      const base = host === 'ig' ? IG_API : FB_API;
      return json(200, { data, ...(more ? { paging: { next: `${base}/${list[1]}/comments?after=${page + 1}&access_token=${q.access_token}` } } : {}) });
    }
    return metaErr(`unknown path ${method} ${p}`, 100);
  }
  return { fetchImpl, calls, sends, replies };
}

export function memoryLedger(records = []) {
  const recs = [...records];
  let checkpoints = 0;
  return { records: () => recs, append(r) { recs.push(r); }, async checkpoint() { checkpoints++; }, get checkpoints() { return checkpoints; } };
}

// Workers KV, with the method shapes the Worker uses and a count of operations (they count as subrequests).
export function fakeKv(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  const ops = [];
  return {
    m, ops,
    async get(k, type) { ops.push(`get ${k}`); const v = m.get(k); if (v == null) return null; return type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { ops.push(`put ${k}`); m.set(k, v); },
    json(k) { const v = m.get(k); return v == null ? null : JSON.parse(v); },
    puts(k) { return ops.filter((o) => o === `put ${k}`).length; },
  };
}

export const funnel = (over = {}) => ({ name: 'guide', post: '17900000000000001', keywords: ['GUIDE'], message: 'Here it is: https://example.com/guide', replies: [], until: null, untilMs: null, ...over });
export const config = (funnels = [funnel()], over = {}) => ({ account: ME.username, askWords: undefined, maxWords: undefined, funnels, ...over });
