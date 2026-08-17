import type { MessageRequest, MessageResponse } from '../types/common';
import type { SubtitleChunk, MeaningfulSentence } from '../types/subtitle';
import { groupAndProcessSubtitles } from '../utils/subtitle-processor';
import {
  DEFAULT_EXPLANATION_LANGUAGE,
  EXPLANATION_LANGUAGE_STORAGE_KEY,
  getLanguageLabel,
  normalizeLanguagePreference,
} from '../utils/language-preferences';
import {
  handleNetflixAudioExperimentMessage,
  isNetflixAudioOffscreenMessage,
  stopNetflixAudioExperimentForTab,
} from '../experiments/netflix-audio/background-controller';
import { isNetflixOrMaxUrl } from '../experiments/netflix-audio/protocol';

console.log('Service Worker starting...');

// ── Backend & auth configuration ─────────────────────────────────────────────
const API_BASE_URL      = 'https://6b9x4wcwjh.execute-api.eu-central-1.amazonaws.com/prod';
const ANALYZE_URL = `${API_BASE_URL}/analyze`;
// language_backend tier1 public endpoint (non-API-Gateway)
const LANGUAGE_TIER1_BASE_URL = 'https://api.getfluentfast.app';
const COGNITO_DOMAIN    = 'https://auth.getfluentfast.app';
const COGNITO_CLIENT_ID = '15ea0bds6jmm1shhqvkcdckudh'; // dedicated browser extension client

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

async function getExplanationLanguage(): Promise<string> {
  const stored = await chrome.storage.sync.get(EXPLANATION_LANGUAGE_STORAGE_KEY);
  return normalizeLanguagePreference(
    stored[EXPLANATION_LANGUAGE_STORAGE_KEY],
    DEFAULT_EXPLANATION_LANGUAGE,
  );
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const encoded = token.split('.')[1];
    if (!encoded) return null;
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function getStoredTokens(): Promise<{ idToken: string; refreshToken: string; expiry: number } | null> {
  const s = await chrome.storage.sync.get([STORAGE_ID_TOKEN, STORAGE_REFRESH_TOKEN, STORAGE_EXPIRY]);
  if (!s[STORAGE_ID_TOKEN]) return null;
  const idToken = String(s[STORAGE_ID_TOKEN] || '');
  const refreshToken = String(s[STORAGE_REFRESH_TOKEN] || '');
  const storedExpiry = Number(s[STORAGE_EXPIRY]);
  const tokenExpirySeconds = Number(decodeJwtPayload(idToken)?.exp);
  const expiry = Number.isFinite(storedExpiry) && storedExpiry > 0
    ? storedExpiry
    : Number.isFinite(tokenExpirySeconds)
      ? tokenExpirySeconds * 1000
      : 0;
  return { idToken, refreshToken, expiry };
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
  if (!refreshToken.trim()) return null;
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
  return stored.refreshToken ? refreshIdToken(stored.refreshToken) : null;
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

function normalizeLearnItemError(status: number, raw: string): { message: string; code: string } {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {}

  const serverMessage = String(parsed.error || parsed.reason || parsed.message || '').trim();
  if (status === 401) {
    return { message: 'Your session expired. Please sign in again.', code: 'AUTH_REQUIRED' };
  }
  if (status === 402) {
    return {
      message: serverMessage || 'Your vocabulary limit has been reached for the current plan.',
      code: 'VOCABULARY_LIMIT_REACHED',
    };
  }
  if (status === 429) {
    return { message: 'Too many save requests. Please wait a moment and retry.', code: 'RATE_LIMITED' };
  }

  const fallback = raw.trim() || `Vocabulary service returned HTTP ${status}.`;
  return {
    message: (serverMessage || fallback).slice(0, 300),
    code: status >= 500 ? 'SERVICE_ERROR' : 'SAVE_REJECTED',
  };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  capturedTimedtextUrls.delete(tabId);
  void stopNetflixAudioExperimentForTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url === undefined) return;
  capturedTimedtextUrls.delete(tabId);
  if (!isNetflixOrMaxUrl(changeInfo.url)) {
    void stopNetflixAudioExperimentForTab(tabId);
  }
});

// ── Intercept YouTube's own timedtext request (has pot= token baked in) ─────
// YouTube's player fetches the timedtext URL automatically on page load.
// We capture the full URL (including pot + signature) so we can re-fetch it.

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId >= 0) {
      console.log(`[webRequest] Captured timedtext URL for tab ${details.tabId}`);
      capturedTimedtextUrls.set(details.tabId, details.url);
      try {
        const timedTextUrl = new URL(details.url);
        const languageCode =
          timedTextUrl.searchParams.get('tlang') ||
          timedTextUrl.searchParams.get('lang') ||
          '';
        if (languageCode) {
          void chrome.tabs.sendMessage(details.tabId, {
            type: 'PLAYER_LANGUAGE_CHANGED',
            payload: { languageCode },
          }).catch(() => undefined);
        }
      } catch {
        // Ignore malformed request URLs; the transcript fetch will retry normally.
      }
    }
  },
  { urls: ['*://*.youtube.com/api/timedtext*'] }
);

chrome.runtime.onMessage.addListener((message: MessageRequest, sender, sendResponse) => {
  console.log('Message received:', message.type);

  try {
    // NETFLIX_AUDIO_EXPERIMENT: offscreen-targeted messages are handled by the
    // isolated recorder document, not by the general service-worker router.
    if (isNetflixAudioOffscreenMessage(message)) return;
    if (handleNetflixAudioExperimentMessage(message, sender, sendResponse)) return true;

    if (message.type === 'GET_PREFERENCES') {
      // LLM settings are now backend-managed; nothing to return from storage
      sendResponse({ success: true, data: {} });
      return;
    }

    if (message.type === 'GET_LANGUAGE_PREFERENCES') {
      (async () => {
        sendResponse({
          success: true,
          data: { explanationLanguage: await getExplanationLanguage() },
        });
      })();
      return true;
    }

    if (message.type === 'SET_LANGUAGE_PREFERENCES') {
      (async () => {
        const explanationLanguage = normalizeLanguagePreference(
          message.payload?.explanationLanguage,
          DEFAULT_EXPLANATION_LANGUAGE,
        );
        await chrome.storage.sync.set({
          [EXPLANATION_LANGUAGE_STORAGE_KEY]: explanationLanguage,
        });
        sendResponse({ success: true, data: { explanationLanguage } });
      })();
      return true;
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
      const requestedVideoId = String(message.payload?.videoId || '').trim();

      (async () => {
        // Poll up to 10 s for YouTube's player to make its own timedtext request
        let url = capturedTimedtextUrls.get(tabId);
        const belongsToRequestedVideo = (candidate?: string): boolean => {
          if (!candidate) return false;
          if (!requestedVideoId) return true;
          try {
            return new URL(candidate).searchParams.get('v') === requestedVideoId;
          } catch {
            return false;
          }
        };
        for (let i = 0; i < 40 && !belongsToRequestedVideo(url); i++) {
          await new Promise(r => setTimeout(r, 250));
          url = capturedTimedtextUrls.get(tabId);
        }

        if (!url || !belongsToRequestedVideo(url)) {
          console.log(`GET_TRANSCRIPT: no timedtext URL captured for tab ${tabId}`);
          sendResponse({ success: false, error: 'timedtext URL not yet captured' });
          return;
        }

        console.log(`GET_TRANSCRIPT: fetching captured URL for tab ${tabId}`);
        try {
          const timedTextUrl = new URL(url);
          const languageCode =
            timedTextUrl.searchParams.get('tlang') ||
            timedTextUrl.searchParams.get('lang') ||
            '';
          const resp = await fetch(url, { credentials: 'omit' });
          const text = await resp.text();
          console.log(`GET_TRANSCRIPT: status=${resp.status} length=${text.length}`);
          if (text.length > 100) {
            sendResponse({ success: true, data: text, languageCode });
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
          const targetLanguage = normalizeLanguagePreference(
            message.payload?.targetLanguage || message.payload?.target_language,
          );
          const explanationLanguage = normalizeLanguagePreference(
            message.payload?.explanationLanguage || message.payload?.explanation_language,
            await getExplanationLanguage(),
          );

          const targetLanguageLabel = targetLanguage
            ? getLanguageLabel(targetLanguage)
            : 'the language detected from the sentence';
          const explanationLanguageLabel = getLanguageLabel(explanationLanguage);
          const systemPrompt = `You are a multilingual linguistics expert for language learners.
The sentence language is ${targetLanguageLabel}. Write every learner-facing meaning and note in ${explanationLanguageLabel}.
Keep foundInText, canonicalForm, baseForm, and examples in the sentence language. Never translate those fields into an unrelated language.
Return ONLY valid JSON with exactly these top-level keys: phrasalVerbs, fixedPhrases, note.
- phrasalVerbs: phrasal, particle, or separable verbs. Each item has foundInText, baseForm, meaning, prefix, stem, example. Use empty strings for prefix/stem when those concepts do not apply.
- fixedPhrases: idioms, collocations, connectors, verb-complement patterns, semi-modal constructions, and other memorable multi-word grammar. Each item has foundInText, kind, canonicalForm, meaning, and optional example.
- note: a concise learner-facing observation in ${explanationLanguageLabel}.

Coverage procedure (mandatory):
1. Scan the complete sentence from left to right and inspect every verb group and multi-word span. Do not stop after finding one obvious idiom.
2. Include productive grammar constructions learners need to reuse, especially auxiliary/modal/semi-modal + infinitive patterns, aspectual constructions, and verb + complement patterns.
3. Preserve overlapping items when they teach different things. A broad construction and a collocation inside it may both be useful.
4. Interpret negation and tense in context, while giving canonicalForm in a reusable dictionary-style form.

Example coverage: for “I didn't get to say goodbye,” fixedPhrases must include both:
- foundInText “didn't get to say”, canonicalForm “get to + verb”, kind “verb construction”, meaning the contextual idea of not having the opportunity/chance;
- foundInText “say goodbye”, canonicalForm “say goodbye”, kind “collocation”.

If nothing learner-worthy is found, return empty arrays. Do not invent translations or phrases from another language.`;

          const resp = await fetch(ANALYZE_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              model: 'gpt-4o-mini',
              temperature: 0,
              response_format: { type: 'json_object' },
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Analyze this sentence:\n${sentence}` },
              ],
            }),
          });

          if (!resp.ok) {
            const err = normalizeApiError(resp.status, await resp.text());
            sendResponse({ success: false, error: err });
            return;
          }

          const json = await resp.json();
          const content = (json?.choices?.[0]?.message?.content as string) || '{}';
          let analysis: Record<string, unknown> = {};
          try {
            analysis = JSON.parse(content) as Record<string, unknown>;
          } catch {
            analysis = { phrasalVerbs: [], fixedPhrases: [], note: content };
          }
          sendResponse({ success: true, data: { analysis } });
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
          const payload = decodeJwtPayload(token);
          if (!payload) {
            await clearStoredTokens();
            sendResponse({ success: true, data: { loggedIn: false } });
            return;
          }
          sendResponse({
            success: true,
            data: {
              loggedIn: true,
              email: payload.email ?? payload['cognito:username'] ?? '',
              name: payload.name ?? payload.given_name ?? '',
              tokenExpiry: Number(payload.exp || 0) * 1000,
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

    if (message.type === 'OPEN_EXTENSION_SETTINGS') {
      (async () => {
        try {
          const settingsUrl = chrome.runtime.getURL('popup/index.html?tab=settings');
          await chrome.tabs.create({ url: settingsUrl, active: true });
          sendResponse({ success: true, data: { opened: 'settings' } });
        } catch (err) {
          sendResponse({ success: false, error: `Failed to open extension settings: ${String(err)}` });
        }
      })();
      return true;
    }

    if (message.type === 'SAVE_IDIOM') {
      (async () => {
        try {
          let token = (await getValidIdToken()) || '';

          if (!token) {
            sendResponse({
              success: false,
              error: 'Not logged in. Please sign in via the extension popup.',
              data: { code: 'AUTH_REQUIRED' }
            });
            return;
          }

          const payload = message.payload || {};
          const requestedTargetLanguage = String(
            payload.target_language || payload.targetLanguage || payload.language || ''
          ).trim().toLowerCase().split('-', 1)[0];
          if (!requestedTargetLanguage) {
            sendResponse({
              success: false,
              error: 'The subtitle language could not be detected. Turn subtitles on and try again.',
              data: { code: 'TARGET_LANGUAGE_REQUIRED' },
            });
            return;
          }
          const targetLanguage = requestedTargetLanguage;
          const kindRaw = String(payload.kind || '').trim().toLowerCase();

          let itemKind: 'phrase' | 'sentence' | 'word' = 'phrase';
          if (kindRaw.includes('sentence')) itemKind = 'sentence';
          else if (kindRaw.includes('word')) itemKind = 'word';

          const word = String(payload.canonical_form || payload.found_in_text || '').trim();
          const definition = String(payload.meaning || '').trim();
          const example = String(payload.example || payload.source_sentence || '').trim();
          const sourceSentence = String(payload.source_sentence || payload.example || '').trim();

          if (!word) {
            sendResponse({
              success: false,
              error: 'Nothing was selected to add to vocabulary.',
              data: { code: 'EMPTY_VOCABULARY_ITEM' },
            });
            return;
          }

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

          const postLearnItem = (bearerToken: string) => fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${bearerToken}`,
            },
            body: JSON.stringify(learnItemBody),
          });

          let resp = await postLearnItem(token);
          if (resp.status === 401) {
            const stored = await getStoredTokens();
            const refreshedToken = stored?.refreshToken
              ? await refreshIdToken(stored.refreshToken)
              : null;
            if (refreshedToken) {
              token = refreshedToken;
              resp = await postLearnItem(token);
            }
          }

          if (!resp.ok) {
            const rawError = await resp.text();
            const normalized = normalizeLearnItemError(resp.status, rawError);
            if (resp.status === 401) await clearStoredTokens();
            sendResponse({
              success: false,
              error: normalized.message,
              data: { code: normalized.code, status: resp.status },
            });
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
