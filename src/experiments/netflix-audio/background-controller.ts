import type { MessageRequest } from '../../types/common';
import {
  NETFLIX_AUDIO_EXPERIMENT_ENABLED,
  NETFLIX_AUDIO_MESSAGES,
  NETFLIX_AUDIO_OFFSCREEN_TARGET,
  isNetflixAudioExperimentMessage,
  isNetflixOrMaxUrl,
  type NetflixAudioCaptureStatus,
  type NetflixAudioExperimentResponse,
} from './protocol';

const OFFSCREEN_DOCUMENT_PATH = 'experiments/netflix-audio/offscreen.html';
let creatingOffscreenDocument: Promise<void> | null = null;

export function isNetflixAudioOffscreenMessage(message: MessageRequest): boolean {
  return message.payload?.target === NETFLIX_AUDIO_OFFSCREEN_TARGET;
}

async function hasOffscreenDocument(): Promise<boolean> {
  const url = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [
        chrome.offscreen.Reason.USER_MEDIA,
        chrome.offscreen.Reason.AUDIO_PLAYBACK,
        chrome.offscreen.Reason.BLOBS,
      ],
      justification: 'Experimental user-initiated Netflix sentence audio recording and playback.',
    }).finally(() => {
      creatingOffscreenDocument = null;
    });
  }
  await creatingOffscreenDocument;
}

async function sendToOffscreen<T>(
  type: string,
  payload: Record<string, unknown> = {},
): Promise<NetflixAudioExperimentResponse<T>> {
  return chrome.runtime.sendMessage({
    type,
    payload: { ...payload, target: NETFLIX_AUDIO_OFFSCREEN_TARGET },
  }) as Promise<NetflixAudioExperimentResponse<T>>;
}

function getTabMediaStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      const error = chrome.runtime.lastError;
      if (error || !streamId) {
        reject(new Error(error?.message || 'Chrome did not provide a tab audio stream.'));
        return;
      }
      resolve(streamId);
    });
  });
}

const inactiveStatus: NetflixAudioCaptureStatus = {
  offscreenReady: false,
  active: false,
  activeForCurrentTab: false,
  capturedTabId: null,
  recording: false,
};

export function handleNetflixAudioExperimentMessage(
  message: MessageRequest,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: NetflixAudioExperimentResponse) => void,
): boolean {
  if (!NETFLIX_AUDIO_EXPERIMENT_ENABLED || !isNetflixAudioExperimentMessage(message.type)) {
    return false;
  }

  void (async () => {
    try {
      if (message.type === NETFLIX_AUDIO_MESSAGES.GET_STATUS) {
        if (!await hasOffscreenDocument()) {
          sendResponse({ success: true, data: inactiveStatus });
          return;
        }
        const response = await sendToOffscreen<NetflixAudioCaptureStatus>(message.type);
        if (response.success && response.data) {
          response.data.activeForCurrentTab = response.data.active &&
            sender.tab?.id !== undefined &&
            response.data.capturedTabId === sender.tab.id;
        }
        sendResponse(response);
        return;
      }

      if (message.type === NETFLIX_AUDIO_MESSAGES.ATTACH_STREAM) {
        const tabId = Number(message.payload?.tabId);
        if (!Number.isInteger(tabId)) throw new Error('Missing captured tab.');
        const tab = await chrome.tabs.get(tabId);
        if (!isNetflixOrMaxUrl(tab.url || '')) {
          throw new Error('Open a Netflix or Max player tab before enabling the audio experiment.');
        }
        await ensureOffscreenDocument();
        const streamId = await getTabMediaStreamId(tabId);
        const response = await sendToOffscreen<NetflixAudioCaptureStatus>(message.type, { tabId, streamId });
        sendResponse(response);
        if (response.success) {
          void chrome.tabs.sendMessage(tabId, {
            type: NETFLIX_AUDIO_MESSAGES.STATUS_CHANGED,
            payload: response.data,
          }).catch(() => undefined);
        }
        return;
      }

      if (message.type === NETFLIX_AUDIO_MESSAGES.STOP_CAPTURE) {
        if (!await hasOffscreenDocument()) {
          sendResponse({ success: true, data: inactiveStatus });
          return;
        }
        const current = await sendToOffscreen<NetflixAudioCaptureStatus>(NETFLIX_AUDIO_MESSAGES.GET_STATUS);
        const response = await sendToOffscreen<NetflixAudioCaptureStatus>(message.type, {
          tabId: message.payload?.tabId,
        });
        sendResponse(response);
        if (current.data?.capturedTabId !== null && current.data?.capturedTabId !== undefined) {
          void chrome.tabs.sendMessage(current.data.capturedTabId, {
            type: NETFLIX_AUDIO_MESSAGES.STATUS_CHANGED,
            payload: response.data,
          }).catch(() => undefined);
        }
        return;
      }

      await ensureOffscreenDocument();
      const requestingTabId = sender.tab?.id;
      if (
        message.type === NETFLIX_AUDIO_MESSAGES.START_RECORDING ||
        message.type === NETFLIX_AUDIO_MESSAGES.STOP_RECORDING ||
        message.type === NETFLIX_AUDIO_MESSAGES.ABORT_RECORDING
      ) {
        if (requestingTabId === undefined) throw new Error('Audio recording must be requested by the player tab.');
      }

      sendResponse(await sendToOffscreen(message.type, {
        ...(message.payload || {}),
        requestingTabId,
      }));
    } catch (error) {
      sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();

  return true;
}

export async function stopNetflixAudioExperimentForTab(tabId: number): Promise<void> {
  if (!NETFLIX_AUDIO_EXPERIMENT_ENABLED || !await hasOffscreenDocument()) return;
  await sendToOffscreen(NETFLIX_AUDIO_MESSAGES.STOP_CAPTURE, { tabId }).catch(() => undefined);
}
