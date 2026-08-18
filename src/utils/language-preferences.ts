export const EXPLANATION_LANGUAGE_STORAGE_KEY = 'explanation_language';
export const BROWSER_EXTENSION_PREFERENCES_STORAGE_KEY = 'browser_extension_preferences';
export const DEFAULT_EXPLANATION_LANGUAGE = 'en';

export interface BrowserExtensionPreferences {
  explanation_language_by_target: Record<string, string>;
  updated_at: string;
}

export const LANGUAGE_OPTIONS = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'German' },
  { code: 'tr', label: 'Turkish' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' },
  { code: 'ru', label: 'Russian' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ar', label: 'Arabic' },
] as const;

const LANGUAGE_NAME_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(english|ingilizce)\b/u, 'en'],
  [/\b(german|deutsch|almanca)\b/u, 'de'],
  [/\b(spanish|español|espanol|ispanyolca)\b/u, 'es'],
  [/\b(french|français|francais|fransızca)\b/u, 'fr'],
  [/\b(italian|italiano|italyanca)\b/u, 'it'],
  [/\b(portuguese|português|portugues|portekizce)\b/u, 'pt'],
  [/\b(turkish|türkçe|turkce)\b/u, 'tr'],
  [/\b(dutch|nederlands)\b/u, 'nl'],
  [/(russian|русский)/u, 'ru'],
  [/(japanese|日本語)/u, 'ja'],
  [/(korean|한국어)/u, 'ko'],
  [/(chinese|中文)/u, 'zh'],
  [/(arabic|العربية)/u, 'ar'],
];

const LANGUAGE_FLAGS: Record<string, string> = {
  en: '🇬🇧',
  de: '🇩🇪',
  tr: '🇹🇷',
  es: '🇪🇸',
  fr: '🇫🇷',
  it: '🇮🇹',
  pt: '🇵🇹',
  nl: '🇳🇱',
  ru: '🇷🇺',
  ja: '🇯🇵',
  ko: '🇰🇷',
  zh: '🇨🇳',
  ar: '🇸🇦',
};

export function normalizeLanguagePreference(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const code = value.trim().toLowerCase().split(/[-_]/)[0] || '';
  return LANGUAGE_OPTIONS.some((option) => option.code === code) ? code : fallback;
}

export function normalizeBrowserExtensionPreferences(value: unknown): BrowserExtensionPreferences {
  const raw = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  const languageMap = raw.explanation_language_by_target;
  const explanationLanguageByTarget: Record<string, string> = {};

  if (languageMap && typeof languageMap === 'object' && !Array.isArray(languageMap)) {
    for (const [rawTarget, rawExplanation] of Object.entries(languageMap as Record<string, unknown>)) {
      const target = normalizeLanguagePreference(rawTarget);
      const explanation = normalizeLanguagePreference(rawExplanation);
      if (target && explanation) explanationLanguageByTarget[target] = explanation;
    }
  }

  return {
    explanation_language_by_target: explanationLanguageByTarget,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
  };
}

export function getExplanationLanguageForTarget(
  preferences: BrowserExtensionPreferences,
  targetLanguage: unknown,
  fallback = DEFAULT_EXPLANATION_LANGUAGE,
): string {
  const target = normalizeLanguagePreference(targetLanguage);
  return target
    ? normalizeLanguagePreference(preferences.explanation_language_by_target[target], fallback)
    : fallback;
}

export function getLanguageLabel(code: string): string {
  return LANGUAGE_OPTIONS.find((option) => option.code === code)?.label || code.toUpperCase();
}

/** Parse player metadata such as `en`, `en-US`, or `en (Original)`. */
export function detectLanguageCode(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  if (!normalized) return '';

  const leadingCode = normalized.match(/^([a-z]{2})(?=$|[-_\s([{])/u)?.[1] || '';
  if (LANGUAGE_OPTIONS.some((option) => option.code === leadingCode)) {
    return leadingCode;
  }

  return LANGUAGE_NAME_PATTERNS.find(([pattern]) => pattern.test(normalized))?.[1] || '';
}

export function getLanguageFlag(code: string): string {
  return LANGUAGE_FLAGS[detectLanguageCode(code)] || '🌐';
}
