import React from 'react';
import type { PhraseAnalysis } from '../../types/subtitle';
import styles from './GrammarExplanation.module.css';

interface GrammarExplanationProps {
  analysis: PhraseAnalysis;
}

const GrammarExplanation: React.FC<GrammarExplanationProps> = ({ analysis }) => {
  const difficultyColors: Record<string, string> = {
    'beginner': '#5ba67f',
    'intermediate': '#f0ad4e',
    'advanced': '#d9534f'
  };

  return (
    <div className={styles.container}>
      <div className={styles.structure}>
        <h4>Grammar Structure</h4>
        <p>{analysis.grammaticalStructure}</p>
      </div>

      <div className={styles.difficulty}>
        <span className={styles.label}>Difficulty Level:</span>
        <span
          className={styles.badge}
          style={{ backgroundColor: difficultyColors[analysis.difficulty] }}
        >
          {analysis.difficulty.charAt(0).toUpperCase() + analysis.difficulty.slice(1)}
        </span>
      </div>

      <div className={styles.phrases}>
        <h4>Key Words & Phrases</h4>
        <ul>
          {analysis.phrases.map((phrase, idx) => (
            <li key={idx} className={styles.phraseItem}>
              <div className={styles.phraseText}>
                <strong>"{phrase.text}"</strong>
                <span className={styles.partOfSpeech}>{phrase.partOfSpeech}</span>
              </div>
              <div className={styles.phraseType}>
                {phrase.type.replace('_', ' ').toUpperCase()}
              </div>
              <p className={styles.explanation}>{phrase.explanation}</p>
            </li>
          ))}
        </ul>
      </div>

      {analysis.explanation && (
        <div className={styles.additionalInfo}>
          <h4>Additional Notes</h4>
          <p>{analysis.explanation}</p>
        </div>
      )}
    </div>
  );
};

export default GrammarExplanation;
