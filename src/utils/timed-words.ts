import type { SubtitleChunk } from '../types/subtitle';

export interface TimedWord { text: string; startMs: number; endMs: number }
export interface Json3Seg { utf8?: string; tOffsetMs?: number }
export interface Json3Event { tStartMs?: number; dDurationMs?: number; aAppend?: number; segs?: Json3Seg[] }

function cleanSpeech(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/​/g, '')
    .replace(/>>/g, ' ')
    .replace(/\n/g, ' ');
}

function wordsOf(text: string): string[] {
  return cleanSpeech(text).split(/\s+/).filter(Boolean);
}

/** Spreads words over [startMs, endMs], each taking a share proportional to length + 1. */
function spreadWords(words: string[], startMs: number, endMs: number): TimedWord[] {
  const total = words.reduce((sum, w) => sum + w.length + 1, 0);
  const span = endMs - startMs;
  let consumed = 0;
  let previousEnd = startMs;
  return words.map((text, index) => {
    consumed += text.length + 1;
    const end = index === words.length - 1 ? endMs : Math.round(startMs + (span * consumed) / total);
    const word = { text, startMs: previousEnd, endMs: end };
    previousEnd = end;
    return word;
  });
}

export function timedWordsFromJson3(events: Json3Event[]): TimedWord[] {
  const speech = events.filter(
    (event) => !event.aAppend && (event.segs ?? []).some((seg) => wordsOf(seg.utf8 ?? '').length > 0)
  );

  const result: TimedWord[] = [];
  speech.forEach((event, index) => {
    const start = Math.round(event.tStartMs ?? 0);
    const naturalEnd = start + Math.round(event.dDurationMs ?? 0);
    const nextStart = speech[index + 1]?.tStartMs;
    const end = nextStart !== undefined && nextStart > start ? Math.min(naturalEnd, Math.round(nextStart)) : naturalEnd;
    const segs = event.segs ?? [];

    if (!segs.some((seg) => seg.tOffsetMs !== undefined)) {
      result.push(...spreadWords(wordsOf(segs.map((seg) => seg.utf8 ?? '').join('')), start, end));
      return;
    }

    segs.forEach((seg, segIndex) => {
      const segStart = start + Math.round(seg.tOffsetMs ?? 0);
      const next = segs[segIndex + 1];
      const segEnd = next ? start + Math.round(next.tOffsetMs ?? 0) : end;
      result.push(...spreadWords(wordsOf(seg.utf8 ?? ''), segStart, Math.max(segStart, segEnd)));
    });
  });
  return result;
}

/** Parses a raw caption response; returns [] unless it is json3 with an `events` array. */
export function timedWordsFromCaptionText(raw: string): TimedWord[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.events) ? timedWordsFromJson3(parsed.events) : [];
  } catch {
    return [];
  }
}

/** Each cue is treated as a single-seg event. */
export function timedWordsFromCues(cues: SubtitleChunk[]): TimedWord[] {
  return timedWordsFromJson3(
    cues.map((cue) => ({
      tStartMs: cue.startTime,
      dDurationMs: cue.endTime - cue.startTime,
      segs: [{ utf8: cue.text }]
    }))
  );
}
