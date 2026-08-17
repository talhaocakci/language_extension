import type { MessageRequest } from '../../types/common';
import {
  NETFLIX_AUDIO_MESSAGES,
  NETFLIX_AUDIO_OFFSCREEN_TARGET,
  type NetflixAudioCaptureStatus,
  type NetflixAudioClipMetadata,
  type NetflixAudioClipData,
  type NetflixAudioExperimentResponse,
  type NetflixAudioRecordingSpec,
} from './protocol';

const DB_NAME = 'GetFluentFastNetflixAudioExperiment';
const DB_VERSION = 1;
const CLIP_STORE = 'clips';
const STALE_CLIP_AGE_MS = 24 * 60 * 60 * 1000;

interface StoredNetflixAudioClip extends NetflixAudioClipMetadata {
  blob: Blob;
}

interface ActiveRecording {
  recorder: MediaRecorder;
  chunks: Blob[];
  spec: NetflixAudioRecordingSpec;
  startedAt: number;
}

let captureStream: MediaStream | null = null;
let capturedTabId: number | null = null;
let monitorContext: AudioContext | null = null;
let monitorSource: MediaStreamAudioSourceNode | null = null;
let activeRecording: ActiveRecording | null = null;
let playbackAudio: HTMLAudioElement | null = null;

function getStatus(): NetflixAudioCaptureStatus {
  const active = !!captureStream?.getAudioTracks().some((track) => track.readyState === 'live');
  return {
    offscreenReady: true,
    active,
    activeForCurrentTab: active,
    capturedTabId: active ? capturedTabId : null,
    recording: !!activeRecording,
  };
}

function chooseRecordingMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || '';
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error || new Error('Could not open clip database.'));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CLIP_STORE)) {
        const store = db.createObjectStore(CLIP_STORE, { keyPath: 'clipId' });
        store.createIndex('sentenceKey', 'sentenceKey', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function storeClip(clip: StoredNetflixAudioClip): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(CLIP_STORE, 'readwrite');
      transaction.onerror = () => reject(transaction.error || new Error('Could not save audio clip.'));
      transaction.oncomplete = () => resolve();
      transaction.objectStore(CLIP_STORE).put(clip);
    });
  } finally {
    db.close();
  }
}

async function findClip(sentenceKey: string): Promise<StoredNetflixAudioClip | null> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(CLIP_STORE, 'readonly');
      const request = transaction.objectStore(CLIP_STORE).index('sentenceKey').getAll(sentenceKey);
      request.onerror = () => reject(request.error || new Error('Could not read audio clips.'));
      request.onsuccess = () => {
        const clips = (request.result as StoredNetflixAudioClip[])
          .sort((left, right) => right.createdAt - left.createdAt);
        resolve(clips[0] || null);
      };
    });
  } finally {
    db.close();
  }
}

async function getClip(clipId: string): Promise<StoredNetflixAudioClip | null> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(CLIP_STORE, 'readonly').objectStore(CLIP_STORE).get(clipId);
      request.onerror = () => reject(request.error || new Error('Could not read audio clip.'));
      request.onsuccess = () => resolve((request.result as StoredNetflixAudioClip | undefined) || null);
    });
  } finally {
    db.close();
  }
}

async function clearClips(): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(CLIP_STORE, 'readwrite');
      transaction.onerror = () => reject(transaction.error || new Error('Could not clear audio clips.'));
      transaction.oncomplete = () => resolve();
      transaction.objectStore(CLIP_STORE).clear();
    });
  } finally {
    db.close();
  }
}

async function deleteClip(clipId: string): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(CLIP_STORE, 'readwrite');
      transaction.onerror = () => reject(transaction.error || new Error('Could not delete audio clip.'));
      transaction.oncomplete = () => resolve();
      transaction.objectStore(CLIP_STORE).delete(clipId);
    });
  } finally {
    db.close();
  }
}

async function cleanupStaleClips(): Promise<number> {
  const db = await openDatabase();
  try {
    return await new Promise<number>((resolve, reject) => {
      let deleted = 0;
      const transaction = db.transaction(CLIP_STORE, 'readwrite');
      transaction.onerror = () => reject(transaction.error || new Error('Could not clean stale audio clips.'));
      transaction.oncomplete = () => resolve(deleted);
      const cutoff = IDBKeyRange.upperBound(Date.now() - STALE_CLIP_AGE_MS);
      const request = transaction.objectStore(CLIP_STORE).index('createdAt').openKeyCursor(cutoff);
      request.onerror = () => reject(request.error || new Error('Could not scan stale audio clips.'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        transaction.objectStore(CLIP_STORE).delete(cursor.primaryKey);
        deleted += 1;
        cursor.continue();
      };
    });
  } finally {
    db.close();
  }
}

async function clipToTransferData(clipId: string): Promise<NetflixAudioClipData> {
  const clip = await getClip(clipId);
  if (!clip) throw new Error('Captured audio clip was not found. Please save again.');
  const bytes = new Uint8Array(await clip.blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const { blob: _blob, ...metadata } = clip;
  return { ...metadata, base64Data: btoa(binary) };
}

async function discardActiveRecording(): Promise<void> {
  const session = activeRecording;
  activeRecording = null;
  if (!session || session.recorder.state === 'inactive') return;
  await new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, 1000);
    session.recorder.addEventListener('stop', () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
    session.recorder.stop();
  });
}

async function releaseCapture(expectedTabId?: number): Promise<void> {
  if (expectedTabId !== undefined && capturedTabId !== expectedTabId) return;
  await discardActiveRecording();

  if (playbackAudio) {
    playbackAudio.pause();
    playbackAudio.src = '';
    playbackAudio = null;
  }

  const stream = captureStream;
  captureStream = null;
  capturedTabId = null;
  stream?.getTracks().forEach((track) => track.stop());
  monitorSource?.disconnect();
  monitorSource = null;
  if (monitorContext) await monitorContext.close().catch(() => undefined);
  monitorContext = null;
}

async function attachCaptureStream(streamId: string, tabId: number): Promise<NetflixAudioCaptureStatus> {
  await releaseCapture();

  const constraints = {
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  } as unknown as MediaStreamConstraints;

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('The captured tab did not provide an audio track.');
  }

  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  try {
    source.connect(audioContext.destination);
    await audioContext.resume();
  } catch (error) {
    source.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    await audioContext.close().catch(() => undefined);
    throw error;
  }

  captureStream = stream;
  capturedTabId = tabId;
  monitorContext = audioContext;
  monitorSource = source;

  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      if (captureStream === stream) void releaseCapture(tabId);
    }, { once: true });
  }

  return getStatus();
}

async function startRecording(spec: NetflixAudioRecordingSpec, requestingTabId: number): Promise<void> {
  const status = getStatus();
  if (!status.active || capturedTabId !== requestingTabId || !captureStream) {
    throw new Error('Audio capture is not enabled for this Netflix tab.');
  }
  if (activeRecording) throw new Error('Another audio clip is already being recorded.');

  const mimeType = chooseRecordingMimeType();
  const recorder = new MediaRecorder(captureStream, mimeType ? { mimeType } : undefined);
  const session: ActiveRecording = {
    recorder,
    chunks: [],
    spec,
    startedAt: Date.now(),
  };
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) session.chunks.push(event.data);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = () => reject(new Error('MediaRecorder could not start.'));
    recorder.addEventListener('error', onError, { once: true });
    recorder.addEventListener('start', () => {
      recorder.removeEventListener('error', onError);
      resolve();
    }, { once: true });
    recorder.start(100);
  });
  activeRecording = session;
}

async function stopRecording(requestingTabId: number): Promise<NetflixAudioClipMetadata> {
  const session = activeRecording;
  if (!session) throw new Error('No audio clip is being recorded.');
  if (capturedTabId !== requestingTabId) throw new Error('Recording belongs to another tab.');
  activeRecording = null;

  const blob = await new Promise<Blob>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Timed out while finishing audio clip.')), 4000);
    session.recorder.addEventListener('error', () => {
      window.clearTimeout(timer);
      reject(new Error('MediaRecorder failed while finishing the clip.'));
    }, { once: true });
    session.recorder.addEventListener('stop', () => {
      window.clearTimeout(timer);
      resolve(new Blob(session.chunks, {
        type: session.recorder.mimeType || session.chunks[0]?.type || 'audio/webm',
      }));
    }, { once: true });
    session.recorder.stop();
  });

  if (blob.size === 0) throw new Error('Netflix produced an empty audio clip.');

  const clip: StoredNetflixAudioClip = {
    ...session.spec,
    durationMs: Math.max(0, session.spec.endTimeMs - session.spec.startTimeMs),
    mimeType: blob.type || 'audio/webm',
    byteLength: blob.size,
    createdAt: Date.now(),
    blob,
  };
  await storeClip(clip);
  const { blob: _blob, ...metadata } = clip;
  return metadata;
}

async function playClip(clipId: string): Promise<void> {
  const clip = await getClip(clipId);
  if (!clip) throw new Error('Saved audio clip was not found.');

  if (playbackAudio) {
    playbackAudio.pause();
    playbackAudio.src = '';
  }
  const url = URL.createObjectURL(clip.blob);
  const audio = new Audio(url);
  playbackAudio = audio;
  const cleanup = () => {
    if (playbackAudio === audio) playbackAudio = null;
    URL.revokeObjectURL(url);
  };
  audio.addEventListener('ended', cleanup, { once: true });
  audio.addEventListener('error', cleanup, { once: true });
  try {
    await audio.play();
  } catch (error) {
    cleanup();
    throw error;
  }
}

function sendSuccess<T>(sendResponse: (response: NetflixAudioExperimentResponse<T>) => void, data: T): void {
  sendResponse({ success: true, data });
}

chrome.runtime.onMessage.addListener((message: MessageRequest, _sender, sendResponse) => {
  if (message.payload?.target !== NETFLIX_AUDIO_OFFSCREEN_TARGET) return;

  void (async () => {
    try {
      switch (message.type) {
        case NETFLIX_AUDIO_MESSAGES.GET_STATUS:
          sendSuccess(sendResponse, getStatus());
          break;
        case NETFLIX_AUDIO_MESSAGES.ATTACH_STREAM:
          sendSuccess(sendResponse, await attachCaptureStream(
            String(message.payload?.streamId || ''),
            Number(message.payload?.tabId),
          ));
          break;
        case NETFLIX_AUDIO_MESSAGES.STOP_CAPTURE:
          await releaseCapture(
            Number.isFinite(Number(message.payload?.tabId)) ? Number(message.payload?.tabId) : undefined,
          );
          sendSuccess(sendResponse, getStatus());
          break;
        case NETFLIX_AUDIO_MESSAGES.START_RECORDING:
          await startRecording(
            message.payload?.spec as NetflixAudioRecordingSpec,
            Number(message.payload?.requestingTabId),
          );
          sendSuccess(sendResponse, { recording: true });
          break;
        case NETFLIX_AUDIO_MESSAGES.STOP_RECORDING:
          sendSuccess(sendResponse, await stopRecording(Number(message.payload?.requestingTabId)));
          break;
        case NETFLIX_AUDIO_MESSAGES.ABORT_RECORDING:
          await discardActiveRecording();
          sendSuccess(sendResponse, { recording: false });
          break;
        case NETFLIX_AUDIO_MESSAGES.FIND_CLIP: {
          const clip = await findClip(String(message.payload?.sentenceKey || ''));
          if (!clip) {
            sendSuccess(sendResponse, null);
            break;
          }
          const { blob: _blob, ...metadata } = clip;
          sendSuccess(sendResponse, metadata);
          break;
        }
        case NETFLIX_AUDIO_MESSAGES.GET_CLIP_DATA:
          sendSuccess(sendResponse, await clipToTransferData(String(message.payload?.clipId || '')));
          break;
        case NETFLIX_AUDIO_MESSAGES.DELETE_CLIP:
          await deleteClip(String(message.payload?.clipId || ''));
          sendSuccess(sendResponse, { deleted: true });
          break;
        case NETFLIX_AUDIO_MESSAGES.CLEANUP_STALE_CLIPS:
          sendSuccess(sendResponse, { deleted: await cleanupStaleClips() });
          break;
        case NETFLIX_AUDIO_MESSAGES.PLAY_CLIP:
          await playClip(String(message.payload?.clipId || ''));
          sendSuccess(sendResponse, { playing: true });
          break;
        case NETFLIX_AUDIO_MESSAGES.CLEAR_CLIPS:
          await clearClips();
          sendSuccess(sendResponse, { cleared: true });
          break;
        default:
          sendResponse({ success: false, error: `Unsupported offscreen audio message: ${message.type}` });
      }
    } catch (error) {
      sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();

  return true;
});
