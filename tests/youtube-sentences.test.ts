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
