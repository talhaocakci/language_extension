import type { MessageRequest, MessageResponse } from '../types/common';
import type { SubtitleChunk, MeaningfulSentence } from '../types/subtitle';
import { groupAndProcessSubtitles } from '../utils/subtitle-processor';

console.log('Service Worker starting...');

// ── Backend & auth configuration ─────────────────────────────────────────────
const API_BASE_URL      = 'https://6b9x4wcwjh.execute-api.eu-central-1.amazonaws.com/prod';
const ANALYZE_URL = `${API_BASE_URL}/analyze`;
const EXPLAIN_URL = `${API_BASE_URL}/explain`;
const EXPLAIN_PROMPT_ID = 'language_backend:tier3:explain_sentence';
// language_backend tier1 public endpoint (non-API-Gateway)
const LANGUAGE_TIER1_BASE_URL = 'https://api.getfluentfast.app';
const COGNITO_DOMAIN    = 'https://auth.getfluentfast.app';
const COGNITO_CLIENT_ID = '73qd5gena9hggpc4ms7b2ip7ea'; // language_backend web SPA client

// ── PKCE helpers ─────────────────────────────────────────────────────────────

function base64url(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generateCodeVerifier(): Promise<string> {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return base64url(arr.buffer);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  return base64url(await crypto.subtle.digest('SHA-256', data));
}

// ── Cognito token storage keys ────────────────────────────────────────────────
const STORAGE_ID_TOKEN      = 'cognito_id_token';
const STORAGE_REFRESH_TOKEN = 'cognito_refresh_token';
const STORAGE_EXPIRY        = 'cognito_token_expiry';  // ms epoch

// ── Auth helpers ──────────────────────────────────────────────────────────────

async function getStoredTokens(): Promise<{ idToken: string; refreshToken: string; expiry: number } | null> {
  const s = await chrome.storage.sync.get([STORAGE_ID_TOKEN, STORAGE_REFRESH_TOKEN, STORAGE_EXPIRY]);
  if (!s[STORAGE_ID_TOKEN]) return null;
  return { idToken: s[STORAGE_ID_TOKEN], refreshToken: s[STORAGE_REFRESH_TOKEN], expiry: s[STORAGE_EXPIRY] };
}

async function storeTokens(idToken: string, refreshToken: string, expiresIn: number): Promise<void> {
  await chrome.storage.sync.set({
    [STORAGE_ID_TOKEN]:      idToken,
    [STORAGE_REFRESH_TOKEN]: refreshToken,
    [STORAGE_EXPIRY]:        Date.now() + expiresIn * 1000,
    // Keep api_token in sync so SAVE_IDIOM always has a fresh token
    api_token: idToken,
  });
}

async function clearStoredTokens(): Promise<void> {
  await chrome.storage.sync.remove([STORAGE_ID_TOKEN, STORAGE_REFRESH_TOKEN, STORAGE_EXPIRY, 'api_token']);
}

async function refreshIdToken(refreshToken: string): Promise<string | null> {
  try {
    const resp = await fetch(`${COGNITO_DOMAIN}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     COGNITO_CLIENT_ID,
        refresh_token: refreshToken,
      }).toString(),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    await storeTokens(data.id_token, refreshToken, data.expires_in ?? 3600);
    return data.id_token as string;
  } catch {
    return null;
  }
}

/** Returns a valid (non-expired) ID token, refreshing automatically if needed. */
async function getValidIdToken(): Promise<string | null> {
  const stored = await getStoredTokens();
  if (!stored) return null;

  // Refresh 60 s before expiry
  if (Date.now() < stored.expiry - 60_000) return stored.idToken;
  return refreshIdToken(stored.refreshToken);
}

/** Full PKCE login via Cognito Hosted UI → chrome.identity.launchWebAuthFlow */
async function cognitoLogin(): Promise<{ email: string }> {
  const verifier   = await generateCodeVerifier();
  const challenge  = await generateCodeChallenge(verifier);
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;

  const authUrl = `${COGNITO_DOMAIN}/login?${new URLSearchParams({
    response_type:         'code',
    client_id:             COGNITO_CLIENT_ID,
    redirect_uri:          redirectUri,
    scope:                 'openid email profile',
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  })}`;

  const resultUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive: true,
  });

  if (!resultUrl) throw new Error('Login cancelled or popup blocked');
  const code = new URL(resultUrl).searchParams.get('code');
  if (!code) throw new Error('No auth code in callback URL');

  const tokenResp = await fetch(`${COGNITO_DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     COGNITO_CLIENT_ID,
      redirect_uri:  redirectUri,
      code,
      code_verifier: verifier,
    }).toString(),
  });

  if (!tokenResp.ok) throw new Error(`Token exchange failed: ${tokenResp.status}`);
  const tokens = await tokenResp.json();

  await storeTokens(tokens.id_token, tokens.refresh_token, tokens.expires_in ?? 3600);

  // Decode email from ID token payload (no library needed)
  const payload = JSON.parse(atob(tokens.id_token.split('.')[1]));
  return { email: payload.email ?? payload['cognito:username'] ?? '' };
}

// YouTube timedtext URL capture (must exist before tab listeners reference it)
const capturedTimedtextUrls = new Map<number, string>(); // tabId → url

function normalizeApiError(status: number, raw: string): string {
  let message = raw;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.error === 'string' && parsed.error.trim()) message = parsed.error;
    else if (typeof parsed.message === 'string' && parsed.message.trim()) message = parsed.message;
  } catch {}

  const msg = message.trim();
  if (status === 403 && /ADMIN group membership required/i.test(msg)) {
    return 'Only ADMIN users can run Explain on the backend.';
  }
  if (/invalid_api_key|Incorrect API key provided|OpenAI 401/i.test(msg)) {
    return 'Backend LLM key is invalid. Update OPENAI credentials on language_backend tier3.';
  }
  if (status === 401) {
    return 'Your session expired. Please sign in again from the extension popup.';
  }
  return msg.length > 220 ? `${msg.slice(0, 220)}…` : msg;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  capturedTimedtextUrls.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url === undefined) return;
  capturedTimedtextUrls.delete(tabId);
});

// ── Intercept YouTube's own timedtext request (has pot= token baked in) ─────
// YouTube's player fetches the timedtext URL automatically on page load.
// We capture the full URL (including pot + signature) so we can re-fetch it.

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId >= 0) {
      console.log(`[webRequest] Captured timedtext URL for tab ${details.tabId}`);
      capturedTimedtextUrls.set(details.tabId, details.url);
    }
  },
  { urls: ['*://*.youtube.com/api/timedtext*'] }
);

chrome.runtime.onMessage.addListener((message: MessageRequest, sender, sendResponse) => {
  console.log('Message received:', message.type);

  try {
    if (message.type === 'GET_PREFERENCES') {
      // LLM settings are now backend-managed; nothing to return from storage
      sendResponse({ success: true, data: {} });
      return;
    }

    if (message.type === 'SET_PREFERENCES') {
      // LLM settings no longer stored client-side
      sendResponse({ success: true });
      return;
    }

    if (message.type === 'GET_ID_TOKEN') {
      (async () => {
        try {
          const token = await getValidIdToken();
          if (!token) {
            sendResponse({ success: false, error: 'Not logged in' });
          } else {
            sendResponse({ success: true, data: { token } });
          }
        } catch {
          sendResponse({ success: false, error: 'Failed to get token' });
        }
      })();
      return true;
    }

    if (message.type === 'GET_SUBTITLES') {
      // Subtitle data comes from content script
      sendResponse({
        success: true,
        data: {
          subtitles: message.payload?.subtitles || []
        }
      });
      return;
    }

    if (message.type === 'PROCESS_SUBTITLES') {
      try {
        const chunks: SubtitleChunk[] = message.payload?.chunks || [];
        console.log(`Processing ${chunks.length} subtitle chunks into meaningful sentences`);
        
        // Group subtitles into meaningful sentences
        const meaningfulSentences = groupAndProcessSubtitles(chunks);
        console.log(`Grouped into ${meaningfulSentences.length} meaningful sentences`);
        
        sendResponse({
          success: true,
          data: meaningfulSentences
        });
      } catch (error) {
        console.error('Error processing subtitles:', error);
        sendResponse({
          success: false,
          error: String(error),
          data: []
        });
      }
      return;
    }

    if (message.type === 'GET_TRANSCRIPT') {
      // Return the timedtext URL captured via webRequest for this tab.
      // If not yet captured, poll for up to 10 seconds (YouTube loads it early).
      const tabId: number = sender.tab?.id ?? -1;

      (async () => {
        // Poll up to 10 s for YouTube's player to make its own timedtext request
        let url = capturedTimedtextUrls.get(tabId);
        for (let i = 0; i < 40 && !url; i++) {
          await new Promise(r => setTimeout(r, 250));
          url = capturedTimedtextUrls.get(tabId);
        }

        if (!url) {
          console.log(`GET_TRANSCRIPT: no timedtext URL captured for tab ${tabId}`);
          sendResponse({ success: false, error: 'timedtext URL not yet captured' });
          return;
        }

        console.log(`GET_TRANSCRIPT: fetching captured URL for tab ${tabId}`);
        try {
          const resp = await fetch(url, { credentials: 'omit' });
          const text = await resp.text();
          console.log(`GET_TRANSCRIPT: status=${resp.status} length=${text.length}`);
          if (text.length > 100) {
            sendResponse({ success: true, data: text });
          } else {
            sendResponse({ success: false, error: `empty response (${text.length} bytes)` });
          }
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      })();

      return true; // async response
    }

    if (message.type === 'FETCH_CAPTIONS_URL') {
      const url: string = message.payload?.url || '';
      if (!url) { sendResponse({ success: false, error: 'No URL provided' }); return; }
      fetch(url, { credentials: 'include' })
        .then(r => r.text())
        .then(text => sendResponse({ success: true, data: { text } }))
        .catch(err => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    if (message.type === 'FETCH_TIMEDTEXT') {
      // The background service worker has host_permissions for youtube.com, so
      // Chrome lifts CORS restrictions and the request is made with the extension's
      // origin. The timedtext URL already contains pot + signature auth tokens, so
      // cookies are not required. We try omit first, then include as fallback.
      const url: string = message.payload?.url || '';
      if (!url) { sendResponse({ success: false, error: 'No URL provided' }); return; }

      (async () => {
        const attempts: Array<{ label: string; opts: RequestInit }> = [
          { label: 'omit',    opts: { credentials: 'omit' } },
          { label: 'include', opts: { credentials: 'include' } },
          { label: 'same-origin', opts: { credentials: 'same-origin' } },
        ];

        for (const { label, opts } of attempts) {
          try {
            const resp = await fetch(url, opts);
            const text = await resp.text();
            console.log(`FETCH_TIMEDTEXT [${label}]: status=${resp.status} length=${text.length}`);
            if (text.length > 100) {
              sendResponse({ success: true, data: text });
              return;
            }
          } catch (err) {
            console.log(`FETCH_TIMEDTEXT [${label}] error:`, err);
          }
        }

        sendResponse({ success: false, error: 'All fetch attempts returned empty body' });
      })();

      return true; // async response
    }

    if (message.type === 'ANALYZE_PHRASE') {
      // Return empty analysis for now
      sendResponse({
        success: true,
        data: {
          sentence: message.payload?.sentence || '',
          grammaticalStructure: 'Analysis not available',
          phrases: [],
          difficulty: 'beginner'
        }
      });
      return;
    }

    if (message.type === 'OVERLAY_CALL_LLM') {
      (async () => {
        try {
          const token = await getValidIdToken();
          if (!token) {
            sendResponse({ success: false, error: 'Not logged in. Please sign in from the extension popup.' });
            return;
          }

          const messages = Array.isArray(message.payload?.messages)
            ? message.payload.messages
            : null;
          const model =
            typeof message.payload?.model === 'string' && message.payload.model.trim()
              ? message.payload.model.trim()
              : 'gpt-4o-mini';

          if (!messages || messages.length === 0) {
            sendResponse({ success: false, error: 'Invalid LLM messages payload.' });
            return;
          }

          const resp = await fetch(ANALYZE_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              model,
              temperature: 0,
              response_format: { type: 'json_object' },
              messages,
            }),
          });

          if (!resp.ok) {
            const err = normalizeApiError(resp.status, await resp.text());
            sendResponse({ success: false, error: err });
            return;
          }

          const json = await resp.json();
          const content = (json?.choices?.[0]?.message?.content as string) || '{}';
          sendResponse({ success: true, data: { content } });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      })();
      return true;
    }

    if (message.type === 'OVERLAY_EXPLAIN_SENTENCE') {
      (async () => {
        try {
          const token = await getValidIdToken();
          if (!token) {
            sendResponse({ success: false, error: 'Not logged in. Please sign in from the extension popup.' });
            return;
          }

          const sentence =
            typeof message.payload?.sentence === 'string' ? message.payload.sentence.trim() : '';
          if (!sentence) {
            sendResponse({ success: false, error: 'Sentence is required.' });
            return;
          }

          const resp = await fetch(EXPLAIN_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              sentence,
              prompt_id: EXPLAIN_PROMPT_ID,
            }),
          });

          if (!resp.ok) {
            const err = normalizeApiError(resp.status, await resp.text());
            sendResponse({ success: false, error: err });
            return;
          }

          const json = await resp.json();
          sendResponse({ success: true, data: { analysis: json?.analysis || json || {} } });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      })();
      return true;
    }

    if (message.type === 'COGNITO_LOGIN') {
      (async () => {
        try {
          const result = await cognitoLogin();
          sendResponse({ success: true, data: result });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      })();
      return true;
    }

    if (message.type === 'COGNITO_LOGOUT') {
      (async () => {
        await clearStoredTokens();
        sendResponse({ success: true });
      })();
      return true;
    }

    if (message.type === 'GET_AUTH_STATE') {
      (async () => {
        try {
          const token = await getValidIdToken();
          if (!token) {
            sendResponse({ success: true, data: { loggedIn: false } });
            return;
          }
          const payload = JSON.parse(atob(token.split('.')[1]));
          sendResponse({
            success: true,
            data: {
              loggedIn: true,
              email: payload.email ?? payload['cognito:username'] ?? '',
              tokenExpiry: payload.exp * 1000,
            },
          });
        } catch {
          sendResponse({ success: true, data: { loggedIn: false } });
        }
      })();
      return true;
    }

    if (message.type === 'OPEN_EXTENSION_POPUP') {
      (async () => {
        try {
          const popupApi = chrome.action && typeof chrome.action.openPopup === 'function'
            ? chrome.action.openPopup.bind(chrome.action)
            : null;

          if (popupApi) {
            try {
              await popupApi();
              sendResponse({ success: true, data: { opened: 'popup' } });
              return;
            } catch (openPopupError) {
              console.warn('openPopup failed, falling back to popup tab:', openPopupError);
            }
          }

          const popupUrl = chrome.runtime.getURL('popup/index.html');
          await chrome.tabs.create({ url: popupUrl, active: true });
          sendResponse({ success: true, data: { opened: 'tab' } });
        } catch (err) {
          sendResponse({ success: false, error: `Failed to open sign-in UI: ${String(err)}` });
        }
      })();
      return true;
    }

    if (message.type === 'SAVE_IDIOM') {
      (async () => {
        try {
          // Prefer a fresh Cognito token; fall back to manually stored api_token
          const token = (await getValidIdToken()) ??
            ((await chrome.storage.sync.get('api_token')).api_token as string | undefined) ??
            '';

          if (!token) {
            sendResponse({
              success: false,
              error: 'Not logged in. Please sign in via the extension popup.',
              data: { code: 'AUTH_REQUIRED' }
            });
            return;
          }

          const payload = message.payload || {};
          const targetLanguage = String(
            payload.target_language || payload.targetLanguage || payload.language || 'de'
          ).trim().toLowerCase();
          const kindRaw = String(payload.kind || '').trim().toLowerCase();

          let itemKind: 'phrase' | 'sentence' | 'word' = 'phrase';
          if (kindRaw.includes('sentence')) itemKind = 'sentence';
          else if (kindRaw.includes('word')) itemKind = 'word';

          const word = String(payload.canonical_form || payload.found_in_text || '').trim();
          const definition = String(payload.meaning || '').trim();
          const example = String(payload.example || payload.source_sentence || '').trim();
          const sourceSentence = String(payload.source_sentence || payload.example || '').trim();

          // language_backend SaveLearnItemRequest
          const learnItemBody = {
            word,
            definition,
            example,
            source_sentence: sourceSentence,
            target_language: targetLanguage,
            item_kind: itemKind,
            folder: 'fromweb',
            source_lesson_id: String(payload.video_title || 'HBO Max').trim(),
            source_content_key: String(payload.source_url || '').trim(),
            highlight_snippet: String(payload.found_in_text || payload.source_sentence || '').trim(),
          };
          const url = `${LANGUAGE_TIER1_BASE_URL}/learn-items`;

          const resp = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify(learnItemBody),
          });

          if (!resp.ok) {
            const err = await resp.text();
            sendResponse({ success: false, error: `API ${resp.status}: ${err}` });
            return;
          }

          const data = await resp.json();
          sendResponse({ success: true, data: { ...data, saved_via: 'language_backend/tier1/learn-items' } });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      })();
      return true; // async
    }

    // Unknown message
    sendResponse({
      success: false,
      error: 'Unknown message type: ' + message.type
    });

  } catch (error) {
    console.error('Error handling message:', error);
    try {
      sendResponse({
        success: false,
        error: String(error)
      });
    } catch (e) {
      console.error('Failed to send error response:', e);
    }
  }

  return true;
});

console.log('Service Worker loaded successfully');
