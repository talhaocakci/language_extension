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

function isSameCaptionOccurrence(
  existing: CapturedSubtitleChunk,
  latest: CapturedSubtitleChunk
): boolean {
  if (existing.text !== latest.text) return false;

  if (existing.timingSource === 'media-cue' && latest.timingSource === 'media-cue') {
    return Math.abs(existing.startTime - latest.startTime) <= 250;
  }

  if (existing.timingSource === 'media-cue') {
    return latest.startTime >= existing.startTime - 500 && latest.startTime <= existing.endTime + 500;
  }

  if (latest.timingSource === 'media-cue') {
    return existing.startTime >= latest.startTime - 1500 && existing.startTime <= latest.endTime + 500;
  }

  return latest.startTime >= existing.startTime - 500 && latest.startTime <= existing.endTime + 750;
}

/**
 * Merge a live caption observation into a chronological timeline.
 * Streaming players can emit an older cue after a backward seek, so callers must
 * not assume observations arrive in playback order.
 */
export function upsertCapturedSubtitle(
  subtitles: CapturedSubtitleChunk[],
  latest: CapturedSubtitleChunk
): boolean {
  const existing = subtitles.find((subtitle) => isSameCaptionOccurrence(subtitle, latest));
  if (existing) {
    const before = `${existing.startTime}|${existing.endTime}|${existing.timingSource}`;
    updateMatchingSubtitleTiming(existing, latest);
    subtitles.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
    const after = `${existing.startTime}|${existing.endTime}|${existing.timingSource}`;
    return before !== after;
  }

  const inserted = { ...latest };
  subtitles.push(inserted);
  subtitles.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);

  const index = subtitles.indexOf(inserted);
  if (index > 0) {
    closeObservedSubtitleAtNextStart(subtitles[index - 1], subtitles[index].startTime);
  }

  return true;
}
