import {
  NETFLIX_AUDIO_MESSAGES,
  isNetflixOrMaxUrl,
  type NetflixAudioCaptureStatus,
  type NetflixAudioExperimentResponse,
} from './protocol';

async function getActivePlayerTab(): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id || !isNetflixOrMaxUrl(tab.url || '')) {
    throw new Error('Open a Netflix or Max player tab first.');
  }
  return tab;
}

export async function getNetflixAudioExperimentStatus(): Promise<NetflixAudioCaptureStatus> {
  const response = await chrome.runtime.sendMessage({
    type: NETFLIX_AUDIO_MESSAGES.GET_STATUS,
  }) as NetflixAudioExperimentResponse<NetflixAudioCaptureStatus>;
  if (!response?.success || !response.data) {
    throw new Error(response?.error || 'Could not read audio experiment status.');
  }
  return response.data;
}

export async function startNetflixAudioExperiment(): Promise<NetflixAudioCaptureStatus> {
  const tab = await getActivePlayerTab();
  const response = await chrome.runtime.sendMessage({
    type: NETFLIX_AUDIO_MESSAGES.ATTACH_STREAM,
    payload: { tabId: tab.id },
  }) as NetflixAudioExperimentResponse<NetflixAudioCaptureStatus>;
  if (!response?.success || !response.data) {
    throw new Error(response?.error || 'Could not start tab audio capture.');
  }
  return response.data;
}

export async function stopNetflixAudioExperiment(): Promise<NetflixAudioCaptureStatus> {
  const response = await chrome.runtime.sendMessage({
    type: NETFLIX_AUDIO_MESSAGES.STOP_CAPTURE,
  }) as NetflixAudioExperimentResponse<NetflixAudioCaptureStatus>;
  if (!response?.success || !response.data) {
    throw new Error(response?.error || 'Could not stop tab audio capture.');
  }
  return response.data;
}

export async function clearNetflixAudioExperimentClips(): Promise<void> {
  const response = await chrome.runtime.sendMessage({
    type: NETFLIX_AUDIO_MESSAGES.CLEAR_CLIPS,
  }) as NetflixAudioExperimentResponse;
  if (!response?.success) throw new Error(response?.error || 'Could not clear local audio clips.');
}
