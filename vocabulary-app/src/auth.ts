/**
 * Cognito PKCE auth helpers.
 *
 * Required env vars (set in .env.local):
 *   VITE_COGNITO_DOMAIN       e.g. https://my-pool.auth.eu-west-1.amazoncognito.com
 *   VITE_COGNITO_CLIENT_ID    e.g. 4abc123...
 *   VITE_REDIRECT_URI         e.g. http://localhost:5173/callback  (or prod URL)
 */

const COGNITO_DOMAIN  = import.meta.env.VITE_COGNITO_DOMAIN  as string;
const CLIENT_ID       = import.meta.env.VITE_COGNITO_CLIENT_ID as string;
const REDIRECT_URI    = import.meta.env.VITE_REDIRECT_URI     as string;

const TOKEN_KEY        = 'vocab_id_token';
const ACCESS_TOKEN_KEY = 'vocab_access_token';
const REFRESH_KEY      = 'vocab_refresh_token';
const EXPIRY_KEY       = 'vocab_token_expiry';
const VERIFIER_KEY     = 'pkce_code_verifier';

// ── PKCE helpers ──────────────────────────────────────────────────────────────

function base64url(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function generateCodeVerifier(): Promise<string> {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64url(array.buffer);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64url(digest);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getIdToken(): string | null {
  const token   = localStorage.getItem(TOKEN_KEY);
  const expiry  = localStorage.getItem(EXPIRY_KEY);
  if (!token || !expiry) return null;
  if (Date.now() > Number(expiry)) { clearTokens(); return null; }
  return token;
}

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function clearTokens(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(EXPIRY_KEY);
}

export async function redirectToLogin(): Promise<void> {
  const verifier   = await generateCodeVerifier();
  const challenge  = await generateCodeChallenge(verifier);
  sessionStorage.setItem(VERIFIER_KEY, verifier);

  const params = new URLSearchParams({
    response_type:         'code',
    client_id:             CLIENT_ID,
    redirect_uri:          REDIRECT_URI,
    scope:                 'openid email profile',
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  });

  window.location.href = `${COGNITO_DOMAIN}/login?${params}`;
}

export async function handleCallback(): Promise<boolean> {
  const params   = new URLSearchParams(window.location.search);
  const code     = params.get('code');
  const verifier = sessionStorage.getItem(VERIFIER_KEY);

  if (!code || !verifier) return false;

  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    code,
    code_verifier: verifier,
  });

  const resp = await fetch(`${COGNITO_DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) return false;

  const data = await resp.json();
  const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  localStorage.setItem(TOKEN_KEY,        data.id_token     ?? '');
  localStorage.setItem(ACCESS_TOKEN_KEY, data.access_token ?? '');
  localStorage.setItem(REFRESH_KEY,      data.refresh_token ?? '');
  localStorage.setItem(EXPIRY_KEY,       String(expiresAt));
  sessionStorage.removeItem(VERIFIER_KEY);
  return true;
}
