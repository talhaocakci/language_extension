import {
  NETFLIX_AUDIO_MESSAGES,
  isNetflixOrMaxUrl,
  type NetflixAudioCaptureStatus,
  type NetflixAudioExperimentResponse,
} from './protocol';

async function getActivePlayerTab(): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  let tab: chrome.tabs.Tab | undefined = tabs[0];
  if (!tab?.id || !isNetflixOrMaxUrl(tab.url || '')) {
    const stored = await chrome.storage.session.get('sentence_audio_setup_tab_id');
    const storedId = Number(stored.sentence_audio_setup_tab_id);
    if (Number.isInteger(storedId)) {
      tab = await chrome.tabs.get(storedId).catch(() => undefined);
    }
  }
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
  const playerTab = await getActivePlayerTab().catch(() => null);
  return {
    ...response.data,
    activeForCurrentTab: response.data.active && response.data.capturedTabId === playerTab?.id,
  };
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
  await chrome.storage.session.remove('sentence_audio_setup_tab_id');
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
