export interface MessageRequest<T = any> {
  type: string;
  payload?: T;
  requestId?: string;
}

export interface MessageResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  requestId?: string;
}

export type PlaybackControlAction = 'pause' | 'play' | 'seek_to_ms' | 'toggle_slow';

export interface PlaybackControlPayload {
  action: PlaybackControlAction;
  timeMs?: number;
}

export type Platform = 'youtube' | 'netflix' | 'other';

export interface UserPreferences {
  apiEndpoint: string;
  apiToken: string;
  llmEndpoint: string;
  llmApiKey: string;
  llmModel: string;
  theme: 'light' | 'dark';
  language: string;
  autoSaveEnabled: boolean;
  /** Transcribe YouTube videos without captions without asking first (uses credits). */
  alwaysTranscribeCaptionless: boolean;
}

/** The part of the preferences that GET_PREFERENCES / SET_PREFERENCES store in the browser. */
export type StoredUserPreferences = Pick<UserPreferences, 'alwaysTranscribeCaptionless'>;

export const USER_PREFERENCES_STORAGE_KEY = 'user_preferences';
export const DEFAULT_STORED_USER_PREFERENCES: StoredUserPreferences = { alwaysTranscribeCaptionless: false };

export function normalizeStoredUserPreferences(value: unknown): StoredUserPreferences {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    alwaysTranscribeCaptionless: raw.alwaysTranscribeCaptionless === true,
  };
}

export interface StorageData {
  preferences?: UserPreferences;
  savedMaterials?: Map<string, any>;
  recentVideos?: Map<string, any>;
}
