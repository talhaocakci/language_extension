# YouTube Sentence Shaping (Extension Half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On YouTube, re-cut punctuated captions (human-written and new auto-generated) into whole sentences with word-derived start and end times, entirely inside the extension.

**Architecture:** A pure module turns a json3 caption response into a flat list of timed words. A second pure module decides whether the track is punctuated and, if so, cuts the words into `MeaningfulSentence`s. `youtube-injector.ts` uses those sentences when available and otherwise keeps today's `groupAndProcessSubtitles` output. No network calls are added.

**Tech Stack:** TypeScript, Chrome MV3 content script, `node:test` via the per-file `tsc` + `node --test` scripts in `package.json`.

**Spec:** `docs/superpowers/specs/2026-11-23-youtube-sentence-shaping-design.md` — this plan covers "Build order" step 1 (design sections 1 to 3) only. Steps 2 and 3 (unpunctuated path, backend endpoint, cache, limits) get their own plan after a real unpunctuated track has been captured.

## Global Constraints

- The words on screen are exactly the words YouTube supplied; this plan adds no punctuation and no capitalisation.
- No network call and no cost on the punctuated path.
- Output type is the existing `MeaningfulSentence` (`src/types/subtitle.ts`); overlay, side panel, Q/W/E navigation and saving keep working unchanged.
- Netflix and Max are untouched: do not edit `src/content/netflix-injector.ts` and do not change the behaviour of `groupAndProcessSubtitles`.
- Languages written without spaces (Japanese, Chinese, Thai and similar) stay on today's heuristic.
- Sentence-ending marks are `.` `?` `!` `…` `。` `？` `！` `؟`.
- A sentence boundary inside a single-seg cue is an estimate (up to about a second off); a boundary at a cue edge uses the cue's real time.
- Sentence ids are deterministic, derived from track, start time and text.
- Tests run through `npm run test:<name>` scripts that follow the existing pattern in `package.json`. Node is not on the default PATH on the owner's machine; the executor needs a working Node 20+ and `npm`.

## Review Focus

1. Caption response that is not json3 (VTT, empty string, HTML error page): timed-word extraction returns `[]` and the overlay shows today's heuristic sentences. Test in Task 1.
2. Track with no sentence-ending marks at all (classic auto-captions): `sentencesFromTimedWords` returns `null`, heuristic output is used, nothing is invented. Test in Task 2.
3. One very long sentence with no commas (a speaker who never pauses): it is still split so no sentence exceeds 28 words. Test in Task 2.
4. Dots that do not end a sentence: initials (`J. K. Rowling`), titles (`Dr.`), ordinals (`am 3. Mai`), decimals (`3.5`), `z.B.`. Test in Task 2.
5. Overlapping cues and newline-append events: word times never run backwards and no word is emitted twice. Test in Task 1.

---

### Task 1: Timed words from a caption response

**Files:**
- Create: `src/utils/timed-words.ts`
- Test: `tests/timed-words.test.ts`
- Modify: `package.json` (add `test:timed-words`, same shape as `test:youtube-timedtext`, compiling `tests/timed-words.test.ts src/utils/timed-words.ts src/types/subtitle.ts`)

**Interfaces:**
- Consumes: `SubtitleChunk` from `src/types/subtitle.ts`.
- Produces:

```ts
export interface TimedWord { text: string; startMs: number; endMs: number }
export interface Json3Seg { utf8?: string; tOffsetMs?: number }
export interface Json3Event { tStartMs?: number; dDurationMs?: number; aAppend?: number; segs?: Json3Seg[] }

export function timedWordsFromJson3(events: Json3Event[]): TimedWord[];
/** Parses a raw caption response; returns [] unless it is json3 with an `events` array. */
export function timedWordsFromCaptionText(raw: string): TimedWord[];
/** Each cue is treated as a single-seg event. */
export function timedWordsFromCues(cues: SubtitleChunk[]): TimedWord[];
```

Rules the tests below do not fully determine:
- An event's visible span is `[tStartMs, min(tStartMs + dDurationMs, next speech event's tStartMs)]`; when the next start is not later than `tStartMs`, use `tStartMs + dDurationMs`.
- Before splitting, remove bracketed non-speech (`/\[[^\]]*\]/g`), zero-width spaces and the speaker marker `>>`; treat `\n` as a space.
- Single-seg event: split on whitespace and give each word a share of the visible span proportional to `word.length + 1`; consecutive words touch (`endMs` of one is `startMs` of the next); the last word ends at the span end.
- Multi-seg event (any seg has `tOffsetMs`): a seg starts at `tStartMs + (tOffsetMs ?? 0)` and ends at the next seg's start, or the span end for the last seg; a seg holding several words spreads them inside its own span by the same proportional rule.
- Skip events with `aAppend` or with no speech left after cleaning.
- Round all times to integers.

- [ ] **Step 1: Write the failing tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  timedWordsFromCaptionText,
  timedWordsFromCues,
  timedWordsFromJson3
} from '../src/utils/timed-words';

// Real new-style auto-caption cues (2026-11-23): they overlap and break mid-sentence.
const NEW_ASR = [
  { tStartMs: 320, dDurationMs: 14260, segs: [{ utf8: '[Music]' }] },
  { tStartMs: 18800, dDurationMs: 10319, segs: [{ utf8: "We're no strangers to\nlove. You know the rules and so do" }] },
  { tStartMs: 25960, dDurationMs: 8400, segs: [{ utf8: "I. I feel commitments from what I'm\nthinking" }] }
];

test('single-seg cues are spread over their visible span, clipped at the next cue', () => {
  const words = timedWordsFromJson3(NEW_ASR);
  assert.deepEqual(words.slice(0, 5).map((w) => w.text), ["We're", 'no', 'strangers', 'to', 'love.']);
  assert.equal(words.length, 12 + 8);
  assert.equal(words[0].startMs, 18800);
  assert.equal(words[11].text, 'do');
  assert.equal(words[11].endMs, 25960);
  assert.equal(words[12].text, 'I.');
  assert.equal(words[12].startMs, 25960);
  assert.equal(words[19].endMs, 25960 + 8400);
});

test('word times never run backwards and words touch inside a cue', () => {
  const words = timedWordsFromJson3(NEW_ASR);
  for (let i = 1; i < words.length; i++) {
    assert.ok(words[i].startMs >= words[i - 1].startMs);
    assert.ok(words[i].endMs >= words[i].startMs);
  }
  assert.equal(words[1].startMs, words[0].endMs);
});

test('longer words get a larger share of the cue', () => {
  const [a, b] = timedWordsFromJson3([{ tStartMs: 0, dDurationMs: 1200, segs: [{ utf8: 'a strangers' }] }]);
  assert.ok(b.endMs - b.startMs > a.endMs - a.startMs);
  assert.equal(b.endMs, 1200);
});

test('per-word offsets are used when the track has them, and append events are skipped', () => {
  const words = timedWordsFromJson3([
    { tStartMs: 1000, dDurationMs: 4000, segs: [{ utf8: 'so' }, { utf8: ' today', tOffsetMs: 400 }, { utf8: ' we', tOffsetMs: 900 }] },
    { tStartMs: 2500, dDurationMs: 100, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 2600, dDurationMs: 3000, segs: [{ utf8: 'begin' }] }
  ]);
  assert.deepEqual(words, [
    { text: 'so', startMs: 1000, endMs: 1400 },
    { text: 'today', startMs: 1400, endMs: 1900 },
    { text: 'we', startMs: 1900, endMs: 2600 },
    { text: 'begin', startMs: 2600, endMs: 5600 }
  ]);
});

test('non-speech markers are dropped', () => {
  const words = timedWordsFromJson3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: '>> [Applause and laughter] thank you' }] }]);
  assert.deepEqual(words.map((w) => w.text), ['thank', 'you']);
});

test('anything that is not json3 yields no words', () => {
  assert.deepEqual(timedWordsFromCaptionText(''), []);
  assert.deepEqual(timedWordsFromCaptionText('WEBVTT\n\n00:00.000 --> 00:01.000\nHi'), []);
  assert.deepEqual(timedWordsFromCaptionText('<html>error</html>'), []);
  assert.deepEqual(timedWordsFromCaptionText('{"events":"nope"}'), []);
  assert.equal(timedWordsFromCaptionText(JSON.stringify({ events: NEW_ASR })).length, 20);
});

test('plain cues are treated like single-seg events', () => {
  const words = timedWordsFromCues([
    { text: 'Hello there.', startTime: 0, endTime: 1000 },
    { text: 'Bye.', startTime: 1000, endTime: 1500 }
  ]);
  assert.deepEqual(words.map((w) => w.text), ['Hello', 'there.', 'Bye.']);
  assert.equal(words[1].endMs, 1000);
  assert.equal(words[2].startMs, 1000);
});
```

- [ ] **Step 2: Add the `test:timed-words` script and run it to verify it fails**

Run: `npm run test:timed-words`
Expected: FAIL, `File 'src/utils/timed-words.ts' not found`.

- [ ] **Step 3: Implement `src/utils/timed-words.ts`** with the three exported functions and the rules above. `timedWordsFromCues` maps each cue to `{ tStartMs: startTime, dDurationMs: endTime - startTime, segs: [{ utf8: text }] }` and delegates.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:timed-words && npm run type-check`
Expected: 7 passing, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/utils/timed-words.ts tests/timed-words.test.ts package.json
git commit -m "Extract timed words from YouTube caption responses"
```

---

### Task 2: Sentences from timed words

**Files:**
- Create: `src/utils/sentence-builder.ts`
- Test: `tests/sentence-builder.test.ts`
- Modify: `package.json` (add `test:sentence-builder`, compiling `tests/sentence-builder.test.ts src/utils/sentence-builder.ts src/utils/timed-words.ts src/types/subtitle.ts`)

**Interfaces:**
- Consumes: `TimedWord`, `timedWordsFromJson3` from Task 1; `MeaningfulSentence` from `src/types/subtitle.ts`.
- Produces:

```ts
export const MAX_SENTENCE_WORDS = 28;
export const MAX_SENTENCE_MS = 15_000;

/** True when sentence-ending marks occur at least once per 40 words. */
export function hasSentencePunctuation(words: TimedWord[]): boolean;
/** False when more than 30% of the letters are CJK, kana or Thai. */
export function usesSpaceSeparatedWords(words: TimedWord[]): boolean;
/** `yt-` + 8 hex digits (FNV-1a 32-bit) of `${trackKey}|${startMs}|${text}`. */
export function sentenceId(trackKey: string, startMs: number, text: string): string;
/** Null when the track must stay on the heuristic (unpunctuated, no-space script, or no words). */
export function sentencesFromTimedWords(words: TimedWord[], trackKey: string): MeaningfulSentence[] | null;
```

Rules the tests below do not fully determine:
- A word ends a sentence when, after stripping trailing closing quotes and brackets (`"'»”’)]`), it ends with a sentence-ending mark, unless it is: a single uppercase letter other than `I` followed by `.`; digits only followed by `.`; or, lower-cased without its final dot, one of `dr mr mrs ms prof nr st vs bzw ca etc z.b d.h u.a e.g i.e`.
- Sentence `text` is the words joined by one space; `startTime` is the first word's `startMs`; `endTime` is the last word's `endMs`; `subPortions` has one entry per word; `confidence` is `0.95`; `id` is `sentenceId(trackKey, startTime, text)`.
- A sentence longer than `MAX_SENTENCE_WORDS` words or `MAX_SENTENCE_MS` is split, repeatedly, at the last word within the limit that ends with `,` `;` or `:`; when there is none, after the word followed by the largest time gap within the limit; when all gaps are zero, at the word limit.
- Trailing words after the last sentence-ending mark form a final sentence.

- [ ] **Step 1: Write the failing tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_SENTENCE_WORDS,
  hasSentencePunctuation,
  sentenceId,
  sentencesFromTimedWords,
  usesSpaceSeparatedWords
} from '../src/utils/sentence-builder';
import { timedWordsFromJson3, type TimedWord } from '../src/utils/timed-words';

function words(text: string, stepMs = 300): TimedWord[] {
  return text.split(/\s+/).map((t, i) => ({ text: t, startMs: i * stepMs, endMs: (i + 1) * stepMs }));
}
const texts = (ws: TimedWord[]) => (sentencesFromTimedWords(ws, 'vid|en||') || []).map((s) => s.text);

test('a sentence cut across cues is put back together (regression: "and so do" / "I. I feel")', () => {
  const ws = timedWordsFromJson3([
    { tStartMs: 18800, dDurationMs: 10319, segs: [{ utf8: "We're no strangers to\nlove. You know the rules and so do" }] },
    { tStartMs: 25960, dDurationMs: 8400, segs: [{ utf8: "I. I feel commitments from what I'm\nthinking" }] },
    { tStartMs: 30279, dDurationMs: 12841, segs: [{ utf8: "of. You wouldn't get this from any other\nguy." }] }
  ]);
  const sentences = sentencesFromTimedWords(ws, 'vid|en|asr|')!;
  assert.deepEqual(sentences.map((s) => s.text), [
    "We're no strangers to love.",
    'You know the rules and so do I.',
    "I feel commitments from what I'm thinking of.",
    "You wouldn't get this from any other guy."
  ]);
  assert.equal(sentences[0].startTime, 18800);
  assert.equal(sentences[1].startTime, sentences[0].endTime);
  assert.ok(sentences[1].endTime > 25960 && sentences[1].endTime < 27000);
  assert.equal(sentences[3].endTime, 30279 + 12841);
  assert.equal(sentences[1].subPortions.length, 8);
  assert.equal(sentences[1].confidence, 0.95);
});

test('dots that do not end a sentence are not boundaries', () => {
  assert.deepEqual(texts(words('J. K. Rowling wrote it. Dr. Who agreed.')), ['J. K. Rowling wrote it.', 'Dr. Who agreed.']);
  assert.deepEqual(texts(words('Wir treffen uns am 3. Mai. Das kostet 3.5 Euro, z.B. hier.')), [
    'Wir treffen uns am 3. Mai.',
    'Das kostet 3.5 Euro, z.B. hier.'
  ]);
});

test('closing quotes, ellipses and non-Latin marks end sentences', () => {
  assert.deepEqual(texts(words('He said "stop." Then… Nothing happened! هل تسمعني؟ نعم.')), [
    'He said "stop."',
    'Then…',
    'Nothing happened!',
    'هل تسمعني؟',
    'نعم.'
  ]);
});

test('trailing words without a final mark still form a sentence', () => {
  assert.deepEqual(texts(words('One. Two. Three. and then some')), ['One.', 'Two.', 'Three.', 'and then some']);
});

test('an over-long sentence is split at a comma when there is one', () => {
  const long = `${Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ')}, ${Array.from({ length: 20 }, (_, i) => `x${i}`).join(' ')}. Ok.`;
  const out = texts(words(long));
  assert.equal(out.length, 3);
  assert.ok(out[0].endsWith('w19,'));
});

test('an over-long sentence with no commas never exceeds the word limit', () => {
  const run = `${Array.from({ length: 90 }, (_, i) => `w${i}`).join(' ')}. Short one. Another one. Third one.`;
  const sentences = sentencesFromTimedWords(words(run), 'vid|en||')!;
  assert.ok(sentences.every((s) => s.text.split(' ').length <= MAX_SENTENCE_WORDS));
  assert.equal(sentences.map((s) => s.text).join(' '), run);
});

test('an unpunctuated track is left to the heuristic', () => {
  const classic = words(Array.from({ length: 120 }, (_, i) => `word${i}`).join(' '));
  assert.equal(hasSentencePunctuation(classic), false);
  assert.equal(sentencesFromTimedWords(classic, 'vid|en|asr|'), null);
  assert.equal(sentencesFromTimedWords([], 'vid|en||'), null);
});

test('one stray full stop in a long unpunctuated track does not count as punctuated', () => {
  const ws = words(`${Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ')}.`);
  assert.equal(hasSentencePunctuation(ws), false);
});

test('scripts without spaces stay on the heuristic', () => {
  const ja = words('これはテストです。 次の文です。');
  assert.equal(usesSpaceSeparatedWords(ja), false);
  assert.equal(sentencesFromTimedWords(ja, 'vid|ja||'), null);
  assert.equal(usesSpaceSeparatedWords(words('Das ist ein Test.')), true);
});

test('sentence ids are stable for the same sentence and differ across tracks', () => {
  const a = sentencesFromTimedWords(words('Hello there. Bye.'), 'vid|en||')!;
  const b = sentencesFromTimedWords(words('Hello there. Bye.'), 'vid|en||')!;
  const c = sentencesFromTimedWords(words('Hello there. Bye.'), 'vid|en||de')!;
  assert.equal(a[0].id, b[0].id);
  assert.notEqual(a[0].id, a[1].id);
  assert.notEqual(a[0].id, c[0].id);
  assert.match(a[0].id, /^yt-[0-9a-f]{8}$/);
  assert.equal(a[0].id, sentenceId('vid|en||', 0, 'Hello there.'));
});
```

- [ ] **Step 2: Add the `test:sentence-builder` script and run it to verify it fails**

Run: `npm run test:sentence-builder`
Expected: FAIL, `File 'src/utils/sentence-builder.ts' not found`.

- [ ] **Step 3: Implement `src/utils/sentence-builder.ts`** with the exports and rules above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:sentence-builder && npm run type-check`
Expected: 10 passing, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/utils/sentence-builder.ts tests/sentence-builder.test.ts package.json
git commit -m "Cut punctuated YouTube captions into whole sentences"
```

---

### Task 3: Use shaped sentences on YouTube (overlay and side panel)

**Files:**
- Modify: `src/content/youtube-injector.ts` — the two `parseCaptionText(...)` call sites (in `fetchCaptionsFromCaptionTracksFallback` and `fetchCaptionsViaPageScript`), `resetTranscriptState`, `ensureCaptionsForCurrentVideo`, and the `GET_SUBTITLES` handler (every place that calls `groupAndProcessSubtitles(captions)` or responds with `subtitles: lastSubtitles`)
- Modify: `src/panel/index.tsx` — `loadSentences`
- Test: `tests/youtube-sentences.test.ts`
- Create: `src/utils/youtube-sentences.ts`
- Modify: `package.json` (add `test:youtube-sentences`, compiling the test plus `src/utils/youtube-sentences.ts src/utils/sentence-builder.ts src/utils/timed-words.ts src/utils/subtitle-processor.ts src/types/subtitle.ts`, with `NODE_PATH=./node_modules` like `test:subtitle-processor`)

**Interfaces:**
- Consumes: `timedWordsFromCaptionText`, `timedWordsFromCues`, `TimedWord` (Task 1); `sentencesFromTimedWords` (Task 2); `groupAndProcessSubtitles` from `src/utils/subtitle-processor.ts`; `captionTrackKeyInUse` and `currentVideoId` in `youtube-injector.ts`.
- Produces:

```ts
/**
 * Sentences for a YouTube caption response: shaped sentences when the track is
 * punctuated, otherwise exactly groupAndProcessSubtitles(cues).
 */
export function buildYouTubeSentences(
  rawCaptionText: string,
  cues: SubtitleChunk[],
  trackKey: string
): MeaningfulSentence[];
```

- [ ] **Step 1: Write the failing tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildYouTubeSentences } from '../src/utils/youtube-sentences';
import { groupAndProcessSubtitles } from '../src/utils/subtitle-processor';

const cues = [
  { text: 'You know the rules and so do', startTime: 0, endTime: 4000 },
  { text: 'I. I feel fine.', startTime: 4000, endTime: 6000 }
];
const json3 = JSON.stringify({
  events: cues.map((c) => ({ tStartMs: c.startTime, dDurationMs: c.endTime - c.startTime, segs: [{ utf8: c.text }] }))
});

test('a punctuated json3 response yields shaped sentences', () => {
  const out = buildYouTubeSentences(json3, cues, 'vid|en|asr|');
  assert.deepEqual(out.map((s) => s.text), ['You know the rules and so do I.', 'I feel fine.']);
});

test('a non-json3 response is shaped from its cues', () => {
  const out = buildYouTubeSentences('WEBVTT', cues, 'vid|en||');
  assert.deepEqual(out.map((s) => s.text), ['You know the rules and so do I.', 'I feel fine.']);
});

test('an unpunctuated track gets exactly the heuristic text', () => {
  const plain = Array.from({ length: 60 }, (_, i) => ({ text: `caption fragment number ${i}`, startTime: i * 2500, endTime: (i + 1) * 2500 }));
  const out = buildYouTubeSentences('', plain, 'vid|en|asr|');
  assert.deepEqual(out.map((s) => s.text), groupAndProcessSubtitles(plain).map((s) => s.text));
});

test('no cues and no words yield no sentences', () => {
  assert.deepEqual(buildYouTubeSentences('', [], 'vid|en||'), []);
});
```

- [ ] **Step 2: Add the `test:youtube-sentences` script and run it to verify it fails**

Run: `npm run test:youtube-sentences`
Expected: FAIL, `File 'src/utils/youtube-sentences.ts' not found`.

- [ ] **Step 3: Implement `buildYouTubeSentences` in `src/utils/youtube-sentences.ts`**: words come from `timedWordsFromCaptionText(rawCaptionText)`, or from `timedWordsFromCues(cues)` when that is empty; return `sentencesFromTimedWords(words, trackKey) ?? groupAndProcessSubtitles(cues)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:youtube-sentences`
Expected: 4 passing.

- [ ] **Step 5: Wire it into `src/content/youtube-injector.ts`**

- Add `let lastRawCaptionText = '';` beside `lastSubtitles`; set it to the raw response string immediately before each of the two `parseCaptionText(...)` calls returns a non-empty result; clear it in `resetTranscriptState`.
- Replace every `groupAndProcessSubtitles(captions)` in this file with `buildYouTubeSentences(lastRawCaptionText, captions, captionTrackKeyInUse || currentVideoId)`.
- In the `GET_SUBTITLES` handler, add `sentences: meaningfulSentences` to every response `data` object that already carries `subtitles`.

- [ ] **Step 6: Make the side panel use the same sentences**

In `loadSentences` in `src/panel/index.tsx`: when the `GET_SUBTITLES` response carries a non-empty `sentences` array, use it as the sentence list instead of regrouping `subtitles`; otherwise keep the current behaviour (Netflix and Max responses have no `sentences`).

- [ ] **Step 7: Verify the whole build**

Run: `npm run type-check && npm run test:timed-words && npm run test:sentence-builder && npm run test:youtube-sentences && npm run test:subtitle-processor && npm run test:subtitle-timing && npm run test:language-preferences && npm run test:youtube-timedtext && npm run build`
Expected: every suite passes, `webpack ... compiled successfully`.

- [ ] **Step 8: Verify in Chrome**

Reload the unpacked extension from `dist/` and reload the YouTube tab. On `https://www.youtube.com/watch?v=dQw4w9WgXcQ` with the English (auto-generated) track selected and "Learn CC" on:
- the overlay shows `You know the rules and so do I.` as one sentence, never `…and so do` followed by `I. I feel…`;
- pressing W replays from the sentence's first word, and E moves to the next sentence;
- the side panel lists the same sentences as the overlay.
Then on a video with human-written captions (`https://www.youtube.com/watch?v=TdMDZ8K1kDI`, German) confirm each overlay card is one sentence. Finally open any Netflix title and confirm its overlay behaves as before.

- [ ] **Step 9: Commit**

```bash
git add src/utils/youtube-sentences.ts tests/youtube-sentences.test.ts src/content/youtube-injector.ts src/panel/index.tsx package.json
git commit -m "Show whole sentences for punctuated YouTube captions"
```
