import assert from 'node:assert/strict';
import test from 'node:test';
import {
  closeObservedSubtitleAtNextStart,
  type CapturedSubtitleChunk,
  updateMatchingSubtitleTiming
} from '../src/utils/subtitle-timing';

test('a new observed caption keeps its actual observed start time', () => {
  const previous: CapturedSubtitleChunk = {
    text: 'First caption',
    startTime: 10_000,
    endTime: 10_000,
    timingSource: 'observed'
  };

  updateMatchingSubtitleTiming(previous, {
    ...previous,
    startTime: 11_750,
    endTime: 11_750
  });

  const next: CapturedSubtitleChunk = {
    text: 'Next caption',
    startTime: 12_000,
    endTime: 12_000,
    timingSource: 'observed'
  };
  closeObservedSubtitleAtNextStart(previous, next.startTime);

  assert.equal(previous.endTime, 12_000);
  assert.equal(next.startTime, 12_000);
});

test('native media cue timings replace approximate observation timings', () => {
  const previous: CapturedSubtitleChunk = {
    text: 'Exact caption',
    startTime: 20_180,
    endTime: 20_180,
    timingSource: 'observed'
  };

  updateMatchingSubtitleTiming(previous, {
    text: 'Exact caption',
    startTime: 20_000,
    endTime: 22_400,
    timingSource: 'media-cue'
  });

  assert.deepEqual(previous, {
    text: 'Exact caption',
    startTime: 20_000,
    endTime: 22_400,
    timingSource: 'media-cue'
  });
});

test('a later caption does not truncate an exact overlapping media cue', () => {
  const previous: CapturedSubtitleChunk = {
    text: 'Overlapping cue',
    startTime: 30_000,
    endTime: 33_000,
    timingSource: 'media-cue'
  };

  closeObservedSubtitleAtNextStart(previous, 32_000);

  assert.equal(previous.endTime, 33_000);
});
