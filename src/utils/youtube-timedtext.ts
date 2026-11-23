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

/**
 * `urls` is in request order, oldest first. With `track`, the result is the
 * URL for exactly that track: one player token serves every track of a video,
 * so any tokened request for the video can be re-pointed at it.
 */
export function pickTimedtextUrl(
  urls: string[],
  videoId: string,
  track?: TimedtextTrack | null
): string | null {
  let best: string | null = null;
  let bestRank = -1;

  for (const url of urls) {
    const parsed = parse(url);
    if (!parsed || !parsed.pathname.endsWith(TIMEDTEXT_PATH)) continue;
    const params = parsed.searchParams;
    if (videoId && params.get('v') !== videoId) continue;
    if (!params.get('pot')) continue;

    const candidateRank = track?.lang ? 0 : rank(params);
    if (candidateRank >= bestRank) {
      best = url;
      bestRank = candidateRank;
    }
  }

  if (!best || !track?.lang) return best;

  const pointed = new URL(best);
  pointed.searchParams.set('lang', track.lang);
  setOrDelete(pointed.searchParams, 'kind', track.kind);
  setOrDelete(pointed.searchParams, 'tlang', track.tlang);
  return pointed.toString();
}

export function getTimedtextLanguage(url: string): string {
  const params = parse(url)?.searchParams;
  return params?.get('tlang') || params?.get('lang') || '';
}
