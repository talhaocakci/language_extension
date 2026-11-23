import type { MeaningfulSentence, SubPortions } from '../types/subtitle';
import type { TimedWord } from './timed-words';

export const MAX_SENTENCE_WORDS = 28;
export const MAX_SENTENCE_MS = 15_000;

const SENTENCE_MARKS = new Set(['.', '?', '!', '…', '。', '？', '！', '؟']);
const CLOSERS = new Set(['"', "'", '»', '”', '’', ')', ']']);
const ABBREVIATIONS = new Set([
  'dr', 'mr', 'mrs', 'ms', 'prof', 'nr', 'st', 'vs', 'bzw', 'ca', 'etc', 'z.b', 'd.h', 'u.a', 'e.g', 'i.e'
]);
const SOFT_BREAKS = new Set([',', ';', ':']);
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const MARKS_PER_WORDS = 40;
const CONFIDENCE = 0.95;

function stripClosers(text: string): string {
  let end = text.length;
  while (end > 0 && CLOSERS.has(text[end - 1])) end--;
  return text.slice(0, end);
}

function endsSentence(text: string): boolean {
  const core = stripClosers(text);
  if (!core || !SENTENCE_MARKS.has(core[core.length - 1])) return false;
  if (core[core.length - 1] !== '.') return true;
  if (/^\p{Lu}\.$/u.test(core) && core !== 'I.') return false;
  if (/^\d+\.$/.test(core)) return false;
  return !ABBREVIATIONS.has(core.slice(0, -1).toLowerCase());
}

/** True when sentence-ending marks occur at least once per 40 words. */
export function hasSentencePunctuation(words: TimedWord[]): boolean {
  if (words.length === 0) return false;
  const marks = words.filter((w) => endsSentence(w.text)).length;
  return marks * MARKS_PER_WORDS >= words.length;
}

/** False when more than 30% of the letters are CJK, kana or Thai. */
export function usesSpaceSeparatedWords(words: TimedWord[]): boolean {
  let letters = 0;
  let unspaced = 0;
  for (const word of words) {
    for (const ch of word.text) {
      if (!/\p{L}/u.test(ch)) continue;
      letters++;
      if (NO_SPACE_SCRIPT.test(ch)) unspaced++;
    }
  }
  return letters === 0 || unspaced / letters <= 0.3;
}

/** `yt-` + 8 hex digits (FNV-1a 32-bit) of `${trackKey}|${startMs}|${text}`. */
export function sentenceId(trackKey: string, startMs: number, text: string): string {
  const input = `${trackKey}|${startMs}|${text}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash = Math.imul(hash ^ input.charCodeAt(i), 0x01000193) >>> 0;
  }
  return `yt-${hash.toString(16).padStart(8, '0')}`;
}

function withinLimits(words: TimedWord[], first: number, last: number): boolean {
  return last - first + 1 <= MAX_SENTENCE_WORDS && words[last].endMs - words[first].startMs <= MAX_SENTENCE_MS;
}

/** Index of the last word of the first piece of a run that exceeds the limits. */
function splitIndex(run: TimedWord[]): number {
  let limit = 0;
  while (limit + 1 < run.length && withinLimits(run, 0, limit + 1)) limit++;

  for (let i = limit; i >= 0; i--) {
    if (SOFT_BREAKS.has(run[i].text[run[i].text.length - 1])) return i;
  }

  let best = limit;
  let bestGap = -1;
  for (let i = 0; i <= limit; i++) {
    const gap = run[i + 1].startMs - run[i].endMs;
    if (gap >= bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return best;
}

function toSentence(run: TimedWord[], trackKey: string): MeaningfulSentence {
  const text = run.map((w) => w.text).join(' ');
  const startTime = run[0].startMs;
  const subPortions: SubPortions[] = run.map((w) => ({ text: w.text, startTime: w.startMs, endTime: w.endMs }));
  return {
    id: sentenceId(trackKey, startTime, text),
    text,
    startTime,
    endTime: run[run.length - 1].endMs,
    subPortions,
    confidence: CONFIDENCE
  };
}

/** Null when the track must stay on the heuristic (unpunctuated, no-space script, or no words). */
export function sentencesFromTimedWords(words: TimedWord[], trackKey: string): MeaningfulSentence[] | null {
  if (words.length === 0 || !usesSpaceSeparatedWords(words) || !hasSentencePunctuation(words)) return null;

  const sentences: MeaningfulSentence[] = [];
  let run: TimedWord[] = [];

  const flush = () => {
    while (run.length > 0 && !withinLimits(run, 0, run.length - 1)) {
      const cut = splitIndex(run);
      sentences.push(toSentence(run.slice(0, cut + 1), trackKey));
      run = run.slice(cut + 1);
    }
    if (run.length > 0) sentences.push(toSentence(run, trackKey));
    run = [];
  };

  for (const word of words) {
    run.push(word);
    if (endsSentence(word.text)) flush();
  }
  flush();
  return sentences;
}
