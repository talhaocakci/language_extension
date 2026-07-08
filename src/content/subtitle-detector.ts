import type { SubtitleChunk } from '../types/subtitle';

export class SubtitleDetector {
  static detectSubtitlePlatform(): 'youtube' | 'netflix' | 'generic' | null {
    const url = window.location.href;

    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      return 'youtube';
    } else if (
      url.includes('netflix.com') ||
      url.includes('max.com') ||
      url.includes('hbomax.com')
    ) {
      return 'netflix';
    }

    if (this.hasGenericSubtitles()) {
      return 'generic';
    }

    return null;
  }

  static hasGenericSubtitles(): boolean {
    const selectors = [
      '.subtitle',
      '.subtitles',
      '[role="region"][aria-label*="subtitle"]',
      '.vjs-text-track-cue',
      '.captions',
      '[data-uia="subtitle"]',
      '.ytp-caption-window-container',
      '[data-testid="cueBoxRowTextCue"]',
      '[data-testid="caption_renderer_overlay"]'
    ];

    for (const selector of selectors) {
      if (document.querySelector(selector)) {
        return true;
      }
    }

    const video = document.querySelector('video');
    if (video && video.textTracks && video.textTracks.length > 0) {
      return true;
    }

    return false;
  }

  static getAvailableSubtitles(): SubtitleChunk[] {
    const video = document.querySelector('video') as HTMLVideoElement;
    
    if (!video || !video.textTracks) {
      return [];
    }

    const subtitles: SubtitleChunk[] = [];

    for (let i = 0; i < video.textTracks.length; i++) {
      const track = video.textTracks[i];

      if (track.kind === 'captions' || track.kind === 'subtitles') {
        if (track.cues) {
          for (let j = 0; j < track.cues.length; j++) {
            const cue = track.cues[j] as VTTCue;
            subtitles.push({
              text: cue.text,
              startTime: cue.startTime * 1000,
              endTime: cue.endTime * 1000
            });
          }
        }
      }
    }

    return subtitles;
  }

  static getSubtitleLanguages(): string[] {
    const video = document.querySelector('video') as HTMLVideoElement;
    
    if (!video || !video.textTracks) {
      return [];
    }

    const languages: string[] = [];

    for (let i = 0; i < video.textTracks.length; i++) {
      const track = video.textTracks[i];
      if ((track.kind === 'captions' || track.kind === 'subtitles') && track.label) {
        languages.push(track.label);
      }
    }

    return languages;
  }

  static getVideoElement(): HTMLVideoElement | null {
    return document.querySelector('video');
  }

  static getVideoTitle(): string {
    const url = new URL(window.location.href);

    if (url.hostname.includes('youtube')) {
      const titleElement = document.querySelector('h1.title yt-formatted-string');
      if (titleElement) {
        return titleElement.textContent || 'YouTube Video';
      }
    } else if (url.hostname.includes('netflix')) {
      const titleElement = document.querySelector('[data-uia="preplay-title"]');
      if (titleElement) {
        return titleElement.textContent || 'Netflix Video';
      }
    }

    let title = document.querySelector('title')?.textContent;
    if (!title) {
      const ogTitle = document.querySelector('meta[property="og:title"]');
      title = ogTitle?.getAttribute('content') || undefined;
    }

    return title || 'Unknown Video';
  }

  static watchSubtitleChanges(callback: (subtitles: SubtitleChunk[]) => void): void {
    const checkInterval = setInterval(() => {
      const subtitles = this.getAvailableSubtitles();
      if (subtitles.length > 0) {
        callback(subtitles);
      }
    }, 1000);

    window.addEventListener('beforeunload', () => {
      clearInterval(checkInterval);
    });
  }
}
