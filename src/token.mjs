// The access token's life. Two kinds (see src/meta.mjs):
// Unified login: a Business Integration System User token. By Meta's default it never expires (expiresAt null) and
// it has no refresh call, so nothing here touches it. A dead one fails with code 190 like any other: generate again.
// Instagram login: the dashboard's "Generate token" gives a long-lived token (60 days). Meta's
// refresh_access_token turns any valid long-lived token that is at least 24 hours old into a fresh 60-day one,
// with no app secret. So every run that sees fewer than REFRESH_DAYS left renews it, and nobody refreshes by hand.
// Token shape (stored locally in .state/token.json, in the Worker under the KV key `token`, never printed):
//   { access_token, login, userId, username, expiresAt, estimated, obtainedAt, refreshedAt }
// `login` is "unified" or absent (Instagram login, and every token stored before Unified login was supported).
// `estimated` = Meta did not tell us the expiry yet (a fresh token refuses refresh for its first 24 h), so we
// assume 60 days and refresh as soon as Meta allows, which replaces the guess with the real date.
import { MetaError } from './meta.mjs';

export const REFRESH_DAYS = 10;
export const TOKEN_DAYS = 60;
const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export const daysLeft = (tok, now) => (tok.expiresAt == null ? Infinity : Math.floor((Date.parse(tok.expiresAt) - now) / DAY));
export const isExpired = (tok, now) => tok.expiresAt != null && Date.parse(tok.expiresAt) <= now;
// For status lines: "about 59 days left" or "does not expire".
export const tokenLife = (tok, now) => (tok.expiresAt == null ? 'does not expire (Unified login)' : `${tok.estimated ? 'about ' : ''}${daysLeft(tok, now)} days left`);

export function needsRefresh(tok, now) {
  if (tok.expiresAt == null) return false;
  if (Date.parse(tok.expiresAt) - now < REFRESH_DAYS * DAY) return true;
  return !!tok.estimated && now - Date.parse(tok.refreshedAt ?? tok.obtainedAt) >= DAY;
}

// A pasted (or seeded) token: find out which setup it is from and whose it is, then (Instagram login) learn its real
// expiry with one refresh. graph.instagram.com refuses a Unified-login token, so a refusal there tries graph.facebook.com.
// `apiFor(token, opts)` returns makeApi({ token, ...opts }).
export async function adopt(raw, { account, apiFor, now, refresh = true }) {
  const token = String(raw ?? '').trim();
  if (!token) throw new Error('empty token');
  let me;
  let login = 'instagram';
  try {
    me = await apiFor(token).me();
  } catch (e) {
    if (!(e instanceof MetaError)) throw e;
    let accounts;
    try { accounts = await apiFor(token, { login: 'unified' }).accounts(); } catch (e2) {
      if (!(e2 instanceof MetaError)) throw e2;
      throw new Error(`Meta refused this token. As an Instagram-login token: ${e.message}. As a Unified-login token: ${e2.message}`);
    }
    me = pickAccount(accounts, account);
    login = 'unified';
  }
  if (account && me.username !== account) throw new Error(`this token belongs to @${me.username}, but config.json says "account": "${account}"; generate the token while logged in as @${account}, or fix the config`);
  const base = { userId: me.userId, username: me.username, obtainedAt: iso(now), refreshedAt: null };
  if (login === 'unified') return { ...base, login, access_token: token, expiresAt: null, estimated: false };
  if (refresh) {
    try {
      const j = await apiFor(token).refresh();
      return { ...base, access_token: j.access_token, expiresAt: iso(now + Number(j.expires_in) * 1000), estimated: false, refreshedAt: iso(now) };
    } catch { /* /me already proved the token works; keep it and guess the expiry */ }
  }
  return { ...base, access_token: token, expiresAt: iso(now + TOKEN_DAYS * DAY), estimated: true };
}

// A Unified-login token can be assigned several Instagram accounts: take the one config.json names.
function pickAccount(accounts, account) {
  const names = accounts.map((a) => `@${a.username}`).join(', ');
  if (!accounts.length) throw new Error('this Unified-login token has no Instagram account assigned: add the account in the dashboard (API setup with Unified login), then generate the token again');
  if (account) {
    const hit = accounts.find((a) => a.username === account);
    if (!hit) throw new Error(`this token belongs to ${names}, but config.json says "account": "${account}"; add @${account} in the dashboard and generate the token again, or fix the config`);
    return hit;
  }
  if (accounts.length > 1) throw new Error(`this token can act for ${names}: write the one to use as "account" in config.json first (SETUP.md, part C), then run npm run auth again`);
  return accounts[0];
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
