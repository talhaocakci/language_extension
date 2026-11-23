import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWindowFile, parseWebmAudio } from '../src/utils/webm-audio';
import { cluster, concat, init } from './webm-fixture';

test('finds complete clusters and the init length', () => {
  const s = concat(init(), cluster(0, 100), cluster(10001, 80));
  const p = parseWebmAudio(s)!;
  assert.equal(p.initLength, init().length);
  assert.deepEqual(p.clusters.map(c => c.timecodeMs), [0, 10001]);
  assert.equal(p.clusters[1].offset, init().length + cluster(0, 100).length);
});

test('a half-received cluster is left out', () => {
  const s = concat(init(), cluster(0, 100), cluster(10001, 80).slice(0, 40));
  assert.deepEqual(parseWebmAudio(s)!.clusters.map(c => c.timecodeMs), [0]);
});

test('bytes after a seek are picked up at the next cluster', () => {
  const s = concat(init(), cluster(0, 100).slice(0, 50), cluster(90001, 60), cluster(100001, 60));
  assert.deepEqual(parseWebmAudio(s)!.clusters.map(c => c.timecodeMs), [90001, 100001]);
});

test('not WebM', () => {
  assert.equal(parseWebmAudio(new Uint8Array([0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70])), null);
});

test('a window file starts at time zero and leaves the source untouched', () => {
  const s = concat(init(), cluster(0, 10), cluster(30001, 10), cluster(40001, 10));
  const p = parseWebmAudio(s)!;
  const copy = s.slice();
  const file = buildWindowFile(s, p, p.clusters.slice(1));
  assert.deepEqual(parseWebmAudio(file)!.clusters.map(c => c.timecodeMs), [0, 10000]);
  assert.equal(file.length, p.initLength + p.clusters[1].length + p.clusters[2].length);
  assert.deepEqual(s, copy);
});
