import type { MeaningfulSentence } from '../types/subtitle';
import { MAX_SENTENCE_WORDS, endsSentence, sentencesFromTimedWords, toSentence } from './sentence-builder';
import type { TimedWord } from './timed-words';

export const WINDOW_MS = 30_000;
export const WINDOW_EDGE_TOLERANCE_MS = 100;
const DEFAULT_SPACING_MS = 10_000;

export interface ClusterTime { timecodeMs: number }
export interface ReadyWindow { index: number; startMs: number; partial: boolean; clusterIndexes: number[] }

function windowOf(timecodeMs: number): number {
  return Math.floor((timecodeMs + WINDOW_EDGE_TOLERANCE_MS) / WINDOW_MS);
}

/** Lower median of the spacings between neighbouring clusters; 10 000 ms with fewer than two spacings. */
function medianSpacing(clusters: ClusterTime[]): number {
  const spacings: number[] = [];
  for (let i = 1; i < clusters.length; i++) spacings.push(clusters[i].timecodeMs - clusters[i - 1].timecodeMs);
  if (spacings.length < 2) return DEFAULT_SPACING_MS;
  spacings.sort((a, b) => a - b);
  return spacings[Math.floor((spacings.length - 1) / 2)];
}

/** Windows that can be sent now. videoEndMs: pass when the stream's end has been captured. */
export function readyWindows(clusters: ClusterTime[], videoEndMs?: number): ReadyWindow[] {
  const groups = new Map<number, number[]>();
  clusters.forEach((cluster, i) => {
    const index = windowOf(cluster.timecodeMs);
    const group = groups.get(index);
    if (group) group.push(i);
    else groups.set(index, [i]);
  });
  if (groups.size === 0) return [];

  const maxIndex = Math.max(...groups.keys());
  const maxGap = 2 * medianSpacing(clusters);
  const result: ReadyWindow[] = [];

  for (const index of [...groups.keys()].sort((a, b) => a - b)) {
    const isLast = index === maxIndex;
    if (isLast && videoEndMs === undefined) continue;

    const indexes = groups.get(index)!;
    const first = clusters[indexes[0]].timecodeMs;
    const lastPos = indexes[indexes.length - 1];
    const last = clusters[lastPos].timecodeMs;

    let partial = first - index * WINDOW_MS > WINDOW_EDGE_TOLERANCE_MS;
    for (let k = 1; k < indexes.length && !partial; k++) {
      if (clusters[indexes[k]].timecodeMs - clusters[indexes[k - 1]].timecodeMs > maxGap) partial = true;
    }
    if (!partial) {
      if (isLast) partial = (videoEndMs as number) - last > maxGap;
      else partial = clusters[lastPos + 1].timecodeMs - last > maxGap;
    }
    result.push({ index, startMs: first, partial, clusterIndexes: indexes });
  }
  return result;
}

/** Which window to send next: nearest at or after the playhead, not stored, not in flight. */
export function nextWindowToSend(
  ready: ReadyWindow[],
  done: Set<number>,
  inFlight: Set<number>,
  playheadMs: number
): ReadyWindow | null {
  const playheadIndex = Math.floor(playheadMs / WINDOW_MS);
  const open = ready.filter((w) => !done.has(w.index) && !inFlight.has(w.index));
  const ahead = open.filter((w) => w.index >= playheadIndex).sort((a, b) => a.index - b.index);
  if (ahead.length > 0) return ahead[0];
  const behind = open.filter((w) => w.index < playheadIndex).sort((a, b) => b.index - a.index);
  return behind[0] ?? null;
}

/** Sentences over contiguous windows. The last, unfinished sentence of a run is held back unless final. */
export function sentencesFromWindows(
  words: Map<number, TimedWord[]>,
  trackKey: string,
  lastWindowIndex?: number
): MeaningfulSentence[] {
  const indexes = [...words.keys()].sort((a, b) => a - b);
  const output: MeaningfulSentence[] = [];

  let i = 0;
  while (i < indexes.length) {
    let j = i;
    while (j + 1 < indexes.length && indexes[j + 1] === indexes[j] + 1) j++;
    const runLastIndex = indexes[j];
    const runWords = indexes.slice(i, j + 1).flatMap((index) => words.get(index) ?? []);
    i = j + 1;
    if (runWords.length === 0) continue;

    const isFinal = runLastIndex === lastWindowIndex;
    const lastWord = runWords[runWords.length - 1];
    const sentences = sentencesFromTimedWords(runWords, trackKey);
    if (sentences) {
      if (!isFinal && !endsSentence(lastWord.text)) sentences.pop();
      output.push(...sentences);
      continue;
    }

    // Unpunctuated: fixed-size chunks. A short trailing chunk may still grow, so it waits unless final.
    for (let start = 0; start < runWords.length; start += MAX_SENTENCE_WORDS) {
      const chunk = runWords.slice(start, start + MAX_SENTENCE_WORDS);
      if (chunk.length < MAX_SENTENCE_WORDS && !isFinal) break;
      output.push(toSentence(chunk, trackKey));
    }
  }
  return output.sort((a, b) => a.startTime - b.startTime);
}
