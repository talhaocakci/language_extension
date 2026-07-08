import React, { useState, useEffect } from 'react';
import type { MeaningfulSentence, Phrase } from '../../types/subtitle';
import styles from './PhraseHighlighter.module.css';

const PHRASE_COLORS: Record<string, string> = {
  'phrasal_verb': '#ff6b6b',
  'prepositional': '#4ecdc4',
  'compound': '#45b7d1',
  'single_word': '#95a3a3'
};

interface PhraseHighlighterProps {
  sentence: MeaningfulSentence;
  onTextSelect: (text: string, phrase?: Phrase) => void;
}

const PhraseHighlighter: React.FC<PhraseHighlighterProps> = ({
  sentence,
  onTextSelect
}) => {
  const [highlightedPhrases, setHighlightedPhrases] = useState<Phrase[]>([]);
  const [hoveredPhrase, setHoveredPhrase] = useState<Phrase | null>(null);

  useEffect(() => {
    if (sentence.phraseAnalysis) {
      setHighlightedPhrases(sentence.phraseAnalysis.phrases);
    }
  }, [sentence]);

  const renderSentenceWithHighlights = () => {
    if (highlightedPhrases.length === 0) {
      return <span>{sentence.text}</span>;
    }

    const parts: Array<{ text: string; phrase?: Phrase }> = [];
    let lastEnd = 0;

    highlightedPhrases
      .sort((a, b) => a.startPos - b.startPos)
      .forEach((phrase) => {
        if (phrase.startPos > lastEnd) {
          parts.push({
            text: sentence.text.substring(lastEnd, phrase.startPos)
          });
        }
        parts.push({
          text: sentence.text.substring(phrase.startPos, phrase.endPos),
          phrase
        });
        lastEnd = phrase.endPos;
      });

    if (lastEnd < sentence.text.length) {
      parts.push({
        text: sentence.text.substring(lastEnd)
      });
    }

    return (
      <>
        {parts.map((part, idx) => (
          part.phrase ? (
            <span
              key={idx}
              className={styles.highlightedPhrase}
              style={{
                backgroundColor: PHRASE_COLORS[part.phrase.type] || PHRASE_COLORS['single_word'],
                opacity: hoveredPhrase?.text === part.phrase.text ? 0.9 : 0.7
              }}
              onMouseEnter={() => setHoveredPhrase(part.phrase || null)}
              onMouseLeave={() => setHoveredPhrase(null)}
              onClick={() => onTextSelect(part.text, part.phrase)}
            >
              {part.text}
            </span>
          ) : (
            <span key={idx}>{part.text}</span>
          )
        ))}
      </>
    );
  };

  return (
    <div className={styles.container}>
      <div className={styles.sentenceText}>
        {renderSentenceWithHighlights()}
      </div>

      {hoveredPhrase && (
        <div className={styles.tooltip}>
          <div className={styles.tooltipTitle}>{hoveredPhrase.text}</div>
          <div className={styles.tooltipType}>
            {hoveredPhrase.type.replace('_', ' ').toUpperCase()}
          </div>
          <div className={styles.tooltipExplanation}>{hoveredPhrase.explanation}</div>
        </div>
      )}
    </div>
  );
};

export default PhraseHighlighter;
