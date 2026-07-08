export interface PhraseItem {
  phrase_id: string;
  user_id: string;
  sort_key: string;
  canonical_form: string;
  found_in_text: string;
  kind: string;
  meaning: string;
  example?: string[] | null;
  /** BCP-47 language code of the canonical form, e.g. "de" */
  language?: string | null;
  /** Pronunciation audio stored as a base64 data URL */
  audio?: string | null;
  source_sentence: string;
  source_url: string;
  video_title: string;
  saved_at: string;
  tags: string[];
  user_notes?: string | null;
}

export interface GetPhrasesResponse {
  phrases: PhraseItem[];
  count: number;
  next_cursor: string | null;
}
