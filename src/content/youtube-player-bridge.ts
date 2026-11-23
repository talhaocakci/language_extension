// Runs in the PAGE world on YouTube, where the player API lives. It tells the
// content script which caption track the player is showing and switches
// captions on when asked. It never reads or forwards caption text itself.

import { CAPTIONS_ON_EVENT, PLAYER_TRACK_ATTRIBUTE } from '../utils/youtube-timedtext';

const PUBLISH_INTERVAL_MS = 1000;

function getPlayer(): any {
  return document.getElementById('movie_player');
}

function readTrackState(): string {
  try {
    const player = getPlayer();
    if (!player || typeof player.getOption !== 'function') return '';
    if (typeof player.isSubtitlesOn !== 'function' || !player.isSubtitlesOn()) return '';

    const track = player.getOption('captions', 'track');
    const videoId = player.getVideoData?.()?.video_id;
    if (!track?.languageCode || !videoId) return '';

    return JSON.stringify({
      videoId,
      lang: track.languageCode,
      kind: track.kind || '',
      tlang: track.translationLanguage?.languageCode || '',
    });
  } catch {
    return '';
  }
}

function publishTrackState(): void {
  const root = document.documentElement;
  const state = readTrackState();
  if (root.getAttribute(PLAYER_TRACK_ATTRIBUTE) !== state) {
    root.setAttribute(PLAYER_TRACK_ATTRIBUTE, state);
  }
}

document.addEventListener(CAPTIONS_ON_EVENT, () => {
  try {
    const player = getPlayer();
    if (typeof player?.toggleSubtitlesOn === 'function' && !player.isSubtitlesOn?.()) {
      player.toggleSubtitlesOn();
    }
  } catch {
    // The player is not ready yet; the content script asks again on retry.
  }
  publishTrackState();
});

window.setInterval(publishTrackState, PUBLISH_INTERVAL_MS);
