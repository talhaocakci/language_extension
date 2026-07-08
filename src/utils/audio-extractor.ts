import type { AudioStorage } from '../types/api';
import { v4 as uuidv4 } from 'uuid';

export class AudioExtractor {
  private static mediaRecorder: MediaRecorder | null = null;
  private static audioChunks: Blob[] = [];
  private static audioContext: AudioContext | null = null;

  static async captureAudioFromVideo(
    video: HTMLVideoElement,
    startTimeMs: number,
    endTimeMs: number,
    materialId?: string
  ): Promise<AudioStorage | null> {
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const source = audioContext.createMediaElementSource(video);
      const destination = audioContext.createMediaStreamDestination();
      
      source.connect(destination);
      source.connect(audioContext.destination);

      const mediaRecorder = new MediaRecorder(destination.stream);
      const audioChunks: Blob[] = [];

      mediaRecorder.ondataavailable = (event) => {
        audioChunks.push(event.data);
      };

      const startSeconds = startTimeMs / 1000;
      const endSeconds = endTimeMs / 1000;
      const duration = endSeconds - startSeconds;

      video.currentTime = startSeconds;

      return new Promise((resolve) => {
        mediaRecorder.start();

        const updateTimer = setInterval(() => {
          if (video.currentTime >= endSeconds) {
            clearInterval(updateTimer);
            mediaRecorder.stop();

            mediaRecorder.onstop = () => {
              const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
              const audioStorage: AudioStorage = {
                learningMaterialId: materialId || uuidv4(),
                audioBlob,
                duration,
                format: 'audio/wav',
                dataUrl: URL.createObjectURL(audioBlob)
              };

              resolve(audioStorage);
            };
          }
        }, 100);

        setTimeout(() => {
          clearInterval(updateTimer);
          mediaRecorder.stop();
          resolve(null);
        }, (endSeconds - startSeconds + 1) * 1000);
      });
    } catch (error) {
      console.error('Error capturing audio:', error);
      return null;
    }
  }

  static storeAudioInIndexedDB(
    db: IDBDatabase,
    audioStorage: AudioStorage
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['audioClips'], 'readwrite');
      const store = transaction.objectStore('audioClips');

      const blobUrl = URL.createObjectURL(audioStorage.audioBlob);
      
      const request = store.add({
        learningMaterialId: audioStorage.learningMaterialId,
        blob: audioStorage.audioBlob,
        duration: audioStorage.duration,
        format: audioStorage.format,
        timestamp: new Date().toISOString(),
        blobUrl
      });

      request.onsuccess = () => {
        resolve(blobUrl);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  static retrieveAudioFromIndexedDB(
    db: IDBDatabase,
    materialId: string
  ): Promise<AudioStorage | null> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['audioClips'], 'readonly');
      const store = transaction.objectStore('audioClips');
      const index = store.index('materialIdIndex');

      const request = index.get(materialId);

      request.onsuccess = () => {
        if (request.result) {
          resolve({
            learningMaterialId: request.result.learningMaterialId,
            audioBlob: request.result.blob,
            duration: request.result.duration,
            format: request.result.format,
            dataUrl: request.result.blobUrl
          });
        } else {
          resolve(null);
        }
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  static initializeIndexedDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('SubtitleLearning', 1);

      request.onerror = () => {
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains('audioClips')) {
          const store = db.createObjectStore('audioClips', { keyPath: 'id', autoIncrement: true });
          store.createIndex('materialIdIndex', 'learningMaterialId', { unique: false });
        }

        if (!db.objectStoreNames.contains('learningMaterials')) {
          db.createObjectStore('learningMaterials', { keyPath: 'id', autoIncrement: true });
        }
      };
    });
  }

  static deleteAudioFromIndexedDB(
    db: IDBDatabase,
    materialId: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['audioClips'], 'readwrite');
      const store = transaction.objectStore('audioClips');
      const index = store.index('materialIdIndex');

      const range = IDBKeyRange.only(materialId);
      const request = index.openCursor(range);

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }
}
