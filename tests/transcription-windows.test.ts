import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_SENTENCE_WORDS } from '../src/utils/sentence-builder';
import type { TimedWord } from '../src/utils/timed-words';
import { nextWindowToSend, readyWindows, sentencesFromWindows } from '../src/utils/transcription-windows';

const tc = (...ms: number[]) => ms.map((timecodeMs) => ({ timecodeMs }));

function words(text: string, startMs: number, endMs: number): TimedWord[] {
  const parts = text.split(/\s+/).filter(Boolean);
  // Evenly spread, but at most 500 ms per word so sentences stay within MAX_SENTENCE_MS.
  const step = Math.min((endMs - startMs) / parts.length, 500);
  return parts.map((t, i) => ({ text: t, startMs: Math.round(startMs + i * step), endMs: Math.round(startMs + (i + 1) * step) }));
}

test('a window is ready once a cluster of the next window exists', () => {
  assert.deepEqual(readyWindows(tc(0, 10001, 20001)), []);
  assert.deepEqual(readyWindows(tc(0, 10001, 20001, 30001)),
    [{ index: 0, startMs: 0, partial: false, clusterIndexes: [0, 1, 2] }]);
});
test('the last window is ready when the end was captured', () => {
  assert.deepEqual(readyWindows(tc(0, 10001), 18_000).map(w => w.index), [0]);
});
test('a window entered by a seek is partial and starts where its audio starts', () => {
  const [w] = readyWindows(tc(100001, 110001, 120001));
  assert.deepEqual([w.index, w.startMs, w.partial], [3, 100001, true]);
});
test('a hole inside a window makes it partial', () => {
  assert.equal(readyWindows(tc(0, 20001, 30001))[0].partial, true);
});
test('a window whose audio stops early before a seek is partial', () => {
  const ready = readyWindows(tc(0, 90001, 100001, 110001, 120001));
  const w0 = ready.find(w => w.index === 0)!;
  const w3 = ready.find(w => w.index === 3)!;
  assert.equal(w0.partial, true);
  assert.equal(w3.partial, false);
});
test('one missing cluster makes a window partial', () => {
  assert.equal(readyWindows(tc(0, 10001, 30001, 40001, 50001))[0].partial, true);
  assert.equal(readyWindows(tc(0, 10000, 30000, 40000))[0].partial, true);
});
test('continuous audio gives complete windows and keeps the last one waiting', () => {
  const ms = Array.from({ length: 18 }, (_, i) => i * 10_000 + (i > 0 ? 1 : 0));
  assert.equal(ms[17], 170001);
  const ready = readyWindows(tc(...ms));
  assert.deepEqual(ready.map(w => [w.index, w.partial]), [[0, false], [1, false], [2, false], [3, false], [4, false]]);
});
test('a video end close after the last cluster completes the last window', () => {
  const ms = Array.from({ length: 19 }, (_, i) => i * 10_000 + (i > 0 ? 1 : 0));
  const ready = readyWindows(tc(...ms), 186_521);
  const last = ready[ready.length - 1];
  assert.deepEqual([last.index, last.partial], [6, false]);
});
test('clusters out of order or repeated do not throw and index the first occurrences', () => {
  const a = readyWindows(tc(0, 10001, 20001, 30001, 100001, 110001, 120001, 130001, 10001, 20001));
  const w0a = a.find(w => w.index === 0)!;
  assert.equal(w0a.partial, false);
  assert.deepEqual(w0a.clusterIndexes, [0, 1, 2]);
  const b = readyWindows(tc(0, 10001, 20001, 30001, 40001, 50001, 10001, 20001));
  const w0b = b.find(w => w.index === 0)!;
  assert.equal(w0b.partial, false);
  assert.deepEqual(w0b.clusterIndexes, [0, 1, 2]);
});
test('empty and invalid input yields nothing', () => {
  assert.deepEqual(readyWindows([]), []);
  assert.deepEqual(readyWindows(tc(NaN, -5, Infinity)), []);
});
test('the window at the playhead goes first, stored and in-flight ones are skipped', () => {
  const ready = readyWindows(tc(0, 10001, 20001, 30001, 40001, 50001, 60001, 70001, 80001, 90001));
  assert.equal(nextWindowToSend(ready, new Set(), new Set(), 35_000)!.index, 1);
  assert.equal(nextWindowToSend(ready, new Set([1]), new Set([2]), 35_000)!.index, 0);
  assert.equal(nextWindowToSend(ready, new Set([0, 1, 2]), new Set(), 0), null);
});
test('a sentence crossing a window edge is whole once both windows are in', () => {
  const w0 = words('Das ist der Anfang. Und hier', 27_000, 30_000);
  const w1 = words('geht es weiter. Ende.', 30_000, 33_000);
  assert.deepEqual(sentencesFromWindows(new Map([[0, w0]]), 'k').map(s => s.text), ['Das ist der Anfang.']);
  assert.deepEqual(sentencesFromWindows(new Map([[0, w0], [1, w1]]), 'k', 1).map(s => s.text),
    ['Das ist der Anfang.', 'Und hier geht es weiter.', 'Ende.']);
});
test('windows that are not neighbours do not share a sentence', () => {
  const out = sentencesFromWindows(new Map([[0, words('Eins zwei', 0, 30_000)], [3, words('drei. Vier.', 90_000, 120_000)]]), 'k', 3);
  assert.deepEqual(out.map(s => s.text), ['drei.', 'Vier.']);
});
test('a window without words yields nothing and does not block its neighbours', () => {
  const out = sentencesFromWindows(new Map([[0, words('Hallo.', 0, 30_000)], [1, []], [2, words('Welt.', 60_000, 90_000)]]), 'k', 2);
  assert.deepEqual(out.map(s => s.text), ['Hallo.', 'Welt.']);
});
test('an unpunctuated run is cut into chunks of MAX_SENTENCE_WORDS', () => {
  const total = MAX_SENTENCE_WORDS * 2 + 5;
  const text = Array.from({ length: total }, (_, i) => `w${i}`).join(' ');
  const out = sentencesFromWindows(new Map([[0, words(text, 0, 30_000)]]), 'k', 0);
  assert.deepEqual(out.map(s => s.subPortions!.length), [MAX_SENTENCE_WORDS, MAX_SENTENCE_WORDS, 5]);
  assert.equal(out[0].startTime, 0);
  assert.ok(out[0].id.startsWith('yt-'));
});
