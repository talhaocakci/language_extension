import assert from 'node:assert/strict';
import test from 'node:test';
import { detectLanguageCode, getLanguageFlag } from '../src/utils/language-preferences';

test('detects language codes with player metadata suffixes', () => {
  assert.equal(detectLanguageCode('en (Original)'), 'en');
  assert.equal(detectLanguageCode('EN_us [CC]'), 'en');
  assert.equal(detectLanguageCode('de-DE'), 'de');
});

test('detects supported localized language names', () => {
  assert.equal(detectLanguageCode('English [CC]'), 'en');
  assert.equal(detectLanguageCode('English CC'), 'en');
  assert.equal(detectLanguageCode('English - Original'), 'en');
  assert.equal(detectLanguageCode('Türkçe (Orijinal)'), 'tr');
  assert.equal(detectLanguageCode('Deutsch – Audiodeskription'), 'de');
});

test('does not turn arbitrary metadata into a language code', () => {
  assert.equal(detectLanguageCode('Original with subtitles'), '');
  assert.equal(getLanguageFlag('unknown'), '🌐');
});
