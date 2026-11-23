// Runs in the PAGE world on YouTube, where the player API lives. It tells the
// content script which caption track the player is showing and switches
// captions on when asked. It never reads or forwards caption text itself.
// For videos without captions it also captures the audio the player buffers
// and hands a window of it to the content script, but only when asked.

import {
  AUDIO_STATE_ATTRIBUTE,
  AUDIO_WINDOW_MESSAGE,
  AUDIO_WINDOW_REQUEST_EVENT,
  CAPTIONS_ON_EVENT,
  PLAYER_TRACK_ATTRIBUTE,
} from '../utils/youtube-timedtext';
import type { AudioCaptureState } from '../utils/youtube-timedtext';
import { installAudioCapture } from './youtube-audio-capture';

const PUBLISH_INTERVAL_MS = 1000;
const VIDEO_END_TOLERANCE_MS = 11_000;

// Installed first, at module load, so the player's first buffers are seen.
const capture = installAudioCapture(
  typeof MediaSource !== 'undefined' ? MediaSource.prototype : null,
  typeof SourceBuffer !== 'undefined' ? SourceBuffer.prototype : null
);

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

/** The video's end, when the captured audio reaches it; otherwise undefined. */
function videoEndMs(player: any): number | undefined {
  try {
    const duration = Number(player?.getDuration?.());
    const last = capture.lastClusterMs();
    if (!(duration > 0) || last === null) return undefined;
    const endMs = duration * 1000;
    return Math.abs(endMs - last) <= VIDEO_END_TOLERANCE_MS ? endMs : undefined;
  } catch {
    return undefined;
  }
}

function readAudioState(): string {
  try {
    const player = getPlayer();
    const videoId = player?.getVideoData?.()?.video_id;
    if (!player || !videoId) return '';

    const tracks = player.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    const hasCaptions = Array.isArray(tracks) && tracks.length > 0;
    capture.setEnabled(!hasCaptions);
    if (hasCaptions) capture.reset();

    const state: AudioCaptureState = {
      videoId,
      hasCaptions,
      format: capture.format(),
      windows: hasCaptions
        ? []
        : capture.windows(videoEndMs(player)).map((w) => ({ index: w.index, startMs: w.startMs, partial: w.partial })),
    };
    return JSON.stringify(state);
  } catch {
    return '';
  }
}

function publishAudioState(): void {
  const root = document.documentElement;
  const state = readAudioState();
  if (root.getAttribute(AUDIO_STATE_ATTRIBUTE) !== state) {
    root.setAttribute(AUDIO_STATE_ATTRIBUTE, state);
  }
}

function publish(): void {
  publishTrackState();
  publishAudioState();
}

document.addEventListener(AUDIO_WINDOW_REQUEST_EVENT, (event) => {
  try {
    const detail = (event as CustomEvent).detail;
    const request = typeof detail === 'string' ? JSON.parse(detail) : null;
    if (!request || typeof request.requestId !== 'string' || !Number.isInteger(request.index)) return;

    const endMs = videoEndMs(getPlayer());
    const window_ = capture.windows(endMs).find((w) => w.index === request.index);
    const bytes = window_ ? capture.windowFile(request.index, endMs) : null;
    const file = bytes ? bytes.slice().buffer : null;
    window.postMessage(
      {
        type: AUDIO_WINDOW_MESSAGE,
        requestId: request.requestId,
        index: request.index,
        startMs: window_?.startMs ?? 0,
        partial: window_?.partial ?? false,
        file,
      },
      location.origin,
      file ? [file] : []
    );
  } catch {
    // A malformed request is ignored.
  }
});

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

window.setInterval(publish, PUBLISH_INTERVAL_MS);
