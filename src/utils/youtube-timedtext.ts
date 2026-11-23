// Choosing which of the YouTube player's own caption requests to reuse.
//
// YouTube answers /api/timedtext with an empty body unless the URL carries the
// player's `pot` token, so the only usable URLs are the ones the player itself
// requested. The player (and other extensions) may request several tracks for
// one video: the spoken-language track, its auto-generated variant, and
// machine translations (`tlang`). Learners need the spoken-language track.

const TIMEDTEXT_PATH = '/api/timedtext';

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function collectTimedtextUrls(resourceNames: string[]): string[] {
  return resourceNames.filter((name) => name.includes(TIMEDTEXT_PATH));
}

function rank(params: URLSearchParams): number {
  if (params.get('tlang')) return 0;
  if (params.get('kind') === 'asr') return 1;
  return 2;
}

export interface TimedtextTrack {
  lang: string;
  kind: string;
  tlang: string;
}

export interface PlayerTrackState extends TimedtextTrack {
  videoId: string;
}

// The page-world bridge publishes the track the player is showing on this
// attribute; the content script asks for captions with this event.
export const PLAYER_TRACK_ATTRIBUTE = 'data-gff-caption-track';
export const CAPTIONS_ON_EVENT = 'gff-captions-on';

export function parsePlayerTrackState(raw: string | null | undefined): PlayerTrackState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.videoId !== 'string' || !value.videoId) return null;
    if (typeof value.lang !== 'string' || !value.lang) return null;
    return {
      videoId: value.videoId,
      lang: value.lang,
      kind: typeof value.kind === 'string' ? value.kind : '',
      tlang: typeof value.tlang === 'string' ? value.tlang : '',
    };
  } catch {
    return null;
  }
}

export function playerTrackKey(state: PlayerTrackState): string {
  return [state.videoId, state.lang, state.kind, state.tlang].join('|');
}

function setOrDelete(params: URLSearchParams, name: string, value: string): void {
  if (value) params.set(name, value);
  else params.delete(name);
}

function isYoutubeHttps(url: URL): boolean {
  return url.protocol === 'https:' && (url.hostname === 'www.youtube.com' || url.hostname.endsWith('.youtube.com'));
}

function isTrack(params: URLSearchParams, track: TimedtextTrack): boolean {
  return (
    params.get('lang') === track.lang &&
    (params.get('kind') === 'asr') === (track.kind === 'asr') &&
    (params.get('tlang') || '') === (track.tlang || '')
  );
}

/**
 * `urls` is in request order, oldest first. With `track`, the result is the
 * URL for exactly that track: the newest request already for that track is
 * used as it is; otherwise, since one player token serves every track of a
 * video, the newest tokened request is re-pointed at it. Only https URLs on
 * youtube.com hosts are accepted.
 */
export function pickTimedtextUrl(
  urls: string[],
  videoId: string,
  track?: TimedtextTrack | null
): string | null {
  let best: string | null = null;
  let bestRank = -1;
  let exact: string | null = null;

  for (const url of urls) {
    const parsed = parse(url);
    if (!parsed || !isYoutubeHttps(parsed) || !parsed.pathname.endsWith(TIMEDTEXT_PATH)) continue;
    const params = parsed.searchParams;
    if (videoId && params.get('v') !== videoId) continue;
    if (!params.get('pot')) continue;

    if (track?.lang && isTrack(params, track)) exact = url;
    const candidateRank = track?.lang ? 0 : rank(params);
    if (candidateRank >= bestRank) {
      best = url;
      bestRank = candidateRank;
    }
  }

  if (!best || !track?.lang) return best;
  if (exact) return exact;

  const pointed = new URL(best);
  pointed.searchParams.set('lang', track.lang);
  setOrDelete(pointed.searchParams, 'kind', track.kind);
  setOrDelete(pointed.searchParams, 'tlang', track.tlang);
  pointed.searchParams.delete('name');
  return pointed.toString();
}

export function getTimedtextLanguage(url: string): string {
  const params = parse(url)?.searchParams;
  return params?.get('tlang') || params?.get('lang') || '';
}

// Audio capture (videos without captions). The page-world bridge publishes
// which audio windows it holds on this attribute and answers a request for one
// window's file with a window message; the audio never goes anywhere else.
export const AUDIO_STATE_ATTRIBUTE = 'data-gff-audio-state';
export const AUDIO_WINDOW_REQUEST_EVENT = 'gff-audio-window-request'; // detail: JSON string { requestId, index, videoId? }
export const AUDIO_WINDOW_MESSAGE = 'gff-audio-window'; // window.postMessage type

/** window.postMessage payload answering a window request; file is null when the window is unavailable. */
export interface AudioWindowMessage {
  type: typeof AUDIO_WINDOW_MESSAGE;
  requestId: string;
  index: number;
  /** The player's current video id when the answer was made. */
  videoId: string;
  startMs: number;
  partial: boolean;
  file: ArrayBuffer | null;
}

export interface AudioCaptureState {
  videoId: string;
  hasCaptions: boolean;
  format: 'webm-opus' | 'unsupported' | '';
  windows: { index: number; startMs: number; partial: boolean }[];
}

export function parseAudioCaptureState(raw: string | null | undefined): AudioCaptureState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.videoId !== 'string' || typeof value.hasCaptions !== 'boolean') return null;
    if (value.format !== 'webm-opus' && value.format !== 'unsupported' && value.format !== '') return null;
    if (!Array.isArray(value.windows)) return null;
    const windows: AudioCaptureState['windows'] = [];
    for (const w of value.windows as Record<string, unknown>[]) {
      if (!w || typeof w.index !== 'number' || typeof w.startMs !== 'number' || typeof w.partial !== 'boolean') return null;
      windows.push({ index: w.index, startMs: w.startMs, partial: w.partial });
    }
    return { videoId: value.videoId, hasCaptions: value.hasCaptions, format: value.format, windows };
  } catch {
    return null;
  }
}
