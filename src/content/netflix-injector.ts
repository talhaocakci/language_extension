import type { MeaningfulSentence } from '../types/subtitle';
import type { MessageRequest, MessageResponse, PlaybackControlPayload } from '../types/common';
import { groupAndProcessSubtitles } from '../utils/subtitle-processor';
import {
  type CapturedSubtitleChunk,
  upsertCapturedSubtitle
} from '../utils/subtitle-timing';
import {
  BROWSER_EXTENSION_PREFERENCES_STORAGE_KEY,
  DEFAULT_EXPLANATION_LANGUAGE,
  detectLanguageCode,
  getExplanationLanguageForTarget,
  getLanguageFlag,
  getLanguageLabel,
  normalizeBrowserExtensionPreferences,
  normalizeLanguagePreference,
} from '../utils/language-preferences';
import {
  cleanupStaleNetflixSentenceAudioClips,
  deleteNetflixSentenceAudioClip,
  findNetflixSentenceAudioClip,
  getNetflixSentenceAudioClipData,
  getNetflixSentenceAudioStatus,
  recordNetflixSentenceAudioClip,
} from '../experiments/netflix-audio/content-client';
import {
  NETFLIX_AUDIO_MESSAGES,
} from '../experiments/netflix-audio/protocol';

let subtitleObserver: MutationObserver | null = null;
let subtitleCaptureInterval: number | null = null;
let overlayRefreshInterval: number | null = null;
let subtitleMutationTimer: number | null = null;
let lastPlaybackSessionId = '';
let collectedSubtitles: CapturedSubtitleChunk[] = [];
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
const STREAMING_TOGGLE_BTN_ID = 'subtitle-learning-player-toggle';
const MIN_WORD_DURATION_MS = 320;
const OVERLAY_TARGET_LANGUAGE_VALUE_ID = 'sl-overlay-target-language';
const OVERLAY_HELP_ID = 'sl-overlay-help';
const STREAMING_NATIVE_CAPTION_SUPPRESSION_STYLE_ID = 'sl-streaming-native-caption-suppression';
const OVERLAY_ENABLE_WORD_HIGHLIGHTING = false;
const SLOW_PLAYBACK_RATE = 0.75;
const NORMAL_PLAYBACK_RATE = 1;

let overlayLastSentenceKey = '';
let overlayLastWordIndex = -1;
let overlayLastSentenceIndex = -1;
let overlayLastRenderTimeMs = 0;
let overlayLastAnchorSyncTimeMs = 0;
let overlayStableSentenceIndex = -1;
let overlayHidden = true;
let overlayListenersBound = false;
// Learning mode is opt-in for every title so casual streaming stays untouched.
let overlayEnabled = false;

let overlayCurrentSentence: MeaningfulSentence | null = null;
let overlayExplainVisible = false;
let overlayExplainLoading = false;
let overlayExplainError: string | null = null;
let overlayExplainAuthActionLoading = false;
let overlayExplainAuthActionError: string | null = null;
let overlayAnalysisSentenceKey = '';
let overlayExplanationLanguage = DEFAULT_EXPLANATION_LANGUAGE;

let overlayWordPopup: WordPopupState | null = null;
let overlayWordLookupReqId = 0;

type OverlaySentenceSaveState = 'idle' | 'preflight' | 'capture-required' | 'capturing' | 'saving' | 'saved' | 'audio-error' | 'error';
let overlaySentenceSaveState: OverlaySentenceSaveState = 'idle';
let overlaySentenceSaveMessage = '';
let overlaySentenceSavedItemId = '';

const wordMeaningCache: Record<string, WordMeaning> = {};
const sentenceAnalysisCache: Record<string, SentenceAnalysis> = {};
const overlaySaveState: Record<string, OverlaySaveState> = {};
const overlaySaveError: Record<string, string> = {};

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
const STREAMING_NATIVE_CAPTION_SELECTOR = activePlatform === 'max'
  ? '[data-testid="cueBoxRow"], [data-testid="cueBoxRowTextCue"], [data-testid="caption_renderer_overlay"], [class*="TextCue"]'
  : '[data-uia="subtitle"], .player-timedtext, .watch-video [data-uia*="subtitle"], .lln-subs .lln-sub-text';

function resetSubtitleState(): void {
  collectedSubtitles = [];
  meaningfulSentences = [];
  lastDetectedCaptionLanguageCode = '';

  overlayLastSentenceKey = '';
  overlayLastWordIndex = -1;
  overlayLastSentenceIndex = -1;
  overlayLastRenderTimeMs = 0;
  overlayLastAnchorSyncTimeMs = 0;
  overlayStableSentenceIndex = -1;

  overlayCurrentSentence = null;
  overlayExplainVisible = false;
  overlayExplainLoading = false;
  overlayExplainError = null;
  overlayExplainAuthActionLoading = false;
  overlayExplainAuthActionError = null;
  overlayAnalysisSentenceKey = '';

  overlayWordPopup = null;
  overlayWordLookupReqId += 1;
  overlaySentenceSaveState = 'idle';
  overlaySentenceSaveMessage = '';
  overlaySentenceSavedItemId = '';
  for (const key of Object.keys(overlaySaveState)) delete overlaySaveState[key];
  for (const key of Object.keys(overlaySaveError)) delete overlaySaveError[key];

  overlayEnabled = false;
  const toggle = document.getElementById(STREAMING_TOGGLE_BTN_ID) as HTMLButtonElement | null;
  if (toggle) updateStreamingToggleState(toggle);
  hideOnVideoSentenceOverlay();
  renderOverlayWordPopup();
}

function getVideoElement(): HTMLVideoElement | null {
  const videoElements = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
  if (videoElements.length === 0) return null;

  let bestVideo: HTMLVideoElement | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const video of videoElements) {
    const rect = video.getBoundingClientRect();
    const visibleArea = Math.max(0, rect.width) * Math.max(0, rect.height);
    let score = Math.min(visibleArea, 10_000_000);

    if (!video.paused && !video.ended) score += 1_000_000_000;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) score += 100_000_000;
    if (video.currentSrc) score += 10_000_000;
    if (Number.isFinite(video.currentTime)) score += 1_000_000;

    if (score > bestScore) {
      bestScore = score;
      bestVideo = video;
    }
  }

  return bestVideo;
}

function getCurrentTimeMs(): number | null {
  const videoElement = getVideoElement();
  if (!videoElement || !Number.isFinite(videoElement.currentTime)) {
    return null;
  }
  return Math.max(0, Math.round(videoElement.currentTime * 1000));
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

function getActiveSubtitleFromMediaTextTracks(): CapturedSubtitleChunk | null {
  const videoElement = getVideoElement();
  if (!videoElement || !videoElement.textTracks || videoElement.textTracks.length === 0) {
    return null;
  }

  const samples: Array<{ subtitle: CapturedSubtitleChunk; showing: boolean }> = [];
  for (let i = 0; i < videoElement.textTracks.length; i += 1) {
    const track = videoElement.textTracks[i];
    if (track.kind !== 'subtitles' && track.kind !== 'captions') {
      continue;
    }

    const activeCues = track.activeCues;
    if (!activeCues || activeCues.length === 0) {
      continue;
    }

    const activeLines: string[] = [];
    let startTime = Number.POSITIVE_INFINITY;
    let endTime = Number.NEGATIVE_INFINITY;

    for (let cueIndex = 0; cueIndex < activeCues.length; cueIndex += 1) {
      const cue = activeCues[cueIndex];
      if (!cue) continue;
      const cueText = extractTextFromCue(cue);
      if (cueText) {
        activeLines.push(cueText);
      }
      if (Number.isFinite(cue.startTime)) {
        startTime = Math.min(startTime, Math.round(cue.startTime * 1000));
      }
      if (Number.isFinite(cue.endTime)) {
        endTime = Math.max(endTime, Math.round(cue.endTime * 1000));
      }
    }

    const text = normalizeSubtitleText(activeLines.join(' '));
    if (!text || !Number.isFinite(startTime) || !Number.isFinite(endTime)) {
      continue;
    }

    samples.push({
      subtitle: {
        text,
        startTime: Math.max(0, startTime),
        endTime: Math.max(startTime + 1, endTime),
        timingSource: 'media-cue'
      },
      showing: track.mode === 'showing'
    });
  }

  const selected = samples.find((sample) => sample.showing) || samples[0];
  return selected?.subtitle || null;
}

function getSubtitleTextFromMediaTextTracks(): string {
  return getActiveSubtitleFromMediaTextTracks()?.text || '';
}

function normalizeLanguageCode(value: string): string {
  return detectLanguageCode(value);
}

function getLanguageCodeFromTrackMetadata(language: string, label: string): string {
  return detectLanguageCode(language) || detectLanguageCode(label);
}

function getOverlayEffectiveTargetLanguage(): string {
  return getPlayerLanguageCode();
}

const MEDIA_SECTION_HEADING_SELECTOR = [
  'h1',
  'h2',
  'h3',
  'h4',
  '[role="heading"]',
  '[data-uia*="header" i]',
  '[data-uia*="title" i]',
  '[data-testid*="header" i]',
  '[data-testid*="title" i]',
  '[class*="heading" i]',
  '[class*="header" i]',
  '[class*="title" i]',
].join(',');

const PLAYER_LANGUAGE_OPTION_SELECTOR = [
  'button',
  'li',
  '[role="menuitemradio"]',
  '[role="radio"]',
  '[role="option"]',
  '[data-uia*="item" i]',
  '[data-testid*="item" i]',
].join(',');

const SUBTITLE_SECTION_PATTERN = /^(subtitles?|captions?|closed captions?|untertitel|sous-titres|subt[ií]tulos|sottotitoli|altyazılar?)$/iu;
const AUDIO_SECTION_PATTERN = /^(audio|ses|ton|audios?)$/iu;

function elementText(element: Element): string {
  return normalizeSubtitleText((element as HTMLElement).innerText || element.textContent || '');
}

function elementMetadata(element: Element): string {
  const htmlElement = element as HTMLElement;
  return [
    htmlElement.getAttribute('data-uia') || '',
    htmlElement.getAttribute('data-testid') || '',
    htmlElement.getAttribute('aria-label') || '',
    typeof htmlElement.className === 'string' ? htmlElement.className : '',
  ].join(' ').toLowerCase();
}

function selectedStateIsExplicit(element: Element): boolean {
  const selectedAttributes = [
    ['aria-checked', 'true'],
    ['aria-selected', 'true'],
    ['aria-current', 'true'],
    ['data-state', 'checked'],
    ['data-selected', 'true'],
  ] as const;

  if (selectedAttributes.some(([name, value]) => element.getAttribute(name) === value)) {
    return true;
  }
  if (selectedAttributes.some(([name, value]) => element.querySelector(`[${name}="${value}"]`))) {
    return true;
  }

  const selectionMetadata = `${elementMetadata(element)} ${Array.from(element.children)
    .map((child) => elementMetadata(child))
    .join(' ')}`;
  if (/(^|[\s_-])(selected|checked|current)([\s_-]|$)/u.test(selectionMetadata)) {
    return true;
  }

  // Netflix/Max render the selected option's check mark as an SVG without an
  // ARIA selection attribute. Section classification below prevents an audio
  // selection from being treated as the subtitle language.
  return !!element.querySelector('svg');
}

function mediaSectionFromAncestors(element: Element): 'subtitle' | 'audio' | '' {
  let current: Element | null = element;
  for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
    const metadata = elementMetadata(current);
    const mentionsSubtitle = /subtitle|caption/u.test(metadata);
    const mentionsAudio = /audio/u.test(metadata);
    if (mentionsSubtitle !== mentionsAudio) return mentionsSubtitle ? 'subtitle' : 'audio';

    const headings = Array.from(current.querySelectorAll(MEDIA_SECTION_HEADING_SELECTOR))
      .map((heading) => elementText(heading).toLowerCase())
      .filter(Boolean);
    const hasSubtitleHeading = headings.some((heading) => SUBTITLE_SECTION_PATTERN.test(heading));
    const hasAudioHeading = headings.some((heading) => AUDIO_SECTION_PATTERN.test(heading));
    if (hasSubtitleHeading !== hasAudioHeading) {
      return hasSubtitleHeading ? 'subtitle' : 'audio';
    }
  }
  return '';
}

function mediaSectionFromPosition(element: Element): 'subtitle' | 'audio' | '' {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return '';
  const optionCenterX = rect.left + rect.width / 2;

  const headings = Array.from(document.querySelectorAll(MEDIA_SECTION_HEADING_SELECTOR))
    .map((heading) => ({ heading, text: elementText(heading).toLowerCase() }))
    .filter(({ heading }) => isElementVisible(heading));
  const distances = (pattern: RegExp): number[] => headings
    .filter(({ text }) => pattern.test(text))
    .map(({ heading }) => {
      const headingRect = heading.getBoundingClientRect();
      return Math.abs(optionCenterX - (headingRect.left + headingRect.width / 2));
    });

  const subtitleDistance = Math.min(...distances(SUBTITLE_SECTION_PATTERN), Number.POSITIVE_INFINITY);
  const audioDistance = Math.min(...distances(AUDIO_SECTION_PATTERN), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(subtitleDistance)) return '';
  if (!Number.isFinite(audioDistance) || subtitleDistance + 24 < audioDistance) return 'subtitle';
  if (audioDistance + 24 < subtitleDistance) return 'audio';
  return '';
}

function getSelectedSubtitleLanguageCodeFromPlayerMenu(): string | null {
  const subtitleMenuIsVisible = Array.from(document.querySelectorAll(MEDIA_SECTION_HEADING_SELECTOR))
    .some((heading) =>
      isElementVisible(heading) && SUBTITLE_SECTION_PATTERN.test(elementText(heading).toLowerCase()),
    );
  if (!subtitleMenuIsVisible) return null;

  const optionElements = new Set<Element>();
  const explicitlySelected = document.querySelectorAll([
    '[aria-checked="true"]',
    '[aria-selected="true"]',
    '[aria-current="true"]',
    '[data-state="checked"]',
    '[data-selected="true"]',
    '[class*="selected" i]',
    '[class*="checked" i]',
    '[class*="current" i]',
  ].join(','));

  for (const selected of Array.from(explicitlySelected)) {
    optionElements.add(selected.closest(PLAYER_LANGUAGE_OPTION_SELECTOR) || selected);
  }
  for (const option of Array.from(document.querySelectorAll(PLAYER_LANGUAGE_OPTION_SELECTOR))) {
    if (selectedStateIsExplicit(option)) optionElements.add(option);
  }

  const detected = new Set<string>();
  let hasExplicitSubtitleSelection = false;
  for (const option of optionElements) {
    if (!selectedStateIsExplicit(option)) continue;
    const section = mediaSectionFromAncestors(option) || mediaSectionFromPosition(option);
    if (section !== 'subtitle') continue;
    hasExplicitSubtitleSelection = true;
    const language = detectLanguageCode(elementText(option));
    if (language) detected.add(language);
  }

  if (!hasExplicitSubtitleSelection) return null;
  // An explicitly selected "Off"/unknown option, or multiple different
  // selected subtitle languages, clears the target language. Do not retain a
  // stale language or choose one.
  return detected.size === 1 ? Array.from(detected)[0] : '';
}

function captureClickedSubtitleLanguage(target: EventTarget | null): void {
  if (!(target instanceof Element)) return;
  const option = target.closest(PLAYER_LANGUAGE_OPTION_SELECTOR);
  if (!option) return;
  const section = mediaSectionFromAncestors(option) || mediaSectionFromPosition(option);
  if (section !== 'subtitle') return;

  const language = detectLanguageCode(elementText(option));
  lastDetectedCaptionLanguageCode = language;
  if (language) {
    console.info(`Selected subtitle language: ${getLanguageLabel(language)} (${language})`);
  } else {
    console.info('Selected subtitles are off or their language is unknown.');
  }
}

function getLanguageCodeFromVisibleCaptionMetadata(): string {
  const captionNodes = Array.from(document.querySelectorAll(STREAMING_NATIVE_CAPTION_SELECTOR))
    .filter((node) => isElementVisible(node));
  const detected = new Set<string>();

  for (const captionNode of captionNodes) {
    let current: Element | null = captionNode;
    for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
      const language = getLanguageCodeFromTrackMetadata(
        current.getAttribute('lang') || current.getAttribute('data-language') || current.getAttribute('data-lang') || '',
        current.getAttribute('aria-label') || '',
      );
      if (language) detected.add(language);
    }
  }

  return detected.size === 1 ? Array.from(detected)[0] : '';
}

function getActiveSubtitleLanguageCodeFromTracks(): string {
  const videoElement = getVideoElement();
  if (videoElement?.textTracks) {
    const showingLanguages = new Set<string>();
    const activeCueLanguages = new Set<string>();
    for (let i = 0; i < videoElement.textTracks.length; i += 1) {
      const track = videoElement.textTracks[i];
      if (track.kind !== 'subtitles' && track.kind !== 'captions') continue;
      const language = getLanguageCodeFromTrackMetadata(track.language || '', track.label || '');
      if (!language) continue;
      if (track.mode === 'showing') showingLanguages.add(language);
      if (track.activeCues && track.activeCues.length > 0) activeCueLanguages.add(language);
    }

    if (showingLanguages.size === 1) return Array.from(showingLanguages)[0];
    if (showingLanguages.size === 0 && activeCueLanguages.size === 1) {
      return Array.from(activeCueLanguages)[0];
    }
  }

  return '';
}

function getPlayerLanguageCode(): string {
  const menuSelection = getSelectedSubtitleLanguageCodeFromPlayerMenu();
  if (menuSelection !== null) {
    lastDetectedCaptionLanguageCode = menuSelection;
    return menuSelection;
  }

  const detected =
    getActiveSubtitleLanguageCodeFromTracks() ||
    getLanguageCodeFromVisibleCaptionMetadata();
  if (detected) {
    lastDetectedCaptionLanguageCode = detected;
  }
  return detected || lastDetectedCaptionLanguageCode;
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

function extractSubtitlesFromNetflix(): CapturedSubtitleChunk[] {
  const subtitles: CapturedSubtitleChunk[] = [];

  try {
    const videoElement = getVideoElement();
    if (videoElement?.seeking) return subtitles;

    const mediaSubtitle = getActiveSubtitleFromMediaTextTracks();
    const text =
      activePlatform === 'max'
        ? getVisibleSubtitleTextFromMax()
        : getVisibleSubtitleTextFromNetflix();
    if (!text) return subtitles;

    const currentTimeMs = getCurrentTimeMs();
    if (currentTimeMs === null) return subtitles;

    if (mediaSubtitle && mediaSubtitle.text === text) {
      subtitles.push(mediaSubtitle);
    } else {
      // DOM captions do not expose cue boundaries. Record when the caption is actually
      // observed and let the next observation/caption close it; future padding makes
      // every following caption start late.
      subtitles.push({
        text,
        startTime: currentTimeMs,
        endTime: currentTimeMs,
        timingSource: 'observed'
      });
    }
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
  const preferences = await chrome.runtime.sendMessage({
    type: 'GET_LANGUAGE_PREFERENCES',
    payload: { targetLanguage: getOverlayEffectiveTargetLanguage() },
  });
  const explanationLanguage = normalizeLanguagePreference(
    preferences?.data?.explanationLanguage,
    DEFAULT_EXPLANATION_LANGUAGE,
  );
  overlayExplanationLanguage = explanationLanguage;
  const targetLanguage = getOverlayEffectiveTargetLanguage() || 'auto-detect';
  const systemPrompt = `You are a multilingual language teacher. The learner clicked a token in a ${targetLanguage} sentence.
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

  const rawText = await callOverlayLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Clicked token: "${word}"\nFull sentence: "${sentence}"` }
  ]);

  const parsed = JSON.parse(rawText) as Record<string, unknown>;
  return normalizeWordMeaning(parsed, word);
}

async function analyseForPhrasalVerbs(sentence: string): Promise<SentenceAnalysis> {
  const preferences = await chrome.runtime.sendMessage({
    type: 'GET_LANGUAGE_PREFERENCES',
    payload: { targetLanguage: getOverlayEffectiveTargetLanguage() },
  });
  const explanationLanguage = normalizeLanguagePreference(
    preferences?.data?.explanationLanguage,
    DEFAULT_EXPLANATION_LANGUAGE,
  );
  overlayExplanationLanguage = explanationLanguage;
  const resp = (await chrome.runtime.sendMessage({
    type: 'OVERLAY_EXPLAIN_SENTENCE',
    payload: {
      sentence,
      targetLanguage: getOverlayEffectiveTargetLanguage(),
      explanationLanguage,
    }
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
    const clean = new URL(`${url.protocol}//${url.host}${url.pathname}`);
    clean.searchParams.set('t', String(seconds));
    return clean.toString();
  } catch {
    return base;
  }
}

function setOverlaySaveState(key: string, state?: OverlaySaveState, error = ''): void {
  if (state) {
    overlaySaveState[key] = state;
  } else {
    delete overlaySaveState[key];
  }
  if (state === 'error' && error) overlaySaveError[key] = error;
  else if (state !== 'error') delete overlaySaveError[key];
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

    console.error('SAVE_IDIOM failed:', resp?.error, resp?.data);
    if (resp?.error && isAuthRequiredError(resp.error)) {
      void openExtensionPopupFromOverlay();
    }
    setOverlaySaveState(canonicalForm, 'error', resp?.error || 'Could not add this item.');
    window.setTimeout(() => setOverlaySaveState(canonicalForm), 3000);
  } catch (error) {
    console.error('SAVE_IDIOM error:', error);
    setOverlaySaveState(
      canonicalForm,
      'error',
      error instanceof Error ? error.message : 'Could not reach the vocabulary service.',
    );
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

  // Capture the user's explicit subtitle choice before Netflix/Max closes and
  // removes the language menu from the DOM.
  document.addEventListener('click', (event) => {
    captureClickedSubtitleLanguage(event.target);
  }, true);

  document.addEventListener('mousedown', (event) => {
    const target = event.target as Node | null;
    const help = document.getElementById(OVERLAY_HELP_ID) as HTMLDivElement | null;
    if (help && help.style.display !== 'none') {
      const helpButton = help.parentElement?.querySelector('button[aria-label="Keyboard shortcuts"]');
      if (!target || (!help.contains(target) && !helpButton?.contains(target))) {
        help.style.display = 'none';
      }
    }

    if (!overlayWordPopup) return;

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
    if (!overlayEnabled) return;
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
    } else if (key === 'p') {
      event.preventDefault();
      const videoElement = getVideoElement();
      if (videoElement) {
        void applyPlaybackControl({ action: videoElement.paused ? 'play' : 'pause' });
      }
    }
  });
}

function restoreStreamingNativeCaptions(): void {
  document.getElementById(STREAMING_NATIVE_CAPTION_SUPPRESSION_STYLE_ID)?.remove();
}

function suppressStreamingNativeCaptions(): void {
  if (document.getElementById(STREAMING_NATIVE_CAPTION_SUPPRESSION_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STREAMING_NATIVE_CAPTION_SUPPRESSION_STYLE_ID;
  style.textContent = activePlatform === 'max'
    ? `
      [data-testid="cueBoxRow"],
      [data-testid="cueBoxRowTextCue"],
      [data-testid="caption_renderer_overlay"],
      [class*="TextCue"] {
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `
    : `
      [data-uia="subtitle"],
      .player-timedtext,
      .watch-video [data-uia*="subtitle"],
      .lln-subs .lln-sub-text {
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `;
  (document.head || document.documentElement).appendChild(style);
}

function syncStreamingOverlayWithPlayer(overlay: HTMLDivElement): void {
  const videoRect = getVideoElement()?.getBoundingClientRect();
  const hasPlayerBounds = !!videoRect && videoRect.width >= 240 && videoRect.height >= 135;
  const playerLeft = hasPlayerBounds ? videoRect.left : 0;
  const playerWidth = hasPlayerBounds ? videoRect.width : window.innerWidth;
  const playerBottom = hasPlayerBounds ? videoRect.bottom : window.innerHeight;
  const playerHeight = hasPlayerBounds ? videoRect.height : window.innerHeight;
  const availableWidth = Math.max(280, playerWidth - 16);
  const overlayWidth = Math.min(1080, playerWidth * 0.82, availableWidth);

  overlay.style.width = `${overlayWidth}px`;
  overlay.style.left = `${playerLeft + playerWidth / 2}px`;
  overlay.style.top = 'auto';
  overlay.style.bottom = `${Math.max(24, window.innerHeight - playerBottom + playerHeight * 0.13)}px`;
  overlay.style.transform = 'translateX(-50%)';
  suppressStreamingNativeCaptions();
}

interface SentencePreflightData {
  original_audio_storage_enabled?: boolean;
  max_audio_bytes?: number;
  code?: string;
}

interface SentenceOriginalAudioUpload {
  url: string;
  fields: Record<string, string>;
  s3_key: string;
  expires_in_seconds?: number;
  max_bytes?: number;
}

interface SentenceSaveData {
  item_id?: string;
  code?: string;
  original_audio_status?: string;
  original_audio_upload?: SentenceOriginalAudioUpload | null;
  warnings?: unknown[];
}

interface PendingSentenceAudioEnrichment {
  sentence: MeaningfulSentence;
  sentenceKey: string;
  itemId: string;
  upload: SentenceOriginalAudioUpload;
}

let pendingSentenceAudioEnrichment: PendingSentenceAudioEnrichment | null = null;

function sentenceSource(sentence: MeaningfulSentence): Record<string, unknown> {
  return {
    platform: activePlatform,
    url: buildSourceUrl(sentence.startTime),
    title: document.title,
    content_id: getSessionId(),
    start_ms: Math.max(0, Math.round(sentence.startTime)),
    end_ms: Math.max(Math.round(sentence.startTime) + 1, Math.round(sentence.endTime)),
  };
}

async function enrichSavedSentenceOriginalAudio(
  sentence: MeaningfulSentence,
  sentenceKey: string,
  itemId: string,
  upload: SentenceOriginalAudioUpload,
): Promise<void> {
  try {
    let clip = await findNetflixSentenceAudioClip(sentenceKey);
    if (!clip) {
      const video = getVideoElement();
      if (!video) throw new Error('The streaming video element was not found.');
      clip = await recordNetflixSentenceAudioClip(video, {
        sentenceKey,
        sentenceText: sentence.text,
        sourceUrl: buildSourceUrl(sentence.startTime),
        videoTitle: document.title,
        startTimeMs: sentence.startTime,
        endTimeMs: sentence.endTime,
      });
    }
    const clipData = await getNetflixSentenceAudioClipData(clip.clipId);
    const response = await chrome.runtime.sendMessage({
      type: 'UPLOAD_SENTENCE_AUDIO',
      payload: {
        item_id: itemId,
        upload,
        clip: {
          base64: clipData.base64Data,
          mime_type: clipData.mimeType,
          duration_ms: clipData.durationMs,
        },
      },
    }) as MessageResponse<Record<string, unknown>>;
    if (!response?.success) throw new Error(response?.error || 'Could not queue the original audio.');
    await deleteNetflixSentenceAudioClip(clip.clipId).catch(() => undefined);
    pendingSentenceAudioEnrichment = null;
    if (overlaySentenceSavedItemId === itemId) {
      overlaySentenceSaveState = 'saved';
      overlaySentenceSaveMessage = 'Saved to From Web → Sentences. Original audio is processing.';
      renderExplainPanel();
    }
  } catch (error) {
    if (overlaySentenceSavedItemId === itemId) {
      overlaySentenceSaveState = 'audio-error';
      overlaySentenceSaveMessage = `Sentence saved. Original audio will need a retry: ${error instanceof Error ? error.message : String(error)}`;
      renderExplainPanel();
    }
  }
}

async function retrySavedSentenceOriginalAudio(): Promise<void> {
  const pending = pendingSentenceAudioEnrichment;
  if (!pending) return;
  overlaySentenceSaveState = 'capturing';
  overlaySentenceSaveMessage = 'Sentence is already saved. Retrying original audio…';
  renderExplainPanel();
  try {
    const refreshed = await chrome.runtime.sendMessage({
      type: 'REFRESH_SENTENCE_AUDIO_UPLOAD',
      payload: { item_id: pending.itemId },
    }) as MessageResponse<SentenceSaveData>;
    const upload = refreshed?.data?.original_audio_upload || null;
    if (!refreshed?.success || !upload) {
      throw new Error(refreshed?.error || 'Could not prepare a new audio upload.');
    }
    pending.upload = upload;
    await enrichSavedSentenceOriginalAudio(
      pending.sentence,
      pending.sentenceKey,
      pending.itemId,
      upload,
    );
  } catch (error) {
    overlaySentenceSaveState = 'audio-error';
    overlaySentenceSaveMessage = `Sentence saved. Original audio retry failed: ${error instanceof Error ? error.message : String(error)}`;
    renderExplainPanel();
  }
}

async function saveExplainedSentence(): Promise<void> {
  const sentence = overlayCurrentSentence;
  if (!sentence) return;
  const sentenceKey = getSentenceStableKey(sentence);
  const analysis = sentenceAnalysisCache[sentenceKey];
  if (!analysis) return;

  const targetLanguage = getOverlayEffectiveTargetLanguage();
  const basePayload = {
    text: sentence.text,
    target_language: targetLanguage,
    source: sentenceSource(sentence),
  };
  try {
    overlaySentenceSaveState = 'preflight';
    overlaySentenceSaveMessage = 'Checking your Learn List…';
    renderExplainPanel();
    const preflight = await chrome.runtime.sendMessage({
      type: 'PREFLIGHT_SENTENCE',
      payload: basePayload,
    }) as MessageResponse<SentencePreflightData>;
    if (!preflight?.success) {
      if (preflight?.data?.code === 'SENTENCE_ALREADY_SAVED') {
        const staleRetry = await findNetflixSentenceAudioClip(sentenceKey).catch(() => null);
        if (staleRetry) await deleteNetflixSentenceAudioClip(staleRetry.clipId).catch(() => undefined);
        overlaySentenceSaveState = 'saved';
        overlaySentenceSaveMessage = 'Already saved in Sentences.';
        renderExplainPanel();
        return;
      }
      throw new Error(preflight?.error || 'Sentence preflight failed.');
    }

    const originalEnabled = preflight.data?.original_audio_storage_enabled !== false;
    if (originalEnabled) {
      const captureStatus = await getNetflixSentenceAudioStatus();
      if (!captureStatus.activeForCurrentTab) {
        overlaySentenceSaveState = 'capture-required';
        overlaySentenceSaveMessage = 'Enable tab audio capture, then press Save sentence again.';
        renderExplainPanel();
        await chrome.runtime.sendMessage({ type: 'OPEN_SENTENCE_AUDIO_SETUP' }).catch(() => undefined);
        return;
      }
    }

    overlaySentenceSaveState = 'saving';
    overlaySentenceSaveMessage = 'Saving sentence and explanation…';
    renderExplainPanel();
    const saveResponse = await chrome.runtime.sendMessage({
      type: 'SAVE_SENTENCE',
      payload: {
        ...basePayload,
        folder: 'fromweb',
        explanation_language: overlayExplanationLanguage,
        sentence_explanation: analysis,
        client_request_id: crypto.randomUUID(),
      },
    }) as MessageResponse<SentenceSaveData>;
    if (!saveResponse?.success) {
      if (saveResponse?.data?.code === 'SENTENCE_ALREADY_SAVED') {
        overlaySentenceSaveState = 'saved';
        overlaySentenceSaveMessage = 'Already saved in Sentences.';
        renderExplainPanel();
        return;
      }
      throw new Error(saveResponse?.error || 'Could not save this sentence.');
    }
    overlaySentenceSavedItemId = String(saveResponse.data?.item_id || '');
    overlaySentenceSaveState = 'saved';
    const originalUpload = saveResponse.data?.original_audio_upload || null;
    if (originalEnabled && originalUpload && overlaySentenceSavedItemId) {
      pendingSentenceAudioEnrichment = {
        sentence,
        sentenceKey,
        itemId: overlaySentenceSavedItemId,
        upload: originalUpload,
      };
      overlaySentenceSaveMessage = 'Saved. Adding original audio in the background…';
      void enrichSavedSentenceOriginalAudio(
        sentence,
        sentenceKey,
        overlaySentenceSavedItemId,
        originalUpload,
      );
    } else {
      overlaySentenceSaveMessage = 'Saved to From Web → Sentences. Audio is processing.';
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isAuthRequiredError(message)) void openExtensionPopupFromOverlay();
    overlaySentenceSaveState = 'error';
    overlaySentenceSaveMessage = message;
  }
  renderExplainPanel();
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
    width: min(82vw, 1080px);
    max-width: calc(100vw - 16px);
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
    position: relative;
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
    width: 100%;
    box-sizing: border-box;
  `;


  const controls = document.createElement('div');
  controls.className = 'sl-overlay-controls';
  controls.style.cssText = `
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 8px;
  `;

  const createToolbarButton = (label: string, title: string): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.style.cssText = `
      pointer-events: auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 28px;
      height: 25px;
      padding: 0 7px;
      background: rgba(111, 143, 255, 0.16);
      border: 1px solid rgba(154, 181, 255, 0.48);
      color: #edf3ff;
      border-radius: 8px;
      font-size: 12px;
      line-height: 1;
      font-weight: 600;
      cursor: pointer;
    `;
    button.addEventListener('mouseenter', () => { button.style.background = 'rgba(111, 143, 255, 0.22)'; });
    button.addEventListener('mouseleave', () => { button.style.background = 'rgba(111, 143, 255, 0.16)'; });
    return button;
  };

  const targetLanguageFlag = document.createElement('span');
  targetLanguageFlag.id = OVERLAY_TARGET_LANGUAGE_VALUE_ID;
  targetLanguageFlag.style.cssText = `
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    height: 25px;
    padding: 0 3px;
    border-radius: 6px;
    color: #edf3ff;
    font-size: 17px;
    line-height: 1;
  `;
  targetLanguageFlag.textContent = '🌐';
  targetLanguageFlag.title = 'Detecting target language';
  controls.appendChild(targetLanguageFlag);

  const explainBtn = createToolbarButton('✨ Explain', 'Explain sentence');
  explainBtn.className = 'sl-overlay-explain-btn';
  explainBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void toggleExplainForCurrentSentence();
  });

  controls.appendChild(explainBtn);

  const helpBtn = createToolbarButton('?', 'Keyboard shortcuts');
  helpBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const help = overlay.querySelector(`#${OVERLAY_HELP_ID}`) as HTMLDivElement | null;
    if (help) help.style.display = help.style.display === 'none' ? 'grid' : 'none';
  });
  controls.appendChild(helpBtn);

  const helpPanel = document.createElement('div');
  helpPanel.id = OVERLAY_HELP_ID;
  helpPanel.style.cssText = `
    display: none;
    grid-template-columns: auto auto;
    gap: 5px 14px;
    position: absolute;
    right: 14px;
    top: 42px;
    z-index: 3;
    min-width: 150px;
    padding: 9px 11px;
    border: 1px solid rgba(255, 255, 255, 0.22);
    border-radius: 9px;
    background: rgba(8, 12, 18, 0.97);
    box-shadow: 0 8px 22px rgba(0, 0, 0, 0.48);
    color: #edf3ff;
    font-size: 11px;
    text-align: left;
  `;
  helpPanel.innerHTML = '<kbd>Q</kbd><span>Previous</span><kbd>W</kbd><span>Repeat</span><kbd>E</kbd><span>Next</span><kbd>P</kbd><span>Play / pause</span><kbd>S</kbd><span>Slow / normal speed</span>';

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
    min-height: 2.6em;
    display: flex;
    align-items: center;
    justify-content: center;
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
  pill.appendChild(helpPanel);
  pill.appendChild(sentenceWrap);
  pill.appendChild(explainPanel);

  overlay.appendChild(pill);
  document.body.appendChild(overlay);

  renderOverlayTargetLanguageControl();
  void chrome.runtime.sendMessage({
    type: 'GET_LANGUAGE_PREFERENCES',
    payload: { targetLanguage: getOverlayEffectiveTargetLanguage() },
  }).then((response) => {
    overlayExplanationLanguage = normalizeLanguagePreference(
      response?.data?.explanationLanguage,
      DEFAULT_EXPLANATION_LANGUAGE,
    );
    renderOverlayTargetLanguageControl();
  }).catch(() => undefined);

  return overlay;
}

function hideOnVideoSentenceOverlay(): void {
  restoreStreamingNativeCaptions();
  const overlay = document.getElementById(OVERLAY_ID) as HTMLDivElement | null;
  if (!overlay) {
    overlayHidden = true;
    return;
  }

  overlay.style.opacity = '0';
  overlayHidden = true;
  hideOverlayWordPopup();
}

function updateStreamingToggleState(button: HTMLButtonElement): void {
  const label = overlayEnabled ? 'Learn CC: On' : 'Learn CC: Off';
  if (button.textContent !== label) button.textContent = label;
  button.title = overlayEnabled ? 'Turn off learning subtitles' : 'Turn on learning subtitles';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(overlayEnabled));
  button.style.background = overlayEnabled
    ? 'rgba(74, 105, 220, 0.9)'
    : 'rgba(18, 22, 30, 0.82)';
  button.style.borderColor = overlayEnabled
    ? 'rgba(181, 198, 255, 0.95)'
    : 'rgba(255, 255, 255, 0.42)';
}

function ensureStreamingToggleButton(): HTMLButtonElement | null {
  const videoElement = getVideoElement();
  const existing = document.getElementById(STREAMING_TOGGLE_BTN_ID) as HTMLButtonElement | null;
  if (!videoElement) {
    if (existing) existing.style.display = 'none';
    return existing;
  }

  const videoRect = videoElement.getBoundingClientRect();
  if (videoRect.width < 240 || videoRect.height < 135) {
    if (existing) existing.style.display = 'none';
    return existing;
  }

  const button = existing || document.createElement('button');
  if (!existing) {
    button.id = STREAMING_TOGGLE_BTN_ID;
    button.type = 'button';
    button.style.cssText = `
      position: fixed;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 34px;
      padding: 7px 11px;
      border: 1px solid;
      border-radius: 8px;
      color: #f5f7ff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px;
      line-height: 1;
      font-weight: 700;
      white-space: nowrap;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.38);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    `;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setStreamingOverlayEnabled(!overlayEnabled);
    });
    document.body.appendChild(button);
  }

  button.style.display = 'flex';
  button.style.top = `${Math.max(10, videoRect.top + 14)}px`;
  button.style.right = `${Math.max(10, window.innerWidth - videoRect.right + 14)}px`;
  updateStreamingToggleState(button);
  return button;
}

function setStreamingOverlayEnabled(enabled: boolean): void {
  overlayEnabled = enabled;
  ensureStreamingToggleButton();
  if (overlayEnabled) {
    collectAndProcessSubtitles();
  } else {
    hideOnVideoSentenceOverlay();
  }
}

function getOverlayTargetSentence(currentTimeMs: number): {
  sentence: MeaningfulSentence;
  index: number;
} | null {
  if (meaningfulSentences.length === 0) {
    overlayStableSentenceIndex = -1;
    return null;
  }

  const earliest = meaningfulSentences[0];
  if (currentTimeMs < earliest.startTime - 250) {
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
    btn.title = 'Explain sentence';
    btn.setAttribute('aria-label', btn.title);
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
    btn.title = 'Analysing sentence';
    btn.setAttribute('aria-label', btn.title);
    btn.disabled = true;
    btn.style.opacity = '0.85';
    btn.style.cursor = 'wait';
    return;
  }

  const isVisibleForCurrent =
    overlayExplainVisible &&
    overlayCurrentSentence &&
    overlayAnalysisSentenceKey === getSentenceStableKey(overlayCurrentSentence);
  btn.textContent = isVisibleForCurrent ? '× Hide' : '✨ Explain';
  btn.title = isVisibleForCurrent ? 'Hide explanation' : 'Explain sentence';
  btn.setAttribute('aria-label', btn.title);
}

function renderOverlayTargetLanguageControl(): void {
  const overlay = document.getElementById(OVERLAY_ID) as HTMLDivElement | null;
  if (!overlay) return;

  const value = overlay.querySelector(
    `#${OVERLAY_TARGET_LANGUAGE_VALUE_ID}`,
  ) as HTMLSpanElement | null;
  if (!value) return;

  const detected = getPlayerLanguageCode();
  const targetLabel = detected ? `${getLanguageLabel(detected)} subtitles` : 'Target language not detected';
  value.textContent = getLanguageFlag(detected);
  value.title = targetLabel;
  value.setAttribute('aria-label', value.title);
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
    panel.appendChild(createExplainSectionTitle('Phrases & grammar'));
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
            : saveStatus === 'error'
              ? overlaySaveError[saveKey] || 'Could not add this item.'
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
      if (saveStatus === 'error' && overlaySaveError[saveKey]) {
        const saveError = document.createElement('div');
        saveError.textContent = overlaySaveError[saveKey];
        saveError.style.cssText = 'margin-top:3px;color:#ffb3b3;font-size:10px;';
        row.appendChild(saveError);
      }
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
    panel.appendChild(createExplainSectionTitle('Phrasal & particle verbs'));
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
            : saveStatus === 'error'
              ? overlaySaveError[saveKey] || 'Could not add this item.'
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
      if (saveStatus === 'error' && overlaySaveError[saveKey]) {
        const saveError = document.createElement('div');
        saveError.textContent = overlaySaveError[saveKey];
        saveError.style.cssText = 'margin-top:3px;color:#ffb3b3;font-size:10px;';
        row.appendChild(saveError);
      }

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
    note.textContent = analysis.note || 'No learner-worthy phrases or grammar constructions detected.';
    note.style.color = '#d6e2ff';
    panel.appendChild(note);
  } else if (analysis.note) {
    const note = document.createElement('div');
    note.textContent = analysis.note;
    note.style.cssText = 'margin-top:6px;color:#b8c9f5;';
    panel.appendChild(note);
  }

  const sentenceSaveWrap = document.createElement('div');
  sentenceSaveWrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;padding-top:8px;border-top:1px solid rgba(175,197,255,0.22);';
  const sentenceSaveButton = document.createElement('button');
  sentenceSaveButton.type = 'button';
  const busy = overlaySentenceSaveState === 'preflight' ||
    overlaySentenceSaveState === 'capturing' || overlaySentenceSaveState === 'saving';
  sentenceSaveButton.disabled = busy || overlaySentenceSaveState === 'saved';
  sentenceSaveButton.textContent = overlaySentenceSaveState === 'saved'
    ? '✓ Sentence saved'
    : overlaySentenceSaveState === 'audio-error'
      ? 'Retry original audio'
    : overlaySentenceSaveState === 'capture-required'
      ? 'Enable audio capture'
      : busy
        ? 'Saving sentence…'
        : overlaySentenceSaveState === 'error'
          ? 'Retry Save sentence'
          : '＋ Save sentence';
  sentenceSaveButton.title = 'Save this complete sentence and its explanation to From Web → Sentences';
  sentenceSaveButton.style.cssText = `
    border:1px solid ${overlaySentenceSaveState === 'saved' ? 'rgba(120,220,170,0.75)' : 'rgba(153,179,255,0.72)'};
    background:${overlaySentenceSaveState === 'saved' ? 'rgba(64,152,109,0.36)' : 'rgba(90,125,245,0.32)'};
    color:#f2f6ff;border-radius:8px;padding:6px 11px;font-size:12px;font-weight:700;
    cursor:${sentenceSaveButton.disabled ? 'default' : 'pointer'};opacity:${sentenceSaveButton.disabled ? '0.76' : '1'};
  `;
  sentenceSaveButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (overlaySentenceSaveState === 'capture-required') {
      void chrome.runtime.sendMessage({ type: 'OPEN_SENTENCE_AUDIO_SETUP' });
      return;
    }
    if (overlaySentenceSaveState === 'audio-error') {
      void retrySavedSentenceOriginalAudio();
      return;
    }
    void saveExplainedSentence();
  });
  sentenceSaveWrap.appendChild(sentenceSaveButton);
  if (overlaySentenceSaveMessage) {
    const status = document.createElement('span');
    status.textContent = overlaySentenceSaveMessage;
    status.style.cssText = `font-size:11px;color:${overlaySentenceSaveState === 'error' || overlaySentenceSaveState === 'audio-error' ? '#ffb6b6' : '#c8d7ff'};`;
    status.title = overlaySentenceSavedItemId ? `Learn item ${overlaySentenceSavedItemId}` : '';
    sentenceSaveWrap.appendChild(status);
  }
  panel.appendChild(sentenceSaveWrap);
}

async function toggleExplainForCurrentSentence(forceRefresh = false): Promise<void> {
  const sentence = overlayCurrentSentence;
  if (!sentence) return;
  await applyPlaybackControl({ action: 'pause' });
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
  await applyPlaybackControl({ action: 'pause' });

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
  if (!document.getElementById(STREAMING_TOGGLE_BTN_ID)) {
    ensureStreamingToggleButton();
  }
  if (!overlayEnabled) {
    hideOnVideoSentenceOverlay();
    return;
  }

  const videoElement = getVideoElement();
  if (videoElement?.seeking) {
    overlayStableSentenceIndex = -1;
    overlayLastRenderTimeMs = 0;
    hideOnVideoSentenceOverlay();
    return;
  }

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
    overlaySentenceSaveState = 'idle';
    overlaySentenceSaveMessage = '';
    overlaySentenceSavedItemId = '';
    hideOverlayWordPopup();
  }

  const shouldRerender =
    sentenceChanged ||
    activeWordIndex !== overlayLastWordIndex ||
    index !== overlayLastSentenceIndex ||
    overlayHidden;

  if (!shouldRerender) {
    renderOverlayTargetLanguageControl();
    const now = performance.now();
    if (now - overlayLastAnchorSyncTimeMs >= 350) {
      const overlay = document.getElementById(OVERLAY_ID) as HTMLDivElement | null;
      if (overlay) syncStreamingOverlayWithPlayer(overlay);
      overlayLastAnchorSyncTimeMs = now;
    }
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
  syncStreamingOverlayWithPlayer(overlay);
  overlayLastAnchorSyncTimeMs = performance.now();

  overlayLastSentenceKey = sentenceKey;
  overlayLastWordIndex = activeWordIndex;
  overlayLastSentenceIndex = index;
}

function collectAndProcessSubtitles(force = false): void {
  if (!overlayEnabled && !force) {
    hideOnVideoSentenceOverlay();
    return;
  }

  getPlayerLanguageCode();
  const liveSubtitles = extractSubtitlesFromNetflix();
  if (liveSubtitles.length === 0) {
    renderOnVideoSentenceOverlay();
    return;
  }

  const latest = liveSubtitles[0];
  const timelineChanged = upsertCapturedSubtitle(collectedSubtitles, latest);
  if (timelineChanged) {
    meaningfulSentences = groupAndProcessSubtitles(collectedSubtitles);
  }
  renderOnVideoSentenceOverlay();
}

function isExtensionOwnedNode(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return !!element?.closest(
    `#${OVERLAY_ID}, #${WORD_POPUP_ID}, #${STREAMING_TOGGLE_BTN_ID}`,
  );
}

function mutationOnlyTouchesExtension(mutation: MutationRecord): boolean {
  if (isExtensionOwnedNode(mutation.target)) return true;
  if (mutation.type !== 'childList') return false;

  const changedNodes = [
    ...Array.from(mutation.addedNodes),
    ...Array.from(mutation.removedNodes),
  ];
  return changedNodes.length > 0 && changedNodes.every(isExtensionOwnedNode);
}

function nodeTouchesNativeCaptions(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  if (!element) return false;
  return !!element.closest(STREAMING_NATIVE_CAPTION_SELECTOR) ||
    !!element.querySelector(STREAMING_NATIVE_CAPTION_SELECTOR);
}

function mutationTouchesNativeCaptions(mutation: MutationRecord): boolean {
  if (nodeTouchesNativeCaptions(mutation.target)) return true;
  if (mutation.type !== 'childList') return false;
  return [
    ...Array.from(mutation.addedNodes),
    ...Array.from(mutation.removedNodes),
  ].some(nodeTouchesNativeCaptions);
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
  if (subtitleMutationTimer !== null) {
    window.clearTimeout(subtitleMutationTimer);
    subtitleMutationTimer = null;
  }

  try {
    subtitleObserver = new MutationObserver((mutations) => {
      if (mutations.every(mutationOnlyTouchesExtension)) return;
      if (!mutations.some(mutationTouchesNativeCaptions)) return;
      if (subtitleMutationTimer !== null) return;

      subtitleMutationTimer = window.setTimeout(() => {
        subtitleMutationTimer = null;
        collectAndProcessSubtitles();
      }, 60);
    });

    subtitleObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    subtitleCaptureInterval = window.setInterval(() => {
      collectAndProcessSubtitles();
    }, 500);

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

  bindOverlayGlobalListeners();
  void cleanupStaleNetflixSentenceAudioClips().catch(() => undefined);
  lastPlaybackSessionId = getSessionId();
  ensureStreamingToggleButton();
  window.addEventListener('resize', ensureStreamingToggleButton, { passive: true });
  document.addEventListener('fullscreenchange', ensureStreamingToggleButton);
  window.setInterval(() => {
    ensureStreamingToggleButton();
    const sessionId = getSessionId();
    if (sessionId !== lastPlaybackSessionId) {
      lastPlaybackSessionId = sessionId;
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
  if (message.type === NETFLIX_AUDIO_MESSAGES.STATUS_CHANGED) {
    if (overlaySentenceSaveState === 'capture-required') {
      overlaySentenceSaveState = 'idle';
      overlaySentenceSaveMessage = 'Audio capture is ready. Press Save sentence.';
      renderExplainPanel();
    }
    sendResponse({ success: true } as MessageResponse);
  } else if (message.type === 'GET_CURRENT_VIDEO') {
    const videoElement = getVideoElement();
    const currentSessionId = getSessionId();
    sendResponse({
      success: true,
      data: {
        platform: activePlatform,
        videoId: currentSessionId,
        sessionId: currentSessionId,
        currentTime: videoElement?.currentTime || 0,
        duration: videoElement?.duration || 0,
        playerLanguageCode: getPlayerLanguageCode(),
      }
    } as MessageResponse);
  } else if (message.type === 'GET_SUBTITLES') {
    // An explicit panel request is user intent even when the on-video overlay
    // is off, so provide transcript data without enabling or showing it.
    collectAndProcessSubtitles(true);
    const currentSessionId = getSessionId();
    const playerLanguageCode = getPlayerLanguageCode();
    sendResponse({
      success: true,
      data: {
        meaningfulSentences,
        subtitles: collectedSubtitles,
        captionLanguageCode: playerLanguageCode,
        playerLanguageCode,
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

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || !changes[BROWSER_EXTENSION_PREFERENCES_STORAGE_KEY]) return;
  overlayExplanationLanguage = getExplanationLanguageForTarget(
    normalizeBrowserExtensionPreferences(
      changes[BROWSER_EXTENSION_PREFERENCES_STORAGE_KEY].newValue,
    ),
    getOverlayEffectiveTargetLanguage(),
  );
  for (const key of Object.keys(sentenceAnalysisCache)) delete sentenceAnalysisCache[key];
  for (const key of Object.keys(wordMeaningCache)) delete wordMeaningCache[key];
  overlayExplainVisible = false;
  overlayExplainError = null;
  renderExplainPanel();
  setExplainButtonState();
  renderOverlayTargetLanguageControl();
});
