# Netflix sentence-audio experiment

This folder is intentionally self-contained. The experiment records the active
Netflix/Max tab audio while replaying one subtitle interval and stores the Blob
only in the extension's local IndexedDB database
`GetFluentFastNetflixAudioExperiment`.

It does **not** modify saved phrases, call the backend, upload media, or use the
legacy `src/utils/audio-extractor.ts` prototype.

## Manual test

1. Reload the unpacked extension after building it.
2. Open a Netflix or Max player tab with audible dialogue.
3. Open the extension popup and choose **Enable for active tab** in the
   experimental audio card.
4. On the learning subtitle overlay, click **🎙 Audio**. The player briefly
   replays the subtitle and restores the previous playback position.
5. Click **▶ Clip** to play the locally recorded result.
6. Stop tab capture or delete all local clips from the popup.

## Removal boundary

1. Delete `src/experiments/netflix-audio/`.
2. Remove the marked imports/UI block from `src/content/netflix-injector.ts`,
   `src/popup/index.tsx`, and `src/popup/popup.css`.
3. Remove the audio-controller import/hook from
   `src/background/service-worker.ts`.
4. Remove the offscreen entry/copy rule from `webpack.config.js`.
5. Remove `offscreen`, `tabCapture`, and `minimum_chrome_version` from
   `manifest.json`.

The local experiment database can be removed by clicking **Delete local clips**
before uninstalling the experiment.
