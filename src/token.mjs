// The access token's life. The dashboard's "Generate token" gives a long-lived token (60 days). Meta's
// refresh_access_token turns any valid long-lived token that is at least 24 hours old into a fresh 60-day one,
// with no app secret. So every run that sees fewer than REFRESH_DAYS left renews it, and nobody refreshes by hand.
// Token shape (stored locally in .state/token.json, in the Worker under the KV key `token`, never printed):
//   { access_token, userId, username, expiresAt, estimated, obtainedAt, refreshedAt }
// `estimated` = Meta did not tell us the expiry yet (a fresh token refuses refresh for its first 24 h), so we
// assume 60 days and refresh as soon as Meta allows, which replaces the guess with the real date.
export const REFRESH_DAYS = 10;
export const TOKEN_DAYS = 60;
const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export const daysLeft = (tok, now) => Math.floor((Date.parse(tok.expiresAt) - now) / DAY);

export function needsRefresh(tok, now) {
  if (Date.parse(tok.expiresAt) - now < REFRESH_DAYS * DAY) return true;
  return !!tok.estimated && now - Date.parse(tok.refreshedAt ?? tok.obtainedAt) >= DAY;
}

// A pasted (or seeded) token: check whose it is, then learn its real expiry with one refresh.
export async function adopt(raw, { account, apiFor, now, refresh = true }) {
  const token = String(raw ?? '').trim();
  if (!token) throw new Error('empty token');
  const me = await apiFor(token).me();
  if (account && me.username !== account) throw new Error(`this token belongs to @${me.username}, but config.json says "account": "${account}"; generate the token while logged in as @${account}, or fix the config`);
  const base = { userId: me.userId, username: me.username, obtainedAt: iso(now), refreshedAt: null };
  if (refresh) {
    try {
      const j = await apiFor(token).refresh();
      return { ...base, access_token: j.access_token, expiresAt: iso(now + Number(j.expires_in) * 1000), estimated: false, refreshedAt: iso(now) };
    } catch { /* /me already proved the token works; keep it and guess the expiry */ }
  }
  return { ...base, access_token: token, expiresAt: iso(now + TOKEN_DAYS * DAY), estimated: true };
}

// → { tok, changed }. A refused refresh is fine while the token is still valid; an expired one stops the run.
export async function freshen(tok, { apiFor, now, log = () => {} }) {
  if (!needsRefresh(tok, now)) return { tok, changed: false };
  const left = Date.parse(tok.expiresAt) - now;
  try {
    const j = await apiFor(tok.access_token).refresh();
    return { tok: { ...tok, access_token: j.access_token, expiresAt: iso(now + Number(j.expires_in) * 1000), estimated: false, refreshedAt: iso(now) }, changed: true };
  } catch (e) {
    if (left <= 0) throw new Error(`the Instagram token expired ${tok.expiresAt} and refresh failed (${e.message}); generate a new one and run npm run auth (Worker: then npm run worker:seed)`);
    log(`token refresh refused (${e.message}); still valid about ${Math.floor(left / DAY)} d, trying again next run`);
    return { tok, changed: false };
  }
}
