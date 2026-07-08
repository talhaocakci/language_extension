import React, { useState } from 'react';
import styles from './SaveButton.module.css';

interface SaveButtonProps {
  phrase: string;
  sentence: string;
  sentenceStartTime: number;
  sentenceEndTime: number;
  onSaved: () => void;
}

const SaveButton: React.FC<SaveButtonProps> = ({
  phrase,
  sentence,
  sentenceStartTime,
  sentenceEndTime,
  onSaved
}) => {
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');

  const handleSave = async () => {
    setIsSaving(true);
    
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SAVE_LEARNING_MATERIAL',
        payload: {
          phrase,
          meaningfulSentence: sentence,
          timestamps: {
            phraseStart: sentenceStartTime,
            phraseEnd: sentenceEndTime,
            sentenceStart: sentenceStartTime,
            sentenceEnd: sentenceEndTime
          }
        }
      });

      if (response.success) {
        setSaveStatus('success');
        setTimeout(() => {
          setSaveStatus('idle');
          onSaved();
        }, 2000);
      } else {
        setSaveStatus('error');
        setTimeout(() => setSaveStatus('idle'), 3000);
      }
    } catch (error) {
      console.error('Error saving:', error);
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.selectedPhrase}>
        Selected: <strong>"{phrase}"</strong>
      </div>
      <button
        className={styles.saveButton}
        onClick={handleSave}
        disabled={isSaving}
      >
        {isSaving ? 'Saving...' : '💾 Save'}
      </button>
      {saveStatus === 'success' && (
        <div className={styles.successMessage}>✓ Saved successfully!</div>
      )}
      {saveStatus === 'error' && (
        <div className={styles.errorMessage}>✗ Error saving. Please try again.</div>
      )}
    </div>
  );
};

export default SaveButton;
