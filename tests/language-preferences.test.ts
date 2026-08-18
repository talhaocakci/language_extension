import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectLanguageCode,
  getExplanationLanguageForTarget,
  getLanguageFlag,
  normalizeBrowserExtensionPreferences,
} from '../src/utils/language-preferences';

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

test('normalizes target-specific browser extension explanation languages', () => {
  const preferences = normalizeBrowserExtensionPreferences({
    explanation_language_by_target: {
      'de-DE': 'EN_us',
      es: 'tr',
      unknown: 'en',
      fr: 'unsupported',
    },
    updated_at: '2026-08-18T12:00:00Z',
  });

  assert.deepEqual(preferences.explanation_language_by_target, { de: 'en', es: 'tr' });
  assert.equal(preferences.updated_at, '2026-08-18T12:00:00Z');
  assert.equal(getExplanationLanguageForTarget(preferences, 'de'), 'en');
  assert.equal(getExplanationLanguageForTarget(preferences, 'es-ES'), 'tr');
  assert.equal(getExplanationLanguageForTarget(preferences, 'fr'), 'en');
});
