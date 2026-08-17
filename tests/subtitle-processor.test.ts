import assert from 'node:assert/strict';
import test from 'node:test';
import { SubtitleProcessor, groupAndProcessSubtitles } from '../src/utils/subtitle-processor';
import type { SubtitleChunk } from '../src/types/subtitle';

function cue(text: string, index: number): SubtitleChunk {
  return {
    text,
    startTime: index * 2_500,
    endTime: (index + 1) * 2_500
  };
}

test('unpunctuated YouTube cues do not cascade into one giant final card', () => {
  const chunks = Array.from({ length: 20 }, (_, index) =>
    cue(`caption fragment number ${index + 1}`, index)
  );

  const groups = SubtitleProcessor.groupSubtitlesByHeuristic(chunks);

  assert.ok(groups.length > 1);
  assert.ok(groups.every((group) => group.length <= 5));
  assert.deepEqual(groups.flat(), chunks);
});

test('high-confidence ASR boundaries reconstruct the screenshot transcript', () => {
  const chunks = [
    'process of writing occurs',
    'I am NOT presently nervous',
    'time to read the prompts',
    'okay the year is 2048',
    "that's an excellent year for it to be",
    'the main character has',
    'to encounter her old colleague',
    'at her local protein'
  ].map(cue);

  const sentences = groupAndProcessSubtitles(chunks).map((sentence) => sentence.text);

  assert.deepEqual(sentences, [
    'Process of writing occurs.',
    'I am NOT presently nervous.',
    'Time to read the prompts.',
    'Okay the year is 2048.',
    "That's an excellent year for it to be.",
    'The main character has to encounter her old colleague at her local protein.'
  ]);
});
