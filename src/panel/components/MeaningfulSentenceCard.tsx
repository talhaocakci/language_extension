import React, { useState } from 'react';
import type { MeaningfulSentence } from '../../types/subtitle';
import PhraseHighlighter from './PhraseHighlighter';
import GrammarExplanation from './GrammarExplanation';
import TimestampMarkers from './TimestampMarkers';
import SaveButton from './SaveButton';
import styles from './MeaningfulSentenceCard.module.css';

interface MeaningfulSentenceCardProps {
  sentence: MeaningfulSentence;
  isActive: boolean;
  onSubPortionClick: (startTime: number) => void;
}

const MeaningfulSentenceCard: React.FC<MeaningfulSentenceCardProps> = ({
  sentence,
  isActive,
  onSubPortionClick
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectedText, setSelectedText] = useState<string | null>(null);

  const handleTextSelection = () => {
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) {
      setSelectedText(selection.toString());
    }
  };

  return (
    <div className={`${styles.card} ${isActive ? styles.active : ''}`}>
      <div className={styles.cardContent}>
        <PhraseHighlighter
          sentence={sentence}
          onTextSelect={handleTextSelection}
        />
        
        <TimestampMarkers
          subPortions={sentence.subPortions}
          onPortionClick={onSubPortionClick}
        />

        <button 
          className={styles.expandButton}
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? '▼' : '▶'} Grammar & Explanation
        </button>

        {isExpanded && sentence.phraseAnalysis && (
          <GrammarExplanation analysis={sentence.phraseAnalysis} />
        )}

        {selectedText && (
          <SaveButton
            phrase={selectedText}
            sentence={sentence.text}
            sentenceStartTime={sentence.startTime}
            sentenceEndTime={sentence.endTime}
            onSaved={() => setSelectedText(null)}
          />
        )}
      </div>
    </div>
  );
};

export default MeaningfulSentenceCard;
