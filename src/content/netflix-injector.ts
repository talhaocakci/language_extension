import type { SubtitleChunk } from '../types/subtitle';
import type { MeaningfulSentence } from '../types/subtitle';
import type { MessageRequest, MessageResponse, PlaybackControlPayload } from '../types/common';
import { groupAndProcessSubtitles } from '../utils/subtitle-processor';

let subtitleObserver: MutationObserver | null = null;
let subtitleCaptureInterval: number | null = null;
let overlayRefreshInterval: number | null = null;
let lastCapturedSubtitleText = '';
let lastPlaybackHref = '';
let collectedSubtitles: SubtitleChunk[] = [];
let meaningfulSentences: MeaningfulSentence[] = [];
let lastDetectedCaptionLanguageCode = '';

type StreamingPlatform = 'netflix' | 'max';

interface PhrasalVerb {
  foundInText: string;
  baseForm: string;
  meaning: string;
  prefix: string;
  stem: string;
  example: string;
}

interface FixedPhrase {
  foundInText: string;
  kind: string;
  canonicalForm: string;
  meaning: string;
  example?: string;
}

interface SentenceAnalysis {
  phrasalVerbs: PhrasalVerb[];
  fixedPhrases: FixedPhrase[];
  note: string;
}

interface VerbPreposition {
  preposition: string;
  case: 'nominative' | 'accusative' | 'dative' | 'genitive';
  note?: string;
}

interface WordMeaning {
  lemma: string;
  meaning: string;
  nounPhraseInSentence?: string | null;
  grammaticalCase?: 'nominative' | 'accusative' | 'dative' | 'genitive' | null;
  articleAsInSentence?: string | null;
  dictionaryArticle?: 'der' | 'die' | 'das' | null;
  adjectiveAgreement?: string | null;
  caseGovernor?: string | null;
  verbPrepositions?: VerbPreposition[] | null;
}

interface WordPopupState {
  sentenceKey: string;
  sourceSentence: string;
  sourceStartTime: number;
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

interface OverlayToken {
  type: 'word' | 'space';
  raw: string;
  clean: string;
}

type OverlaySaveState = 'saving' | 'saved' | 'error';
type OverlayNavDirection = 'prev' | 'repeat' | 'next';

const OVERLAY_ID = 'subtitle-learning-onvideo-overlay';
const WORD_POPUP_ID = 'subtitle-learning-word-popup';
const MIN_WORD_DURATION_MS = 320;
const OVERLAY_TARGET_LANGUAGE_SELECT_ID = 'sl-overlay-target-language';
const OVERLAY_ENABLE_WORD_HIGHLIGHTING = false;
const SLOW_PLAYBACK_RATE = 0.75;
const NORMAL_PLAYBACK_RATE = 1;

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

let overlayLastSentenceKey = '';
let overlayLastWordIndex = -1;
let overlayLastSentenceIndex = -1;
let overlayLastRenderTimeMs = 0;
let overlayStableSentenceIndex = -1;
let overlayHidden = true;
let overlayListenersBound = false;

let overlayCurrentSentence: MeaningfulSentence | null = null;
let overlayExplainVisible = false;
let overlayExplainLoading = false;
let overlayExplainError: string | null = null;
let overlayExplainAuthActionLoading = false;
let overlayExplainAuthActionError: string | null = null;
let overlayAnalysisSentenceKey = '';
let overlayTargetLanguageCode = '';
let overlayTargetLanguageManual = false;

let overlayWordPopup: WordPopupState | null = null;
let overlayWordLookupReqId = 0;

const wordMeaningCache: Record<string, WordMeaning> = {};
const sentenceAnalysisCache: Record<string, SentenceAnalysis> = {};
const overlaySaveState: Record<string, OverlaySaveState> = {};

const CASE_LABEL_DE: Record<string, string> = {
  nominative: 'Nominativ',
  accusative: 'Akkusativ',
  dative: 'Dativ',
  genitive: 'Genitiv'
};

function detectPlatform(): StreamingPlatform {
  const host = window.location.hostname.toLowerCase();
  if (
    host === 'max.com' ||
    host.endsWith('.max.com') ||
    host === 'hbomax.com' ||
    host.endsWith('.hbomax.com')
  ) {
    return 'max';
  }

  return 'netflix';
}

const activePlatform: StreamingPlatform = detectPlatform();

function resetSubtitleState(): void {
  lastCapturedSubtitleText = '';
  collectedSubtitles = [];
  meaningfulSentences = [];
  lastDetectedCaptionLanguageCode = '';

  overlayLastSentenceKey = '';
  overlayLastWordIndex = -1;
  overlayLastSentenceIndex = -1;
  overlayLastRenderTimeMs = 0;
  overlayStableSentenceIndex = -1;

  overlayCurrentSentence = null;
  overlayExplainVisible = false;
  overlayExplainLoading = false;
  overlayExplainError = null;
  overlayExplainAuthActionLoading = false;
  overlayExplainAuthActionError = null;
  overlayAnalysisSentenceKey = '';
  overlayTargetLanguageCode = '';
  overlayTargetLanguageManual = false;

  overlayWordPopup = null;
  overlayWordLookupReqId += 1;

  hideOnVideoSentenceOverlay();
  renderOverlayWordPopup();
}

function getCurrentTimeMs(): number | null {
  const videoElement = document.querySelector('video') as HTMLVideoElement | null;
  if (!videoElement || Number.isNaN(videoElement.currentTime)) {
    return null;
  }
  return Math.max(0, Math.round(videoElement.currentTime * 1000));
}

function getVideoElement(): HTMLVideoElement | null {
  const videoElement = document.querySelector('video') as HTMLVideoElement | null;
  if (!videoElement) return null;
  return videoElement;
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return target.isContentEditable;
}

function normalizeSubtitleText(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\u200B/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isElementVisible(element: Element): boolean {
  const htmlElement = element as HTMLElement;
  const style = window.getComputedStyle(htmlElement);
  if (style.display === 'none' || style.visibility === 'hidden') {
    return false;
  }

  const rect = htmlElement.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

function extractTextFromCue(cue: TextTrackCue): string {
  const maybeVttCue = cue as VTTCue;
  const rawText =
    typeof maybeVttCue.text === 'string'
      ? maybeVttCue.text
      : (cue as unknown as { text?: string }).text || cue.id || '';
  return normalizeSubtitleText(rawText);
}

function getSubtitleTextFromMediaTextTracks(): string {
  const videoElement = document.querySelector('video') as HTMLVideoElement | null;
  if (!videoElement || !videoElement.textTracks || videoElement.textTracks.length === 0) {
    return '';
  }

  const activeLines: string[] = [];
  for (let i = 0; i < videoElement.textTracks.length; i += 1) {
    const track = videoElement.textTracks[i];
    if (track.kind !== 'subtitles' && track.kind !== 'captions') {
      continue;
    }

    const activeCues = track.activeCues;
    if (!activeCues || activeCues.length === 0) {
      continue;
    }

    for (let cueIndex = 0; cueIndex < activeCues.length; cueIndex += 1) {
      const cue = activeCues[cueIndex];
      if (!cue) continue;
      const cueText = extractTextFromCue(cue);
      if (cueText) {
        activeLines.push(cueText);
      }
    }
  }

  return normalizeSubtitleText(activeLines.join(' '));
}

function normalizeLanguageCode(value: string): string {
  const lang = (value || '').trim().toLowerCase();
  if (!lang) return '';
  return lang.split(/[-_]/)[0] || '';
}

function buildTargetLanguageOptions(
  detectedCode: string,
  selectedCode: string,
): Array<{ code: string; label: string }> {
  const baseCodes = Object.keys(TARGET_LANGUAGE_LABELS);
  const set = new Set<string>(baseCodes);
  if (detectedCode) set.add(detectedCode);
  if (selectedCode) set.add(selectedCode);
  return Array.from(set).map((code) => ({
    code,
    label: TARGET_LANGUAGE_LABELS[code] || code.toUpperCase(),
  }));
}

function syncOverlayTargetLanguageFromCaptionTrack(): void {
  const detected = getActiveSubtitleLanguageCodeFromTracks();
  if (!detected) return;
  if (!overlayTargetLanguageManual || !overlayTargetLanguageCode) {
    overlayTargetLanguageCode = detected;
  }
}

function getOverlayEffectiveTargetLanguage(): string {
  return overlayTargetLanguageCode || lastDetectedCaptionLanguageCode || 'de';
}

function getActiveSubtitleLanguageCodeFromTracks(): string {
  const videoElement = document.querySelector('video') as HTMLVideoElement | null;
  if (!videoElement || !videoElement.textTracks || videoElement.textTracks.length === 0) {
    return lastDetectedCaptionLanguageCode;
  }

  const subtitleTracks: TextTrack[] = [];
  for (let i = 0; i < videoElement.textTracks.length; i += 1) {
    const track = videoElement.textTracks[i];
    if (track.kind !== 'subtitles' && track.kind !== 'captions') continue;
    subtitleTracks.push(track);

    const activeCues = track.activeCues;
    if (!activeCues || activeCues.length === 0) continue;
    const lang = normalizeLanguageCode(track.language || '');
    if (!lang) continue;
    lastDetectedCaptionLanguageCode = lang;
    return lang;
  }

  for (const track of subtitleTracks) {
    if (track.mode !== 'showing') continue;
    const lang = normalizeLanguageCode(track.language || '');
    if (!lang) continue;
    lastDetectedCaptionLanguageCode = lang;
    return lang;
  }

  for (const track of subtitleTracks) {
    const lang = normalizeLanguageCode(track.language || '');
    if (!lang) continue;
    lastDetectedCaptionLanguageCode = lang;
    return lang;
  }

  const domTrackNodes = videoElement.querySelectorAll('track[kind="subtitles"], track[kind="captions"]');
  for (const node of Array.from(domTrackNodes)) {
    const el = node as HTMLTrackElement;
    const lang = normalizeLanguageCode(el.srclang || el.label || '');
    if (!lang) continue;
    lastDetectedCaptionLanguageCode = lang;
    return lang;
  }

  return lastDetectedCaptionLanguageCode;
}

interface SubtitleDomProbe {
  selector: string;
  allowHidden?: boolean;
}

function getSubtitleTextFromDomProbes(probes: SubtitleDomProbe[]): string {
  for (const probe of probes) {
    const nodes = Array.from(document.querySelectorAll(probe.selector));
    if (nodes.length === 0) {
      continue;
    }

    const lines = nodes
      .filter((node) => probe.allowHidden || isElementVisible(node))
      .map((node) => normalizeSubtitleText(extractNodeTextPreferWordBoundaries(node)))
      .filter(Boolean);

    const merged = normalizeSubtitleText(lines.join(' '));
    if (merged && merged.length <= 320) {
      return merged;
    }
  }

  return '';
}

function extractNodeTextPreferWordBoundaries(node: Element): string {
  const el = node as HTMLElement;
  const raw = (el.innerText || node.textContent || '').trim();

  const leafParts: string[] = [];
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    const text = (current.textContent || '').trim();
    if (text) {
      leafParts.push(text);
    }
    current = walker.nextNode();
  }

  const leafJoined = normalizeSubtitleText(leafParts.join(' '));
  if (leafJoined) {
    const rawWordCount = raw.split(/\s+/).filter(Boolean).length;
    const leafWordCount = leafJoined.split(/\s+/).filter(Boolean).length;
    if (leafWordCount > rawWordCount) {
      return leafJoined;
    }
  }

  const childParts = Array.from(node.childNodes)
    .map((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        return (child.textContent || '').trim();
      }
      if (child.nodeType === Node.ELEMENT_NODE) {
        const childEl = child as HTMLElement;
        return (childEl.innerText || childEl.textContent || '').trim();
      }
      return '';
    })
    .filter(Boolean);

  if (childParts.length <= 1) return raw;

  const childJoined = normalizeSubtitleText(childParts.join(' '));
  const rawWordCount = raw.split(/\s+/).filter(Boolean).length;
  const childWordCount = childJoined.split(/\s+/).filter(Boolean).length;

  // Prefer child-joined text when it preserves more token boundaries than raw extracted text.
  if (childWordCount > rawWordCount) {
    return childJoined;
  }
  return raw;
}

function getVisibleSubtitleTextFromNetflix(): string {
  const probes: SubtitleDomProbe[] = [
    { selector: '[data-uia="subtitle"]' },
    { selector: '.player-timedtext [class*="timedtext-text"]', allowHidden: true },
    { selector: '.player-timedtext [class*="caption"]', allowHidden: true },
    { selector: '.player-timedtext', allowHidden: true },
    { selector: '.watch-video [data-uia*="subtitle"]' },
    { selector: '.lln-subs .lln-sub-text' }
  ];

  const fromDom = getSubtitleTextFromDomProbes(probes);
  if (fromDom) return fromDom;

  const fromTracks = getSubtitleTextFromMediaTextTracks();
  if (fromTracks) return fromTracks;

  return '';
}

function getVisibleSubtitleTextFromMax(): string {
  const rowNodes = document.querySelectorAll('[data-testid="cueBoxRow"], [data-testid*="caption_renderer_overlay"] [data-testid*="cueBoxRow"]');
  const rowLines = Array.from(rowNodes)
    .map((node) => extractNodeTextPreferWordBoundaries(node))
    .filter(Boolean);
  if (rowLines.length > 0) {
    return normalizeSubtitleText(rowLines.join(' '));
  }

  let cueNodes = document.querySelectorAll('[data-testid="cueBoxRowTextCue"]');
  if (cueNodes.length === 0) {
    cueNodes = document.querySelectorAll('[data-testid="caption_renderer_overlay"] [class*="TextCue"]');
  }

  const cueLines = Array.from(cueNodes)
    .map((node) => extractNodeTextPreferWordBoundaries(node))
    .filter(Boolean);
  if (cueLines.length > 0) {
    return normalizeSubtitleText(cueLines.join(' '));
  }

  const fromTracks = getSubtitleTextFromMediaTextTracks();
  if (fromTracks) {
    return fromTracks;
  }

  return '';
}

function extractSubtitlesFromNetflix(): SubtitleChunk[] {
  const subtitles: SubtitleChunk[] = [];

  try {
    const text =
      activePlatform === 'max'
        ? getVisibleSubtitleTextFromMax()
        : getVisibleSubtitleTextFromNetflix();
    if (!text) return subtitles;

    const currentTimeMs = getCurrentTimeMs();
    if (currentTimeMs === null) return subtitles;

    const startTime = currentTimeMs;
    const endTime = startTime + 1200;
    subtitles.push({ text, startTime, endTime });
  } catch (error) {
    console.error('Error extracting subtitles:', error);
  }

  return subtitles;
}

function getSessionId(): string {
  const url = new URL(window.location.href);
  if (activePlatform === 'max') {
    const maxPathMatch =
      url.pathname.match(/\/video\/watch\/([^/?#]+(?:\/[^/?#]+)?)/) ||
      url.pathname.match(/\/watch\/([^/?#]+)/);
    return maxPathMatch ? maxPathMatch[1] : url.pathname;
  }

  const netflixPathMatch = url.pathname.match(/\/watch\/(\d+)/);
  return netflixPathMatch ? netflixPathMatch[1] : '';
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
        typeof o.foundInText === 'string'
          ? o.foundInText
          : typeof o.foundIn_sentence === 'string'
            ? o.foundIn_sentence
            : '';
      const canon =
        typeof o.canonicalForm === 'string'
          ? o.canonicalForm
          : typeof o.expression === 'string'
            ? o.expression
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
    verbPrepositions,
  };
}

function tokenizeSentence(text: string): OverlayToken[] {
  const tokens: OverlayToken[] = [];
  const re = /(\s+)|([^\s]+)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) {
      tokens.push({ type: 'space', raw: m[1], clean: '' });
    } else {
      const raw = m[2];
      const clean = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      tokens.push({ type: 'word', raw, clean });
    }
  }
  return tokens;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function callOverlayLLM(
  messages: { role: string; content: string }[],
  model = 'gpt-4o-mini'
): Promise<string> {
  const resp = (await chrome.runtime.sendMessage({
    type: 'OVERLAY_CALL_LLM',
    payload: { messages, model }
  })) as MessageResponse<{ content: string }>;

  if (!resp?.success || !resp.data?.content) {
    throw new Error(resp?.error || 'Failed to call analysis backend.');
  }

  return resp.data.content;
}

async function lookupWordInContext(word: string, sentence: string): Promise<WordMeaning> {
  const systemPrompt = `You are a German teacher. The learner clicked a token in a German sentence.

Return ONLY valid JSON with these keys (use null when not applicable):
- "lemma": dictionary form / base form of the clicked word or its head noun.
- "meaning": 1–2 short English sentences: meaning IN THIS CONTEXT.

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

  const rawText = await callOverlayLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Clicked token: "${word}"\nFull sentence: "${sentence}"` }
  ]);

  const parsed = JSON.parse(rawText) as Record<string, unknown>;
  return normalizeWordMeaning(parsed, word);
}

async function analyseForPhrasalVerbs(sentence: string): Promise<SentenceAnalysis> {
  const resp = (await chrome.runtime.sendMessage({
    type: 'OVERLAY_EXPLAIN_SENTENCE',
    payload: { sentence }
  })) as MessageResponse<{ analysis: Record<string, unknown> }>;

  if (!resp?.success) {
    throw new Error(resp?.error || 'Failed to explain sentence.');
  }

  const parsed = (resp.data?.analysis || {}) as Record<string, unknown>;
  return normalizeSentenceAnalysis(parsed);
}

function isAuthRequiredExplainError(message: string): boolean {
  const m = message.toLowerCase();
  if (m.includes('only admin users')) return false;
  return (
    m.includes('not logged in') ||
    m.includes('session expired') ||
    m.includes('please sign in') ||
    m.includes('extension popup')
  );
}

function isAuthRequiredError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('not logged in') || m.includes('please sign in') || m.includes('session expired');
}

async function openExtensionPopupFromOverlay(): Promise<void> {
  overlayExplainAuthActionLoading = true;
  overlayExplainAuthActionError = null;
  renderExplainPanel();
  try {
    const resp = (await chrome.runtime.sendMessage({
      type: 'OPEN_EXTENSION_POPUP'
    })) as MessageResponse;
    if (!resp?.success) {
      overlayExplainAuthActionError = resp?.error || 'Could not open sign-in UI.';
    } else {
      overlayExplainAuthActionError = null;
    }
  } catch (err) {
    overlayExplainAuthActionError = err instanceof Error ? err.message : String(err);
  } finally {
    overlayExplainAuthActionLoading = false;
    renderExplainPanel();
  }
}

function getSentenceStableKey(sentence: MeaningfulSentence): string {
  const roundedStart = Math.round(sentence.startTime / 250) * 250;
  return `${roundedStart}|${sentence.text}`;
}

function buildSourceUrl(startTimeMs: number): string {
  const base = window.location.href;
  const seconds = Math.floor(startTimeMs / 1000);
  try {
    const url = new URL(base);
    url.searchParams.set('t', String(seconds));
    return url.toString();
  } catch {
    return base;
  }
}

function setOverlaySaveState(key: string, state?: OverlaySaveState): void {
  if (state) {
    overlaySaveState[key] = state;
  } else {
    delete overlaySaveState[key];
  }
  renderExplainPanel();
  renderOverlayWordPopup();
}

async function saveIdiomFromOverlay(
  canonicalForm: string,
  foundInText: string,
  kind: string,
  meaning: string,
  example: string | undefined,
  sourceSentence: string,
  sourceUrl: string,
  videoTitle: string,
): Promise<void> {
  if (!canonicalForm.trim()) return;

  setOverlaySaveState(canonicalForm, 'saving');
  const targetLanguage = getOverlayEffectiveTargetLanguage();

  try {
    const resp = (await chrome.runtime.sendMessage({
      type: 'SAVE_IDIOM',
      payload: {
        target_language: targetLanguage,
        canonical_form: canonicalForm,
        found_in_text: foundInText,
        kind,
        meaning,
        example: example || null,
        language: targetLanguage,
        source_sentence: sourceSentence,
        source_url: sourceUrl,
        video_title: videoTitle,
        tags: [],
      },
    })) as MessageResponse;

    if (resp?.success) {
      setOverlaySaveState(canonicalForm, 'saved');
      return;
    }

    console.error('SAVE_IDIOM failed:', resp?.error);
    if (resp?.error && isAuthRequiredError(resp.error)) {
      void openExtensionPopupFromOverlay();
    }
    setOverlaySaveState(canonicalForm, 'error');
    window.setTimeout(() => setOverlaySaveState(canonicalForm), 3000);
  } catch (error) {
    console.error('SAVE_IDIOM error:', error);
    setOverlaySaveState(canonicalForm, 'error');
    window.setTimeout(() => setOverlaySaveState(canonicalForm), 3000);
  }
}

function ensureWordPopupElement(): HTMLDivElement {
  const existing = document.getElementById(WORD_POPUP_ID) as HTMLDivElement | null;
  if (existing) return existing;

  const popup = document.createElement('div');
  popup.id = WORD_POPUP_ID;
  popup.style.cssText = `
    position: fixed;
    z-index: 2147483647;
    max-width: min(360px, 88vw);
    background: rgba(13, 18, 27, 0.96);
    border: 1px solid rgba(150, 175, 255, 0.44);
    border-radius: 10px;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.52);
    color: #eef3ff;
    padding: 10px 12px;
    font-size: 13px;
    line-height: 1.35;
    display: none;
    backdrop-filter: blur(3px);
    -webkit-backdrop-filter: blur(3px);
    pointer-events: auto;
  `;
  document.body.appendChild(popup);
  return popup;
}

function renderOverlayWordPopup(): void {
  const popup = ensureWordPopupElement();
  const state = overlayWordPopup;

  if (!state) {
    popup.style.display = 'none';
    return;
  }

  const estimatedWidth = 330;
  const x = Math.max(10, Math.min(window.innerWidth - estimatedWidth - 10, Math.round(state.x)));
  const y = Math.max(10, Math.min(window.innerHeight - 220, Math.round(state.y)));

  popup.style.left = `${x}px`;
  popup.style.top = `${y}px`;
  popup.style.display = 'block';

  if (state.loading) {
    popup.innerHTML = `<div style="color:#b9c9ff;font-weight:600;">${escapeHtml(state.display)}</div><div style="margin-top:6px;color:#d7e1ff;">Loading meaning…</div>`;
    return;
  }

  if (state.error) {
    popup.innerHTML = `<div style="color:#b9c9ff;font-weight:600;">${escapeHtml(state.display)}</div><div style="margin-top:6px;color:#ffb8b8;">${escapeHtml(state.error)}</div>`;
    return;
  }

  const rows: string[] = [];
  rows.push(`<div style="color:#b9c9ff;font-weight:700;">${escapeHtml(state.display)}</div>`);

  if (state.lemma) {
    rows.push(`<div style="margin-top:4px;color:#d5dfff;"><strong>Lemma:</strong> ${escapeHtml(state.lemma)}</div>`);
  }
  if (state.meaning) {
    rows.push(`<div style="margin-top:4px;color:#f3f7ff;">${escapeHtml(state.meaning)}</div>`);
  }
  if (state.nounPhraseInSentence) {
    rows.push(`<div style="margin-top:6px;color:#d5dfff;"><strong>Im Satz:</strong> ${escapeHtml(state.nounPhraseInSentence)}</div>`);
  }
  if (state.grammaticalCase) {
    const caseLabel = CASE_LABEL_DE[state.grammaticalCase] || state.grammaticalCase;
    rows.push(`<div style="margin-top:4px;color:#d5dfff;"><strong>Kasus:</strong> ${escapeHtml(caseLabel)}</div>`);
  }
  if (state.articleAsInSentence || state.dictionaryArticle) {
    const articleBits = [
      state.articleAsInSentence ? `Satz: ${escapeHtml(state.articleAsInSentence)}` : '',
      state.dictionaryArticle ? `Wörterbuch: ${escapeHtml(state.dictionaryArticle)}` : ''
    ].filter(Boolean).join(' · ');
    rows.push(`<div style="margin-top:4px;color:#d5dfff;"><strong>Artikel:</strong> ${articleBits}</div>`);
  }
  if (state.caseGovernor) {
    rows.push(`<div style="margin-top:4px;color:#d5dfff;"><strong>Regiert von:</strong> ${escapeHtml(state.caseGovernor)}</div>`);
  }
  if (state.adjectiveAgreement) {
    rows.push(`<div style="margin-top:4px;color:#d5dfff;"><strong>Adjektiv:</strong> ${escapeHtml(state.adjectiveAgreement)}</div>`);
  }

  if (state.verbPrepositions && state.verbPrepositions.length > 0) {
    const vpRows = state.verbPrepositions
      .map((vp) => {
        const c = CASE_LABEL_DE[vp.case] || vp.case;
        const note = vp.note ? ` — ${escapeHtml(vp.note)}` : '';
        return `<li style="margin-top:2px;">${escapeHtml(vp.preposition)} + ${escapeHtml(c)}${note}</li>`;
      })
      .join('');
    rows.push(`<div style="margin-top:6px;color:#d5dfff;"><strong>Verb + Präposition:</strong><ul style="margin:4px 0 0 18px;padding:0;">${vpRows}</ul></div>`);
  }

  popup.innerHTML = rows.join('');

  const popupSaveKey = (state.lemma || state.word || state.display || '').trim();
  const popupSaveState = popupSaveKey ? overlaySaveState[popupSaveKey] : undefined;
  const canSavePopupWord = popupSaveKey.length > 0 && !!state.meaning?.trim();

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'sl-overlay-popup-add-btn';
  addBtn.textContent =
    popupSaveState === 'saved'
      ? '✓ Added'
      : popupSaveState === 'saving'
        ? 'Adding…'
        : popupSaveState === 'error'
          ? 'Retry Add'
          : '+ Add';
  addBtn.disabled =
    !canSavePopupWord || popupSaveState === 'saving' || popupSaveState === 'saved';
  addBtn.style.cssText = `
    margin-top: 8px;
    width: 100%;
    border: 1px solid ${popupSaveState === 'saved' ? 'rgba(120, 220, 170, 0.7)' : popupSaveState === 'error' ? 'rgba(255, 160, 160, 0.72)' : 'rgba(153, 179, 255, 0.6)'};
    background: ${popupSaveState === 'saved' ? 'rgba(64, 152, 109, 0.35)' : popupSaveState === 'error' ? 'rgba(159, 74, 74, 0.38)' : 'rgba(90, 125, 245, 0.24)'};
    color: #eef3ff;
    border-radius: 8px;
    padding: 7px 10px;
    font-size: 12px;
    font-weight: 700;
    cursor: ${addBtn.disabled ? 'default' : 'pointer'};
    opacity: ${addBtn.disabled ? '0.72' : '1'};
  `;

  addBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!canSavePopupWord || !popupSaveKey) return;

    const sourceSentence = state.sourceSentence || '';
    const sourceUrl = sourceSentence ? buildSourceUrl(state.sourceStartTime) : window.location.href;
    const foundInText = state.display.trim() || popupSaveKey;

    void saveIdiomFromOverlay(
      popupSaveKey,
      foundInText,
      'word',
      state.meaning || '',
      undefined,
      sourceSentence,
      sourceUrl,
      document.title,
    );
  });

  popup.appendChild(addBtn);
}

function hideOverlayWordPopup(): void {
  if (!overlayWordPopup) return;
  overlayWordPopup = null;
  renderOverlayWordPopup();
}

function bindOverlayGlobalListeners(): void {
  if (overlayListenersBound) return;
  overlayListenersBound = true;

  document.addEventListener('mousedown', (event) => {
    if (!overlayWordPopup) return;

    const target = event.target as Node | null;
    const popup = document.getElementById(WORD_POPUP_ID);
    if (popup && target && popup.contains(target)) {
      return;
    }

    const htmlTarget = event.target as HTMLElement | null;
    if (htmlTarget?.closest('.sl-overlay-word')) {
      return;
    }

    hideOverlayWordPopup();
  });

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.repeat) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isEditableElement(event.target)) return;
    if (meaningfulSentences.length === 0) return;

    const key = event.key.toLowerCase();
    if (key === 'q') {
      event.preventDefault();
      void navigateOverlaySentence('prev');
    } else if (key === 'w') {
      event.preventDefault();
      void navigateOverlaySentence('repeat');
    } else if (key === 'e') {
      event.preventDefault();
      void navigateOverlaySentence('next');
    } else if (key === 's') {
      event.preventDefault();
      toggleSlowPlayback();
    }
  });
}

function ensureOnVideoSentenceOverlay(): HTMLDivElement {
  const existing = document.getElementById(OVERLAY_ID) as HTMLDivElement | null;
  if (existing) {
    return existing;
  }

  bindOverlayGlobalListeners();

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.cssText = `
    position: fixed;
    left: 50%;
    bottom: 19%;
    transform: translateX(-50%);
    max-width: min(80vw, 1080px);
    width: max-content;
    z-index: 2147483646;
    pointer-events: auto;
    opacity: 0;
    transition: opacity 0.16s ease;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    text-align: center;
  `;

  const pill = document.createElement('div');
  pill.className = 'sl-overlay-pill';
  pill.style.cssText = `
    display: inline-flex;
    flex-direction: column;
    gap: 7px;
    background: rgba(8, 12, 18, 0.86);
    border: 1px solid rgba(255, 255, 255, 0.24);
    border-radius: 12px;
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
    padding: 10px 14px;
    pointer-events: auto;
  `;


  const controls = document.createElement('div');
  controls.className = 'sl-overlay-controls';
  controls.style.cssText = `
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 8px;
  `;

  const createNavButton = (label: string, direction: OverlayNavDirection): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.cssText = `
      pointer-events: auto;
      background: rgba(111, 143, 255, 0.16);
      border: 1px solid rgba(154, 181, 255, 0.48);
      color: #edf3ff;
      border-radius: 8px;
      padding: 5px 10px;
      font-size: 12px;
      line-height: 1;
      font-weight: 600;
      cursor: pointer;
    `;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void navigateOverlaySentence(direction);
    });
    return button;
  };

  controls.appendChild(createNavButton('⏮ Prev', 'prev'));
  controls.appendChild(createNavButton('⟲ Repeat', 'repeat'));
  controls.appendChild(createNavButton('⏭ Next', 'next'));

  const targetLanguageLabel = document.createElement('label');
  targetLanguageLabel.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: rgba(232, 240, 255, 0.84);
    font-size: 11px;
    font-weight: 600;
  `;
  targetLanguageLabel.textContent = 'Target';

  const targetLanguageSelect = document.createElement('select');
  targetLanguageSelect.id = OVERLAY_TARGET_LANGUAGE_SELECT_ID;
  targetLanguageSelect.style.cssText = `
    pointer-events: auto;
    border: 1px solid rgba(154, 181, 255, 0.44);
    background: rgba(23, 31, 46, 0.9);
    color: #edf3ff;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    padding: 3px 6px;
    min-width: 112px;
  `;
  targetLanguageSelect.addEventListener('change', () => {
    overlayTargetLanguageCode = normalizeLanguageCode(targetLanguageSelect.value);
    overlayTargetLanguageManual = true;
  });
  targetLanguageLabel.appendChild(targetLanguageSelect);
  controls.appendChild(targetLanguageLabel);

  const explainBtn = document.createElement('button');
  explainBtn.className = 'sl-overlay-explain-btn';
  explainBtn.type = 'button';
  explainBtn.textContent = '✨ Explain';
  explainBtn.style.cssText = `
    pointer-events: auto;
    background: rgba(111, 143, 255, 0.16);
    border: 1px solid rgba(154, 181, 255, 0.48);
    color: #edf3ff;
    border-radius: 8px;
    padding: 5px 10px;
    font-size: 12px;
    line-height: 1;
    font-weight: 600;
    cursor: pointer;
  `;

  explainBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void toggleExplainForCurrentSentence();
  });

  controls.appendChild(explainBtn);

  const sentenceWrap = document.createElement('div');
  sentenceWrap.className = 'sl-overlay-sentence';
  sentenceWrap.style.cssText = `
    color: #f8fbff;
    font-size: clamp(17px, 2.1vw, 28px);
    line-height: 1.3;
    font-weight: 520;
    white-space: pre-wrap;
    word-wrap: break-word;
    text-shadow: 0 2px 10px rgba(0, 0, 0, 0.5);
  `;

  const explainPanel = document.createElement('div');
  explainPanel.className = 'sl-overlay-explain-panel';
  explainPanel.style.cssText = `
    display: none;
    text-align: left;
    margin-top: 2px;
    border-top: 1px solid rgba(175, 197, 255, 0.28);
    padding-top: 8px;
    max-width: min(74vw, 760px);
    font-size: 12px;
    line-height: 1.4;
    color: #ecf2ff;
  `;

  pill.appendChild(controls);
  pill.appendChild(sentenceWrap);
  pill.appendChild(explainPanel);

  overlay.appendChild(pill);
  document.body.appendChild(overlay);

  renderOverlayTargetLanguageControl();

  return overlay;
}

function hideOnVideoSentenceOverlay(): void {
  const overlay = document.getElementById(OVERLAY_ID) as HTMLDivElement | null;
  if (!overlay) {
    overlayHidden = true;
    return;
  }

  overlay.style.opacity = '0';
  overlayHidden = true;
  hideOverlayWordPopup();
}

function getOverlayTargetSentence(currentTimeMs: number): {
  sentence: MeaningfulSentence;
  index: number;
} | null {
  if (meaningfulSentences.length === 0) {
    overlayStableSentenceIndex = -1;
    return null;
  }

  let startBasedIndex = -1;
  for (let i = 0; i < meaningfulSentences.length; i += 1) {
    if (meaningfulSentences[i].startTime <= currentTimeMs + 120) {
      startBasedIndex = i;
    } else {
      break;
    }
  }
  if (startBasedIndex < 0) startBasedIndex = 0;

  const previousTimeMs = overlayLastRenderTimeMs;
  overlayLastRenderTimeMs = currentTimeMs;

  const seekedBackward = previousTimeMs > 0 && currentTimeMs + 1200 < previousTimeMs;
  const seekedForward = previousTimeMs > 0 && currentTimeMs - previousTimeMs > 4000;

  if (
    overlayStableSentenceIndex < 0 ||
    overlayStableSentenceIndex >= meaningfulSentences.length ||
    seekedBackward ||
    seekedForward
  ) {
    overlayStableSentenceIndex = startBasedIndex;
  } else {
    if (startBasedIndex > overlayStableSentenceIndex) {
      overlayStableSentenceIndex = startBasedIndex;
    } else if (startBasedIndex < overlayStableSentenceIndex) {
      const stable = meaningfulSentences[overlayStableSentenceIndex];
      if (currentTimeMs < stable.startTime - 900) {
        overlayStableSentenceIndex = startBasedIndex;
      }
    }
  }

  overlayStableSentenceIndex = Math.max(
    0,
    Math.min(overlayStableSentenceIndex, meaningfulSentences.length - 1)
  );

  const stableSentence = meaningfulSentences[overlayStableSentenceIndex];
  if (
    currentTimeMs > stableSentence.endTime + 2000 &&
    overlayStableSentenceIndex < meaningfulSentences.length - 1
  ) {
    overlayStableSentenceIndex = Math.min(
      meaningfulSentences.length - 1,
      Math.max(overlayStableSentenceIndex + 1, startBasedIndex)
    );
  }

  const chosen = meaningfulSentences[overlayStableSentenceIndex];
  if (!chosen) {
    return null;
  }

  const latest = meaningfulSentences[meaningfulSentences.length - 1];
  if (currentTimeMs > latest.endTime + 3000) {
    return null;
  }

  return { sentence: chosen, index: overlayStableSentenceIndex };
}

async function applyPlaybackControl(payload: PlaybackControlPayload): Promise<boolean> {
  const videoElement = getVideoElement();
  if (!videoElement) return false;

  if (payload.action === 'seek_to_ms') {
    const nextMs = Number(payload.timeMs);
    if (!Number.isFinite(nextMs)) return false;
    videoElement.currentTime = Math.max(0, nextMs) / 1000;
    return true;
  }

  if (payload.action === 'pause') {
    videoElement.pause();
    return true;
  }

  if (payload.action === 'play') {
    try {
      await videoElement.play();
      return true;
    } catch {
      return false;
    }
  }

  if (payload.action === 'toggle_slow') {
    const isSlow = Math.abs(videoElement.playbackRate - SLOW_PLAYBACK_RATE) < 0.01;
    videoElement.playbackRate = isSlow ? NORMAL_PLAYBACK_RATE : SLOW_PLAYBACK_RATE;
    return true;
  }

  return false;
}

function toggleSlowPlayback(): boolean {
  const videoElement = getVideoElement();
  if (!videoElement) return false;
  const isSlow = Math.abs(videoElement.playbackRate - SLOW_PLAYBACK_RATE) < 0.01;
  videoElement.playbackRate = isSlow ? NORMAL_PLAYBACK_RATE : SLOW_PLAYBACK_RATE;
  return true;
}

function resolveCurrentSentenceIndex(): number {
  if (meaningfulSentences.length === 0) return -1;

  if (overlayCurrentSentence) {
    const currentKey = getSentenceStableKey(overlayCurrentSentence);
    const fromOverlay = meaningfulSentences.findIndex(
      (sentence) => getSentenceStableKey(sentence) === currentKey
    );
    if (fromOverlay >= 0) return fromOverlay;
  }

  if (overlayLastSentenceIndex >= 0 && overlayLastSentenceIndex < meaningfulSentences.length) {
    return overlayLastSentenceIndex;
  }

  const currentTimeMs = getCurrentTimeMs();
  if (currentTimeMs !== null) {
    for (let i = 0; i < meaningfulSentences.length; i += 1) {
      const sentence = meaningfulSentences[i];
      if (currentTimeMs >= sentence.startTime && currentTimeMs <= sentence.endTime) {
        return i;
      }
    }

    let previous = -1;
    for (let i = 0; i < meaningfulSentences.length; i += 1) {
      if (meaningfulSentences[i].startTime <= currentTimeMs) {
        previous = i;
      } else {
        break;
      }
    }
    if (previous >= 0) return previous;
  }

  return 0;
}

function getSentenceSeekStartMs(sentence: MeaningfulSentence): number {
  const starts = (sentence.subPortions || [])
    .map((portion) => portion.startTime)
    .filter((time) => Number.isFinite(time));
  if (starts.length === 0) return sentence.startTime;
  return Math.min(...starts);
}

async function navigateOverlaySentence(direction: OverlayNavDirection): Promise<void> {
  if (meaningfulSentences.length === 0) return;
  const currentIndex = resolveCurrentSentenceIndex();
  if (currentIndex < 0) return;

  let targetIndex = currentIndex;
  if (direction === 'prev') {
    targetIndex = Math.max(0, currentIndex - 1);
  } else if (direction === 'next') {
    targetIndex = Math.min(meaningfulSentences.length - 1, currentIndex + 1);
  }

  const targetSentence = meaningfulSentences[targetIndex];
  if (!targetSentence) return;

  await applyPlaybackControl({ action: 'seek_to_ms', timeMs: getSentenceSeekStartMs(targetSentence) });
  await applyPlaybackControl({ action: 'play' });
}

function countCleanWordsInText(text: string): number {
  return tokenizeSentence(text).filter((part) => part.type === 'word' && part.clean.length > 0).length;
}

function findActiveSubPortionIndex(
  portions: Array<{ startTime: number; endTime: number }>,
  currentTimeMs: number
): number {
  for (let i = 0; i < portions.length; i += 1) {
    const p = portions[i];
    if (currentTimeMs >= p.startTime && currentTimeMs <= p.endTime) {
      return i;
    }
  }

  let previous = -1;
  for (let i = 0; i < portions.length; i += 1) {
    if (portions[i].startTime <= currentTimeMs) previous = i;
    else break;
  }

  if (previous >= 0) return previous;
  return 0;
}

function computeActiveWordIndex(sentence: MeaningfulSentence, currentTimeMs: number): number {
  const totalWords = countCleanWordsInText(sentence.text);
  if (totalWords <= 0) {
    return -1;
  }

  const subPortions = (sentence.subPortions || [])
    .filter((p) => Number.isFinite(p.startTime) && Number.isFinite(p.endTime))
    .map((p) => ({
      startTime: p.startTime,
      endTime: Math.max(p.endTime, p.startTime + 1),
      wordCount: countCleanWordsInText(p.text || '')
    }))
    .filter((p) => p.wordCount > 0);

  if (subPortions.length > 0) {
    const rawTotalWords = subPortions.reduce((acc, p) => acc + p.wordCount, 0);
    if (rawTotalWords > 0) {
      const activePortionIndex = findActiveSubPortionIndex(subPortions, currentTimeMs);
      const activePortion = subPortions[activePortionIndex];
      const wordsBeforeRaw = subPortions
        .slice(0, activePortionIndex)
        .reduce((acc, p) => acc + p.wordCount, 0);

      const mappedStart = Math.floor((wordsBeforeRaw / rawTotalWords) * totalWords);
      const mappedEnd = Math.max(
        mappedStart + 1,
        Math.ceil(((wordsBeforeRaw + activePortion.wordCount) / rawTotalWords) * totalWords)
      );
      const mappedCount = Math.max(1, mappedEnd - mappedStart);

      const rawDuration = Math.max(1, activePortion.endTime - activePortion.startTime);
      const effectiveDuration = Math.max(rawDuration, activePortion.wordCount * MIN_WORD_DURATION_MS);
      const elapsed = Math.max(0, currentTimeMs - activePortion.startTime);
      const progress = Math.min(1, elapsed / effectiveDuration);
      const localWordIndex = Math.min(mappedCount - 1, Math.floor(progress * mappedCount));

      return Math.max(0, Math.min(totalWords - 1, mappedStart + localWordIndex));
    }
  }

  // Fallback when subPortions are missing: avoid overly fast sweep on short spans.
  const rawSpanMs = Math.max(1, sentence.endTime - sentence.startTime);
  const effectiveSpanMs = Math.max(rawSpanMs, totalWords * MIN_WORD_DURATION_MS);
  const elapsed = Math.max(0, currentTimeMs - sentence.startTime);
  const progress = Math.min(1, elapsed / effectiveSpanMs);
  return Math.min(totalWords - 1, Math.floor(progress * totalWords));
}

function formatTimeForOverlay(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function setExplainButtonState(): void {
  const overlay = document.getElementById(OVERLAY_ID) as HTMLDivElement | null;
  if (!overlay) return;

  const btn = overlay.querySelector('.sl-overlay-explain-btn') as HTMLButtonElement | null;
  if (!btn) return;

  if (!overlayCurrentSentence) {
    btn.textContent = '✨ Explain';
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.style.cursor = 'default';
    return;
  }

  btn.disabled = false;
  btn.style.opacity = '1';
  btn.style.cursor = 'pointer';

  if (overlayExplainLoading) {
    btn.textContent = '⏳ Analysing…';
    btn.disabled = true;
    btn.style.opacity = '0.85';
    btn.style.cursor = 'wait';
    return;
  }

  const isVisibleForCurrent =
    overlayExplainVisible &&
    overlayCurrentSentence &&
    overlayAnalysisSentenceKey === getSentenceStableKey(overlayCurrentSentence);
  btn.textContent = isVisibleForCurrent ? 'Hide Explain' : '✨ Explain';
}

function renderOverlayTargetLanguageControl(): void {
  const overlay = document.getElementById(OVERLAY_ID) as HTMLDivElement | null;
  if (!overlay) return;

  const select = overlay.querySelector(
    `#${OVERLAY_TARGET_LANGUAGE_SELECT_ID}`,
  ) as HTMLSelectElement | null;
  if (!select) return;

  const detected = lastDetectedCaptionLanguageCode;
  const options = buildTargetLanguageOptions(detected, overlayTargetLanguageCode);
  const effective = getOverlayEffectiveTargetLanguage();

  select.innerHTML = '';
  for (const opt of options) {
    const option = document.createElement('option');
    option.value = opt.code;
    option.textContent = `${opt.label} (${opt.code})`;
    select.appendChild(option);
  }
  select.value = effective;
}

function createExplainSectionTitle(title: string): HTMLDivElement {
  const el = document.createElement('div');
  el.textContent = title;
  el.style.cssText = `
    color: #bcd0ff;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    margin-top: 6px;
  `;
  return el;
}

function renderExplainPanel(): void {
  const overlay = document.getElementById(OVERLAY_ID) as HTMLDivElement | null;
  if (!overlay) return;

  const panel = overlay.querySelector('.sl-overlay-explain-panel') as HTMLDivElement | null;
  if (!panel) return;

  const isCurrent =
    overlayCurrentSentence &&
    overlayAnalysisSentenceKey === getSentenceStableKey(overlayCurrentSentence);
  if (!overlayExplainVisible || !isCurrent) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }

  panel.style.display = 'block';
  panel.innerHTML = '';

  if (overlayExplainLoading) {
    const loading = document.createElement('div');
    loading.textContent = 'Analysing sentence…';
    loading.style.color = '#d6e2ff';
    panel.appendChild(loading);
    return;
  }

  if (overlayExplainError) {
    if (isAuthRequiredExplainError(overlayExplainError)) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

      const msg = document.createElement('div');
      msg.textContent = 'Sign in required to use Explain.';
      msg.style.cssText = 'color:#ffd0d0;font-size:12px;';
      wrap.appendChild(msg);

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;';

      const signInBtn = document.createElement('button');
      signInBtn.type = 'button';
      signInBtn.textContent = overlayExplainAuthActionLoading ? 'Opening…' : 'Sign in';
      signInBtn.disabled = overlayExplainAuthActionLoading;
      signInBtn.style.cssText = `
        border: 1px solid #99b3ff;
        background: rgba(90,125,245,0.24);
        color: #edf3ff;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 700;
        padding: 4px 10px;
        cursor: ${overlayExplainAuthActionLoading ? 'wait' : 'pointer'};
        opacity: ${overlayExplainAuthActionLoading ? '0.8' : '1'};
      `;
      signInBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void openExtensionPopupFromOverlay();
      });
      actions.appendChild(signInBtn);

      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.textContent = 'Retry Explain';
      retryBtn.disabled = overlayExplainAuthActionLoading;
      retryBtn.style.cssText = `
        border: 1px solid rgba(153,179,255,0.52);
        background: rgba(32,44,77,0.55);
        color: #d6e2ff;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
        padding: 4px 10px;
        cursor: ${overlayExplainAuthActionLoading ? 'wait' : 'pointer'};
      `;
      retryBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void toggleExplainForCurrentSentence(true);
      });
      actions.appendChild(retryBtn);
      wrap.appendChild(actions);

      if (overlayExplainAuthActionError) {
        const actionErr = document.createElement('div');
        actionErr.textContent = overlayExplainAuthActionError;
        actionErr.style.cssText = 'color:#ffb6b6;font-size:11px;';
        wrap.appendChild(actionErr);
      }

      panel.appendChild(wrap);
    } else {
      const err = document.createElement('div');
      err.textContent = overlayExplainError;
      err.style.color = '#ffb6b6';
      panel.appendChild(err);
    }
    return;
  }

  const sentenceKey = overlayCurrentSentence ? getSentenceStableKey(overlayCurrentSentence) : '';
  const analysis = sentenceAnalysisCache[sentenceKey];

  if (!analysis) {
    const empty = document.createElement('div');
    empty.textContent = 'No explain data available.';
    empty.style.color = '#d6e2ff';
    panel.appendChild(empty);
    return;
  }

  if (analysis.fixedPhrases.length > 0) {
    panel.appendChild(createExplainSectionTitle('Phrases & Wendungen'));
    for (const phrase of analysis.fixedPhrases) {
      const row = document.createElement('div');
      row.style.cssText = 'margin-top:4px;padding:4px 6px;border-radius:6px;background:rgba(115,142,224,0.14);';

      const top = document.createElement('div');
      top.style.cssText = 'display:flex;gap:8px;align-items:baseline;justify-content:space-between;';

      const left = document.createElement('strong');
      left.textContent = phrase.canonicalForm;
      left.style.color = '#f0f5ff';

      const kind = document.createElement('span');
      kind.textContent = phrase.kind;
      kind.style.cssText = 'color:#c9d8ff;font-size:11px;opacity:0.92;';
      const saveKey = phrase.canonicalForm;
      const saveStatus = overlaySaveState[saveKey];
      const right = document.createElement('div');
      right.style.cssText = 'display:flex;align-items:center;gap:7px;';

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.title =
        saveStatus === 'saved'
          ? 'Saved'
          : saveStatus === 'saving'
            ? 'Saving…'
            : 'Save to vocabulary';
      saveBtn.textContent =
        saveStatus === 'saved'
          ? '✓'
          : saveStatus === 'saving'
            ? '…'
            : saveStatus === 'error'
              ? '✕'
              : '＋';
      saveBtn.disabled = saveStatus === 'saving' || saveStatus === 'saved';
      saveBtn.style.cssText = `
        border: 1px solid ${saveStatus === 'saved' ? 'rgba(120,220,170,0.7)' : saveStatus === 'error' ? 'rgba(255,160,160,0.72)' : 'rgba(153,179,255,0.52)'};
        background: ${saveStatus === 'saved' ? 'rgba(64,152,109,0.35)' : saveStatus === 'error' ? 'rgba(159,74,74,0.38)' : 'rgba(90,125,245,0.24)'};
        color: #edf3ff;
        border-radius: 999px;
        width: 22px;
        height: 22px;
        font-size: 12px;
        font-weight: 700;
        line-height: 1;
        cursor: ${saveBtn.disabled ? 'default' : 'pointer'};
        opacity: ${saveBtn.disabled ? '0.72' : '1'};
      `;
      saveBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!overlayCurrentSentence) return;
        void saveIdiomFromOverlay(
          phrase.canonicalForm,
          phrase.foundInText,
          phrase.kind,
          phrase.meaning,
          phrase.example,
          overlayCurrentSentence.text,
          buildSourceUrl(overlayCurrentSentence.startTime),
          document.title,
        );
      });

      right.appendChild(kind);
      right.appendChild(saveBtn);

      top.appendChild(left);
      top.appendChild(right);

      const meaning = document.createElement('div');
      meaning.textContent = phrase.meaning;
      meaning.style.cssText = 'margin-top:2px;color:#e4ecff;';

      row.appendChild(top);
      row.appendChild(meaning);
      if (phrase.example) {
        const ex = document.createElement('div');
        ex.textContent = phrase.example;
        ex.style.cssText = 'margin-top:2px;color:#b8c9f5;font-style:italic;';
        row.appendChild(ex);
      }
      panel.appendChild(row);
    }
  }

  if (analysis.phrasalVerbs.length > 0) {
    panel.appendChild(createExplainSectionTitle('Trennbare Verben'));
    for (const pv of analysis.phrasalVerbs) {
      const row = document.createElement('div');
      row.style.cssText = 'margin-top:4px;padding:4px 6px;border-radius:6px;background:rgba(107,166,255,0.12);';

      const top = document.createElement('div');
      top.style.cssText = 'display:flex;gap:8px;align-items:baseline;justify-content:space-between;';

      const base = document.createElement('strong');
      base.textContent = pv.baseForm;
      base.style.color = '#f0f5ff';

      const meaning = document.createElement('span');
      meaning.textContent = pv.meaning;
      meaning.style.cssText = 'color:#d8e5ff;font-size:12px;';
      const saveKey = pv.baseForm;
      const saveStatus = overlaySaveState[saveKey];
      const right = document.createElement('div');
      right.style.cssText = 'display:flex;align-items:center;gap:7px;';

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.title =
        saveStatus === 'saved'
          ? 'Saved'
          : saveStatus === 'saving'
            ? 'Saving…'
            : 'Save to vocabulary';
      saveBtn.textContent =
        saveStatus === 'saved'
          ? '✓'
          : saveStatus === 'saving'
            ? '…'
            : saveStatus === 'error'
              ? '✕'
              : '＋';
      saveBtn.disabled = saveStatus === 'saving' || saveStatus === 'saved';
      saveBtn.style.cssText = `
        border: 1px solid ${saveStatus === 'saved' ? 'rgba(120,220,170,0.7)' : saveStatus === 'error' ? 'rgba(255,160,160,0.72)' : 'rgba(153,179,255,0.52)'};
        background: ${saveStatus === 'saved' ? 'rgba(64,152,109,0.35)' : saveStatus === 'error' ? 'rgba(159,74,74,0.38)' : 'rgba(90,125,245,0.24)'};
        color: #edf3ff;
        border-radius: 999px;
        width: 22px;
        height: 22px;
        font-size: 12px;
        font-weight: 700;
        line-height: 1;
        cursor: ${saveBtn.disabled ? 'default' : 'pointer'};
        opacity: ${saveBtn.disabled ? '0.72' : '1'};
      `;
      saveBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!overlayCurrentSentence) return;
        void saveIdiomFromOverlay(
          pv.baseForm,
          pv.foundInText,
          'phrasal_verb',
          pv.meaning,
          pv.example,
          overlayCurrentSentence.text,
          buildSourceUrl(overlayCurrentSentence.startTime),
          document.title,
        );
      });

      right.appendChild(meaning);
      right.appendChild(saveBtn);

      top.appendChild(base);
      top.appendChild(right);

      row.appendChild(top);

      const detail = document.createElement('div');
      detail.textContent = `${pv.prefix}- + ${pv.stem} · found as: ${pv.foundInText}`;
      detail.style.cssText = 'margin-top:2px;color:#c5d7ff;font-size:11px;';
      row.appendChild(detail);

      if (pv.example) {
        const ex = document.createElement('div');
        ex.textContent = pv.example;
        ex.style.cssText = 'margin-top:2px;color:#b8c9f5;font-style:italic;';
        row.appendChild(ex);
      }
      panel.appendChild(row);
    }
  }

  if (analysis.fixedPhrases.length === 0 && analysis.phrasalVerbs.length === 0) {
    const note = document.createElement('div');
    note.textContent = analysis.note || 'No separable verbs or fixed phrases detected.';
    note.style.color = '#d6e2ff';
    panel.appendChild(note);
    return;
  }

  if (analysis.note) {
    const note = document.createElement('div');
    note.textContent = analysis.note;
    note.style.cssText = 'margin-top:6px;color:#b8c9f5;';
    panel.appendChild(note);
  }
}

async function toggleExplainForCurrentSentence(forceRefresh = false): Promise<void> {
  const sentence = overlayCurrentSentence;
  if (!sentence) return;
  const sentenceKey = getSentenceStableKey(sentence);

  const isCurrentVisible =
    overlayExplainVisible && overlayAnalysisSentenceKey === sentenceKey && !overlayExplainLoading;
  if (isCurrentVisible && !forceRefresh) {
    overlayExplainVisible = false;
    overlayExplainError = null;
    overlayExplainAuthActionError = null;
    overlayExplainAuthActionLoading = false;
    overlayExplainLoading = false;
    renderExplainPanel();
    setExplainButtonState();
    return;
  }

  await applyPlaybackControl({ action: 'pause' });

  overlayExplainVisible = true;
  overlayExplainError = null;
  overlayExplainAuthActionError = null;
  overlayExplainAuthActionLoading = false;
  overlayExplainLoading = false;
  overlayAnalysisSentenceKey = sentenceKey;

  const cached = sentenceAnalysisCache[sentenceKey];
  if (forceRefresh && cached) {
    delete sentenceAnalysisCache[sentenceKey];
  }
  const nextCached = sentenceAnalysisCache[sentenceKey];
  if (nextCached) {
    renderExplainPanel();
    setExplainButtonState();
    return;
  }

  overlayExplainLoading = true;
  renderExplainPanel();
  setExplainButtonState();

  try {
    const result = await analyseForPhrasalVerbs(sentence.text);
    sentenceAnalysisCache[sentenceKey] = result;

    if (!overlayCurrentSentence || getSentenceStableKey(overlayCurrentSentence) !== sentenceKey) {
      return;
    }

    overlayExplainLoading = false;
    overlayExplainError = null;
    overlayExplainVisible = true;
    overlayAnalysisSentenceKey = sentenceKey;
  } catch (err) {
    if (!overlayCurrentSentence || getSentenceStableKey(overlayCurrentSentence) !== sentenceKey) {
      return;
    }

    overlayExplainLoading = false;
    overlayExplainError = err instanceof Error ? err.message : 'Failed to explain sentence.';
    overlayExplainVisible = true;
    overlayAnalysisSentenceKey = sentenceKey;
  }

  renderExplainPanel();
  setExplainButtonState();
}

async function handleOverlayWordClick(
  event: MouseEvent,
  sentence: MeaningfulSentence,
  display: string,
  clean: string
): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  if (!clean) return;

  const target = event.currentTarget as HTMLElement | null;
  const rect = target?.getBoundingClientRect();
  const x = rect ? rect.left + rect.width / 2 : event.clientX;
  const y = rect ? rect.bottom + 8 : event.clientY + 8;

  const sentenceKey = getSentenceStableKey(sentence);
  const cacheKey = `${sentenceKey}|v3vp|${clean.toLowerCase()}`;
  const cached = wordMeaningCache[cacheKey];

  overlayWordPopup = {
    sentenceKey,
    sourceSentence: sentence.text,
    sourceStartTime: sentence.startTime,
    word: clean,
    display,
    x,
    y,
    loading: !cached,
    lemma: cached?.lemma ?? null,
    meaning: cached?.meaning ?? null,
    nounPhraseInSentence: cached?.nounPhraseInSentence ?? null,
    grammaticalCase: (cached?.grammaticalCase as string | null) ?? null,
    articleAsInSentence: cached?.articleAsInSentence ?? null,
    dictionaryArticle: cached?.dictionaryArticle ?? null,
    adjectiveAgreement: cached?.adjectiveAgreement ?? null,
    caseGovernor: cached?.caseGovernor ?? null,
    verbPrepositions: cached?.verbPrepositions ?? null,
    error: null,
  };

  renderOverlayWordPopup();
  if (cached) return;

  const reqId = ++overlayWordLookupReqId;

  try {
    const result = await lookupWordInContext(clean, sentence.text);
    wordMeaningCache[cacheKey] = result;

    if (reqId !== overlayWordLookupReqId) return;
    if (!overlayWordPopup || overlayWordPopup.word !== clean || overlayWordPopup.sentenceKey !== sentenceKey) {
      return;
    }

    overlayWordPopup = {
      ...overlayWordPopup,
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
      error: null,
    };
    renderOverlayWordPopup();
  } catch (err) {
    if (reqId !== overlayWordLookupReqId) return;
    if (!overlayWordPopup || overlayWordPopup.word !== clean || overlayWordPopup.sentenceKey !== sentenceKey) {
      return;
    }

    overlayWordPopup = {
      ...overlayWordPopup,
      loading: false,
      lemma: null,
      meaning: null,
      nounPhraseInSentence: null,
      grammaticalCase: null,
      articleAsInSentence: null,
      dictionaryArticle: null,
      adjectiveAgreement: null,
      caseGovernor: null,
      verbPrepositions: null,
      error: err instanceof Error ? err.message : 'Failed to load meaning.',
    };
    renderOverlayWordPopup();
  }
}

function renderOverlaySentenceText(
  sentenceWrap: HTMLDivElement,
  sentence: MeaningfulSentence,
  activeWordIndex: number
): void {
  sentenceWrap.innerHTML = '';

  const tokens = tokenizeSentence(sentence.text);
  let wordRun = -1;

  for (const tok of tokens) {
    if (tok.type === 'space') {
      sentenceWrap.appendChild(document.createTextNode(tok.raw));
      continue;
    }

    if (!tok.clean) {
      sentenceWrap.appendChild(document.createTextNode(tok.raw));
      continue;
    }

    wordRun += 1;
    const tokenWordIndex = wordRun;

    const span = document.createElement('span');
    span.className = 'sl-overlay-word';
    span.textContent = tok.raw;
    span.style.cssText = `
      cursor: pointer;
      border-radius: 5px;
      padding: 0 3px;
      transition: background-color 0.12s ease, color 0.12s ease;
      ${
        OVERLAY_ENABLE_WORD_HIGHLIGHTING && tokenWordIndex === activeWordIndex
          ? 'background: rgba(120, 154, 255, 0.95); color: #fff; box-shadow: 0 2px 6px rgba(57, 103, 255, 0.28); font-weight: 700;'
          : 'color: #f8fbff;'
      }
    `;

    span.addEventListener('mouseenter', () => {
      if (!OVERLAY_ENABLE_WORD_HIGHLIGHTING) return;
      if (tokenWordIndex !== activeWordIndex) {
        span.style.backgroundColor = 'rgba(133, 162, 255, 0.24)';
      }
    });

    span.addEventListener('mouseleave', () => {
      if (!OVERLAY_ENABLE_WORD_HIGHLIGHTING) return;
      if (tokenWordIndex !== activeWordIndex) {
        span.style.backgroundColor = 'transparent';
      }
    });

    span.addEventListener('click', (event) => {
      void handleOverlayWordClick(event as MouseEvent, sentence, tok.raw, tok.clean);
    });

    sentenceWrap.appendChild(span);
  }
}

function renderOnVideoSentenceOverlay(): void {
  const currentTimeMs = getCurrentTimeMs();
  if (currentTimeMs === null) {
    hideOnVideoSentenceOverlay();
    return;
  }

  const target = getOverlayTargetSentence(currentTimeMs);
  if (!target) {
    hideOnVideoSentenceOverlay();
    return;
  }

  const { sentence, index } = target;
  const activeWordIndex = OVERLAY_ENABLE_WORD_HIGHLIGHTING
    ? computeActiveWordIndex(sentence, currentTimeMs)
    : -1;
  const sentenceKey = getSentenceStableKey(sentence);

  const sentenceChanged = sentenceKey !== overlayLastSentenceKey;
  if (sentenceChanged) {
    overlayCurrentSentence = sentence;
    overlayExplainVisible = false;
    overlayExplainLoading = false;
    overlayExplainError = null;
    overlayExplainAuthActionLoading = false;
    overlayExplainAuthActionError = null;
    overlayAnalysisSentenceKey = sentenceKey;
    hideOverlayWordPopup();
  }

  const shouldRerender =
    sentenceChanged ||
    activeWordIndex !== overlayLastWordIndex ||
    index !== overlayLastSentenceIndex ||
    overlayHidden;

  if (!shouldRerender) {
    return;
  }

  const overlay = ensureOnVideoSentenceOverlay();
  const sentenceWrap = overlay.querySelector('.sl-overlay-sentence') as HTMLDivElement | null;

  if (!sentenceWrap) {
    return;
  }

  renderOverlaySentenceText(sentenceWrap, sentence, activeWordIndex);
  renderOverlayTargetLanguageControl();
  renderExplainPanel();
  setExplainButtonState();

  overlay.style.opacity = '1';
  overlayHidden = false;

  overlayLastSentenceKey = sentenceKey;
  overlayLastWordIndex = activeWordIndex;
  overlayLastSentenceIndex = index;
}

function collectAndProcessSubtitles(): void {
  syncOverlayTargetLanguageFromCaptionTrack();
  const liveSubtitles = extractSubtitlesFromNetflix();
  if (liveSubtitles.length === 0) {
    renderOnVideoSentenceOverlay();
    return;
  }

  const latest = liveSubtitles[0];
  const previous = collectedSubtitles[collectedSubtitles.length - 1];
  if (previous && latest.text === previous.text) {
    previous.endTime = Math.max(previous.endTime, latest.endTime);
    renderOnVideoSentenceOverlay();
    return;
  }

  if (latest.text === lastCapturedSubtitleText) {
    renderOnVideoSentenceOverlay();
    return;
  }

  if (previous) {
    latest.startTime = Math.max(latest.startTime, previous.endTime + 1);
  }

  if (previous && previous.endTime < latest.startTime) {
    previous.endTime = latest.startTime;
  }

  collectedSubtitles.push(latest);
  lastCapturedSubtitleText = latest.text;

  meaningfulSentences = groupAndProcessSubtitles(collectedSubtitles);
  renderOnVideoSentenceOverlay();
}

function setupSubtitleObserver(): void {
  if (subtitleObserver) {
    subtitleObserver.disconnect();
  }
  if (subtitleCaptureInterval !== null) {
    window.clearInterval(subtitleCaptureInterval);
  }
  if (overlayRefreshInterval !== null) {
    window.clearInterval(overlayRefreshInterval);
  }

  try {
    subtitleObserver = new MutationObserver(() => {
      collectAndProcessSubtitles();
    });

    subtitleObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    subtitleCaptureInterval = window.setInterval(() => {
      collectAndProcessSubtitles();
    }, 250);

    overlayRefreshInterval = window.setInterval(() => {
      renderOnVideoSentenceOverlay();
    }, 140);

    collectAndProcessSubtitles();
  } catch (error) {
    console.error('Error setting up observer:', error);
  }
}

function initializeNetflixExtension(): void {
  console.log(`Initializing Subtitle Learning Extension for ${activePlatform}`);

  lastPlaybackHref = window.location.href;
  window.setInterval(() => {
    const h = window.location.href;
    if (h !== lastPlaybackHref) {
      lastPlaybackHref = h;
      resetSubtitleState();
    }
  }, 1000);

  setupSubtitleObserver();
  collectAndProcessSubtitles();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeNetflixExtension);
} else {
  setTimeout(initializeNetflixExtension, 100);
}

chrome.runtime.onMessage.addListener((message: MessageRequest, sender, sendResponse) => {
  if (message.type === 'GET_CURRENT_VIDEO') {
    const videoElement = document.querySelector('video') as HTMLVideoElement;
    const currentSessionId = getSessionId();
    sendResponse({
      success: true,
      data: {
        platform: activePlatform,
        videoId: currentSessionId,
        sessionId: currentSessionId,
        currentTime: videoElement?.currentTime || 0,
        duration: videoElement?.duration || 0
      }
    } as MessageResponse);
  } else if (message.type === 'GET_SUBTITLES') {
    collectAndProcessSubtitles();
    const currentSessionId = getSessionId();
    const captionLanguageCode = getActiveSubtitleLanguageCodeFromTracks();
    sendResponse({
      success: true,
      data: {
        meaningfulSentences,
        subtitles: collectedSubtitles,
        captionLanguageCode,
        sessionId: currentSessionId,
        videoId: currentSessionId
      }
    } as MessageResponse);
  } else if (message.type === 'PLAYBACK_CONTROL') {
    void applyPlaybackControl((message.payload || {}) as PlaybackControlPayload).then((success) => {
      sendResponse({ success } as MessageResponse);
    });
    return true;
  } else if (message.type === 'JUMP_TO_TIME') {
    void applyPlaybackControl({
      action: 'seek_to_ms',
      timeMs: message.payload?.time,
    }).then((success) => {
      sendResponse({ success } as MessageResponse);
    });
    return true;
  }
  return true;
});
