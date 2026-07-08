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
}

export interface StorageData {
  preferences?: UserPreferences;
  savedMaterials?: Map<string, any>;
  recentVideos?: Map<string, any>;
}
