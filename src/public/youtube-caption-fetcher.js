// Runs in PAGE context. Reads the timedtext baseUrl from the live
// ytInitialPlayerResponse (includes pot + signature already) and
// dispatches it back to the content script via CustomEvent.
// The actual HTTP fetch is done by the background service worker which
// bypasses CORS and cookie restrictions entirely.

(async function () {
  function dispatch(detail) {
    window.dispatchEvent(new CustomEvent('__captionDataFetched', { detail }));
  }

  try {
    const tracks =
      window.ytInitialPlayerResponse
        ?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

    console.log('[caption-fetcher] Caption tracks found:', tracks.length);

    if (tracks.length === 0) {
      dispatch({ error: 'no_caption_tracks' });
      return;
    }

    // Prefer human-authored (kind !== 'asr') over auto-generated
    const track = tracks.find(t => t.kind !== 'asr') || tracks[0];
    console.log('[caption-fetcher] Track:', track.name?.simpleText || track.languageCode,
      '| kind:', track.kind || 'prepared');

    const baseUrl = track.baseUrl;
    if (!baseUrl) {
      dispatch({ error: 'no_base_url' });
      return;
    }

    // Append fmt=json3 unless it's already in the URL
    const timedtextUrl = baseUrl.includes('fmt=')
      ? baseUrl
      : baseUrl + '&fmt=json3';

    console.log('[caption-fetcher] Dispatching timedtext URL to content script...');
    // Dispatch the URL — content script forwards it to the service worker for the actual fetch
    dispatch({ timedtextUrl, source: 'baseUrl' });

  } catch (e) {
    console.log('[caption-fetcher] Error reading ytInitialPlayerResponse:', e);
    dispatch({ error: String(e) });
  }
})();
