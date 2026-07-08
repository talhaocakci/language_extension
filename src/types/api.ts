import { PhraseAnalysis } from './subtitle';

export interface SavedLearningMaterial {
  id: string;
  phrase: string;
  meaningfulSentence: string;
  grammarAnalysis: PhraseAnalysis;
  aiExplanation: string;
  timestamps: {
    phraseStart: number;
    phraseEnd: number;
    sentenceStart: number;
    sentenceEnd: number;
  };
  sourceUrl: string;
  platform: 'youtube' | 'netflix';
  videoTitle: string;
  videoUrl: string;
  thumbnailUrl?: string;
  audioClipUrl?: string;
  savedAt: string;
}

export interface AudioStorage {
  learningMaterialId: string;
  audioBlob: Blob;
  duration: number;
  format: 'audio/wav' | 'audio/mp3';
  dataUrl?: string;
}

export interface APIConfig {
  endpoint: string;
  bearerToken: string;
  timeout: number;
}

export interface AIConfig {
  provider: 'custom';
  endpoint: string;
  apiKey: string;
  model: string;
  maxTokens: number;
}

export interface APIRequest<T> {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  endpoint: string;
  data?: T;
  timeout?: number;
}

export interface APIResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  statusCode: number;
}
