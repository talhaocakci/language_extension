import { msToSeconds } from './timestamp-parser';

export interface ResolvedVideoUrl {
  baseUrl: string;
  timestamp?: string;
  fullUrl: string;
}

export function extractYouTubeVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/,
    /youtube\.com\/embed\/([^?]+)/,
    /youtube\.com\/v\/([^?]+)/
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

export function generateYouTubeUrl(videoId: string, startTimeMs?: number): ResolvedVideoUrl {
  const baseUrl = `https://www.youtube.com/watch?v=${videoId}`;
  
  if (startTimeMs !== undefined && startTimeMs > 0) {
    const seconds = msToSeconds(startTimeMs);
    return {
      baseUrl,
      timestamp: `${seconds}s`,
      fullUrl: `${baseUrl}&t=${seconds}s`
    };
  }

  return {
    baseUrl,
    fullUrl: baseUrl
  };
}

export function generateNetflixUrl(
  sessionId: string,
  startTimeMs?: number
): ResolvedVideoUrl {
  const baseUrl = `https://www.netflix.com/watch/${sessionId}`;
  
  if (startTimeMs !== undefined) {
    const seconds = msToSeconds(startTimeMs);
    return {
      baseUrl,
      timestamp: `${seconds}s`,
      fullUrl: baseUrl
    };
  }

  return {
    baseUrl,
    fullUrl: baseUrl
  };
}

export function parseCurrentVideoUrl(url: string): {
  platform: 'youtube' | 'netflix' | 'other';
  videoId?: string;
  sessionId?: string;
} {
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    const videoId = extractYouTubeVideoId(url);
    return {
      platform: 'youtube',
      videoId: videoId || undefined
    };
  } else if (url.includes('netflix.com')) {
    const match = url.match(/\/watch\/(\d+)/);
    const sessionId = match ? match[1] : undefined;
    return {
      platform: 'netflix',
      sessionId
    };
  }

  return {
    platform: 'other'
  };
}

export function generateSourceUrl(
  platform: 'youtube' | 'netflix',
  startTimeMs: number,
  videoId?: string,
  sessionId?: string
): string {
  if (platform === 'youtube' && videoId) {
    return generateYouTubeUrl(videoId, startTimeMs).fullUrl;
  } else if (platform === 'netflix' && sessionId) {
    return generateNetflixUrl(sessionId, startTimeMs).fullUrl;
  }

  return '';
}
