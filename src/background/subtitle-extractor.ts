import type { SubtitleChunk } from '../types/subtitle';

export class SubtitleExtractor {
  static extractFromYouTube(videoElement: HTMLVideoElement): SubtitleChunk[] {
    let subtitles: SubtitleChunk[] = [];

    try {
      const textTracks = videoElement.textTracks;
      
      if (textTracks && textTracks.length > 0) {
        console.log(`Found ${textTracks.length} text tracks`);
        
        for (let i = 0; i < textTracks.length; i++) {
          const track = textTracks[i];
          console.log(`Track ${i}: kind=${track.kind}, label=${track.label}, cues=${track.cues?.length || 0}`);
          
          if (track.cues && track.cues.length > 0) {
            for (let j = 0; j < track.cues.length; j++) {
              const cue = track.cues[j] as VTTCue;
              
              if (cue.text && cue.text.trim()) {
                subtitles.push({
                  text: cue.text.replace(/<[^>]*>/g, '').trim(),
                  startTime: cue.startTime * 1000,
                  endTime: cue.endTime * 1000
                });
              }
            }
          }
        }
      }
      
      // If no text tracks found, try to extract from DOM (for auto-generated captions)
      if (subtitles.length === 0) {
        console.log('No text tracks found, trying DOM extraction for auto-captions');
        subtitles = this.extractFromDOM();
      }
      
    } catch (error) {
      console.error('Error extracting YouTube subtitles:', error);
    }

    console.log(`Total subtitles extracted: ${subtitles.length}`);
    return subtitles;
  }

  static extractFromDOM(): SubtitleChunk[] {
    const subtitles: SubtitleChunk[] = [];
    
    try {
      // YouTube auto-captions are in .ytp-caption-segment elements
      const captionSegments = document.querySelectorAll('.ytp-caption-segment');
      
      if (captionSegments.length === 0) {
        console.log('No caption segments found in DOM');
        return subtitles;
      }
      
      console.log(`Found ${captionSegments.length} caption segments`);
      
      // Get video element to track timing
      const video = document.querySelector('video') as HTMLVideoElement;
      
      // Combine consecutive caption segments
      let currentText = '';
      let startTime = 0;
      let lastSegmentIndex = 0;
      
      captionSegments.forEach((segment, index) => {
        const text = segment.textContent?.trim() || '';
        
        if (text) {
          if (!currentText) {
            startTime = video?.currentTime || 0;
          }
          currentText += (currentText ? ' ' : '') + text;
          lastSegmentIndex = index;
        } else if (currentText) {
          // End of caption group
          const endTime = video?.currentTime || startTime + 5;
          subtitles.push({
            text: currentText,
            startTime: startTime * 1000,
            endTime: endTime * 1000
          });
          currentText = '';
        }
      });
      
      // Add the last caption if exists
      if (currentText) {
        const endTime = video?.currentTime || startTime + 5;
        subtitles.push({
          text: currentText,
          startTime: startTime * 1000,
          endTime: endTime * 1000
        });
      }
      
      console.log(`Extracted ${subtitles.length} subtitles from DOM`);
      
    } catch (error) {
      console.error('Error extracting captions from DOM:', error);
    }
    
    return subtitles;
  }

  static extractFromNetflix(): SubtitleChunk[] {
    const subtitles: SubtitleChunk[] = [];

    try {
      const subtitleElements = document.querySelectorAll('[data-uia="subtitle"]');
      let previousEndTime = 0;

      subtitleElements.forEach((element) => {
        const text = element.textContent || '';
        if (text.trim()) {
          const startTime = previousEndTime;
          const duration = 5000;
          const endTime = startTime + duration;

          subtitles.push({
            text: text.trim(),
            startTime,
            endTime
          });

          previousEndTime = endTime;
        }
      });
    } catch (error) {
      console.error('Error extracting Netflix subtitles:', error);
    }

    return subtitles;
  }

  static watchForLiveSubtitles(
    callback: (subtitles: SubtitleChunk[]) => void
  ): MutationObserver | null {
    try {
      const observer = new MutationObserver(() => {
        const subtitles = this.extractFromDOM();
        if (subtitles.length > 0) {
          callback(subtitles);
        }
      });

      const config = {
        childList: true,
        subtree: true,
        characterData: true,
        characterDataOldValue: false
      };

      const targetElements = document.querySelectorAll(
        '.subtitle, .subtitles, [role="region"][aria-label*="subtitle"]'
      );

      if (targetElements.length > 0) {
        targetElements.forEach(element => {
          observer.observe(element, config);
        });
        return observer;
      }

      observer.observe(document.body, config);
      return observer;
    } catch (error) {
      console.error('Error setting up subtitle watcher:', error);
      return null;
    }
  }

  static getCurrentVideoMetadata(): {
    title: string;
    duration: number;
    currentTime: number;
  } | null {
    try {
      const video = document.querySelector('video') as HTMLVideoElement;
      
      if (!video) return null;

      let title = document.title || 'Unknown Video';
      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) {
        title = ogTitle.getAttribute('content') || title;
      }

      return {
        title,
        duration: video.duration,
        currentTime: video.currentTime
      };
    } catch (error) {
      console.error('Error getting video metadata:', error);
      return null;
    }
  }
}
