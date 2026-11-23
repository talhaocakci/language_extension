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
