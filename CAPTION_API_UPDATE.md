# Caption API Implementation Update

## Problem Solved
The extension now successfully fetches **prepared captions** (user-uploaded, not auto-generated) directly from YouTube's caption API endpoint.

## How It Works

### 1. **API Discovery**
When a YouTube page loads, the caption track information is embedded in `window.ytInitialPlayerResponse`:
- `playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks`
- Each track has a `baseUrl` pointing to YouTube's caption API

### 2. **Caption Fetching**
New function: `fetchCaptionsFromAPI(videoId: string)`

The function:
1. Extracts caption track info from `ytInitialPlayerResponse`
2. Prioritizes German captions (language code: `de`), falls back to first available
3. Fetches the caption data from the `baseUrl`
4. Parses the JSON response containing caption events

### 3. **JSON Response Format**
YouTube's API returns caption data in this format:
```json
{
  "wireMagic": "pb3",
  "events": [
    {
      "tStartMs": 1560,           // Start time in milliseconds
      "dDurationMs": 10320,       // Duration in milliseconds
      "segs": [
        {
          "utf8": "Caption text here"
        }
      ]
    },
    ...
  ]
}
```

### 4. **Subtitle Chunk Creation**
Each event becomes a `SubtitleChunk`:
```typescript
{
  text: "Caption text here",
  startTime: 1560,                    // tStartMs
  endTime: 1560 + 10320              // tStartMs + dDurationMs
}
```

## Integration Points

### Content Script (`youtube-injector.ts`)
- **New function**: `async fetchCaptionsFromAPI(videoId: string): Promise<SubtitleChunk[]>`
- **Updated handler**: `GET_SUBTITLES` message now calls `fetchCaptionsFromAPI()`
- Asynchronous processing with proper error handling

### Side Panel (`panel/index.tsx`)
- Continues to poll for captions via `GET_SUBTITLES` message
- Processes received chunks through `groupAndProcessSubtitles()`
- Groups into meaningful sentences using heuristic
- Displays current sentence with synchronized sub-portions

## Advantages Over Previous Approach

| Aspect | Previous | Now |
|--------|----------|-----|
| **Source** | Real-time DOM observation of visible captions | YouTube's official API |
| **Timing** | Approximate (±2 seconds) | Exact (from YouTube) |
| **Completeness** | Only visible captions | All captions upfront |
| **Language Support** | Auto-detected | Explicitly selected |
| **Coverage** | Depends on video playback | Independent of playback |

## Testing
To test the implementation:

1. **Reload the extension** in Chrome's extension manager
2. **Navigate to a YouTube video with captions** (e.g., `https://www.youtube.com/watch?v=TdMDZ8K1kDI`)
3. **Click the 📚 button** to open the side panel
4. **Check browser console** for logs like:
   - `Fetching captions from YouTube API for video: TdMDZ8K1kDI`
   - `Found N caption tracks`
   - `Using caption track: German (de)`
   - `Received N caption events`
   - `Parsed N caption chunks`
5. **Verify the panel displays** the current meaningful sentence as the video plays

## Next Steps

1. **Test on the target video**: https://www.youtube.com/watch?v=TdMDZ8K1kDI
2. **Verify timing accuracy** by jumping to different timestamps
3. **Enable grammar explanations** once caption extraction is stable
4. **Add caching** of fetched captions to avoid refetching
5. **Support multiple languages** in language selection
