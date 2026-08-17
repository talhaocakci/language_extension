import type { SubtitleChunk, MeaningfulSentence } from '../types/subtitle';
import type { MessageRequest, MessageResponse, PlaybackControlPayload } from '../types/common';
import { groupAndProcessSubtitles } from '../utils/subtitle-processor';
import {
  DEFAULT_EXPLANATION_LANGUAGE,
  detectLanguageCode,
  EXPLANATION_LANGUAGE_STORAGE_KEY,
  getLanguageFlag,
  getLanguageLabel,
  normalizeLanguagePreference,
} from '../utils/language-preferences';

let currentVideoId = '';
let subtitleObserver: MutationObserver | null = null;
let overlayRefreshInterval: number | null = null;
let uiEnsureInterval: number | null = null;
let captionsRetryTimer: number | null = null;
let lastSubtitles: SubtitleChunk[] = [];
let allExtractedSubtitles: SubtitleChunk[] = [];
let meaningfulSentences: MeaningfulSentence[] = [];
let captionsExtracted = false;
let captionsRetryAttempts = 0;
let activeCaptionLanguageCode = '';
// Learning mode is opt-in for each video so ordinary viewing stays untouched.
let overlayEnabled = false;
let overlayLoading = false;
let overlayLastSentenceKey = '';
let overlayLastWordIndex = -1;
let overlayLastSentenceIndex = -1;
let overlayStableSentenceIndex = -1;
let overlayLastRenderTimeMs = 0;
let overlayLastAnchorSyncTimeMs = 0;
let overlayHidden = true;
let overlayShortcutListenersBound = false;

/** Video id that `meaningfulSentences` / `captionsExtracted` belong to (guards stale cache). */
let captionsCacheVideoId = '';
type OverlayNavDirection = 'prev' | 'repeat' | 'next';
type OverlaySaveState = 'saving' | 'saved' | 'error';
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

interface WordMeaning {
  lemma: string;
  meaning: string;
}

interface WordPopupState {
  sentenceKey: string;
  sourceSentence: string;
  word: string;
  display: string;
  x: number;
  y: number;
  loading: boolean;
  lemma: string | null;
  meaning: string | null;
  error: string | null;
}

const YT_OVERLAY_ID = 'yt-subtitle-learning-overlay';
const YT_TOGGLE_BTN_ID = 'yt-subtitle-learning-toggle';
const YT_WORD_POPUP_ID = 'yt-subtitle-learning-word-popup';
const YT_TARGET_LANGUAGE_VALUE_ID = 'sl-yt-overlay-target-language';
const YT_HELP_ID = 'sl-yt-overlay-help';
const YT_NATIVE_CAPTION_SUPPRESSION_STYLE_ID = 'sl-yt-native-caption-suppression';
const YT_MIN_WORD_DURATION_MS = 320;
const YT_ENABLE_WORD_HIGHLIGHTING = false;
const SLOW_PLAYBACK_RATE = 0.75;
const NORMAL_PLAYBACK_RATE = 1;
const MAX_CAPTION_RETRY_ATTEMPTS = 12;
const CAPTION_RETRY_INTERVAL_MS = 1200;

let overlayCurrentSentence: MeaningfulSentence | null = null;
let overlayExplainVisible = false;
let overlayExplainLoading = false;
let overlayExplainError: string | null = null;
let overlayAnalysisSentenceKey = '';
let overlayExplanationLanguage = DEFAULT_EXPLANATION_LANGUAGE;
const sentenceAnalysisCache: Record<string, SentenceAnalysis> = {};
const overlaySaveState: Record<string, OverlaySaveState> = {};
const overlaySaveError: Record<string, string> = {};
let overlayWordPopup: WordPopupState | null = null;
let overlayWordLookupReqId = 0;
const wordMeaningCache: Record<string, WordMeaning> = {};

function resetTranscriptState(): void {
  if (captionsRetryTimer !== null) {
    window.clearTimeout(captionsRetryTimer);
    captionsRetryTimer = null;
  }
  meaningfulSentences = [];
  captionsExtracted = false;
  captionsRetryAttempts = 0;
  captionsCacheVideoId = '';
  lastSubtitles = [];
  allExtractedSubtitles = [];
  activeCaptionLanguageCode = '';
  overlayLastSentenceKey = '';
  overlayLastWordIndex = -1;
  overlayLastSentenceIndex = -1;
  overlayStableSentenceIndex = -1;
  overlayLastRenderTimeMs = 0;
  overlayLastAnchorSyncTimeMs = 0;
  overlayCurrentSentence = null;
  overlayExplainVisible = false;
  overlayExplainLoading = false;
  overlayExplainError = null;
  overlayAnalysisSentenceKey = '';
  overlayWordPopup = null;
  overlayWordLookupReqId += 1;
  for (const key of Object.keys(sentenceAnalysisCache)) delete sentenceAnalysisCache[key];
  for (const key of Object.keys(overlaySaveState)) delete overlaySaveState[key];
  for (const key of Object.keys(overlaySaveError)) delete overlaySaveError[key];
  for (const key of Object.keys(wordMeaningCache)) delete wordMeaningCache[key];
  overlayEnabled = false;
  updateYouTubeToggleState();
  hideYouTubeOverlay();
  renderOverlayWordPopup();
}

function getVideoId(): string {
  const url = new URL(window.location.href);
  return url.searchParams.get('v') || '';
}

// Helper function to convert time string to milliseconds
function timeToMs(timeStr: string): number {
  const parts = timeStr.split(':');
  let hours = 0, minutes = 0, seconds = 0, ms = 0;
  
  if (parts.length === 3) {
    hours = parseInt(parts[0]);
    minutes = parseInt(parts[1]);
    const secParts = parts[2].split('.');
    seconds = parseInt(secParts[0]);
    ms = parseInt(secParts[1] || '0');
  } else if (parts.length === 2) {
    minutes = parseInt(parts[0]);
    const secParts = parts[1].split('.');
    seconds = parseInt(secParts[0]);
    ms = parseInt(secParts[1] || '0');
  }
  
  return hours * 3600000 + minutes * 60000 + seconds * 1000 + ms;
}

// Helper function to parse VTT format
function parseVTT(vttText: string): any[] {
  const events: any[] = [];
  const lines = vttText.split('\n');
  
  let currentTime: any = null;
  let currentText: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Skip header
    if (line === 'WEBVTT' || line === '' || (line.includes('-->') === false && i < 5)) {
      continue;
    }
    
    // Parse timecode line
    if (line.includes('-->')) {
      const [startStr, endStr] = line.split('-->').map(s => s.trim());
      const start = timeToMs(startStr);
      const end = timeToMs(endStr);
      
      currentTime = { start, end };
    } else if (line && currentTime) {
      // Caption text line
      currentText.push(line);
    } else if (!line && currentTime && currentText.length > 0) {
      // Empty line - time to save the current caption
      events.push({
        tStartMs: currentTime.start,
        dDurationMs: currentTime.end - currentTime.start,
        segs: [{utf8: currentText.join(' ')}]
      });
      currentTime = null;
      currentText = [];
    }
  }
  
  // Don't forget the last caption
  if (currentTime && currentText.length > 0) {
    events.push({
      tStartMs: currentTime.start,
      dDurationMs: currentTime.end - currentTime.start,
      segs: [{utf8: currentText.join(' ')}]
    });
  }
  
  return events;
}

type CaptionTrack = { baseUrl?: string; languageCode?: string; kind?: string };

function getCaptionTracksFromPlayerResponse(playerResponse: any): CaptionTrack[] {
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  return Array.isArray(tracks) ? tracks : [];
}

function getPlayerResponsesFromWindowObjects(): any[] {
  const responses: any[] = [];
  const w = window as any;
  const push = (candidate: any): void => {
    if (!candidate) return;
    if (typeof candidate === 'string') {
      try {
        responses.push(JSON.parse(candidate));
      } catch {
        // ignore malformed JSON payloads
      }
      return;
    }
    responses.push(candidate);
  };

  push(w?.ytInitialPlayerResponse);
  push(w?.ytplayer?.config?.player_response);
  push(w?.ytplayer?.config?.args?.raw_player_response);
  push(w?.ytplayer?.config?.args?.player_response);
  push(w?.ytplayer?.bootstrapWebPlayerContextConfig?.jsConfig?.PLAYER_VARS?.player_response);

  return responses;
}

function normalizeLanguageCode(value: string): string {
  return detectLanguageCode(value);
}

function baseLanguage(value: string): string {
  return normalizeLanguageCode(value).split('-')[0];
}

function parseTrackUrl(track: CaptionTrack): URL | null {
  if (!track.baseUrl) return null;
  try {
    return new URL(track.baseUrl);
  } catch {
    return null;
  }
}

function getTrackLanguageCode(track: CaptionTrack): string {
  if (track.languageCode && track.languageCode.trim()) {
    return normalizeLanguageCode(track.languageCode);
  }
  const u = parseTrackUrl(track);
  const lang = u?.searchParams.get('lang') || '';
  return lang ? normalizeLanguageCode(lang) : '';
}

function trackHasTranslation(track: CaptionTrack): boolean {
  const u = parseTrackUrl(track);
  const tlang = u?.searchParams.get('tlang') || '';
  return tlang.trim().length > 0;
}

function collectPreferredAudioLanguageHints(): string[] {
  const hints = new Set<string>();
  const responses = getPlayerResponsesFromWindowObjects();

  for (const response of responses) {
    const directHints = [
      response?.microformat?.playerMicroformatRenderer?.defaultAudioLanguage,
      response?.videoDetails?.defaultAudioLanguage,
    ];

    for (const hint of directHints) {
      if (typeof hint !== 'string' || !hint.trim()) continue;
      hints.add(normalizeLanguageCode(hint));
    }

    const audioTracks = response?.captions?.playerCaptionsTracklistRenderer?.audioTracks;
    if (Array.isArray(audioTracks)) {
      for (const audioTrack of audioTracks) {
        const lang = audioTrack?.languageCode;
        if (typeof lang === 'string' && lang.trim()) {
          hints.add(normalizeLanguageCode(lang));
        }
      }
    }
  }

  return Array.from(hints);
}

function scoreCaptionTrack(track: CaptionTrack, preferredAudioLangs: string[]): number {
  let score = 0;
  if (trackHasTranslation(track)) score += 250;

  const trackLang = getTrackLanguageCode(track);
  const trackBase = trackLang ? baseLanguage(trackLang) : '';
  const preferredBases = new Set(preferredAudioLangs.map(baseLanguage));

  if (trackLang && preferredAudioLangs.length > 0) {
    const exactMatch = preferredAudioLangs.includes(trackLang);
    const baseMatch = preferredBases.has(trackBase);
    if (!exactMatch && !baseMatch) {
      score += 80;
    }

    const preferredIsMostlyNonEnglish = Array.from(preferredBases).some((lang) => lang && lang !== 'en');
    if (preferredIsMostlyNonEnglish && trackBase === 'en') {
      score += 180;
    }
  }

  // Slightly prefer manually authored captions over ASR when language is otherwise equal.
  if (track.kind === 'asr') score += 8;

  return score;
}

function getPreferredCaptionLanguageCodeFromTracks(tracks: CaptionTrack[]): string {
  if (!Array.isArray(tracks) || tracks.length === 0) return '';
  const preferredAudioLangs = collectPreferredAudioLanguageHints();
  const sorted = [...tracks].sort((a, b) => {
    const scoreDiff = scoreCaptionTrack(a, preferredAudioLangs) - scoreCaptionTrack(b, preferredAudioLangs);
    if (scoreDiff !== 0) return scoreDiff;
    return getTrackLanguageCode(a).localeCompare(getTrackLanguageCode(b));
  });
  const bestTrack = sorted.find((track) => !!getTrackLanguageCode(track));
  return bestTrack ? getTrackLanguageCode(bestTrack) : '';
}

function extractJsonObjectAfterMarker(source: string, marker: string): any | null {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;

  const objectStart = source.indexOf('{', markerIndex + marker.length);
  if (objectStart < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = objectStart; i < source.length; i += 1) {
    const ch = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const raw = source.slice(objectStart, i + 1);
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function collectCaptionTracksFromWindowObjects(): CaptionTrack[] {
  const tracks: CaptionTrack[] = [];
  const pushTracks = (playerResponse: any): void => {
    tracks.push(...getCaptionTracksFromPlayerResponse(playerResponse));
  };

  const playerResponses = getPlayerResponsesFromWindowObjects();
  for (const response of playerResponses) {
    pushTracks(response);
  }

  return tracks;
}

async function extractCaptionTracksFromHTML(): Promise<CaptionTrack[]> {
  console.log('Extracting caption tracks from HTML...');
  
  const fromWindow = collectCaptionTracksFromWindowObjects();
  if (fromWindow.length > 0) {
    console.log(`✓ Found ${fromWindow.length} caption tracks on window objects`);
    return fromWindow;
  }

  const scripts = document.querySelectorAll('script');
  for (const script of scripts) {
    const text = script.textContent || '';
    
    if (text.includes('ytInitialPlayerResponse')) {
      const markers = [
        'var ytInitialPlayerResponse =',
        'ytInitialPlayerResponse =',
        'window["ytInitialPlayerResponse"] =',
      ];

      for (const marker of markers) {
        const parsed = extractJsonObjectAfterMarker(text, marker);
        if (!parsed) continue;
        const tracks = getCaptionTracksFromPlayerResponse(parsed);
        if (tracks.length > 0) {
          console.log(`✓ Found ${tracks.length} caption tracks in script tag`);
          return tracks;
        }
      }
    }
    
    // Look for caption data in serialized form
    if (text.includes('captionTracks')) {
      const captionMatch = text.match(/"captionTracks"\s*:\s*\[(.*?)\]/);
      if (captionMatch) {
        try {
          const captionData = JSON.parse('[' + captionMatch[1] + ']');
          console.log('✓ Found captionTracks in script tag');
          return captionData;
        } catch (e) {
          console.log('Failed to parse captionTracks');
        }
      }
    }
  }
  
  return [];
}

// Parse a "M:SS" or "H:MM:SS" string to milliseconds
function parseTimestampText(t: string): number {
  const parts = t.trim().split(':').map(Number);
  if (parts.some(isNaN)) return -1;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  return -1;
}

async function fetchCaptionsFromTranscriptPanel(): Promise<SubtitleChunk[]> {
  try {
    console.log('Fetching captions from YouTube transcript panel...');

    // Find the transcript button (handles multiple locales including Turkish)
    const transcriptButton = document.querySelector(
      'ytd-video-description-transcript-section-renderer #primary-button button, ' +
      'button[aria-label*="ranscript"], ' +
      'button[aria-label*="ranskript"], ' +
      'button[aria-label*="ranskripti"]'
    ) as HTMLButtonElement | null;

    if (!transcriptButton) {
      console.log('⚠️ Transcript button not found');
      return [];
    }

    console.log('✓ Found transcript button, clicking it...');
    transcriptButton.click();

    // Wait up to 8 seconds for any transcript content to appear.
    // We try multiple strategies in order of preference.
    const deadline = Date.now() + 8000;
    let rawCaptions: SubtitleChunk[] = [];

    while (Date.now() < deadline) {
      rawCaptions = extractSegmentsFromDOM();
      if (rawCaptions.length > 0) break;
      await new Promise(r => setTimeout(r, 250));
    }

    if (rawCaptions.length === 0) {
      console.log('⚠️ Transcript panel DOM extraction found nothing after 8 s');
      // Log what IS in the DOM to aid future debugging
      const allCustom = document.querySelectorAll(
        'ytd-transcript-renderer, ytd-transcript-segment-renderer, ytd-transcript-segment-list-renderer'
      );
      console.log(`Custom elements found: ${allCustom.length} (ytd-transcript-*)`);
      return [];
    }

    // Compute endTime = next segment's startTime (last one gets +5 s)
    for (let i = 0; i < rawCaptions.length; i++) {
      rawCaptions[i].endTime =
        i + 1 < rawCaptions.length
          ? rawCaptions[i + 1].startTime
          : rawCaptions[i].startTime + 5000;
    }

    console.log(`✓ Extracted ${rawCaptions.length} captions from transcript panel`);
    return rawCaptions;

  } catch (error) {
    console.error('Error fetching captions from transcript panel:', error);
  }

  return [];
}

function extractSegmentsFromDOM(): SubtitleChunk[] {
  const results: SubtitleChunk[] = [];

  // ── Strategy 1: ytd-transcript-segment-renderer with data-start-ms ──
  const byRenderer = document.querySelectorAll('ytd-transcript-segment-renderer');
  if (byRenderer.length > 0) {
    console.log(`Strategy 1: found ${byRenderer.length} ytd-transcript-segment-renderer`);
    for (const seg of byRenderer) {
      const el = seg as HTMLElement;
      let startMs = parseInt(el.getAttribute('data-start-ms') || '-1', 10);

      // If data-start-ms not present, parse the timestamp child
      if (startMs < 0) {
        const tsEl = el.querySelector('.segment-start-offset, [class*="timestamp"], [class*="offset"]');
        if (tsEl) startMs = parseTimestampText(tsEl.textContent || '');
      }

      const textEl =
        el.querySelector('.segment-text') ||
        el.querySelector('yt-formatted-string.segment-text') ||
        el.querySelector('yt-formatted-string');
      const text = textEl?.textContent?.trim() || '';

      if (startMs >= 0 && text.length > 1) results.push({ text, startTime: startMs, endTime: 0 });
    }
    if (results.length > 0) return results;
  }

  // ── Strategy 2: find the transcript panel container, then pair
  //    timestamp + text children inside each segment row ──────────────
  const transcriptRenderer =
    document.querySelector('ytd-transcript-renderer') ||
    document.querySelector('[target-id="engagement-panel-transcript"]');

  if (transcriptRenderer) {
    console.log('Strategy 2: found transcript renderer container');
    // Each row typically has a timestamp-like child and a text child as siblings
    const rows = transcriptRenderer.querySelectorAll(
      '[class*="segment"], div[class*="cue"], div[class*="line"]'
    );
    for (const row of rows) {
      const children = Array.from(row.children);
      let startMs = -1;
      let text = '';

      for (const child of children) {
        const raw = child.textContent?.trim() || '';
        if (raw.match(/^\d+:\d{2}/) && startMs < 0) {
          startMs = parseTimestampText(raw.replace(/\s.*/, ''));
        } else if (raw.length > 1 && !raw.match(/^\d+:\d{2}/)) {
          text = raw;
        }
      }

      if (startMs >= 0 && text.length > 1) results.push({ text, startTime: startMs, endTime: 0 });
    }
    if (results.length > 0) return results;
  }

  // ── Strategy 3: All yt-formatted-string[role="button"] — these are
  //    the text nodes in the transcript panel. The timestamp is in a
  //    sibling element inside the same parent. ─────────────────────────
  const textButtons = document.querySelectorAll('yt-formatted-string[role="button"]');
  if (textButtons.length > 10) {
    console.log(`Strategy 3: found ${textButtons.length} text buttons, scanning for transcript ones`);
    const seen = new Set<Element>();
    for (const btn of textButtons) {
      const parent = btn.parentElement;
      if (!parent || seen.has(parent)) continue;
      seen.add(parent);

      const captionText = btn.textContent?.trim() || '';
      if (captionText.length < 2) continue;

      // Look for a timestamp sibling
      let startMs = -1;
      for (const sibling of parent.children) {
        if (sibling === btn) continue;
        const raw = sibling.textContent?.trim() || '';
        if (raw.match(/^\d+:\d{2}/)) {
          startMs = parseTimestampText(raw);
          break;
        }
      }

      // If no sibling timestamp, check the parent itself or grandparent
      if (startMs < 0) {
        const grandParent = parent.parentElement;
        if (grandParent) {
          for (const uncle of grandParent.children) {
            if (uncle === parent) continue;
            const raw = uncle.textContent?.trim() || '';
            if (raw.match(/^\d+:\d{2}/)) {
              startMs = parseTimestampText(raw);
              break;
            }
          }
        }
      }

      if (startMs >= 0) results.push({ text: captionText, startTime: startMs, endTime: 0 });
    }
    if (results.length > 0) return results;
  }

  return results;
}

async function fetchCaptionsFromAPI(videoId: string): Promise<SubtitleChunk[]> {
  console.log(`Fetching captions for video: ${videoId}`);
  const discoveredTracks = collectCaptionTracksFromWindowObjects();
  const preferredLanguage = getPreferredCaptionLanguageCodeFromTracks(discoveredTracks);
  if (preferredLanguage) {
    activeCaptionLanguageCode = preferredLanguage;
  }

  // Delegate everything (button click, fetch intercept, DOM scrape) to the
  // page-context script, which has access to YouTube's live window objects,
  // authenticated fetch, and the full DOM — all from within the page origin.
  console.log('Injecting page-context caption fetcher...');
  const pageResult = await fetchCaptionsViaPageScript();
  if (pageResult.length > 0) {
    console.log(`✓ Got ${pageResult.length} captions via page script`);
    return pageResult;
  }

  console.log('✗ All caption extraction methods failed');
  return [];
}

function parseCaptionText(captionText: string): SubtitleChunk[] {
  const captions: SubtitleChunk[] = [];

  const mergeSegTexts = (segs: any[]): string => {
    let merged = '';
    for (const seg of segs) {
      const part = typeof seg?.utf8 === 'string' ? seg.utf8 : '';
      if (!part) continue;
      if (!merged) {
        merged = part;
        continue;
      }

      const prevChar = merged[merged.length - 1];
      const nextChar = part[0];
      const prevEndsWithSpace = /\s$/u.test(merged);
      const nextStartsWithSpace = /^\s/u.test(part);
      const prevIsWord = /[\p{L}\p{N}]/u.test(prevChar);
      const nextIsWord = /[\p{L}\p{N}]/u.test(nextChar);

      // Guard against accidentally gluing tokens from segmented cues (e.g. "doch" + "auch").
      if (!prevEndsWithSpace && !nextStartsWithSpace && prevIsWord && nextIsWord) {
        merged += ' ';
      }

      merged += part;
    }

    return merged
      .replace(/\u200B/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  };

  // Try JSON (fmt=json3)
  try {
    const data = JSON.parse(captionText);
    if (data.events && Array.isArray(data.events)) {
      for (const event of data.events) {
        if (!event.segs) continue;
        const text = mergeSegTexts(event.segs as any[]);
        if (text.length > 0) {
          captions.push({
            text,
            startTime: event.tStartMs || 0,
            endTime: (event.tStartMs || 0) + (event.dDurationMs || 3000)
          });
        }
      }
      console.log(`✓ Parsed ${captions.length} captions from JSON`);
      return captions;
    }
  } catch {
    // not JSON
  }

  // Try WEBVTT
  if (captionText.includes('WEBVTT')) {
    const vttEvents = parseVTT(captionText);
    for (const event of vttEvents) {
      if (!event.segs) continue;
      const text = mergeSegTexts(event.segs as any[]);
      if (text.length > 0) {
        captions.push({
          text,
          startTime: event.tStartMs || 0,
          endTime: (event.tStartMs || 0) + (event.dDurationMs || 3000)
        });
      }
    }
    console.log(`✓ Parsed ${captions.length} captions from VTT`);
    return captions;
  }

  return captions;
}

function buildCaptionUrlCandidates(baseUrl: string): string[] {
  const out = new Set<string>();

  try {
    const u = new URL(baseUrl);

    const withoutTranslation = new URL(u.toString());
    withoutTranslation.searchParams.delete('tlang');
    out.add(withoutTranslation.toString());

    const withoutTranslationJson = new URL(withoutTranslation.toString());
    withoutTranslationJson.searchParams.set('fmt', 'json3');
    out.add(withoutTranslationJson.toString());

    const withoutTranslationVtt = new URL(withoutTranslation.toString());
    withoutTranslationVtt.searchParams.set('fmt', 'vtt');
    out.add(withoutTranslationVtt.toString());

    // Keep translated forms as fallback only.
    out.add(u.toString());

    const asJson = new URL(u.toString());
    asJson.searchParams.set('fmt', 'json3');
    out.add(asJson.toString());

    const asVtt = new URL(u.toString());
    asVtt.searchParams.set('fmt', 'vtt');
    out.add(asVtt.toString());
  } catch {
    // ignore malformed URL
    out.add(baseUrl);
  }

  return Array.from(out);
}

async function fetchCaptionsFromCaptionTracksFallback(): Promise<SubtitleChunk[]> {
  const tracks: CaptionTrack[] = [];
  tracks.push(...collectCaptionTracksFromWindowObjects());

  const htmlTracks = await extractCaptionTracksFromHTML();
  if (Array.isArray(htmlTracks)) {
    tracks.push(...htmlTracks);
  }

  const uniqueTracks: CaptionTrack[] = [];
  const seen = new Set<string>();
  for (const track of tracks) {
    const key = String(track?.baseUrl || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniqueTracks.push(track);
  }

  if (uniqueTracks.length === 0) {
    console.log('No caption tracks found for fallback fetching');
    return [];
  }

  const preferredAudioLangs = collectPreferredAudioLanguageHints();
  uniqueTracks.sort((a, b) => {
    const scoreDiff = scoreCaptionTrack(a, preferredAudioLangs) - scoreCaptionTrack(b, preferredAudioLangs);
    if (scoreDiff !== 0) return scoreDiff;
    return getTrackLanguageCode(a).localeCompare(getTrackLanguageCode(b));
  });

  for (const track of uniqueTracks) {
    if (!track?.baseUrl) continue;
    const candidates = buildCaptionUrlCandidates(track.baseUrl);
    for (const candidate of candidates) {
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'FETCH_TIMEDTEXT',
          payload: { url: candidate }
        });

        if (!resp?.success || !resp.data || typeof resp.data !== 'string') {
          continue;
        }

        const parsed = parseCaptionText(resp.data);
        if (parsed.length > 0) {
          const languageCode = getTrackLanguageCode(track);
          if (languageCode) {
            activeCaptionLanguageCode = languageCode;
          }
          console.log(`✓ Fallback caption-track fetch succeeded (${parsed.length} cues)`);
          return parsed;
        }
      } catch {
        // try next candidate
      }
    }
  }

  return [];
}

async function fetchCaptionsViaPageScript(): Promise<SubtitleChunk[]> {
  // The service worker intercepts YouTube's own timedtext request via webRequest
  // (which includes the pot= token) and re-fetches it from the extension context.
  // We just ask it for the result.
  console.log('Requesting captured timedtext from service worker...');
  const response = await chrome.runtime.sendMessage({
    type: 'GET_TRANSCRIPT',
    payload: { videoId: currentVideoId },
  });

  if (!response?.success || !response?.data) {
    console.log('Service worker GET_TRANSCRIPT failed:', response?.error);
    return fetchCaptionsFromCaptionTracksFallback();
  }

  const playerLanguage = normalizeLanguageCode(String(response.languageCode || ''));
  if (playerLanguage) {
    activeCaptionLanguageCode = playerLanguage;
  }

  console.log(`✓ Service worker returned ${response.data.length} bytes`);
  const parsed = parseCaptionText(response.data);
  if (parsed.length > 0) {
    return parsed;
  }

  return fetchCaptionsFromCaptionTracksFallback();
}

function extractPreparedCaptions(): SubtitleChunk[] {
  const captions: SubtitleChunk[] = [];

  try {
    console.log('=== EXTRACTING CAPTIONS FROM YOUTUBE ===');
    
    // Method 1: Try window.yt object (YouTube's internal API)
    const windowAny = window as any;
    
    if (windowAny.yt && windowAny.yt.player && windowAny.yt.player.instance) {
      console.log('Found window.yt.player.instance');
      const player = windowAny.yt.player.instance;
      
      try {
        // Try to get captions through the player API
        const tracks = player.getVideoData?.()?.captions;
        if (tracks) {
          console.log('Found captions in player API:', tracks);
        }
      } catch (e) {
        console.log('Could not access player captions API');
      }
    }

    // Method 2: Check ytInitialData for caption tracks
    if (windowAny.ytInitialData) {
      console.log('Checking ytInitialData for caption tracks...');
      const data = windowAny.ytInitialData;
      
      // Caption tracks are usually in videoDetails > subtitles
      try {
        const response = data?.contents?.twoColumnWatchNextResults?.results?.results?.contents;
        if (response) {
          console.log('Found response in ytInitialData');
        }
      } catch (e) {
        console.log('Could not find captions in ytInitialData structure');
      }
    }

    // Method 3: Check ytInitialPlayerResponse (contains caption tracks)
    if (windowAny.ytInitialPlayerResponse) {
      console.log('Checking ytInitialPlayerResponse for caption tracks...');
      const playerResponse = windowAny.ytInitialPlayerResponse;
      
      if (playerResponse.captions) {
        const captionTracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (captionTracks && Array.isArray(captionTracks)) {
          console.log(`Found ${captionTracks.length} caption tracks in ytInitialPlayerResponse`);
          
          for (const track of captionTracks) {
            console.log(`Track: ${track.name?.simpleText || track.label} (lang: ${track.languageCode})`);
            
            if (track.baseUrl) {
              console.log(`Track has baseUrl: ${track.baseUrl.substring(0, 100)}...`);
              // The baseUrl points to a JSON file with captions that can be fetched
              // We will use fetchCaptionsFromAPI to handle this
            }
          }
        }
      }
    }

    // Method 4: Access through document.head script tags
    console.log('Looking for caption data in script tags...');
    const scripts = document.querySelectorAll('script');
    let captionDataFound = false;
    
    for (const script of scripts) {
      if (script.textContent && script.textContent.includes('captionTracks')) {
        console.log('Found script tag with captionTracks data');
        captionDataFound = true;
        break;
      }
    }

    // Method 5: Try the video element's tracks after page fully loads
    const videoElement = document.querySelector('video') as HTMLVideoElement;
    if (videoElement) {
      console.log(`Video element textTracks: ${videoElement.textTracks.length}`);
      
      // Force load all tracks
      for (let i = 0; i < videoElement.textTracks.length; i++) {
        const track = videoElement.textTracks[i] as any;
        console.log(`Track ${i}: kind=${track.kind}, label=${track.label}, language=${track.language}`);
        
        // Try to access the track's data
        if (track.kind === 'subtitles' || track.kind === 'captions') {
          console.log(`Processing caption track ${i}...`);
          
          // Set track to 'showing' to force loading
          track.mode = 'showing';
          
          // Now try to access cues
          if (track.cues && track.cues.length > 0) {
            console.log(`Track ${i} has ${track.cues.length} cues!`);
            
            for (let j = 0; j < track.cues.length; j++) {
              const cue = track.cues[j] as VTTCue;
              captions.push({
                text: cue.text.replace(/<[^>]*>/g, '').trim(),
                startTime: cue.startTime * 1000,
                endTime: cue.endTime * 1000
              });
            }
          } else {
            console.log(`Track ${i} has no cues (yet)`);
            // Track might load asynchronously
            track.addEventListener('load', () => {
              console.log(`Track ${i} loaded, cues: ${track.cues?.length || 0}`);
            });
          }
        }
      }
    }

  } catch (error) {
    console.error('Error extracting captions:', error);
  }

  console.log(`Extracted ${captions.length} prepared captions total`);
  return captions;
}

function setupSubtitleObserver(): void {
  if (subtitleObserver) {
    subtitleObserver.disconnect();
  }

  try {
    const videoContainer = document.querySelector('.ytp-caption-window-container');
    if (!videoContainer) {
      setTimeout(setupSubtitleObserver, 1000);
      return;
    }

    console.log('Setting up subtitle observer to collect captions as they appear');
    
    let lastCollectionTime = 0;
    const collectionInterval = 500; // Collect every 500ms

    subtitleObserver = new MutationObserver(() => {
      const now = Date.now();
      if (now - lastCollectionTime < collectionInterval) {
        return; // Don't collect too frequently
      }
      lastCollectionTime = now;

      // Get current visible caption
      const captionWindow = videoContainer.querySelector('.caption-window');
      if (captionWindow) {
        const text = (captionWindow as HTMLElement).innerText?.trim();
        
        if (text && text.length > 3 && text.length < 1000) {
          const video = document.querySelector('video') as HTMLVideoElement;
          const currentTime = video?.currentTime || 0;
          
          // Check if this is a new caption (not already in our list)
          const exists = allExtractedSubtitles.some(s => 
            s.text.trim() === text.trim()
          );
          
          if (!exists) {
            allExtractedSubtitles.push({
              text: text,
              startTime: Math.max(0, (currentTime - 2) * 1000),
              endTime: (currentTime + 2) * 1000
            });
            
            console.log(`Collected caption (total: ${allExtractedSubtitles.length}): "${text.substring(0, 60)}..."`);
          }
        }
      }
    });

    subtitleObserver.observe(videoContainer, {
      childList: true,
      subtree: true,
      characterData: true
    });
    
    console.log('Subtitle observer started - captions will be collected as video plays');
  } catch (error) {
    console.error('Error setting up observer:', error);
    setTimeout(setupSubtitleObserver, 1000);
  }
}

function hideYouTubeOverlay(): void {
  restoreYouTubeNativeCaptions();
  const overlay = document.getElementById(YT_OVERLAY_ID) as HTMLDivElement | null;
  if (!overlay) {
    overlayHidden = true;
    return;
  }
  overlay.style.opacity = '0';
  overlayHidden = true;
  hideOverlayWordPopup();
}

function getCurrentTimeMs(): number | null {
  const video = document.querySelector('video') as HTMLVideoElement | null;
  if (!video || Number.isNaN(video.currentTime)) return null;
  return Math.max(0, Math.round(video.currentTime * 1000));
}

function getVideoElement(): HTMLVideoElement | null {
  const video = document.querySelector('video') as HTMLVideoElement | null;
  if (!video) return null;
  return video;
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return target.isContentEditable;
}

function normalizeSentenceAnalysis(raw: Record<string, unknown>): SentenceAnalysis {
  const pv = raw.phrasalVerbs;
  const fp = raw.fixedPhrases;
  const phrasalVerbs = Array.isArray(pv) ? (pv as PhrasalVerb[]) : [];
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
  const preferences = await chrome.runtime.sendMessage({ type: 'GET_LANGUAGE_PREFERENCES' });
  const explanationLanguage = normalizeLanguagePreference(
    preferences?.data?.explanationLanguage,
    DEFAULT_EXPLANATION_LANGUAGE,
  );
  const targetLanguage = getOverlayEffectiveTargetLanguage() || 'auto-detect';
  const systemPrompt = `You are a multilingual language teacher analysing a ${targetLanguage} sentence.
Return ONLY JSON with keys:
- lemma: base form
- meaning: short meaning in ${explanationLanguage} for this sentence context
No extra keys, no markdown.`;

  const rawText = await callOverlayLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Clicked token: "${word}"\nFull sentence: "${sentence}"` }
  ]);

  const parsed = JSON.parse(rawText) as Record<string, unknown>;
  return {
    lemma: typeof parsed.lemma === 'string' ? parsed.lemma : word,
    meaning: typeof parsed.meaning === 'string' ? parsed.meaning : ''
  };
}

async function analyseForPhrasalVerbs(sentence: string): Promise<SentenceAnalysis> {
  const preferences = await chrome.runtime.sendMessage({ type: 'GET_LANGUAGE_PREFERENCES' });
  const explanationLanguage = normalizeLanguagePreference(
    preferences?.data?.explanationLanguage,
    DEFAULT_EXPLANATION_LANGUAGE,
  );
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
  return (
    m.includes('not logged in') ||
    m.includes('session expired') ||
    m.includes('please sign in') ||
    m.includes('extension popup')
  );
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

function getOverlayEffectiveTargetLanguage(): string {
  const lang = normalizeLanguageCode(activeCaptionLanguageCode || '');
  return lang;
}

function isAuthRequiredError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('not logged in') || m.includes('please sign in') || m.includes('session expired');
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

    if (resp?.error && isAuthRequiredError(resp.error)) {
      void chrome.runtime.sendMessage({ type: 'OPEN_EXTENSION_POPUP' });
    }
    console.error('SAVE_IDIOM failed:', resp?.error, resp?.data);
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

function countCleanWordsInText(text: string): number {
  const parts = text.match(/(\s+|\S+)/gu) || [];
  let count = 0;
  for (const part of parts) {
    if (/^\s+$/u.test(part)) continue;
    const clean = part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (clean.length > 0) count += 1;
  }
  return count;
}

function findActiveSubPortionIndex(
  portions: Array<{ startTime: number; endTime: number }>,
  currentTimeMs: number
): number {
  for (let i = 0; i < portions.length; i += 1) {
    const p = portions[i];
    if (currentTimeMs >= p.startTime && currentTimeMs <= p.endTime) return i;
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
  if (totalWords <= 0) return -1;

  const subPortions = (sentence.subPortions || [])
    .filter((p) => Number.isFinite(p.startTime) && Number.isFinite(p.endTime))
    .map((p) => ({
      startTime: p.startTime,
      endTime: Math.max(p.endTime, p.startTime + 1),
      wordCount: countCleanWordsInText(p.text || ''),
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
      const effectiveDuration = Math.max(rawDuration, activePortion.wordCount * YT_MIN_WORD_DURATION_MS);
      const elapsed = Math.max(0, currentTimeMs - activePortion.startTime);
      const progress = Math.min(1, elapsed / effectiveDuration);
      const localWordIndex = Math.min(mappedCount - 1, Math.floor(progress * mappedCount));

      return Math.max(0, Math.min(totalWords - 1, mappedStart + localWordIndex));
    }
  }

  const rawSpanMs = Math.max(1, sentence.endTime - sentence.startTime);
  const effectiveSpanMs = Math.max(rawSpanMs, totalWords * YT_MIN_WORD_DURATION_MS);
  const elapsed = Math.max(0, currentTimeMs - sentence.startTime);
  const progress = Math.min(1, elapsed / effectiveSpanMs);
  return Math.min(totalWords - 1, Math.floor(progress * totalWords));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function ensureWordPopupElement(): HTMLDivElement {
  const existing = document.getElementById(YT_WORD_POPUP_ID) as HTMLDivElement | null;
  if (existing) return existing;

  const popup = document.createElement('div');
  popup.id = YT_WORD_POPUP_ID;
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

  const x = Math.max(10, Math.min(window.innerWidth - 330, Math.round(state.x)));
  const y = Math.max(10, Math.min(window.innerHeight - 200, Math.round(state.y)));
  popup.style.left = `${x}px`;
  popup.style.top = `${y}px`;
  popup.style.display = 'block';

  if (state.loading) {
    popup.innerHTML = `<div style="color:#b9c9ff;font-weight:700;">${escapeHtml(state.display)}</div><div style="margin-top:6px;color:#d7e1ff;">Loading meaning…</div>`;
    return;
  }
  if (state.error) {
    popup.innerHTML = `<div style="color:#b9c9ff;font-weight:700;">${escapeHtml(state.display)}</div><div style="margin-top:6px;color:#ffb8b8;">${escapeHtml(state.error)}</div>`;
    return;
  }

  popup.innerHTML = `
    <div style="color:#b9c9ff;font-weight:700;">${escapeHtml(state.display)}</div>
    ${state.lemma ? `<div style="margin-top:4px;color:#d5dfff;"><strong>Lemma:</strong> ${escapeHtml(state.lemma)}</div>` : ''}
    ${state.meaning ? `<div style="margin-top:6px;color:#f3f7ff;">${escapeHtml(state.meaning)}</div>` : ''}
  `;
}

function hideOverlayWordPopup(): void {
  if (!overlayWordPopup) return;
  overlayWordPopup = null;
  renderOverlayWordPopup();
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
  const cacheKey = `${sentenceKey}|${clean.toLowerCase()}`;
  const cached = wordMeaningCache[cacheKey];

  overlayWordPopup = {
    sentenceKey,
    sourceSentence: sentence.text,
    word: clean,
    display,
    x,
    y,
    loading: !cached,
    lemma: cached?.lemma ?? null,
    meaning: cached?.meaning ?? null,
    error: null
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
      error: null
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
      error: err instanceof Error ? err.message : 'Failed to load meaning.'
    };
    renderOverlayWordPopup();
  }
}

function setExplainButtonState(): void {
  const overlay = document.getElementById(YT_OVERLAY_ID) as HTMLDivElement | null;
  if (!overlay) return;
  const btn = overlay.querySelector('.sl-yt-overlay-explain-btn') as HTMLButtonElement | null;
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

function renderOverlayLanguagePair(): void {
  const overlay = document.getElementById(YT_OVERLAY_ID) as HTMLDivElement | null;
  if (!overlay) return;
  const value = overlay.querySelector(`#${YT_TARGET_LANGUAGE_VALUE_ID}`) as HTMLSpanElement | null;
  if (!value) return;

  const detected = getOverlayEffectiveTargetLanguage();
  const targetLabel = detected ? `${getLanguageLabel(detected)} subtitles` : 'Target language not detected';
  value.textContent = getLanguageFlag(detected);
  value.title = targetLabel;
  value.setAttribute('aria-label', value.title);
}

function renderExplainPanel(): void {
  const overlay = document.getElementById(YT_OVERLAY_ID) as HTMLDivElement | null;
  if (!overlay) return;
  const panel = overlay.querySelector('.sl-yt-overlay-explain-panel') as HTMLDivElement | null;
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
    const err = document.createElement('div');
    err.textContent = overlayExplainError;
    err.style.color = isAuthRequiredExplainError(overlayExplainError) ? '#ffcccb' : '#ffb8b8';
    panel.appendChild(err);
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
    const title = document.createElement('div');
    title.textContent = 'Phrases & grammar';
    title.style.cssText = 'color:#bcd0ff;font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:6px;';
    panel.appendChild(title);
    for (const fp of analysis.fixedPhrases) {
      const row = document.createElement('div');
      row.style.cssText = 'margin-bottom:6px;padding:5px 6px;border-radius:6px;background:rgba(115,142,224,0.14);';

      const top = document.createElement('div');
      top.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:space-between;';
      const left = document.createElement('strong');
      left.textContent = fp.canonicalForm;
      left.style.color = '#f0f5ff';

      const saveKey = fp.canonicalForm;
      const saveStatus = overlaySaveState[saveKey];
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.textContent =
        saveStatus === 'saved'
          ? 'Added'
          : saveStatus === 'saving'
            ? 'Adding…'
            : saveStatus === 'error'
              ? 'Retry Add'
              : 'Add to vocabulary';
      saveBtn.title = saveStatus === 'error'
        ? overlaySaveError[saveKey] || 'Could not add this item.'
        : saveStatus === 'saved'
          ? 'Added to vocabulary'
          : 'Add to vocabulary';
      saveBtn.disabled = saveStatus === 'saving' || saveStatus === 'saved';
      saveBtn.style.cssText = `
        border: 1px solid ${saveStatus === 'saved' ? 'rgba(120,220,170,0.7)' : saveStatus === 'error' ? 'rgba(255,160,160,0.72)' : 'rgba(153,179,255,0.52)'};
        background: ${saveStatus === 'saved' ? 'rgba(64,152,109,0.35)' : saveStatus === 'error' ? 'rgba(159,74,74,0.38)' : 'rgba(90,125,245,0.24)'};
        color: #edf3ff;
        border-radius: 999px;
        padding: 3px 9px;
        font-size: 11px;
        font-weight: 700;
        line-height: 1.2;
        cursor: ${saveBtn.disabled ? 'default' : 'pointer'};
        opacity: ${saveBtn.disabled ? '0.72' : '1'};
      `;
      saveBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!overlayCurrentSentence) return;
        void saveIdiomFromOverlay(
          fp.canonicalForm,
          fp.foundInText,
          fp.kind,
          fp.meaning,
          fp.example,
          overlayCurrentSentence.text,
          buildSourceUrl(overlayCurrentSentence.startTime),
          document.title,
        );
      });

      top.appendChild(left);
      top.appendChild(saveBtn);

      const meaning = document.createElement('div');
      meaning.textContent = fp.meaning;
      meaning.style.cssText = 'margin-top:2px;color:#e4ecff;';

      row.appendChild(top);
      row.appendChild(meaning);
      if (saveStatus === 'error' && overlaySaveError[saveKey]) {
        const saveError = document.createElement('div');
        saveError.textContent = overlaySaveError[saveKey];
        saveError.style.cssText = 'margin-top:3px;color:#ffb3b3;font-size:10px;';
        row.appendChild(saveError);
      }
      if (fp.example) {
        const ex = document.createElement('div');
        ex.textContent = fp.example;
        ex.style.cssText = 'margin-top:2px;color:#b8c9f5;font-style:italic;';
        row.appendChild(ex);
      }
      panel.appendChild(row);
    }
  }

  if (analysis.phrasalVerbs.length > 0) {
    const title = document.createElement('div');
    title.textContent = 'Phrasal & particle verbs';
    title.style.cssText = 'color:#bcd0ff;font-size:11px;font-weight:700;text-transform:uppercase;margin:8px 0 6px;';
    panel.appendChild(title);
    for (const pv of analysis.phrasalVerbs) {
      const row = document.createElement('div');
      row.style.cssText = 'margin-bottom:6px;padding:5px 6px;border-radius:6px;background:rgba(107,166,255,0.12);';

      const top = document.createElement('div');
      top.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:space-between;';
      const base = document.createElement('strong');
      base.textContent = pv.baseForm || pv.foundInText;
      base.style.color = '#f0f5ff';

      const saveKey = pv.baseForm || pv.foundInText;
      const saveStatus = overlaySaveState[saveKey];
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.textContent =
        saveStatus === 'saved'
          ? 'Added'
          : saveStatus === 'saving'
            ? 'Adding…'
            : saveStatus === 'error'
              ? 'Retry Add'
              : 'Add to vocabulary';
      saveBtn.title = saveStatus === 'error'
        ? overlaySaveError[saveKey] || 'Could not add this item.'
        : saveStatus === 'saved'
          ? 'Added to vocabulary'
          : 'Add to vocabulary';
      saveBtn.disabled = saveStatus === 'saving' || saveStatus === 'saved';
      saveBtn.style.cssText = `
        border: 1px solid ${saveStatus === 'saved' ? 'rgba(120,220,170,0.7)' : saveStatus === 'error' ? 'rgba(255,160,160,0.72)' : 'rgba(153,179,255,0.52)'};
        background: ${saveStatus === 'saved' ? 'rgba(64,152,109,0.35)' : saveStatus === 'error' ? 'rgba(159,74,74,0.38)' : 'rgba(90,125,245,0.24)'};
        color: #edf3ff;
        border-radius: 999px;
        padding: 3px 9px;
        font-size: 11px;
        font-weight: 700;
        line-height: 1.2;
        cursor: ${saveBtn.disabled ? 'default' : 'pointer'};
        opacity: ${saveBtn.disabled ? '0.72' : '1'};
      `;
      saveBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!overlayCurrentSentence) return;
        void saveIdiomFromOverlay(
          pv.baseForm || pv.foundInText,
          pv.foundInText,
          'phrasal_verb',
          pv.meaning,
          pv.example,
          overlayCurrentSentence.text,
          buildSourceUrl(overlayCurrentSentence.startTime),
          document.title,
        );
      });

      top.appendChild(base);
      top.appendChild(saveBtn);

      const meaning = document.createElement('div');
      meaning.textContent = pv.meaning || '';
      meaning.style.cssText = 'margin-top:2px;color:#e4ecff;';

      row.appendChild(top);
      row.appendChild(meaning);
      if (saveStatus === 'error' && overlaySaveError[saveKey]) {
        const saveError = document.createElement('div');
        saveError.textContent = overlaySaveError[saveKey];
        saveError.style.cssText = 'margin-top:3px;color:#ffb3b3;font-size:10px;';
        row.appendChild(saveError);
      }
      panel.appendChild(row);
    }
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
  await applyPlaybackControl({ action: 'pause' });
  const sentenceKey = getSentenceStableKey(sentence);

  const isCurrentVisible =
    overlayExplainVisible && overlayAnalysisSentenceKey === sentenceKey && !overlayExplainLoading;
  if (isCurrentVisible && !forceRefresh) {
    overlayExplainVisible = false;
    overlayExplainError = null;
    overlayExplainLoading = false;
    renderExplainPanel();
    setExplainButtonState();
    return;
  }

  overlayExplainVisible = true;
  overlayExplainError = null;
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
  } catch (err) {
    if (!overlayCurrentSentence || getSentenceStableKey(overlayCurrentSentence) !== sentenceKey) {
      return;
    }
    overlayExplainLoading = false;
    overlayExplainError = err instanceof Error ? err.message : 'Failed to explain sentence.';
    overlayExplainVisible = true;
  }

  renderExplainPanel();
  setExplainButtonState();
}

function restoreYouTubeNativeCaptions(): void {
  document.getElementById(YT_NATIVE_CAPTION_SUPPRESSION_STYLE_ID)?.remove();
}

function suppressYouTubeNativeCaptions(): void {
  if (document.getElementById(YT_NATIVE_CAPTION_SUPPRESSION_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = YT_NATIVE_CAPTION_SUPPRESSION_STYLE_ID;
  // Opacity keeps YouTube's caption nodes available to the extractor while
  // preventing the original subtitle from appearing behind our UI.
  style.textContent = `
    .ytp-caption-window-container {
      opacity: 0 !important;
      pointer-events: none !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function syncYouTubeOverlayWithPlayer(overlay: HTMLDivElement): void {
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
  suppressYouTubeNativeCaptions();
}

function ensureYouTubeOverlay(): HTMLDivElement {
  const existing = document.getElementById(YT_OVERLAY_ID) as HTMLDivElement | null;
  if (existing) return existing;

  const overlay = document.createElement('div');
  overlay.id = YT_OVERLAY_ID;
  overlay.style.cssText = `
    position: fixed;
    left: 50%;
    bottom: 18%;
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
    width: 100%;
    box-sizing: border-box;
  `;


  const controls = document.createElement('div');
  controls.className = 'sl-yt-overlay-controls';
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
  targetLanguageFlag.id = YT_TARGET_LANGUAGE_VALUE_ID;
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
  explainBtn.className = 'sl-yt-overlay-explain-btn';
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
    const help = overlay.querySelector(`#${YT_HELP_ID}`) as HTMLDivElement | null;
    if (help) help.style.display = help.style.display === 'none' ? 'grid' : 'none';
  });
  controls.appendChild(helpBtn);

  const helpPanel = document.createElement('div');
  helpPanel.id = YT_HELP_ID;
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
  sentenceWrap.className = 'sl-yt-overlay-sentence';
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
  explainPanel.className = 'sl-yt-overlay-explain-panel';
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
  renderOverlayLanguagePair();
  void chrome.runtime.sendMessage({ type: 'GET_LANGUAGE_PREFERENCES' }).then((response) => {
    overlayExplanationLanguage = normalizeLanguagePreference(
      response?.data?.explanationLanguage,
      DEFAULT_EXPLANATION_LANGUAGE,
    );
    renderOverlayLanguagePair();
  }).catch(() => undefined);
  return overlay;
}

function bindOverlayShortcutListeners(): void {
  if (overlayShortcutListenersBound) return;
  overlayShortcutListenersBound = true;

  document.addEventListener('mousedown', (event) => {
    const target = event.target as Node | null;
    const help = document.getElementById(YT_HELP_ID) as HTMLDivElement | null;
    if (help && help.style.display !== 'none') {
      const helpButton = help.parentElement?.querySelector('button[aria-label="Keyboard shortcuts"]');
      if (!target || (!help.contains(target) && !helpButton?.contains(target))) {
        help.style.display = 'none';
      }
    }

    if (!overlayWordPopup) return;

    const popup = document.getElementById(YT_WORD_POPUP_ID);
    if (popup && target && popup.contains(target)) return;
    const htmlTarget = event.target as HTMLElement | null;
    if (htmlTarget?.closest('.sl-yt-overlay-word')) return;
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
      void applyPlaybackControl({ action: 'toggle_slow' });
    } else if (key === 'p') {
      event.preventDefault();
      const video = getVideoElement();
      if (video) {
        void applyPlaybackControl({ action: video.paused ? 'play' : 'pause' });
      }
    }
  });
}

function formatTimeForOverlay(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function getOverlayTargetSentence(currentTimeMs: number): { sentence: MeaningfulSentence; index: number } | null {
  if (meaningfulSentences.length === 0) {
    overlayStableSentenceIndex = -1;
    return null;
  }

  let startBasedIndex = -1;
  for (let i = 0; i < meaningfulSentences.length; i += 1) {
    if (meaningfulSentences[i].startTime <= currentTimeMs + 120) startBasedIndex = i;
    else break;
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

  const chosen = meaningfulSentences[overlayStableSentenceIndex];
  if (!chosen) return null;
  return { sentence: chosen, index: overlayStableSentenceIndex };
}

async function applyPlaybackControl(payload: PlaybackControlPayload): Promise<boolean> {
  const video = getVideoElement();
  if (!video) return false;

  if (payload.action === 'seek_to_ms') {
    const nextMs = Number(payload.timeMs);
    if (!Number.isFinite(nextMs)) return false;
    video.currentTime = Math.max(0, nextMs) / 1000;
    return true;
  }

  if (payload.action === 'pause') {
    video.pause();
    return true;
  }

  if (payload.action === 'play') {
    try {
      await video.play();
      return true;
    } catch {
      return false;
    }
  }

  if (payload.action === 'toggle_slow') {
    const isSlow = Math.abs(video.playbackRate - SLOW_PLAYBACK_RATE) < 0.01;
    video.playbackRate = isSlow ? NORMAL_PLAYBACK_RATE : SLOW_PLAYBACK_RATE;
    return true;
  }

  return false;
}

function resolveCurrentSentenceIndex(): number {
  if (meaningfulSentences.length === 0) return -1;
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

  const target = meaningfulSentences[targetIndex];
  if (!target) return;

  await applyPlaybackControl({ action: 'seek_to_ms', timeMs: getSentenceSeekStartMs(target) });
  await applyPlaybackControl({ action: 'play' });
}

function renderOverlaySentenceText(
  sentenceWrap: HTMLDivElement,
  sentence: MeaningfulSentence,
  activeWordIndex: number
): void {
  sentenceWrap.innerHTML = '';
  const parts = sentence.text.match(/(\s+|\S+)/gu) || [sentence.text];
  let wordRun = -1;

  for (const part of parts) {
    if (/^\s+$/u.test(part)) {
      sentenceWrap.appendChild(document.createTextNode(part));
      continue;
    }

    const clean = part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!clean) {
      sentenceWrap.appendChild(document.createTextNode(part));
      continue;
    }

    wordRun += 1;
    const tokenWordIndex = wordRun;
    const span = document.createElement('span');
    span.className = 'sl-yt-overlay-word';
    span.textContent = part;
    span.style.cssText = `
      cursor: pointer;
      border-radius: 5px;
      padding: 0 3px;
      transition: background-color 0.12s ease, color 0.12s ease;
      ${
        YT_ENABLE_WORD_HIGHLIGHTING && tokenWordIndex === activeWordIndex
          ? 'background: rgba(120, 154, 255, 0.95); color: #fff; box-shadow: 0 2px 6px rgba(57, 103, 255, 0.28); font-weight: 700;'
          : 'color: #f8fbff;'
      }
    `;
    span.addEventListener('mouseenter', () => {
      if (!YT_ENABLE_WORD_HIGHLIGHTING) return;
      if (tokenWordIndex !== activeWordIndex) {
        span.style.backgroundColor = 'rgba(133, 162, 255, 0.24)';
      }
    });
    span.addEventListener('mouseleave', () => {
      if (!YT_ENABLE_WORD_HIGHLIGHTING) return;
      if (tokenWordIndex !== activeWordIndex) {
        span.style.backgroundColor = 'transparent';
      }
    });
    span.addEventListener('click', (event) => {
      void handleOverlayWordClick(event as MouseEvent, sentence, part, clean);
    });
    sentenceWrap.appendChild(span);
  }
}

function renderYouTubeOverlay(): void {
  if (!overlayEnabled) {
    hideYouTubeOverlay();
    return;
  }

  const videoElement = getVideoElement();
  if (videoElement?.seeking) {
    overlayStableSentenceIndex = -1;
    overlayLastRenderTimeMs = 0;
    hideYouTubeOverlay();
    return;
  }

  const currentTimeMs = getCurrentTimeMs();
  if (currentTimeMs === null) {
    hideYouTubeOverlay();
    return;
  }

  const target = getOverlayTargetSentence(currentTimeMs);
  if (!target) {
    hideYouTubeOverlay();
    return;
  }

  const { sentence, index } = target;
  const sentenceKey = getSentenceStableKey(sentence);
  const sentenceChanged = sentenceKey !== overlayLastSentenceKey;
  if (sentenceChanged) {
    overlayCurrentSentence = sentence;
    overlayExplainVisible = false;
    overlayExplainLoading = false;
    overlayExplainError = null;
    overlayAnalysisSentenceKey = sentenceKey;
    hideOverlayWordPopup();
  }
  const activeWordIndex = YT_ENABLE_WORD_HIGHLIGHTING
    ? computeActiveWordIndex(sentence, currentTimeMs)
    : -1;
  const shouldRerender =
    sentenceChanged ||
    activeWordIndex !== overlayLastWordIndex ||
    index !== overlayLastSentenceIndex ||
    overlayHidden;

  if (!shouldRerender) {
    renderOverlayLanguagePair();
    const now = performance.now();
    if (now - overlayLastAnchorSyncTimeMs >= 350) {
      const overlay = document.getElementById(YT_OVERLAY_ID) as HTMLDivElement | null;
      if (overlay) syncYouTubeOverlayWithPlayer(overlay);
      overlayLastAnchorSyncTimeMs = now;
    }
    return;
  }

  const overlay = ensureYouTubeOverlay();
  const sentenceWrap = overlay.querySelector('.sl-yt-overlay-sentence') as HTMLDivElement | null;
  if (!sentenceWrap) return;

  renderOverlaySentenceText(sentenceWrap, sentence, activeWordIndex);
  renderOverlayLanguagePair();
  renderExplainPanel();
  setExplainButtonState();
  overlay.style.opacity = '1';
  overlayHidden = false;
  syncYouTubeOverlayWithPlayer(overlay);
  overlayLastAnchorSyncTimeMs = performance.now();

  overlayLastSentenceKey = sentenceKey;
  overlayLastWordIndex = activeWordIndex;
  overlayLastSentenceIndex = index;
}

function updateYouTubeToggleState(): void {
  const button = document.getElementById(YT_TOGGLE_BTN_ID) as HTMLButtonElement | null;
  if (!button) return;
  button.textContent = overlayEnabled ? 'Learn CC: On' : 'Learn CC: Off';
  button.style.backgroundColor = overlayEnabled ? 'rgba(102, 126, 234, 0.34)' : 'transparent';
  button.style.border = overlayEnabled ? '1px solid rgba(170, 190, 255, 0.85)' : '1px solid transparent';
  button.title = overlayEnabled ? 'Disable learning overlay' : 'Enable learning overlay';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(overlayEnabled));
}

function setYouTubeOverlayEnabled(enabled: boolean): void {
  overlayEnabled = enabled;
  updateYouTubeToggleState();
  if (overlayEnabled && meaningfulSentences.length === 0) {
    void ensureCaptionsForCurrentVideo();
  }
  renderYouTubeOverlay();
}

function injectYouTubeToggleButton(): void {
  const topRightControls = document.querySelector('.ytp-right-controls');
  if (!topRightControls || document.getElementById(YT_TOGGLE_BTN_ID)) return;

  const button = document.createElement('button');
  button.id = YT_TOGGLE_BTN_ID;
  button.style.cssText = `
    background: transparent;
    border: 1px solid transparent;
    color: #f1f1f1;
    cursor: pointer;
    padding: 0 8px;
    font-size: 12px;
    font-weight: 700;
    white-space: nowrap;
    height: 36px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background-color 0.15s ease, border-color 0.15s ease;
  `;

  button.addEventListener('click', () => {
    setYouTubeOverlayEnabled(!overlayEnabled);
  });

  topRightControls.insertBefore(button, topRightControls.firstChild);
  updateYouTubeToggleState();
}

function scheduleCaptionRetry(): void {
  if (captionsRetryTimer !== null) return;
  if (!currentVideoId) return;
  if (captionsRetryAttempts >= MAX_CAPTION_RETRY_ATTEMPTS) return;

  captionsRetryAttempts += 1;
  captionsRetryTimer = window.setTimeout(() => {
    captionsRetryTimer = null;
    void ensureCaptionsForCurrentVideo(true);
  }, CAPTION_RETRY_INTERVAL_MS);
}

async function ensureCaptionsForCurrentVideo(force = false): Promise<void> {
  if (!currentVideoId) return;
  if (overlayLoading) return;
  if (!force && captionsExtracted && captionsCacheVideoId === currentVideoId && meaningfulSentences.length > 0) {
    return;
  }

  overlayLoading = true;
  try {
    const requestedVideoId = currentVideoId;
    const captions = await fetchCaptionsFromAPI(requestedVideoId);
    if (currentVideoId !== requestedVideoId) return;
    if (captions.length === 0) {
      scheduleCaptionRetry();
      return;
    }

    meaningfulSentences = groupAndProcessSubtitles(captions);
    lastSubtitles = captions;
    captionsExtracted = true;
    captionsCacheVideoId = requestedVideoId;
    captionsRetryAttempts = 0;
    if (captionsRetryTimer !== null) {
      window.clearTimeout(captionsRetryTimer);
      captionsRetryTimer = null;
    }
  } catch (error) {
    console.error('YouTube overlay caption load failed:', error);
    scheduleCaptionRetry();
  } finally {
    overlayLoading = false;
    renderYouTubeOverlay();
  }
}

function initializeYouTubeExtension(): void {
  currentVideoId = getVideoId();
  
  if (!currentVideoId) {
    setTimeout(initializeYouTubeExtension, 1000);
    return;
  }

  console.log('Initializing Subtitle Learning Extension for YouTube video:', currentVideoId);

  bindOverlayShortcutListeners();
  injectYouTubeToggleButton();
  setupSubtitleObserver();

  if (overlayRefreshInterval !== null) window.clearInterval(overlayRefreshInterval);
  overlayRefreshInterval = window.setInterval(() => {
    renderYouTubeOverlay();
  }, 140);

  if (uiEnsureInterval !== null) window.clearInterval(uiEnsureInterval);
  uiEnsureInterval = window.setInterval(() => {
    injectYouTubeToggleButton();
  }, 1200);

  window.addEventListener('yt-navigate-finish', () => {
    const newVideoId = getVideoId();
    if (newVideoId !== currentVideoId) {
      resetTranscriptState();
      currentVideoId = newVideoId;
      if (subtitleObserver) {
        subtitleObserver.disconnect();
      }
      injectYouTubeToggleButton();
      setupSubtitleObserver();
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeYouTubeExtension);
} else {
  setTimeout(initializeYouTubeExtension, 100);
}

chrome.runtime.onMessage.addListener((message: MessageRequest, sender, sendResponse) => {
  try {
    console.log('Content script received message:', message.type);

    if (message.type === 'PLAYER_LANGUAGE_CHANGED') {
      const languageCode = normalizeLanguageCode(String(message.payload?.languageCode || ''));
      if (languageCode && languageCode !== activeCaptionLanguageCode) {
        activeCaptionLanguageCode = languageCode;
        for (const key of Object.keys(sentenceAnalysisCache)) delete sentenceAnalysisCache[key];
        for (const key of Object.keys(wordMeaningCache)) delete wordMeaningCache[key];
      }
      renderOverlayLanguagePair();
      sendResponse({ success: true } as MessageResponse);
      return true;
    }
    
    if (message.type === 'GET_CURRENT_VIDEO') {
      const videoElement = document.querySelector('video') as HTMLVideoElement;
      console.log('GET_CURRENT_VIDEO - returning video data');
      sendResponse({
        success: true,
        data: {
          videoId: currentVideoId,
          currentTime: videoElement?.currentTime || 0,
          duration: videoElement?.duration || 0,
          playerLanguageCode: activeCaptionLanguageCode,
        }
      } as MessageResponse);
      return true;
    }
    
    if (message.type === 'GET_SUBTITLES') {
      console.log('GET_SUBTITLES - checking if we need to extract captions...');

      const requestedVideoId = currentVideoId;

      // Return cache only when it belongs to the current video
      if (
        captionsExtracted &&
        meaningfulSentences.length > 0 &&
        captionsCacheVideoId === requestedVideoId &&
        requestedVideoId
      ) {
        console.log(`✓ Returning cached ${meaningfulSentences.length} meaningful sentences`);
        sendResponse({
          success: true,
          data: {
            meaningfulSentences: meaningfulSentences,
            subtitles: lastSubtitles,
            videoId: currentVideoId,
            captionLanguageCode: activeCaptionLanguageCode,
            playerLanguageCode: activeCaptionLanguageCode,
          }
        } as MessageResponse);
        return true;
      }

      console.log('Extracting and processing captions for the first time...');

      // Fetch captions from the YouTube API endpoint
      fetchCaptionsFromAPI(requestedVideoId).then((captions) => {
        if (currentVideoId !== requestedVideoId) {
          console.log('Discarding stale caption fetch (video changed during load)');
          sendResponse({
            success: false,
            error: 'Video changed during load',
            data: {
              meaningfulSentences: [],
              subtitles: [],
              videoId: currentVideoId,
              captionLanguageCode: activeCaptionLanguageCode,
              playerLanguageCode: activeCaptionLanguageCode,
            }
          } as MessageResponse);
          return;
        }

        console.log(`Fetched ${captions.length} raw captions from API`);

        if (captions.length === 0) {
          sendResponse({
            success: false,
            error: 'No captions found',
            data: {
              meaningfulSentences: [],
              subtitles: [],
              videoId: currentVideoId,
              captionLanguageCode: activeCaptionLanguageCode,
              playerLanguageCode: activeCaptionLanguageCode,
            }
          } as MessageResponse);
          return;
        }

        // Process raw captions into meaningful sentences
        try {
          if (currentVideoId !== requestedVideoId) {
            sendResponse({
              success: false,
              error: 'Video changed during load',
              data: {
                meaningfulSentences: [],
                subtitles: [],
                videoId: currentVideoId,
                captionLanguageCode: activeCaptionLanguageCode,
                playerLanguageCode: activeCaptionLanguageCode,
              }
            } as MessageResponse);
            return;
          }
          meaningfulSentences = groupAndProcessSubtitles(captions);
          lastSubtitles = captions;
          captionsExtracted = true;
          captionsCacheVideoId = requestedVideoId;

          console.log(`✓ Processed into ${meaningfulSentences.length} meaningful sentences`);

          sendResponse({
            success: true,
            data: {
              meaningfulSentences: meaningfulSentences,
              subtitles: captions,
              videoId: currentVideoId,
              captionLanguageCode: activeCaptionLanguageCode,
              playerLanguageCode: activeCaptionLanguageCode,
            }
          } as MessageResponse);
        } catch (error) {
          console.error('Error processing captions:', error);
          sendResponse({
            success: false,
            error: String(error),
            data: {
              meaningfulSentences: [],
              subtitles: [],
              videoId: currentVideoId,
              captionLanguageCode: activeCaptionLanguageCode,
              playerLanguageCode: activeCaptionLanguageCode,
            }
          } as MessageResponse);
        }
      }).catch((error) => {
        console.error('Error fetching captions:', error);
        sendResponse({
          success: false,
          error: String(error),
          data: {
            meaningfulSentences: [],
            subtitles: [],
            videoId: currentVideoId,
            captionLanguageCode: activeCaptionLanguageCode,
            playerLanguageCode: activeCaptionLanguageCode,
          }
        } as MessageResponse);
      });

      return true; // Will respond asynchronously
    }
    
    if (message.type === 'PLAYBACK_CONTROL') {
      void applyPlaybackControl((message.payload || {}) as PlaybackControlPayload).then((success) => {
        sendResponse({ success } as MessageResponse);
      });
      return true;
    }

    if (message.type === 'JUMP_TO_TIME') {
      console.log('JUMP_TO_TIME - jumping to', message.payload?.time);
      void applyPlaybackControl({
        action: 'seek_to_ms',
        timeMs: message.payload?.time,
      }).then((success) => {
        sendResponse({ success } as MessageResponse);
      });
      return true;
    }
    
    console.log('Unknown message type:', message.type);
    sendResponse({ success: false, error: 'Unknown message type' });
  } catch (error) {
    console.error('Error in message handler:', error);
    sendResponse({ success: false, error: String(error) });
  }
  
  return true; // Will respond asynchronously
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || !changes[EXPLANATION_LANGUAGE_STORAGE_KEY]) return;
  overlayExplanationLanguage = normalizeLanguagePreference(
    changes[EXPLANATION_LANGUAGE_STORAGE_KEY].newValue,
    DEFAULT_EXPLANATION_LANGUAGE,
  );
  for (const key of Object.keys(sentenceAnalysisCache)) delete sentenceAnalysisCache[key];
  for (const key of Object.keys(wordMeaningCache)) delete wordMeaningCache[key];
  overlayExplainVisible = false;
  overlayExplainError = null;
  renderExplainPanel();
  setExplainButtonState();
  renderOverlayLanguagePair();
});
