import type { MeaningfulSentence, SubtitleChunk } from '../types/subtitle';
import { sentencesFromTimedWords } from './sentence-builder';
import { groupAndProcessSubtitles } from './subtitle-processor';
import { timedWordsFromCaptionText, timedWordsFromCues } from './timed-words';

/**
 * Sentences for a YouTube caption response: shaped sentences when the track is
 * punctuated, otherwise exactly groupAndProcessSubtitles(cues).
 */
export function buildYouTubeSentences(
  rawCaptionText: string,
  cues: SubtitleChunk[],
  trackKey: string
): MeaningfulSentence[] {
  let words = timedWordsFromCaptionText(rawCaptionText);
  if (words.length === 0) {
    words = timedWordsFromCues(cues);
  }
  return sentencesFromTimedWords(words, trackKey) ?? groupAndProcessSubtitles(cues);
}
