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

function timed(entries: Array<[string, number]>, startMs = 0): TimedWord[] {
  let t = startMs;
  return entries.map(([text, ms]) => {
    const word = { text, startMs: t, endMs: t + ms };
    t += ms;
    return word;
  });
}

test('a single word longer than the time limit at the end of a track is kept as it is', () => {
  const ws = [...words('Hello there. Thanks for watching.'), ...timed([['♪', 20_000]], 1500)];
  let out: string[] = [];
  assert.doesNotThrow(() => {
    out = texts(ws);
  });
  assert.equal(out[out.length - 1], '♪');
});

test('a one-word sentence longer than the time limit is its own sentence', () => {
  const ws = timed([
    ['See', 300], ['you', 300], ['soon.', 300],
    ['Bye!', 16_000],
    ['Next', 300], ['time', 300], ['then.', 300]
  ]);
  let out: string[] = [];
  assert.doesNotThrow(() => {
    out = texts(ws);
  });
  assert.deepEqual(out, ['See you soon.', 'Bye!', 'Next time then.']);
});

test('an over-long sentence with no commas is split at the largest silent gap within the limit', () => {
  const ws: TimedWord[] = Array.from({ length: 20 }, (_, i) => {
    const start = i * 1000 + (i >= 8 ? 3000 : 0);
    return { text: i === 19 ? `w${i}.` : `w${i}`, startMs: start, endMs: start + 1000 };
  });
  const sentences = sentencesFromTimedWords(ws, 'vid|en||')!;
  assert.ok(sentences.length > 1);
  assert.ok(sentences[0].text.endsWith('w7'));
  assert.equal(sentences[0].subPortions.length, 8);
  assert.ok(sentences.every((s) => s.endTime - s.startTime <= 15_000));
});

test('a year followed by a full stop ends a sentence', () => {
  assert.deepEqual(texts(words('It happened in 2020. Then we left.')), ['It happened in 2020.', 'Then we left.']);
});
