/**
 * Experimental Netflix/Max sentence-audio capture.
 *
 * Keep every cross-context message and shared type in this folder so the
 * experiment can be removed without touching unrelated extension contracts.
 */
export const NETFLIX_AUDIO_EXPERIMENT_ENABLED = true;

export const NETFLIX_AUDIO_MESSAGES = {
  GET_STATUS: 'NETFLIX_AUDIO_EXPERIMENT_GET_STATUS',
  ATTACH_STREAM: 'NETFLIX_AUDIO_EXPERIMENT_ATTACH_STREAM',
  STOP_CAPTURE: 'NETFLIX_AUDIO_EXPERIMENT_STOP_CAPTURE',
  START_RECORDING: 'NETFLIX_AUDIO_EXPERIMENT_START_RECORDING',
  STOP_RECORDING: 'NETFLIX_AUDIO_EXPERIMENT_STOP_RECORDING',
  ABORT_RECORDING: 'NETFLIX_AUDIO_EXPERIMENT_ABORT_RECORDING',
  FIND_CLIP: 'NETFLIX_AUDIO_EXPERIMENT_FIND_CLIP',
  PLAY_CLIP: 'NETFLIX_AUDIO_EXPERIMENT_PLAY_CLIP',
  CLEAR_CLIPS: 'NETFLIX_AUDIO_EXPERIMENT_CLEAR_CLIPS',
  STATUS_CHANGED: 'NETFLIX_AUDIO_EXPERIMENT_STATUS_CHANGED',
} as const;

export const NETFLIX_AUDIO_OFFSCREEN_TARGET = 'netflix-audio-experiment-offscreen';

export type NetflixAudioMessageType =
  typeof NETFLIX_AUDIO_MESSAGES[keyof typeof NETFLIX_AUDIO_MESSAGES];

export interface NetflixAudioCaptureStatus {
  offscreenReady: boolean;
  active: boolean;
  activeForCurrentTab: boolean;
  capturedTabId: number | null;
  recording: boolean;
}

export interface NetflixAudioClipMetadata {
  clipId: string;
  sentenceKey: string;
  sentenceText: string;
  sourceUrl: string;
  videoTitle: string;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  mimeType: string;
  byteLength: number;
  createdAt: number;
}

export interface NetflixAudioRecordingSpec {
  clipId: string;
  sentenceKey: string;
  sentenceText: string;
  sourceUrl: string;
  videoTitle: string;
  startTimeMs: number;
  endTimeMs: number;
}

export interface NetflixAudioExperimentResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export function isNetflixAudioExperimentMessage(type: string): type is NetflixAudioMessageType {
  return Object.values(NETFLIX_AUDIO_MESSAGES).includes(type as NetflixAudioMessageType);
}

export function isNetflixOrMaxUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'netflix.com' || host.endsWith('.netflix.com') ||
      host === 'max.com' || host.endsWith('.max.com') ||
      host === 'hbomax.com' || host.endsWith('.hbomax.com');
  } catch {
    return false;
  }
}
