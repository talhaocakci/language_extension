import type { GetPhrasesResponse, PhraseItem } from './types';
import { getIdToken, clearTokens } from './auth';

const API_BASE = import.meta.env.VITE_API_BASE_URL as string;

async function authFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  // API Gateway COGNITO_USER_POOLS authorizer requires the ID token (has 'aud' claim).
  // Access tokens lack 'aud' and are rejected unless authorization_scopes is configured.
  const token = getIdToken();
  const headers = new Headers(opts.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  headers.set('Content-Type', 'application/json');
  const resp = await fetch(url, { ...opts, headers });
  if (resp.status === 401) { clearTokens(); window.location.reload(); }
  return resp;
}

export async function fetchPhrases(opts: {
  kind?: string;
  cursor?: string | null;
  limit?: number;
}): Promise<GetPhrasesResponse> {
  const params = new URLSearchParams();
  if (opts.kind)   params.set('kind',   opts.kind);
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.limit)  params.set('limit',  String(opts.limit));

  const resp = await authFetch(`${API_BASE}/phrases?${params}`);
  if (!resp.ok) throw new Error(`API ${resp.status}`);
  return resp.json();
}

export async function deletePhrase(phraseId: string): Promise<void> {
  const resp = await authFetch(`${API_BASE}/phrases/${phraseId}`, { method: 'DELETE' });
  if (!resp.ok && resp.status !== 404) throw new Error(`Delete failed: ${resp.status}`);
}

export async function savePhrase(body: {
  canonical_form: string;
  kind: string;
  meaning: string;
  example?: string[];
  language?: string;
  audio?: string;
  found_in_text?: string;
  source_sentence?: string;
  source_url?: string;
  video_title?: string;
}): Promise<{ phrase_id: string; already_exists: boolean }> {
  const resp = await authFetch(`${API_BASE}/phrases`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Save failed: ${resp.status}`);
  return resp.json() as Promise<{ phrase_id: string; already_exists: boolean }>;
}

export interface StoryResult {
  type: 'story' | 'dialogue';
  text: string;        // German text with target phrases wrapped in [[double brackets]]
  translation: string; // English translation
}

export async function generateStory(phrases: PhraseItem[]): Promise<StoryResult> {
  const phraseList = phrases
    .map(p => `- ${p.canonical_form}: ${p.meaning}`)
    .join('\n');

  const systemPrompt = `You are a German language teacher. \
Generate a short story or dialogue (150-200 words) that uses ALL of the given German phrases exactly as written.

STRICT RULES:
1. Write entirely in German.
2. Every phrase from the list MUST appear exactly ONCE, enclosed in [[double brackets]] like [[aufhören]] or [[so wie]].
3. Do NOT alter the phrase inside the brackets (keep exact spelling/capitalisation).
4. Make the text natural, coherent and educational.
5. Return ONLY a valid JSON object (no markdown fences): \
{"type":"story","text":"...text with [[phrases]] bracketed...","translation":"English translation of the full text"}`;

  const resp = await authFetch(`${API_BASE}/analyze`, {
    method: 'POST',
    body: JSON.stringify({
      model: 'gpt-4o',
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Use these German phrases in your story/dialogue:\n${phraseList}`,
        },
      ],
    }),
  });

  if (!resp.ok) throw new Error(`Story API ${resp.status}`);
  const openaiResp = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  const raw = openaiResp.choices?.[0]?.message?.content ?? '{}';
  return JSON.parse(raw) as StoryResult;
}
