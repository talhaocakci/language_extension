import React, { useEffect, useState } from 'react';
import type { MeaningfulSentence } from '../../types/subtitle';
import MeaningfulSentenceCard from './MeaningfulSentenceCard';
import styles from './SubtitleStream.module.css';

interface SubtitleStreamProps {
  sentences: MeaningfulSentence[];
  isLoading: boolean;
  currentTime: number;
  onSubPortionClick: (startTime: number) => void;
}

const SubtitleStream: React.FC<SubtitleStreamProps> = ({
  sentences,
  isLoading,
  currentTime,
  onSubPortionClick
}) => {
  const [activeSentenceId, setActiveSentenceId] = useState<string | null>(null);

  useEffect(() => {
    const activeSentence = sentences.find(
      sentence => currentTime >= sentence.startTime && currentTime <= sentence.endTime
    );
    setActiveSentenceId(activeSentence?.id || null);
  }, [currentTime, sentences]);

  if (isLoading) {
    return (
      <div className={styles.loadingContainer}>
        <div className={styles.spinner}></div>
        <p>Processing subtitles...</p>
      </div>
    );
  }

  if (sentences.length === 0) {
    return (
      <div className={styles.emptyContainer}>
        <p>No subtitles found. Please check if subtitles are enabled on the video.</p>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.streamContent}>
        {sentences.map((sentence) => (
          <MeaningfulSentenceCard
            key={sentence.id}
            sentence={sentence}
            isActive={activeSentenceId === sentence.id}
            onSubPortionClick={onSubPortionClick}
          />
        ))}
      </div>
    </div>
  );
};

export default SubtitleStream;
