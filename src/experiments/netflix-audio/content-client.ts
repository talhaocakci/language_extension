import {
  NETFLIX_AUDIO_MESSAGES,
  type NetflixAudioCaptureStatus,
  type NetflixAudioClipMetadata,
  type NetflixAudioExperimentResponse,
  type NetflixAudioRecordingSpec,
} from './protocol';

const PRE_ROLL_MS = 150;
const POST_ROLL_MS = 250;
const MAX_CLIP_DURATION_MS = 15_000;

export interface NetflixSentenceAudioInput {
  sentenceKey: string;
  sentenceText: string;
  sourceUrl: string;
  videoTitle: string;
  startTimeMs: number;
  endTimeMs: number;
}

async function sendAudioMessage<T>(
  type: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  const response = await chrome.runtime.sendMessage({ type, payload }) as NetflixAudioExperimentResponse<T>;
  if (!response?.success) throw new Error(response?.error || 'Audio experiment request failed.');
  return response.data as T;
}

export function getNetflixSentenceAudioStatus(): Promise<NetflixAudioCaptureStatus> {
  return sendAudioMessage(NETFLIX_AUDIO_MESSAGES.GET_STATUS);
}

export function findNetflixSentenceAudioClip(
  sentenceKey: string,
): Promise<NetflixAudioClipMetadata | null> {
  return sendAudioMessage(NETFLIX_AUDIO_MESSAGES.FIND_CLIP, { sentenceKey });
}

export async function playNetflixSentenceAudioClip(clipId: string): Promise<void> {
  await sendAudioMessage(NETFLIX_AUDIO_MESSAGES.PLAY_CLIP, { clipId });
}

function seekVideo(video: HTMLVideoElement, timeSeconds: number): Promise<void> {
  if (Math.abs(video.currentTime - timeSeconds) < 0.04) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('Netflix did not finish seeking for audio capture.'));
    }, 5000);
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Netflix video failed while seeking for audio capture.'));
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = timeSeconds;
  });
}

function waitUntilVideoTime(
  video: HTMLVideoElement,
  endSeconds: number,
  maximumWaitMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const interval = window.setInterval(() => {
      if (video.currentTime >= endSeconds || video.ended) {
        cleanup();
        resolve();
      }
    }, 40);
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('Timed out while replaying the subtitle for audio capture.'));
    }, maximumWaitMs);
    const cleanup = () => {
      window.clearInterval(interval);
      window.clearTimeout(timer);
    };
  });
}

export async function recordNetflixSentenceAudioClip(
  video: HTMLVideoElement,
  input: NetflixSentenceAudioInput,
): Promise<NetflixAudioClipMetadata> {
  const paddedStartMs = Math.max(0, input.startTimeMs - PRE_ROLL_MS);
  const paddedEndMs = Math.max(input.endTimeMs + POST_ROLL_MS, paddedStartMs + 500);
  const durationMs = paddedEndMs - paddedStartMs;
  if (durationMs > MAX_CLIP_DURATION_MS) {
    throw new Error('This subtitle is too long for the 15-second audio experiment limit.');
  }

  const original = {
    currentTime: video.currentTime,
    paused: video.paused,
    playbackRate: video.playbackRate,
  };
  const spec: NetflixAudioRecordingSpec = {
    clipId: crypto.randomUUID(),
    sentenceKey: input.sentenceKey,
    sentenceText: input.sentenceText,
    sourceUrl: input.sourceUrl,
    videoTitle: input.videoTitle,
    startTimeMs: paddedStartMs,
    endTimeMs: paddedEndMs,
  };

  let recordingStarted = false;
  try {
    video.pause();
    video.playbackRate = 1;
    await seekVideo(video, paddedStartMs / 1000);
    await sendAudioMessage(NETFLIX_AUDIO_MESSAGES.START_RECORDING, { spec });
    recordingStarted = true;
    await video.play();
    await waitUntilVideoTime(video, paddedEndMs / 1000, durationMs + 5000);
    video.pause();
    const clip = await sendAudioMessage<NetflixAudioClipMetadata>(
      NETFLIX_AUDIO_MESSAGES.STOP_RECORDING,
    );
    recordingStarted = false;
    return clip;
  } catch (error) {
    if (recordingStarted) {
      await sendAudioMessage(NETFLIX_AUDIO_MESSAGES.ABORT_RECORDING).catch(() => undefined);
    }
    throw error;
  } finally {
    video.pause();
    video.playbackRate = original.playbackRate;
    await seekVideo(video, original.currentTime).catch(() => {
      video.currentTime = original.currentTime;
    });
    if (!original.paused) await video.play().catch(() => undefined);
  }
}
