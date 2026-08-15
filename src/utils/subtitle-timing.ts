import type { SubtitleChunk } from '../types/subtitle';

export type SubtitleTimingSource = 'media-cue' | 'observed';

export interface CapturedSubtitleChunk extends SubtitleChunk {
  timingSource: SubtitleTimingSource;
}

export function updateMatchingSubtitleTiming(
  previous: CapturedSubtitleChunk,
  latest: CapturedSubtitleChunk
): void {
  if (latest.timingSource === 'media-cue') {
    previous.startTime = latest.startTime;
    previous.endTime = latest.endTime;
    previous.timingSource = 'media-cue';
    return;
  }

  if (previous.timingSource === 'observed') {
    previous.endTime = Math.max(previous.endTime, latest.startTime);
  }
}

export function closeObservedSubtitleAtNextStart(
  previous: CapturedSubtitleChunk,
  nextStartTime: number
): void {
  if (previous.timingSource !== 'observed') return;
  previous.endTime = Math.max(previous.startTime + 1, nextStartTime);
}
