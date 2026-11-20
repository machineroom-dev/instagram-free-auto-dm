// The Instagram API, on either of Meta's two setups. Only `fetch` and `URL`, so the same client runs in Node and in
// a Cloudflare Worker. `budget.left` counts calls: the Worker gives each run a fixed number (Workers Free allows 50
// subrequests a run, KV calls included), the local runner gives Infinity.
//   Instagram login (apps from before late 2026, tab "API setup with Instagram login"): graph.instagram.com, the
//     account is `me`, a 60-day user token that renews itself.
//   Unified login (every new app, tab "API setup with Unified login", needs a business portfolio): graph.facebook.com,
//     a Business Integration System User token, `me` is that system user, so the account is addressed by its ID.
//     From Meta's docs only; not yet run against a real account.
export const IG_API = 'https://graph.instagram.com';
export const FB_API = 'https://graph.facebook.com/v27.0';
export const COMMENT_FIELDS = 'id,text,timestamp,username,from,replies{id,text,timestamp,username,from}';

// Paging links and errors carry the token in the query string: never print one unredacted.
export const redact = (s) => String(s).replace(/([?&])(access_token|client_secret)=[^&\s"]+/g, '$1$2=…');

export class MetaError extends Error {
  constructor(status, body, url) {
    const e = body?.error ?? {};
    const code = e.code != null ? ` [code ${e.code}${e.error_subcode != null ? `/${e.error_subcode}` : ''}]` : '';
    super(`${status} ${e.message || 'Instagram API error'}${code} for ${redact(url)}`);
    this.name = 'MetaError';
    this.status = status;
    this.code = e.code;
    this.subcode = e.error_subcode;
  }
}
export class BudgetSpent extends Error {
  constructor() { super('call budget for this run is spent; the rest waits for the next run'); this.name = 'BudgetSpent'; }
}
// Code 190 = the token is invalid or expired (a password change or a Meta security reset kills it at once).
export const isAuthError = (e) => e instanceof MetaError && (e.code === 190 || e.status === 401);

const withQuery = (base, path, params) => {
  const u = new URL(`${base}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  return u.toString();
};

// The makeApi options a stored token needs: none for Instagram login (also every token stored before Unified login
// existed), the login type and the account ID for Unified login.
export const apiOpts = (tok) => (tok?.login === 'unified' ? { login: 'unified', igId: tok.userId } : {});

export function makeApi({ token, login = 'instagram', igId = null, fetchImpl = (url, init) => fetch(url, init), budget = { left: Infinity } }) {
  if (!token) throw new Error('makeApi needs a token');
  const unified = login === 'unified';
  const base = unified ? FB_API : IG_API;
  // Unified login: `me` is the system user, not the Instagram account, so every account path uses its ID.
  // (Only `accounts()`, which finds that ID, works without it.)
  const self = () => {
    if (!unified) return 'me';
    if (!igId) throw new Error('Unified login needs the Instagram account ID (igId)');
    return igId;
  };
  async function call(url, init = {}) {
    if (budget.left <= 0) throw new BudgetSpent();
    budget.left -= 1;
    const res = await fetchImpl(url, init);
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j?.error) throw new MetaError(res.status, j, url);
    return j;
  }
  const get = (path, params = {}) => call(withQuery(base, path, { ...params, access_token: token }));
  const post = (path, params = {}) => call(withQuery(base, path, { ...params, access_token: token }), { method: 'POST' });
  return {
    login,
    callsLeft: () => budget.left,
    async me() {
      const j = await get(self(), { fields: unified ? 'id,username' : 'user_id,username' });
      return { userId: String(j.user_id ?? j.id), username: String(j.username ?? '').toLowerCase() };
    },
    // Unified login only: the Instagram accounts this system-user token may act for.
    async accounts() {
      const j = await get('me/assigned_instagram_accounts', { fields: 'id,username', limit: 100 });
      return (j.data ?? []).map((a) => ({ userId: String(a.id), username: String(a.username ?? '').toLowerCase() }));
    },
    // Instagram login only. A Unified-login token has no refresh call: by default it never expires.
    refresh: () => get('refresh_access_token', { grant_type: 'ig_refresh_token' }),
    async posts(limit = 25) {
      const j = await get(`${self()}/media`, { fields: 'id,caption,media_product_type,permalink,timestamp,comments_count', limit });
      return j.data ?? [];
    },
    commentsPage: (postId, limit = 50) => get(`${postId}/comments`, { fields: COMMENT_FIELDS, limit }),
    nextPage(url) {
      if (new URL(url).origin !== new URL(base).origin) throw new Error(`refusing a paging link outside ${new URL(base).origin}`);
      return call(url);
    },
    // The private reply: one DM to the person who wrote this comment. Meta allows one per comment, within 7 days.
    sendPrivateReply: (commentId, text) => call(withQuery(base, `${self()}/messages`, { access_token: token }), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text } }),
    }),
    publicReply: (commentId, message) => post(`${commentId}/replies`, { message }),
  };
}
