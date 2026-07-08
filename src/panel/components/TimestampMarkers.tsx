import React from 'react';
import type { SubPortions } from '../../types/subtitle';
import { msToDurationString } from '@utils/timestamp-parser';
import styles from './TimestampMarkers.module.css';

interface TimestampMarkersProps {
  subPortions: SubPortions[];
  onPortionClick: (startTime: number) => void;
}

const TimestampMarkers: React.FC<TimestampMarkersProps> = ({
  subPortions,
  onPortionClick
}) => {
  return (
    <div className={styles.container}>
      <div className={styles.markerLabel}>Timestamp Markers:</div>
      <div className={styles.markers}>
        {subPortions.map((portion, idx) => (
          <button
            key={idx}
            className={styles.marker}
            onClick={() => onPortionClick(portion.startTime)}
            title={`Jump to ${msToDurationString(portion.startTime)}`}
          >
            <span className={styles.markerText}>{portion.text}</span>
            <span className={styles.markerTime}>
              {msToDurationString(portion.startTime)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default TimestampMarkers;
