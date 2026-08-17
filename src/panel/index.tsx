import React, { useEffect, useRef, useState, useCallback } from 'react';
import ReactDOM from 'react-dom/client';
import type { MeaningfulSentence, SubtitleChunk } from '../types/subtitle';
import type { MessageRequest, PlaybackControlPayload } from '../types/common';
import {
  DEFAULT_EXPLANATION_LANGUAGE,
  EXPLANATION_LANGUAGE_STORAGE_KEY,
  getLanguageLabel,
  normalizeLanguagePreference,
} from '../utils/language-preferences';
import './panel.css';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PhrasalVerb {
  foundInText: string;   // how it appears split in the sentence, e.g. "hört … auf"
  baseForm: string;      // infinitive, e.g. "aufhören"
  meaning: string;       // English translation, e.g. "to stop / to cease"
  prefix: string;        // separable prefix, e.g. "auf"
  stem: string;          // verb stem, e.g. "hören"
  example: string;       // usage note or example
}

/** Non-separable but teachable chunks: "so wie", idioms, collocations */
interface FixedPhrase {
  foundInText: string;
  /** Short category in English, e.g. "comparison", "idiom", "collocation" */
  kind: string;
  /** Dictionary / canonical form, e.g. "so wie", "auf Watte gehen" */
  canonicalForm: string;
  meaning: string;
  example?: string;
}

interface SentenceAnalysis {
  phrasalVerbs: PhrasalVerb[];
  fixedPhrases: FixedPhrase[];
  note: string;
}

function normalizeSentenceAnalysis(raw: Record<string, unknown>): SentenceAnalysis {
  const pv = raw.phrasalVerbs;
  const fp = raw.fixedPhrases;
  const phrasalVerbs = Array.isArray(pv)
    ? (pv as PhrasalVerb[]).filter(
        (p) =>
          p &&
          (typeof (p as PhrasalVerb).baseForm === 'string' ||
            typeof (p as PhrasalVerb).foundInText === 'string')
      )
    : [];
  const fixedPhrases: FixedPhrase[] = [];
  if (Array.isArray(fp)) {
    for (const item of fp) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const found =
        typeof o.foundInText === 'string' ? o.foundInText
        : typeof o.foundIn_sentence === 'string' ? o.foundIn_sentence
        : '';
      const canon =
        typeof o.canonicalForm === 'string' ? o.canonicalForm
        : typeof o.expression === 'string' ? o.expression
        : '';
      const meaning = typeof o.meaning === 'string' ? o.meaning : '';
      const kind = typeof o.kind === 'string' ? o.kind : 'phrase';
      const example = typeof o.example === 'string' ? o.example : undefined;
      if (found && canon && meaning) {
        fixedPhrases.push({ foundInText: found, kind, canonicalForm: canon, meaning, example });
      }
    }
  }
  const note = typeof raw.note === 'string' ? raw.note : '';
  return { phrasalVerbs, fixedPhrases, note };
}

interface WordToken {
  type: 'word' | 'space';
  raw: string;
  clean: string;
}

/** Fixed verb + preposition + case (Rektion), e.g. warten + auf + Akk. */
interface VerbPreposition {
  /** Preposition as used with this verb (auf, an, mit, von, …) */
  preposition: string;
  /** Required case after this preposition with this verb */
  case: 'nominative' | 'accusative' | 'dative' | 'genitive';
  /** e.g. Wechselpräposition: Akk. = Richtung, Dat. = Ort */
  note?: string | null;
}

interface WordMeaning {
  lemma: string;
  meaning: string;
  /** Contiguous noun phrase as written (article + adjectives + noun), if token is inside one */
  nounPhraseInSentence?: string | null;
  /** Kasus, if the token belongs to a nominal phrase */
  grammaticalCase?: 'nominative' | 'accusative' | 'dative' | 'genitive' | null;
  /** Article / determiner exactly as in the sentence: der, die, das, den, dem, des, ein, einer, … */
  articleAsInSentence?: string | null;
  /** Dictionary entry article for the head noun: only der | die | das */
  dictionaryArticle?: 'der' | 'die' | 'das' | null;
  /** Short note on adjective endings (weak/strong, -e/-en) in this phrase */
  adjectiveAgreement?: string | null;
  /** Verb or preposition that governs this case, e.g. "mit (+ Dat.)", "sehen (+ Akk.)" */
  caseGovernor?: string | null;
  /**
   * If the clicked token is a **verb** (or separable verb stem): typical prepositions
   * with required case (denken an + Akk., helfen + Dat. without prep → still list if lecture-worthy).
   * Multiple entries for Wechselpräpositionen (e.g. auf + Akk. motion vs. auf + Dat. place).
   */
  verbPrepositions?: VerbPreposition[] | null;
}

interface WordPopupState {
  sentenceId: string;
  word: string;
  display: string;
  x: number;
  y: number;
  loading: boolean;
  lemma: string | null;
  meaning: string | null;
  nounPhraseInSentence: string | null;
  grammaticalCase: string | null;
  articleAsInSentence: string | null;
  dictionaryArticle: string | null;
  adjectiveAgreement: string | null;
  caseGovernor: string | null;
  verbPrepositions: VerbPreposition[] | null;
  error: string | null;
}

interface SubtitleResponsePayload {
  meaningfulSentences?: MeaningfulSentence[];
  subtitles?: SubtitleChunk[];
  videoId?: string;
  captionLanguageCode?: string;
  playerLanguageCode?: string;
}

interface RefinedSentenceEntry {
  text: string;
  startIndex: number;
  endIndex: number;
}

interface QuizEvaluateWordDetail {
  word: string;
  matched: boolean;
  pronunciation_score?: number;
  matched_token?: string;
}

interface QuizEvaluateResult {
  transcript: string;
  score: number;
  word_count: number;
  matched_words: number;
  word_details: QuizEvaluateWordDetail[];
  stt_provider?: string;
}

type ShadowStatus = 'idle' | 'recording' | 'evaluating' | 'ready' | 'error';

interface ShadowState {
  status: ShadowStatus;
  result?: QuizEvaluateResult;
  error?: string;
}

interface ExplainAuthPromptState {
  sourceError: string;
  opening: boolean;
  openError: string | null;
}

interface ShadowRecorderSession {
  sentenceId: string;
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  chunks: Float32Array[];
}

const CASE_LABEL_DE: Record<string, string> = {
  nominative: 'Nominativ',
  accusative: 'Akkusativ',
  dative: 'Dativ',
  genitive: 'Genitiv'
};

const TARGET_LANGUAGE_LABELS: Record<string, string> = {
  de: 'German',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  it: 'Italian',
  pt: 'Portuguese',
  tr: 'Turkish',
  nl: 'Dutch',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  ar: 'Arabic'
};
const ENABLE_WORD_HIGHLIGHTING = false;

/** Split visible text into words and whitespace; strip punctuation for lookup */
function tokenizeSentence(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  const re = /(\s+)|([^\s]+)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) tokens.push({ type: 'space', raw: m[1], clean: '' });
    else {
      const raw = m[2];
      const clean = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      tokens.push({ type: 'word', raw, clean });
    }
  }
  return tokens;
}

function normalizeLanguageCode(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed.split(/[-_]/)[0] || '';
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return target.isContentEditable;
}

function wordCount(text: string): number {
  return tokenizeSentence(text).filter((t) => t.type === 'word' && t.clean.length > 0).length;
}

function getSentenceSeekStartMs(sentence: MeaningfulSentence): number {
  const starts = (sentence.subPortions || [])
    .map((portion) => portion.startTime)
    .filter((time) => Number.isFinite(time));
  if (starts.length === 0) return sentence.startTime;
  return Math.min(...starts);
}

function toInt(value: unknown, fallback = 0): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.trunc(num);
}

function normalizeRefinedSentenceEntries(raw: unknown): RefinedSentenceEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: RefinedSentenceEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const text = typeof obj.text === 'string' ? obj.text.trim() : '';
    if (!text) continue;
    const startIndex = toInt(obj.startIndex, -1);
    const endIndex = toInt(obj.endIndex, -1);
    if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) continue;
    out.push({ text, startIndex, endIndex });
  }
  return out;
}

function mapRefinedEntriesToSentences(
  entries: RefinedSentenceEntry[],
  chunks: SubtitleChunk[],
): MeaningfulSentence[] {
  const out: MeaningfulSentence[] = [];
  let lastEnd = -1;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const startIndex = Math.max(lastEnd + 1, Math.min(chunks.length - 1, entry.startIndex));
    const endIndex = Math.max(startIndex, Math.min(chunks.length - 1, entry.endIndex));
    const subChunks = chunks.slice(startIndex, endIndex + 1);
    if (subChunks.length === 0) continue;
    const startTime = subChunks[0].startTime;
    const endTime = subChunks[subChunks.length - 1].endTime;
    const text = entry.text.trim();
    if (!text) continue;
    out.push({
      id: `refined-${startIndex}-${endIndex}-${i}-${startTime}`,
      text,
      startTime,
      endTime,
      subPortions: subChunks.map((chunk) => ({
        text: chunk.text,
        startTime: chunk.startTime,
        endTime: chunk.endTime,
      })),
      confidence: 0.95,
    });
    lastEnd = endIndex;
  }
  return out;
}

function mergeAudioChunks(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function resampleLinear(data: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || data.length === 0) return data;
  const ratio = fromRate / toRate;
  const newLength = Math.max(1, Math.round(data.length / ratio));
  const out = new Float32Array(newLength);
  for (let i = 0; i < newLength; i += 1) {
    const sourcePos = i * ratio;
    const left = Math.floor(sourcePos);
    const right = Math.min(left + 1, data.length - 1);
    const frac = sourcePos - left;
    out[i] = data[left] * (1 - frac) + data[right] * frac;
  }
  return out;
}

function encodeWavPCM16(samples: Float32Array, sampleRate: number): Blob {
  const clamped = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    clamped[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = clamped.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < clamped.length; i += 1) {
    view.setInt16(offset, clamped[i], true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

// ── OpenAI: word in context ───────────────────────────────────────────────────

function normalizeVerbPrepositions(raw: unknown): VerbPreposition[] | null {
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const allowed: VerbPreposition['case'][] = [
    'nominative',
    'accusative',
    'dative',
    'genitive'
  ];
  const out: VerbPreposition[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const rawPrep = o.preposition;
    const preposition =
      typeof rawPrep === 'string'
        ? rawPrep.trim()
        : rawPrep === null || rawPrep === undefined
          ? ''
          : str(o.preposition) ?? '';
    const c = str(o.case)?.toLowerCase() ?? null;
    if (!c || !allowed.includes(c as VerbPreposition['case'])) continue;
    const note = str(o.note) ?? str(o.comment);
    out.push({
      preposition: preposition || '(ohne Präposition)',
      case: c as VerbPreposition['case'],
      note: note ?? undefined
    });
  }
  return out.length ? out : null;
}

function normalizeWordMeaning(raw: Record<string, unknown>, fallbackWord: string): WordMeaning {
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null;
  const caseVal = str(raw.grammaticalCase);
  const allowed = ['nominative', 'accusative', 'dative', 'genitive'];
  const grammaticalCase =
    caseVal && allowed.includes(caseVal.toLowerCase())
      ? (caseVal.toLowerCase() as WordMeaning['grammaticalCase'])
      : null;
  let dictionaryArticle = str(raw.dictionaryArticle)?.toLowerCase() ?? null;
  if (dictionaryArticle && !['der', 'die', 'das'].includes(dictionaryArticle)) {
    dictionaryArticle = null;
  }

  const verbPrepositions =
    normalizeVerbPrepositions(raw.verbPrepositions) ??
    normalizeVerbPrepositions(raw.verb_prepositions);

  return {
    lemma: str(raw.lemma) || fallbackWord,
    meaning: str(raw.meaning) || '',
    nounPhraseInSentence: str(raw.nounPhraseInSentence),
    grammaticalCase,
    articleAsInSentence: str(raw.articleAsInSentence),
    dictionaryArticle: dictionaryArticle as WordMeaning['dictionaryArticle'],
    adjectiveAgreement: str(raw.adjectiveAgreement),
    caseGovernor: str(raw.caseGovernor),
    verbPrepositions
  };
}

// ── LLM proxy (Lambda Function URL) ──────────────────────────────────────────

const API_BASE_URL = 'https://6b9x4wcwjh.execute-api.eu-central-1.amazonaws.com/prod';
const ANALYZE_URL = `${API_BASE_URL}/analyze`;
const LANGUAGE_TIER1_BASE_URL = 'https://api.getfluentfast.app';

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

function isAuthRequiredError(message: string): boolean {
  const m = message.toLowerCase();
  if (m.includes('only admin users')) return false;
  return (
    m.includes('not logged in') ||
    m.includes('session expired') ||
    m.includes('please sign in') ||
    m.includes('extension popup')
  );
}

async function getIdToken(): Promise<string> {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_ID_TOKEN' });
  if (!resp?.success || !resp.data?.token) {
    throw new Error('Not logged in. Please sign in from the extension popup.');
  }
  return resp.data.token as string;
}

async function callLLM(messages: { role: string; content: string }[], model = 'gpt-4o-mini'): Promise<string> {
  const token = await getIdToken();
  const resp = await fetch(ANALYZE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' }, messages }),
  });
  if (!resp.ok) {
    const err = normalizeApiError(resp.status, await resp.text());
    throw new Error(err);
  }
  const json = await resp.json();
  return (json.choices?.[0]?.message?.content as string) || '{}';
}

async function lookupWordInContext(
  word: string,
  sentence: string,
  targetLanguage: string,
  explanationLanguage: string,
): Promise<WordMeaning> {
  const systemPrompt = `You are a multilingual language teacher. The learner clicked a token in a ${targetLanguage || 'detected-language'} sentence.
Write all learner-facing explanations in ${explanationLanguage}. Use German-specific grammar fields only when the sentence is German; otherwise return null for fields that do not apply.

Return ONLY valid JSON with these keys (use null when not applicable):
- "lemma": dictionary form / base form of the clicked word or its head noun.
- "meaning": 1–2 short sentences in ${explanationLanguage}: meaning IN THIS CONTEXT.

If the token is part of a **noun phrase** (article + optional adjective(s) + noun, or pronoun phrase), also fill:
- "nounPhraseInSentence": the **full contiguous phrase exactly as it appears** in the sentence (include article, all adjectives, noun).
- "grammaticalCase": one of "nominative", "accusative", "dative", "genitive" for that phrase in THIS clause.
- "articleAsInSentence": the **exact article/determiner from the text** (e.g. der, die, das, den, dem, des, ein, eine, einem, kein…). If no article, null.
- "dictionaryArticle": for the **head noun**, which article appears in the dictionary: only "der", "die", or "das" (gender), even if the sentence uses dem/den/etc.
- "adjectiveAgreement": one short line on **adjective endings** in that phrase if there are adjectives (e.g. "weak -e after die", "strong -er nominative masculine").
- "caseGovernor": **verb or preposition** that explains the case (e.g. "mit (+ Dativ)", "sehen (+ Akkusativ)", subject of verb → Nominativ).

If the clicked token is a **verb** (finite form, infinitive, participle, or imperative) — identify by lemma:
- "verbPrepositions": JSON **array** of objects. Each object MUST have:
  - "preposition": the preposition used with this verb for a given meaning (German word only, e.g. "auf", "an", "mit", "von"). For verbs that take **only a direct object** with no preposition, you may use one entry with "preposition": "" and "case": "accusative" or "dative" for the object case (or omit the empty entry and describe in "caseGovernor" only if clearer).
  - "case": exactly one of "nominative", "accusative", "dative", "genitive" — the case **required after that preposition** with this verb (or the case of the object if preposition is empty string for simple transitive/dative verbs).
  - "note": optional short hint (e.g. "Wechselpräposition: Akkusativ bei Richtung/Bewegung, Dativ bei Ort", or "fest: immer + Dativ").
- List **several** entries if the verb uses different prepositions for different meanings (e.g. "denken an" vs "denken über") or both sides of a Wechselpräposition matter.
- If the word is **not** a verb, set "verbPrepositions": null.

For **nouns/adjectives/articles** clicked: set "verbPrepositions" to null. For verbs inside an NP click, still fill noun phrase fields if they apply.

Always output valid JSON. No markdown, no extra keys.`;

  const rawText = await callLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Clicked token: "${word}"\nFull sentence: "${sentence}"` },
  ]);
  const parsed = JSON.parse(rawText) as Record<string, unknown>;
  return normalizeWordMeaning(parsed, word);
}

// ── Explain endpoint call ────────────────────────────────────────────────────

async function analyseForPhrasalVerbs(
  sentence: string,
  targetLanguage: string,
  explanationLanguage: string,
): Promise<SentenceAnalysis> {
  const resp = await chrome.runtime.sendMessage({
    type: 'OVERLAY_EXPLAIN_SENTENCE',
    payload: {
      sentence,
      targetLanguage,
      explanationLanguage,
    },
  });

  if (!resp?.success) {
    throw new Error(resp?.error || 'Failed to explain sentence.');
  }

  const parsed = (resp.data?.analysis || {}) as Record<string, unknown>;
  return normalizeSentenceAnalysis(parsed);
}

async function refineSentencesWithBackend(
  chunks: SubtitleChunk[],
): Promise<MeaningfulSentence[]> {
  if (chunks.length === 0) return [];
  const promptInput = chunks.map((chunk, idx) => ({
    index: idx,
    text: chunk.text,
    start_ms: chunk.startTime,
    end_ms: chunk.endTime,
  }));

  const systemPrompt = `You reorganize subtitle chunks into readable full sentences.
Return ONLY valid JSON with this exact shape:
{
  "sentences": [
    { "text": "full sentence", "startIndex": 0, "endIndex": 3 }
  ]
}
Rules:
- Keep order.
- Use only contiguous chunk ranges.
- startIndex/endIndex are inclusive and refer to provided chunk indices.
- Do not skip chunks unless they are pure noise.
- No markdown, no extra keys.`;

  const raw = await callLLM([
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Chunks:\n${JSON.stringify(promptInput)}`
    },
  ]);

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const entries = normalizeRefinedSentenceEntries(parsed.sentences);
  return mapRefinedEntriesToSentences(entries, chunks);
}

function normalizeQuizEvaluateResult(raw: Record<string, unknown>): QuizEvaluateResult {
  const transcript = typeof raw.transcript === 'string' ? raw.transcript : '';
  const score = toInt(raw.score, 0);
  const wordCountValue = toInt(raw.word_count, 0);
  const matchedWordsValue = toInt(raw.matched_words, 0);
  const detailsRaw = Array.isArray(raw.word_details) ? raw.word_details : [];
  const details: QuizEvaluateWordDetail[] = detailsRaw
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const obj = item as Record<string, unknown>;
      return {
        word: typeof obj.word === 'string' ? obj.word : '',
        matched: Boolean(obj.matched),
        pronunciation_score: toInt(obj.pronunciation_score, 0),
        matched_token: typeof obj.matched_token === 'string' ? obj.matched_token : undefined,
      };
    })
    .filter((item) => item.word.length > 0);
  return {
    transcript,
    score,
    word_count: wordCountValue,
    matched_words: matchedWordsValue,
    word_details: details,
    stt_provider: typeof raw.stt_provider === 'string' ? raw.stt_provider : undefined,
  };
}

// ── Panel component ───────────────────────────────────────────────────────────

const PanelApp: React.FC = () => {
  const [allSentences, setAllSentences] = useState<MeaningfulSentence[]>([]);
  const [captionLanguageCode, setCaptionLanguageCode] = useState('');
  const [explanationLanguage, setExplanationLanguage] = useState(DEFAULT_EXPLANATION_LANGUAGE);
  const [isRefining, setIsRefining] = useState(false);
  const [currentSentenceIndex, setCurrentSentenceIndex] = useState<number>(-1);
  const [currentTime, setCurrentTime] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);

  // Analysis state
  const [analysisCache, setAnalysisCache] = useState<Record<string, SentenceAnalysis>>({});
  const [analysisLoading, setAnalysisLoading] = useState<Record<string, boolean>>({});
  const [expandedCards, setExpandedCards] = useState<Record<string, boolean>>({});
  const [explainAuthPromptBySentence, setExplainAuthPromptBySentence] =
    useState<Record<string, ExplainAuthPromptState>>({});
  const [hoveredCard, setHoveredCard] = useState<string | null>(null);

  const [wordPopup, setWordPopup] = useState<WordPopupState | null>(null);
  const wordMeaningCache = useRef<Record<string, WordMeaning>>({});

  // canonical_form → 'saving' | 'saved' | 'error'
  const [idiomSaveState, setIdiomSaveState] = useState<Record<string, 'saving' | 'saved' | 'error'>>({});
  const [idiomSaveError, setIdiomSaveError] = useState<Record<string, string>>({});
  const [shadowBySentence, setShadowBySentence] = useState<Record<string, ShadowState>>({});

  const sentenceRefs = useRef<(HTMLDivElement | null)[]>([]);
  const sentencesRef = useRef<MeaningfulSentence[]>([]);
  const lastVideoIdRef = useRef<string | null>(null);
  const tabUrlRef = useRef<string>('');
  const lastLiveRefreshAtRef = useRef(0);
  const shadowRecorderRef = useRef<ShadowRecorderSession | null>(null);

  const stopShadowRecorder = useCallback(async (): Promise<{
    sentenceId: string;
    audioBase64: string;
  } | null> => {
    const session = shadowRecorderRef.current;
    if (!session) return null;
    shadowRecorderRef.current = null;

    session.processor.disconnect();
    session.source.disconnect();
    session.stream.getTracks().forEach((track) => track.stop());
    await session.context.close();

    const merged = mergeAudioChunks(session.chunks);
    if (merged.length === 0) {
      return { sentenceId: session.sentenceId, audioBase64: '' };
    }
    const targetSampleRate = 16000;
    const resampled = resampleLinear(merged, session.context.sampleRate, targetSampleRate);
    const wavBlob = encodeWavPCM16(resampled, targetSampleRate);
    const audioBase64 = await blobToBase64(wavBlob);
    return { sentenceId: session.sentenceId, audioBase64 };
  }, []);

  const applySubtitlePayload = useCallback(async (
    payload: SubtitleResponsePayload,
    options?: { skipRefine?: boolean }
  ) => {
    const fallbackSentences = Array.isArray(payload.meaningfulSentences)
      ? payload.meaningfulSentences
      : [];
    const rawChunks = Array.isArray(payload.subtitles) ? payload.subtitles : [];
    const nextCaptionLanguage = typeof payload.playerLanguageCode === 'string'
      ? normalizeLanguageCode(payload.playerLanguageCode)
      : typeof payload.captionLanguageCode === 'string'
        ? normalizeLanguageCode(payload.captionLanguageCode)
      : '';
    setCaptionLanguageCode(nextCaptionLanguage);

    let nextSentences = fallbackSentences;
    if (!options?.skipRefine && rawChunks.length > 0) {
      setIsRefining(true);
      try {
        const refined = await refineSentencesWithBackend(rawChunks);
        if (refined.length > 0) {
          nextSentences = refined;
        }
      } catch (err) {
        console.warn('Sentence refinement failed, using local grouping fallback:', err);
      } finally {
        setIsRefining(false);
      }
    } else {
      setIsRefining(false);
    }

    sentenceRefs.current = new Array(nextSentences.length).fill(null);
    sentencesRef.current = nextSentences;
    setAllSentences(nextSentences);
    setError(null);
  }, []);

  const loadSentences = useCallback(async (tabId: number): Promise<string | undefined> => {
    try {
      const response: any = await chrome.tabs.sendMessage(tabId, { type: 'GET_SUBTITLES' });
      if (response?.success && response.data) {
        await applySubtitlePayload(response.data as SubtitleResponsePayload);
        return typeof response.data?.videoId === 'string' ? response.data.videoId : undefined;
      }
      if (response?.error === 'Video changed during load') {
        await new Promise((r) => setTimeout(r, 400));
        const retry: any = await chrome.tabs.sendMessage(tabId, { type: 'GET_SUBTITLES' });
        if (retry?.success && retry.data) {
          await applySubtitlePayload(retry.data as SubtitleResponsePayload);
          return typeof retry.data?.videoId === 'string' ? retry.data.videoId : undefined;
        }
        setError(retry?.error || response?.error || 'No captions found for this video.');
        return undefined;
      }
      setError(response?.error || 'No captions found for this video.');
      return undefined;
    } catch {
      setError('Could not reach content script. Make sure you are on a supported video page.');
      return undefined;
    }
  }, [applySubtitlePayload]);

  useEffect(() => {
    sentencesRef.current = allSentences;
  }, [allSentences]);

  const initializePanel = useCallback(async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setError('No active tab found.');
        setIsLoading(false);
        return;
      }
      setActiveTabId(tab.id);
      tabUrlRef.current = tab.url ?? '';
      lastVideoIdRef.current = null;
      const vid = await loadSentences(tab.id);
      if (vid) lastVideoIdRef.current = vid;
    } catch {
      setError('Failed to initialize panel.');
    } finally {
      setIsLoading(false);
    }
  }, [loadSentences]);

  useEffect(() => {
    void initializePanel();
  }, [initializePanel]);

  useEffect(() => {
    void chrome.runtime.sendMessage({ type: 'GET_LANGUAGE_PREFERENCES' }).then((response) => {
      if (!response?.success) return;
      setExplanationLanguage(normalizeLanguagePreference(
        response.data?.explanationLanguage,
        DEFAULT_EXPLANATION_LANGUAGE,
      ));
    });

    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'sync' || !changes[EXPLANATION_LANGUAGE_STORAGE_KEY]) return;
      setExplanationLanguage(normalizeLanguagePreference(
        changes[EXPLANATION_LANGUAGE_STORAGE_KEY].newValue,
        DEFAULT_EXPLANATION_LANGUAGE,
      ));
      setAnalysisCache({});
      setExpandedCards({});
      wordMeaningCache.current = {};
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    return () => chrome.storage.onChanged.removeListener(onStorageChanged);
  }, []);

  // Auto-scroll active sentence
  useEffect(() => {
    if (currentSentenceIndex >= 0 && sentenceRefs.current[currentSentenceIndex]) {
      sentenceRefs.current[currentSentenceIndex]!.scrollIntoView({
        behavior: 'smooth', block: 'center'
      });
    }
  }, [currentSentenceIndex]);

  // Poll video time; reload transcript when YouTube SPA navigates to another video
  useEffect(() => {
    if (!activeTabId) return;
    const interval = setInterval(async () => {
      try {
        const response = await chrome.tabs.sendMessage(activeTabId, {
          type: 'GET_CURRENT_VIDEO'
        } as MessageRequest);
        if (response?.success && response.data) {
          const data = response.data as {
            videoId?: string;
            currentTime?: number;
            platform?: string;
            playerLanguageCode?: string;
          };
          const vid = data.videoId;
          const timeMs = (data.currentTime || 0) * 1000;
          setCurrentTime(timeMs);
          const livePlayerLanguage = normalizeLanguageCode(data.playerLanguageCode || '');
          if (livePlayerLanguage) {
            setCaptionLanguageCode(livePlayerLanguage);
          }

          if (vid) {
            if (lastVideoIdRef.current === null) {
              lastVideoIdRef.current = vid;
            } else if (lastVideoIdRef.current !== vid) {
              lastVideoIdRef.current = vid;
              const freshTab = await chrome.tabs.get(activeTabId);
              tabUrlRef.current = freshTab.url ?? '';
              void stopShadowRecorder();
              wordMeaningCache.current = {};
              setAnalysisCache({});
              setAnalysisLoading({});
              setExpandedCards({});
              setExplainAuthPromptBySentence({});
              setShadowBySentence({});
              setCaptionLanguageCode('');
              setWordPopup(null);
              setCurrentSentenceIndex(-1);
              setError(null);
              const newVid = await loadSentences(activeTabId);
              if (newVid) lastVideoIdRef.current = newVid;
            }
          }

          const now = Date.now();
          const isYouTubePlatform = data.platform === 'youtube' ||
            tabUrlRef.current.includes('youtube.com') ||
            tabUrlRef.current.includes('youtu.be');
          if (!isYouTubePlatform && now - lastLiveRefreshAtRef.current > 1500) {
            lastLiveRefreshAtRef.current = now;
            const live = await chrome.tabs.sendMessage(activeTabId, { type: 'GET_SUBTITLES' });
            if (live?.success && live.data && Array.isArray(live.data?.meaningfulSentences)) {
              const nextSentences: MeaningfulSentence[] = live.data.meaningfulSentences;
              const currentSentences = sentencesRef.current;
              const nextPlayerLanguage = normalizeLanguageCode(
                live.data.playerLanguageCode || live.data.captionLanguageCode || '',
              );
              const changed =
                (!!nextPlayerLanguage && nextPlayerLanguage !== captionLanguageCode) ||
                nextSentences.length !== currentSentences.length ||
                (nextSentences.length > 0 &&
                  currentSentences.length > 0 &&
                  nextSentences[nextSentences.length - 1].text !==
                    currentSentences[currentSentences.length - 1].text);

              if (changed) {
                await applySubtitlePayload(live.data as SubtitleResponsePayload, { skipRefine: true });
              }
            }
          }

          if (allSentences.length > 0) {
            const idx = allSentences.findIndex(
              (s) => timeMs >= s.startTime && timeMs <= s.endTime
            );
            setCurrentSentenceIndex((prev) => (idx !== prev ? idx : prev));
          }
        }
      } catch {
        /* tab not ready */
      }
    }, 500);
    return () => clearInterval(interval);
  }, [activeTabId, allSentences, applySubtitlePayload, captionLanguageCode, loadSentences, stopShadowRecorder]);

  // Close word popup on click outside
  useEffect(() => {
    if (!wordPopup) return;
    const onDown = (e: MouseEvent) => {
      const el = document.getElementById('word-meaning-popup');
      if (el && !el.contains(e.target as Node)) setWordPopup(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [wordPopup]);

  useEffect(() => {
    return () => {
      void stopShadowRecorder();
    };
  }, [stopShadowRecorder]);

  const sendPlaybackControl = useCallback(async (payload: PlaybackControlPayload) => {
    if (!activeTabId) return;
    try {
      await chrome.tabs.sendMessage(activeTabId, {
        type: 'PLAYBACK_CONTROL',
        payload,
      } as MessageRequest);
    } catch {}
  }, [activeTabId]);

  const handleWordClick = useCallback(
    async (
      e: React.MouseEvent,
      sentence: MeaningfulSentence,
      display: string,
      clean: string
    ) => {
      e.stopPropagation();
      if (!clean) return;
      await sendPlaybackControl({ action: 'pause' });

      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const cacheKey = `${sentence.id}|${captionLanguageCode}|${explanationLanguage}|v4|${clean.toLowerCase()}`;
      const cached = wordMeaningCache.current[cacheKey];

      setWordPopup({
        sentenceId: sentence.id,
        word: clean,
        display,
        x: rect.left,
        y: rect.bottom + 6,
        loading: !cached,
        lemma: cached?.lemma ?? null,
        meaning: cached?.meaning ?? null,
        nounPhraseInSentence: cached?.nounPhraseInSentence ?? null,
        grammaticalCase: cached?.grammaticalCase ?? null,
        articleAsInSentence: cached?.articleAsInSentence ?? null,
        dictionaryArticle: cached?.dictionaryArticle ?? null,
        adjectiveAgreement: cached?.adjectiveAgreement ?? null,
        caseGovernor: cached?.caseGovernor ?? null,
        verbPrepositions: cached?.verbPrepositions ?? null,
        error: null
      });

      if (cached) return;

      try {
        const result = await lookupWordInContext(
          clean,
          sentence.text,
          captionLanguageCode,
          explanationLanguage,
        );
        wordMeaningCache.current[cacheKey] = result;
        setWordPopup((p) =>
          p && p.sentenceId === sentence.id && p.word === clean
            ? {
                ...p,
                loading: false,
                lemma: result.lemma,
                meaning: result.meaning,
                nounPhraseInSentence: result.nounPhraseInSentence ?? null,
                grammaticalCase: (result.grammaticalCase as string | null) ?? null,
                articleAsInSentence: result.articleAsInSentence ?? null,
                dictionaryArticle: result.dictionaryArticle ?? null,
                adjectiveAgreement: result.adjectiveAgreement ?? null,
                caseGovernor: result.caseGovernor ?? null,
                verbPrepositions: result.verbPrepositions ?? null,
                error: null
              }
            : p
        );
      } catch (err: any) {
        setWordPopup((p) =>
          p && p.sentenceId === sentence.id && p.word === clean
            ? {
                ...p,
                loading: false,
                error: err.message || 'Failed to load',
                lemma: null,
                meaning: null,
                nounPhraseInSentence: null,
                grammaticalCase: null,
                articleAsInSentence: null,
                dictionaryArticle: null,
                adjectiveAgreement: null,
                caseGovernor: null,
                verbPrepositions: null
              }
            : p
        );
      }
    },
    [captionLanguageCode, explanationLanguage, sendPlaybackControl]
  );

  const handleJumpToTime = async (startTimeMs: number) => {
    await sendPlaybackControl({
      action: 'seek_to_ms',
      timeMs: startTimeMs,
    });
  };

  const resolveCurrentSentenceIndex = useCallback((): number => {
    if (allSentences.length === 0) return -1;
    if (currentSentenceIndex >= 0 && currentSentenceIndex < allSentences.length) {
      return currentSentenceIndex;
    }

    let activeIdx = allSentences.findIndex(
      (sentence) => currentTime >= sentence.startTime && currentTime <= sentence.endTime
    );
    if (activeIdx >= 0) return activeIdx;

    let previous = -1;
    for (let i = 0; i < allSentences.length; i += 1) {
      if (allSentences[i].startTime <= currentTime) {
        previous = i;
      } else {
        break;
      }
    }
    if (previous >= 0) return previous;
    return 0;
  }, [allSentences, currentSentenceIndex, currentTime]);

  const handleNavigateSentence = useCallback(async (direction: 'prev' | 'repeat' | 'next') => {
    if (allSentences.length === 0) return;
    const baseIndex = resolveCurrentSentenceIndex();
    if (baseIndex < 0) return;

    let targetIndex = baseIndex;
    if (direction === 'prev') {
      targetIndex = Math.max(0, baseIndex - 1);
    } else if (direction === 'next') {
      targetIndex = Math.min(allSentences.length - 1, baseIndex + 1);
    }

    const targetSentence = allSentences[targetIndex];
    if (!targetSentence) return;
    setCurrentSentenceIndex(targetIndex);
    await sendPlaybackControl({ action: 'seek_to_ms', timeMs: getSentenceSeekStartMs(targetSentence) });
    await sendPlaybackControl({ action: 'play' });
  }, [allSentences, resolveCurrentSentenceIndex, sendPlaybackControl]);

  const handleToggleSlowPlayback = useCallback(async () => {
    await sendPlaybackControl({ action: 'toggle_slow' });
  }, [sendPlaybackControl]);

  /** Returns the YouTube URL with the sentence's start-time as &t=Xs */
  const buildSourceUrl = useCallback((sentence: MeaningfulSentence): string => {
    const base = tabUrlRef.current;
    const seconds = Math.floor(sentence.startTime / 1000);
    if (!base) return '';
    try {
      const url = new URL(base);
      url.searchParams.set('t', String(seconds));
      return url.toString();
    } catch {
      return base;
    }
  }, []);

  const handleExplain = useCallback(async (sentence: MeaningfulSentence) => {
    const id = sentence.id;
    const isExpanded = Boolean(expandedCards[id]);
    await sendPlaybackControl({ action: 'pause' });

    if (analysisCache[id]) {
      setExpandedCards(prev => ({ ...prev, [id]: !prev[id] }));
      return;
    }

    setExplainAuthPromptBySentence((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setExpandedCards(prev => ({ ...prev, [id]: true }));
    setAnalysisLoading(prev => ({ ...prev, [id]: true }));
    try {
      const result = await analyseForPhrasalVerbs(
        sentence.text,
        captionLanguageCode,
        explanationLanguage,
      );
      setAnalysisCache(prev => ({ ...prev, [id]: result }));
    } catch (e: any) {
      const message = e?.message || 'Failed to explain sentence.';
      if (isAuthRequiredError(message)) {
        setExplainAuthPromptBySentence((prev) => ({
          ...prev,
          [id]: { sourceError: message, opening: false, openError: null },
        }));
      } else {
        setAnalysisCache(prev => ({
          ...prev,
          [id]: { phrasalVerbs: [], fixedPhrases: [], note: `Error: ${message}` }
        }));
      }
    } finally {
      setAnalysisLoading(prev => ({ ...prev, [id]: false }));
    }
  }, [analysisCache, captionLanguageCode, expandedCards, explanationLanguage, sendPlaybackControl]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditableElement(event.target)) return;

      const key = event.key.toLowerCase();
      if (key === 'q') {
        event.preventDefault();
        void handleNavigateSentence('prev');
      } else if (key === 'w') {
        event.preventDefault();
        void handleNavigateSentence('repeat');
      } else if (key === 'e') {
        event.preventDefault();
        void handleNavigateSentence('next');
      } else if (key === 's') {
        event.preventDefault();
        void handleToggleSlowPlayback();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleNavigateSentence, handleToggleSlowPlayback]);

  const handleOpenExtensionPopupForExplain = useCallback(async (sentenceId: string) => {
    setExplainAuthPromptBySentence((prev) => {
      const current = prev[sentenceId];
      if (!current) return prev;
      return {
        ...prev,
        [sentenceId]: { ...current, opening: true, openError: null },
      };
    });
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'OPEN_EXTENSION_POPUP' });
      if (!resp?.success) {
        const msg = resp?.error || 'Could not open sign-in UI.';
        setExplainAuthPromptBySentence((prev) => {
          const current = prev[sentenceId];
          if (!current) return prev;
          return {
            ...prev,
            [sentenceId]: { ...current, opening: false, openError: msg },
          };
        });
        return;
      }
      setExplainAuthPromptBySentence((prev) => {
        const current = prev[sentenceId];
        if (!current) return prev;
        return {
          ...prev,
          [sentenceId]: { ...current, opening: false, openError: null },
        };
      });
    } catch (err: any) {
      const msg = err?.message || 'Failed to open sign-in UI.';
      setExplainAuthPromptBySentence((prev) => {
        const current = prev[sentenceId];
        if (!current) return prev;
        return {
          ...prev,
          [sentenceId]: { ...current, opening: false, openError: msg },
        };
      });
    }
  }, []);

  const evaluateShadow = useCallback(async (
    sentence: MeaningfulSentence,
    audioBase64: string,
    targetLanguage: string,
  ): Promise<QuizEvaluateResult> => {
    const token = await getIdToken();
    const resp = await fetch(`${LANGUAGE_TIER1_BASE_URL}/quiz/evaluate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        audio_base64: audioBase64,
        expected_answer: sentence.text,
        target_language: targetLanguage,
        request_pronunciation_score: true,
        pronunciation_context: 'reading',
      }),
    });
    if (!resp.ok) {
      const err = normalizeApiError(resp.status, await resp.text());
      throw new Error(err);
    }
    const json = await resp.json();
    return normalizeQuizEvaluateResult(json as Record<string, unknown>);
  }, []);

  const startShadowRecordingForSentence = useCallback(async (sentence: MeaningfulSentence) => {
    if (shadowRecorderRef.current) return;
    if (!captionLanguageCode) {
      setShadowBySentence((prev) => ({
        ...prev,
        [sentence.id]: {
          status: 'error',
          error: 'Shadowing requires the selected subtitle language to be detected on this video.',
        },
      }));
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      processor.onaudioprocess = (event) => {
        const channel = event.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(channel));
      };
      source.connect(processor);
      processor.connect(context.destination);
      shadowRecorderRef.current = {
        sentenceId: sentence.id,
        stream,
        context,
        source,
        processor,
        chunks,
      };
      setShadowBySentence((prev) => ({
        ...prev,
        [sentence.id]: { status: 'recording' },
      }));
    } catch (err: any) {
      setShadowBySentence((prev) => ({
        ...prev,
        [sentence.id]: {
          status: 'error',
          error: err?.message || 'Microphone access failed. Please allow microphone access and retry.',
        },
      }));
    }
  }, [captionLanguageCode]);

  const stopAndEvaluateShadowForSentence = useCallback(async (sentence: MeaningfulSentence) => {
    const stopped = await stopShadowRecorder();
    if (!stopped || stopped.sentenceId !== sentence.id) return;
    if (!stopped.audioBase64) {
      setShadowBySentence((prev) => ({
        ...prev,
        [sentence.id]: { status: 'error', error: 'No audio captured. Please try again.' },
      }));
      return;
    }

    setShadowBySentence((prev) => ({
      ...prev,
      [sentence.id]: { status: 'evaluating' },
    }));
    try {
      const result = await evaluateShadow(sentence, stopped.audioBase64, captionLanguageCode);
      setShadowBySentence((prev) => ({
        ...prev,
        [sentence.id]: { status: 'ready', result },
      }));
    } catch (err: any) {
      setShadowBySentence((prev) => ({
        ...prev,
        [sentence.id]: { status: 'error', error: err?.message || 'Shadow evaluation failed.' },
      }));
    }
  }, [captionLanguageCode, evaluateShadow, stopShadowRecorder]);

  const handleSaveIdiom = useCallback(async (
    canonical_form: string,
    found_in_text: string,
    kind: string,
    meaning: string,
    example: string | undefined,
    sourceSentence: string,
    sourceUrl: string,
    videoTitle: string,
  ) => {
    setIdiomSaveState(prev => ({ ...prev, [canonical_form]: 'saving' }));
    setIdiomSaveError(prev => {
      const next = { ...prev };
      delete next[canonical_form];
      return next;
    });
    try {
      const resp: any = await chrome.runtime.sendMessage({
        type: 'SAVE_IDIOM',
        payload: {
          target_language: captionLanguageCode,
          canonical_form,
          found_in_text,
          kind,
          meaning,
          example: example || null,
          language: captionLanguageCode,
          source_sentence: sourceSentence,
          source_url: sourceUrl,
          video_title: videoTitle,
          tags: [],
        },
      });
      if (resp?.success) {
        setIdiomSaveState(prev => ({ ...prev, [canonical_form]: 'saved' }));
      } else {
        console.error('SAVE_IDIOM failed:', resp?.error, resp?.data);
        if (typeof resp?.error === 'string' && isAuthRequiredError(resp.error)) {
          try {
            await chrome.runtime.sendMessage({ type: 'OPEN_EXTENSION_POPUP' });
          } catch {}
        }
        setIdiomSaveError(prev => ({
          ...prev,
          [canonical_form]: typeof resp?.error === 'string' ? resp.error : 'Could not add this item.',
        }));
        setIdiomSaveState(prev => ({ ...prev, [canonical_form]: 'error' }));
        setTimeout(() => setIdiomSaveState(prev => {
          const next = { ...prev };
          delete next[canonical_form];
          return next;
        }), 3000);
      }
    } catch (e) {
      console.error('SAVE_IDIOM error:', e);
      setIdiomSaveError(prev => ({
        ...prev,
        [canonical_form]: e instanceof Error ? e.message : 'Could not reach the vocabulary service.',
      }));
      setIdiomSaveState(prev => ({ ...prev, [canonical_form]: 'error' }));
      setTimeout(() => setIdiomSaveState(prev => {
        const next = { ...prev };
        delete next[canonical_form];
        return next;
      }), 3000);
    }
  }, [captionLanguageCode]);

  const handleSaveWordFromPopup = useCallback(() => {
    if (!wordPopup) return;

    const canonicalForm = (wordPopup.lemma || wordPopup.word || wordPopup.display || '').trim();
    if (!canonicalForm) return;

    const foundInText = wordPopup.display.trim() || canonicalForm;
    const sentence = allSentences.find((s) => s.id === wordPopup.sentenceId);
    const sourceSentence = sentence?.text || '';
    const sourceUrl = sentence ? buildSourceUrl(sentence) : '';

    void handleSaveIdiom(
      canonicalForm,
      foundInText,
      'word',
      wordPopup.meaning || '',
      undefined,
      sourceSentence,
      sourceUrl,
      document.title,
    );
  }, [allSentences, buildSourceUrl, handleSaveIdiom, wordPopup]);

  const formatTime = (ms: number): string => {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  };
  const activeRecordingSentenceId =
    Object.entries(shadowBySentence).find(([, state]) => state.status === 'recording')?.[0] || null;
  // ── Render ────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="panelContainer">
        <div style={styles.center}>
          <div style={styles.spinner} />
          <p style={{ color: '#999', marginTop: 12 }}>Loading transcript…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="panelContainer">
        <div style={styles.center}>
          <p style={{ color: '#e55', textAlign: 'center', padding: '0 20px' }}>{error}</p>
        </div>
      </div>
    );
  }

  if (allSentences.length === 0) {
    return (
      <div className="panelContainer">
        <div style={styles.center}><p style={{ color: '#999' }}>No sentences found.</p></div>
      </div>
    );
  }

  return (
    <div className="panelContainer">
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={{ fontWeight: 600, color: '#333' }}>Transcript</span>
          <div style={styles.navControls}>
            <button style={styles.navBtn} onClick={() => { void handleNavigateSentence('prev'); }}>
              Prev (Q)
            </button>
            <button style={styles.navBtn} onClick={() => { void handleNavigateSentence('repeat'); }}>
              Repeat (W)
            </button>
            <button style={styles.navBtn} onClick={() => { void handleNavigateSentence('next'); }}>
              Next (E)
            </button>
            <button style={styles.navBtn} onClick={() => { void handleToggleSlowPlayback(); }}>
              Slow (S)
            </button>
          </div>
        </div>
        <div style={styles.headerRight}>
          <span style={styles.targetLanguageLabel}>
            Target {captionLanguageCode
              ? `${TARGET_LANGUAGE_LABELS[captionLanguageCode] || captionLanguageCode.toUpperCase()} (${captionLanguageCode})`
              : 'not detected'}
          </span>
          <span style={styles.targetLanguageLabel}>
            Explain in {getLanguageLabel(explanationLanguage)}
          </span>
          <button
            style={styles.profileBtn}
            onClick={() => { void chrome.runtime.sendMessage({ type: 'OPEN_EXTENSION_POPUP' }); }}
            title="Open profile and language settings"
          >
            👤 Profile
          </button>
          <span style={{ color: '#999', fontSize: 12 }}>
            {allSentences.length} sentences
            {currentSentenceIndex >= 0 && ` · #${currentSentenceIndex + 1}`}
            {isRefining && ' · refining…'}
          </span>
        </div>
      </div>
      {!captionLanguageCode && (
        <div style={styles.shadowDisabledBanner}>
          Shadowing is unavailable because the selected subtitle language could not be detected.
        </div>
      )}

      {/* Sentence list */}
      <div style={styles.list}>
        {allSentences.map((sentence, idx) => {
          const isActive = idx === currentSentenceIndex;
          const id = sentence.id;
          const analysis = analysisCache[id];
          const explainAuthPrompt = explainAuthPromptBySentence[id];
          const loading = analysisLoading[id];
          const expanded = expandedCards[id];
          const isHovered = hoveredCard === id;
          const shadowState: ShadowState = shadowBySentence[id] || { status: 'idle' };
          const isRecordingThis = shadowState.status === 'recording';
          const isEvaluatingThis = shadowState.status === 'evaluating';
          const hasOtherRecording = !!activeRecordingSentenceId && activeRecordingSentenceId !== id;
          const shadowButtonDisabled = (!isRecordingThis && !captionLanguageCode) || hasOtherRecording || isEvaluatingThis;

          return (
            <div
              key={id}
              ref={el => { sentenceRefs.current[idx] = el; }}
              style={{
                ...styles.card,
                borderLeft: isActive ? '4px solid #667eea' : '4px solid #e0e0e0',
                backgroundColor: isActive ? '#f0f4ff' : '#fafafa',
                boxShadow: isActive ? '0 2px 8px rgba(102,126,234,0.18)' : 'none',
                cursor: 'default',
                position: 'relative'
              }}
              onMouseEnter={() => setHoveredCard(id)}
              onMouseLeave={() => setHoveredCard(null)}
            >
              {/* Timestamp row */}
              <div style={styles.meta}>
                <span style={styles.timeBtn} onClick={() => handleJumpToTime(sentence.startTime)}>
                  {formatTime(sentence.startTime)}
                </span>
                <span style={{ color: '#bbb' }}>–</span>
                <span style={{ color: '#bbb' }}>{formatTime(sentence.endTime)}</span>
                <button
                  style={{
                    ...styles.shadowBtn,
                    ...(isRecordingThis ? styles.shadowBtnRecording : {}),
                    ...(shadowButtonDisabled ? styles.shadowBtnDisabled : {}),
                  }}
                  disabled={shadowButtonDisabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isRecordingThis) {
                      void stopAndEvaluateShadowForSentence(sentence);
                    } else {
                      void startShadowRecordingForSentence(sentence);
                    }
                  }}
                  title={
                    !captionLanguageCode
                      ? 'Selected subtitle language not detected'
                      : hasOtherRecording
                        ? 'Finish the current recording first'
                        : isEvaluatingThis
                          ? 'Evaluation in progress'
                          : 'Record and evaluate this sentence'
                  }
                >
                  {isRecordingThis ? '■ Stop' : isEvaluatingThis ? 'Evaluating…' : '🎙 Shadow'}
                </button>
                <span style={{ marginLeft: 'auto', color: '#ccc' }}>#{idx + 1}</span>
              </div>

              {/* Hover-reveal Explain button */}
              {(isHovered || loading || (analysis && expanded)) && (
                <button
                  style={{
                    ...styles.explainBtn,
                    ...(analysis && expanded ? styles.explainBtnActive : {})
                  }}
                  onClick={e => { e.stopPropagation(); handleExplain(sentence); }}
                >
                  {loading ? '⏳ Analysing…' : analysis && expanded ? '✕ Hide' : '✨ Explain'}
                </button>
              )}

              {/* Sentence text — every word clickable; rough sync highlight when active */}
              <div style={styles.sentenceText}>
                {(() => {
                  const tokens = tokenizeSentence(sentence.text);
                  const wordCount = tokens.filter(
                    t => t.type === 'word' && t.clean.length > 0
                  ).length;
                  const spanMs = Math.max(1, sentence.endTime - sentence.startTime);
                  const prog = isActive
                    ? Math.min(1, Math.max(0, (currentTime - sentence.startTime) / spanMs))
                    : 0;
                  const activeWordIndex =
                    ENABLE_WORD_HIGHLIGHTING && isActive && wordCount > 0
                      ? Math.min(wordCount - 1, Math.floor(prog * wordCount))
                      : -1;
                  let wordRun = -1;
                  return tokens.map((tok, ti) => {
                    if (tok.type === 'space') {
                      return <span key={ti}>{tok.raw}</span>;
                    }
                    if (tok.type === 'word' && !tok.clean) {
                      return <span key={ti}>{tok.raw}</span>;
                    }
                    const wIdx = ++wordRun;
                    const timeHot = isActive && wIdx === activeWordIndex;
                    return (
                      <span
                        key={ti}
                        role="button"
                        tabIndex={0}
                        title="Click for meaning"
                        onClick={(e) => handleWordClick(e, sentence, tok.raw, tok.clean)}
                        style={{
                          ...styles.wordSpan,
                          backgroundColor: timeHot ? '#667eea' : 'transparent',
                          color: timeHot ? '#fff' : '#333',
                          fontWeight: timeHot ? 600 : 400
                        }}
                      >
                        {tok.raw}
                      </span>
                    );
                  });
                })()}
              </div>

              {(shadowState.status === 'recording' ||
                shadowState.status === 'evaluating' ||
                shadowState.status === 'ready' ||
                shadowState.status === 'error') && (
                <div style={styles.shadowPanel}>
                  {shadowState.status === 'recording' && (
                    <p style={styles.shadowHint}>Recording… click “Stop” to evaluate.</p>
                  )}
                  {shadowState.status === 'evaluating' && (
                    <p style={styles.shadowHint}>Evaluating pronunciation and transcript…</p>
                  )}
                  {shadowState.status === 'error' && (
                    <p style={styles.shadowError}>{shadowState.error || 'Shadow evaluation failed.'}</p>
                  )}
                  {shadowState.status === 'ready' && shadowState.result && (
                    <>
                      <div style={styles.shadowSummaryRow}>
                        <span style={styles.shadowScoreBadge}>{shadowState.result.score}%</span>
                        <span style={styles.shadowSummaryText}>
                          matched {shadowState.result.matched_words}/{shadowState.result.word_count}
                          {shadowState.result.stt_provider ? ` · ${shadowState.result.stt_provider}` : ''}
                        </span>
                      </div>
                      {shadowState.result.transcript && (
                        <div style={styles.shadowTranscript}>
                          <span style={styles.shadowTranscriptLabel}>You said:</span> {shadowState.result.transcript}
                        </div>
                      )}
                      {shadowState.result.word_details.length > 0 && (
                        <div style={styles.shadowWordGrid}>
                          {shadowState.result.word_details.slice(0, 14).map((detail, detailIdx) => (
                            <span
                              key={`${id}-shadow-word-${detailIdx}`}
                              style={{
                                ...styles.shadowWordChip,
                                ...(detail.matched ? styles.shadowWordChipMatched : styles.shadowWordChipUnmatched),
                              }}
                            >
                              {detail.word}
                              <strong style={{ marginLeft: 4 }}>{toInt(detail.pronunciation_score, 0)}</strong>
                            </span>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Analysis section */}
              {loading && (
                <div style={styles.analysisWrap}>
                  <div style={styles.analysisSpinner} />
                  <span style={{ color: '#999', fontSize: 12 }}>Analysing…</span>
                </div>
              )}

              {!loading && expanded && explainAuthPrompt && (
                <div style={styles.analysisWrap}>
                  <div style={styles.explainAuthCallout}>
                    <p style={styles.explainAuthText}>Sign in required to use Explain.</p>
                    <div style={styles.explainAuthActions}>
                      <button
                        style={{
                          ...styles.explainAuthPrimaryBtn,
                          ...(explainAuthPrompt.opening ? styles.explainAuthBtnDisabled : {})
                        }}
                        disabled={explainAuthPrompt.opening}
                        onClick={() => { void handleOpenExtensionPopupForExplain(id); }}
                      >
                        {explainAuthPrompt.opening ? 'Opening…' : 'Sign in'}
                      </button>
                      <button
                        style={{
                          ...styles.explainAuthSecondaryBtn,
                          ...(explainAuthPrompt.opening ? styles.explainAuthBtnDisabled : {})
                        }}
                        disabled={explainAuthPrompt.opening}
                        onClick={() => { void handleExplain(sentence); }}
                      >
                        Retry Explain
                      </button>
                    </div>
                    {explainAuthPrompt.openError && (
                      <p style={styles.explainAuthError}>{explainAuthPrompt.openError}</p>
                    )}
                    {!explainAuthPrompt.openError && explainAuthPrompt.sourceError && (
                      <p style={styles.noteTextMuted}>{explainAuthPrompt.sourceError}</p>
                    )}
                  </div>
                </div>
              )}

              {!loading && analysis && expanded && (
                <div style={styles.analysisWrap}>
                  {(analysis.fixedPhrases?.length ?? 0) > 0 && (
                    <>
                      <div style={styles.analysisSubheading}>Phrases & grammar</div>
                      {(analysis.fixedPhrases ?? []).map((ph, i) => {
                        const saveKey = ph.canonicalForm;
                        const ss = idiomSaveState[saveKey];
                        return (
                          <div key={`fp-${i}`} style={styles.phraseCard}>
                            <div style={styles.phraseHeader}>
                              <span style={styles.phraseCanon}>{ph.canonicalForm}</span>
                              <span style={styles.phraseKind}>{ph.kind}</span>
                              <button
                                title={ss === 'saved'
                                  ? 'Saved'
                                  : ss === 'saving'
                                    ? 'Saving…'
                                    : ss === 'error'
                                      ? idiomSaveError[saveKey] || 'Could not add this item.'
                                      : 'Save to vocabulary'}
                                style={{
                                  ...styles.saveIdiomBtn,
                                  ...(ss === 'saved' ? styles.saveIdiomBtnSaved : {}),
                                  ...(ss === 'error' ? styles.saveIdiomBtnError : {}),
                                }}
                                disabled={ss === 'saving' || ss === 'saved'}
                                onClick={() => handleSaveIdiom(
                                  ph.canonicalForm,
                                  ph.foundInText,
                                  ph.kind,
                                  ph.meaning,
                                  ph.example,
                                  sentence.text,
                                  buildSourceUrl(sentence),
                                  document.title,
                                )}
                              >
                                {ss === 'saved' ? '✓' : ss === 'saving' ? '…' : ss === 'error' ? '✕' : '＋'}
                              </button>
                            </div>
                            <div style={styles.phraseFound}>
                              „{ph.foundInText}“
                            </div>
                            <div style={styles.phraseMeaning}>{ph.meaning}</div>
                            {ss === 'error' && idiomSaveError[saveKey] && (
                              <div style={styles.saveIdiomError}>{idiomSaveError[saveKey]}</div>
                            )}
                            {ph.example && (
                              <div style={styles.phraseExample}>{ph.example}</div>
                            )}
                          </div>
                        );
                      })}
                    </>
                  )}

                  {(analysis.phrasalVerbs?.length ?? 0) > 0 && (
                    <>
                      <div style={styles.analysisSubheading}>Phrasal & particle verbs</div>
                      {analysis.phrasalVerbs.map((pv, i) => {
                        const saveKey = pv.baseForm;
                        const ss = idiomSaveState[saveKey];
                        return (
                          <div key={`pv-${i}`} style={styles.verbCard}>
                            <div style={styles.verbHeader}>
                              <span style={styles.baseForm}>{pv.baseForm}</span>
                              <span style={styles.verbMeaning}>{pv.meaning}</span>
                              <button
                                title={ss === 'saved'
                                  ? 'Saved'
                                  : ss === 'saving'
                                    ? 'Saving…'
                                    : ss === 'error'
                                      ? idiomSaveError[saveKey] || 'Could not add this item.'
                                      : 'Save to vocabulary'}
                                style={{
                                  ...styles.saveIdiomBtn,
                                  ...(ss === 'saved' ? styles.saveIdiomBtnSaved : {}),
                                  ...(ss === 'error' ? styles.saveIdiomBtnError : {}),
                                }}
                                disabled={ss === 'saving' || ss === 'saved'}
                                onClick={() => handleSaveIdiom(
                                  pv.baseForm,
                                  pv.foundInText,
                                  'phrasal_verb',
                                  pv.meaning,
                                  pv.example,
                                  sentence.text,
                                  buildSourceUrl(sentence),
                                  document.title,
                                )}
                              >
                                {ss === 'saved' ? '✓' : ss === 'saving' ? '…' : ss === 'error' ? '✕' : '＋'}
                              </button>
                            </div>
                            {ss === 'error' && idiomSaveError[saveKey] && (
                              <div style={styles.saveIdiomError}>{idiomSaveError[saveKey]}</div>
                            )}
                            <div style={styles.verbDetail}>
                              <span style={styles.chip}>{pv.prefix}‑</span>
                              <span style={{ color: '#555', fontSize: 12 }}>+ </span>
                              <span style={styles.chip}>{pv.stem}</span>
                              <span style={{ marginLeft: 8, color: '#888', fontSize: 12, fontStyle: 'italic' }}>
                                found as: "{pv.foundInText}"
                              </span>
                            </div>
                            <div style={styles.exampleText}>{pv.example}</div>
                          </div>
                        );
                      })}
                    </>
                  )}

                  {(analysis.phrasalVerbs?.length ?? 0) === 0 &&
                    (analysis.fixedPhrases?.length ?? 0) === 0 && (
                    <p style={styles.noteText}>
                      {analysis.note || 'No learner-worthy phrases or grammar constructions detected.'}
                    </p>
                  )}
                  {(analysis.phrasalVerbs?.length ?? 0) + (analysis.fixedPhrases?.length ?? 0) >
                    0 &&
                    analysis.note &&
                    analysis.note.trim().length > 0 && (
                      <p style={styles.noteTextMuted}>{analysis.note}</p>
                    )}
                </div>
              )}
            </div>
          );
        })}
        <div style={{ height: 40 }} />
      </div>

      {/* Floating word-meaning popup */}
      {wordPopup && (
        (() => {
          const popupSaveKey = (wordPopup.lemma || wordPopup.word || '').trim();
          const popupSaveState = popupSaveKey ? idiomSaveState[popupSaveKey] : undefined;
          const canSavePopupWord = !wordPopup.loading && !wordPopup.error && !!popupSaveKey;

          return (
        <div
          id="word-meaning-popup"
          style={{
            ...styles.wordPopup,
            left: Math.max(8, wordPopup.x),
            top: wordPopup.y
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            style={styles.wordPopupClose}
            onClick={() => setWordPopup(null)}
            aria-label="Close"
          >
            ×
          </button>
          <div style={styles.wordPopupTitle}>
            {wordPopup.display.trim()}
            {wordPopup.lemma && wordPopup.lemma !== wordPopup.word && (
              <span style={styles.wordPopupLemma}> · {wordPopup.lemma}</span>
            )}
          </div>
          <div style={styles.wordPopupActions}>
            <button
              type="button"
              title={
                popupSaveState === 'saved'
                  ? 'Added to to-learn list'
                  : popupSaveState === 'saving'
                    ? 'Saving…'
                    : 'Add to to-learn list'
              }
              style={{
                ...styles.wordPopupAddBtn,
                ...(popupSaveState === 'saved' ? styles.wordPopupAddBtnSaved : {}),
                ...(popupSaveState === 'error' ? styles.wordPopupAddBtnError : {}),
              }}
              disabled={!canSavePopupWord || popupSaveState === 'saving' || popupSaveState === 'saved'}
              onClick={handleSaveWordFromPopup}
            >
              {popupSaveState === 'saved'
                ? 'Added ✓'
                : popupSaveState === 'saving'
                  ? 'Saving…'
                  : popupSaveState === 'error'
                    ? 'Retry'
                    : 'Add'}
            </button>
          </div>
          {wordPopup.loading && (
            <div style={styles.wordPopupLoading}>Loading…</div>
          )}
          {wordPopup.error && (
            <div style={styles.wordPopupError}>{wordPopup.error}</div>
          )}
          {!wordPopup.loading &&
            !wordPopup.error &&
            (wordPopup.nounPhraseInSentence ||
              wordPopup.grammaticalCase ||
              wordPopup.articleAsInSentence ||
              wordPopup.dictionaryArticle ||
              wordPopup.adjectiveAgreement ||
              wordPopup.caseGovernor ||
              (wordPopup.verbPrepositions && wordPopup.verbPrepositions.length > 0)) && (
            <div style={styles.wordPopupGrammarOuter}>
              {(wordPopup.nounPhraseInSentence ||
                wordPopup.grammaticalCase ||
                wordPopup.articleAsInSentence ||
                wordPopup.dictionaryArticle ||
                wordPopup.adjectiveAgreement ||
                wordPopup.caseGovernor) && (
                <div style={styles.wordPopupGrammar}>
                  {wordPopup.nounPhraseInSentence && (
                    <div style={styles.wordPopupPhrase}>
                      <span style={styles.wordPopupGrammarLabel}>Phrase</span>
                      {wordPopup.nounPhraseInSentence}
                    </div>
                  )}
                  <div style={styles.wordPopupGrammarRow}>
                    {wordPopup.grammaticalCase && (
                      <span style={styles.wordPopupCaseChip}>
                        {CASE_LABEL_DE[wordPopup.grammaticalCase.toLowerCase()] ||
                          wordPopup.grammaticalCase}
                      </span>
                    )}
                    {wordPopup.articleAsInSentence && (
                      <span style={styles.wordPopupMeta}>
                        Im Satz: <strong>{wordPopup.articleAsInSentence}</strong>
                      </span>
                    )}
                    {wordPopup.dictionaryArticle && (
                      <span style={styles.wordPopupMeta}>
                        Wörterbuch: <strong>{wordPopup.dictionaryArticle}</strong>
                      </span>
                    )}
                  </div>
                  {wordPopup.adjectiveAgreement && (
                    <div style={styles.wordPopupAdj}>
                      <span style={styles.wordPopupGrammarLabel}>Adjektive</span>
                      {wordPopup.adjectiveAgreement}
                    </div>
                  )}
                  {wordPopup.caseGovernor && (
                    <div style={styles.wordPopupGovernor}>
                      <span style={styles.wordPopupGrammarLabel}>Passt zu</span>
                      {wordPopup.caseGovernor}
                    </div>
                  )}
                </div>
              )}
              {wordPopup.verbPrepositions && wordPopup.verbPrepositions.length > 0 && (
                <div style={styles.wordPopupVerbPrep}>
                  <span style={styles.wordPopupGrammarLabel}>Verb + Präposition (+ Kasus)</span>
                  <ul style={styles.wordPopupVerbPrepList}>
                    {wordPopup.verbPrepositions.map((vp, i) => (
                      <li key={i} style={styles.wordPopupVerbPrepItem}>
                        <span style={styles.wordPopupVerbPrepPrep}>{vp.preposition}</span>
                        <span style={styles.wordPopupCaseChipSmall}>
                          + {CASE_LABEL_DE[vp.case] || vp.case}
                        </span>
                        {vp.note && (
                          <div style={styles.wordPopupVerbPrepNote}>{vp.note}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {!wordPopup.loading && wordPopup.meaning && (
            <div style={styles.wordPopupBody}>{wordPopup.meaning}</div>
          )}
        </div>
          );
        })()
      )}
    </div>
  );
};

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  center: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', height: '100%', minHeight: 200
  },
  spinner: {
    width: 28, height: 28, border: '3px solid #e0e0e0',
    borderTop: '3px solid #667eea', borderRadius: '50%',
    animation: 'spin 0.8s linear infinite'
  },
  header: {
    position: 'sticky', top: 0, zIndex: 10, backgroundColor: '#fff',
    borderBottom: '1px solid #e8e8e8', padding: '10px 16px',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 10
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 10
  },
  navControls: {
    display: 'flex',
    alignItems: 'center',
    gap: 6
  },
  navBtn: {
    border: '1px solid #cbd5e1',
    borderRadius: 999,
    backgroundColor: '#f8fafc',
    color: '#334155',
    fontSize: 11,
    fontWeight: 700,
    lineHeight: 1.1,
    padding: '4px 9px',
    cursor: 'pointer'
  },
  targetLanguageLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    color: '#64748b',
    fontWeight: 600
  },
  profileBtn: {
    border: '1px solid #cbd5e1',
    borderRadius: 6,
    backgroundColor: '#fff',
    color: '#475569',
    fontSize: 11,
    fontWeight: 700,
    padding: '4px 7px',
    cursor: 'pointer'
  },
  list: { padding: '12px 12px 0', overflowY: 'auto' as const },
  card: {
    borderRadius: 6, border: '1px solid #e8e8e8', padding: '10px 12px',
    marginBottom: 8, transition: 'background-color 0.2s, box-shadow 0.2s, border-color 0.2s'
  },
  meta: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 11, color: '#aaa', marginBottom: 6
  },
  shadowDisabledBanner: {
    margin: '8px 12px 0',
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid #fecaca',
    backgroundColor: '#fff1f2',
    color: '#9f1239',
    fontSize: 12,
    lineHeight: 1.35
  },
  timeBtn: {
    cursor: 'pointer', color: '#667eea', fontWeight: 600,
    fontVariantNumeric: 'tabular-nums' as const
  },
  shadowBtn: {
    marginLeft: 10,
    border: '1px solid #94a3b8',
    borderRadius: 999,
    backgroundColor: '#f8fafc',
    color: '#334155',
    fontSize: 11,
    fontWeight: 700,
    lineHeight: 1.1,
    padding: '4px 9px',
    cursor: 'pointer'
  },
  shadowBtnRecording: {
    border: '1px solid #ef4444',
    backgroundColor: '#fef2f2',
    color: '#b91c1c'
  },
  shadowBtnDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed'
  },
  sentenceText: { fontSize: 14, lineHeight: 1.6, color: '#333' },
  shadowPanel: {
    marginTop: 8,
    borderTop: '1px dashed #e2e8f0',
    paddingTop: 8
  },
  shadowHint: {
    margin: 0,
    fontSize: 12,
    color: '#475569'
  },
  shadowError: {
    margin: 0,
    fontSize: 12,
    color: '#b91c1c'
  },
  shadowSummaryRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6
  },
  shadowScoreBadge: {
    borderRadius: 999,
    backgroundColor: '#e0e7ff',
    color: '#3730a3',
    fontSize: 12,
    fontWeight: 700,
    padding: '3px 9px',
    minWidth: 54,
    textAlign: 'center' as const
  },
  shadowSummaryText: {
    fontSize: 12,
    color: '#334155'
  },
  shadowTranscript: {
    fontSize: 12,
    color: '#1f2937',
    marginBottom: 6
  },
  shadowTranscriptLabel: {
    fontWeight: 700,
    color: '#0f172a'
  },
  shadowWordGrid: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 6
  },
  shadowWordChip: {
    borderRadius: 999,
    fontSize: 11,
    padding: '2px 8px',
    border: '1px solid transparent'
  },
  shadowWordChipMatched: {
    backgroundColor: '#ecfdf5',
    borderColor: '#86efac',
    color: '#166534'
  },
  shadowWordChipUnmatched: {
    backgroundColor: '#fef2f2',
    borderColor: '#fca5a5',
    color: '#991b1b'
  },
  wordSpan: {
    cursor: 'pointer',
    borderRadius: 3,
    padding: '1px 2px',
    margin: '0 -1px',
    transition: 'background-color 0.15s, color 0.15s',
    borderBottom: '1px dotted rgba(102, 126, 234, 0.45)'
  },
  wordPopup: {
    position: 'fixed' as const,
    zIndex: 1000,
    maxWidth: 280,
    padding: '10px 28px 10px 10px',
    backgroundColor: '#fff',
    border: '1px solid #c7d2fe',
    borderRadius: 8,
    boxShadow: '0 8px 24px rgba(30, 27, 75, 0.18)',
    fontSize: 13,
    lineHeight: 1.45,
    color: '#1e1b4b'
  },
  wordPopupClose: {
    position: 'absolute' as const,
    top: 4,
    right: 6,
    width: 24,
    height: 24,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    fontSize: 18,
    lineHeight: 1,
    color: '#64748b',
    padding: 0
  },
  wordPopupTitle: {
    fontWeight: 700,
    fontSize: 14,
    marginBottom: 6,
    borderBottom: '1px solid #e9e7fd',
    paddingBottom: 6
  },
  wordPopupLemma: { fontWeight: 500, color: '#6366f1', fontSize: 12 },
  wordPopupBody: { color: '#334155', fontSize: 13, marginTop: 8 },
  wordPopupActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    marginBottom: 2
  },
  wordPopupAddBtn: {
    border: '1px solid #6366f1',
    borderRadius: 6,
    backgroundColor: '#eef2ff',
    color: '#4338ca',
    fontSize: 11,
    fontWeight: 700,
    lineHeight: 1.2,
    padding: '4px 8px',
    cursor: 'pointer'
  },
  wordPopupAddBtnSaved: {
    border: '1px solid #16a34a',
    backgroundColor: '#f0fdf4',
    color: '#15803d',
    cursor: 'default'
  },
  wordPopupAddBtnError: {
    border: '1px solid #dc2626',
    backgroundColor: '#fef2f2',
    color: '#dc2626'
  },
  wordPopupGrammarOuter: {
    marginTop: 4,
    marginBottom: 4,
    padding: '8px 0',
    borderTop: '1px solid #e9e7fd',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10
  },
  wordPopupGrammar: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8
  },
  wordPopupVerbPrep: { marginTop: 2 },
  wordPopupVerbPrepList: {
    margin: '6px 0 0',
    paddingLeft: 18,
    listStyleType: 'disc' as const
  },
  wordPopupVerbPrepItem: { marginBottom: 8, fontSize: 12, color: '#334155' },
  wordPopupVerbPrepPrep: {
    fontWeight: 700,
    color: '#4338ca',
    marginRight: 6
  },
  wordPopupCaseChipSmall: {
    fontSize: 10,
    fontWeight: 600,
    backgroundColor: '#ede9fe',
    color: '#5b21b6',
    padding: '1px 6px',
    borderRadius: 999
  },
  wordPopupVerbPrepNote: {
    marginTop: 4,
    fontSize: 11,
    color: '#64748b',
    fontStyle: 'italic' as const,
    lineHeight: 1.4
  },
  wordPopupPhrase: {
    fontSize: 13,
    color: '#312e81',
    fontStyle: 'italic' as const,
    lineHeight: 1.45
  },
  wordPopupGrammarLabel: {
    display: 'block',
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    color: '#6366f1',
    marginBottom: 2
  },
  wordPopupGrammarRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 8,
    alignItems: 'center'
  },
  wordPopupCaseChip: {
    fontSize: 11,
    fontWeight: 700,
    backgroundColor: '#ede9fe',
    color: '#5b21b6',
    padding: '2px 8px',
    borderRadius: 999
  },
  wordPopupMeta: { fontSize: 12, color: '#475569' },
  wordPopupAdj: { fontSize: 12, color: '#334155', lineHeight: 1.45 },
  wordPopupGovernor: { fontSize: 12, color: '#334155', lineHeight: 1.45 },
  wordPopupLoading: { color: '#94a3b8', fontSize: 12 },
  wordPopupError: { color: '#dc2626', fontSize: 12 },
  explainBtn: {
    display: 'inline-block', marginBottom: 6,
    fontSize: 11, fontWeight: 600, padding: '3px 8px',
    borderRadius: 10, border: '1px solid #c7d2fe',
    backgroundColor: '#eef2ff', color: '#4f46e5',
    cursor: 'pointer', transition: 'background 0.15s'
  },
  explainBtnActive: {
    backgroundColor: '#e0e7ff', borderColor: '#a5b4fc', color: '#3730a3'
  },

  // Analysis
  analysisWrap: {
    marginTop: 10, paddingTop: 10,
    borderTop: '1px dashed #e0e0e0',
    display: 'flex', flexDirection: 'column' as const, gap: 8
  },
  analysisSpinner: {
    width: 16, height: 16, border: '2px solid #e0e0e0',
    borderTop: '2px solid #667eea', borderRadius: '50%',
    animation: 'spin 0.8s linear infinite', alignSelf: 'center' as const
  },
  noteText: { fontSize: 12, color: '#999', margin: 0, fontStyle: 'italic' },
  noteTextMuted: { fontSize: 11, color: '#aaa', margin: '8px 0 0', fontStyle: 'italic' },
  explainAuthCallout: {
    border: '1px solid #fecaca',
    borderRadius: 6,
    backgroundColor: '#fff1f2',
    padding: '8px 10px'
  },
  explainAuthText: {
    margin: 0,
    color: '#9f1239',
    fontSize: 12,
    fontWeight: 600
  },
  explainAuthActions: {
    marginTop: 8,
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap' as const
  },
  explainAuthPrimaryBtn: {
    border: '1px solid #be123c',
    borderRadius: 999,
    backgroundColor: '#be123c',
    color: '#fff',
    fontSize: 11,
    fontWeight: 700,
    lineHeight: 1.1,
    padding: '4px 10px',
    cursor: 'pointer'
  },
  explainAuthSecondaryBtn: {
    border: '1px solid #fda4af',
    borderRadius: 999,
    backgroundColor: '#fff',
    color: '#9f1239',
    fontSize: 11,
    fontWeight: 700,
    lineHeight: 1.1,
    padding: '4px 10px',
    cursor: 'pointer'
  },
  explainAuthBtnDisabled: {
    opacity: 0.7,
    cursor: 'wait'
  },
  explainAuthError: {
    margin: '8px 0 0',
    fontSize: 11,
    color: '#b91c1c'
  },
  analysisSubheading: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    color: '#64748b',
    marginTop: 4,
    marginBottom: 2
  },
  phraseCard: {
    backgroundColor: '#f0fdfa',
    borderRadius: 6,
    border: '1px solid #99f6e4',
    padding: '8px 10px',
    marginBottom: 4
  },
  phraseHeader: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    flexWrap: 'wrap' as const,
    marginBottom: 4
  },
  phraseCanon: { fontWeight: 700, fontSize: 14, color: '#0f766e' },
  phraseKind: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    color: '#0d9488',
    backgroundColor: '#ccfbf1',
    padding: '2px 6px',
    borderRadius: 4
  },
  saveIdiomBtn: {
    marginLeft: 'auto',
    flexShrink: 0,
    background: 'none',
    border: '1px solid #0d9488',
    borderRadius: 4,
    color: '#0d9488',
    fontSize: 13,
    fontWeight: 700,
    lineHeight: 1,
    padding: '2px 7px',
    cursor: 'pointer',
  },
  saveIdiomBtnSaved: {
    border: '1px solid #16a34a',
    color: '#16a34a',
    cursor: 'default',
  },
  saveIdiomBtnError: {
    border: '1px solid #dc2626',
    color: '#dc2626',
  },
  saveIdiomError: {
    marginTop: 4,
    color: '#b91c1c',
    fontSize: 11,
    lineHeight: 1.35,
  },
  phraseFound: { fontSize: 12, color: '#115e59', marginBottom: 4 },
  phraseMeaning: { fontSize: 12, color: '#334155', lineHeight: 1.45 },
  phraseExample: {
    fontSize: 11,
    color: '#64748b',
    fontStyle: 'italic' as const,
    marginTop: 6
  },
  verbCard: {
    backgroundColor: '#f8f9ff', borderRadius: 6,
    border: '1px solid #dde3ff', padding: '8px 10px'
  },
  verbHeader: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 },
  baseForm: { fontWeight: 700, fontSize: 15, color: '#3730a3' },
  verbMeaning: { fontSize: 12, color: '#555' },
  verbDetail: { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 },
  chip: {
    display: 'inline-block', fontSize: 11, fontWeight: 600,
    backgroundColor: '#ede9fe', color: '#5b21b6',
    borderRadius: 3, padding: '1px 5px'
  },
  exampleText: { fontSize: 12, color: '#666', fontStyle: 'italic' }
};

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<PanelApp />);
