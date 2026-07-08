export interface SubtitleChunk {
  text: string;
  startTime: number;
  endTime: number;
}

export interface SubPortions {
  text: string;
  startTime: number;
  endTime: number;
}

export interface MeaningfulSentence {
  id: string;
  text: string;
  startTime: number;
  endTime: number;
  subPortions: SubPortions[];
  confidence: number;
  phraseAnalysis?: PhraseAnalysis;
}

export interface Phrase {
  text: string;
  startPos: number;
  endPos: number;
  type: 'phrasal_verb' | 'prepositional' | 'compound' | 'single_word';
  explanation: string;
  partOfSpeech: string;
  color?: string;
}

export interface PhraseAnalysis {
  sentence: string;
  grammaticalStructure: string;
  phrases: Phrase[];
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  explanation?: string;
}

export interface VideoMetadata {
  url: string;
  title: string;
  platform: 'youtube' | 'netflix' | 'other';
  videoId?: string;
  sessionId?: string;
  duration: number;
  currentTime?: number;
}

export interface SubtitleStream {
  video: VideoMetadata;
  subtitles: MeaningfulSentence[];
  isLoading: boolean;
  error?: string;
}
