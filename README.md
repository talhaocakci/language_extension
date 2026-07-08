# Subtitle Learning Chrome Extension

An advanced Chrome extension that extracts, analyzes, and helps you learn languages from video subtitles on YouTube, Netflix, and other streaming platforms.

## Features

### 1. Automatic Subtitle Extraction
- **YouTube**: Extracts captions directly from video player using Web TextTracks API
- **Netflix**: Captures subtitles from DOM with timing synchronization
- **Generic Support**: Detects subtitles on any platform with standard video elements

### 2. Intelligent Sentence Grouping (Hybrid AI Approach)
- **Heuristic Phase**: Groups subtitles by sentence endings and timing gaps
- **AI Refinement**: Sends grouped text to your LLM for coherent sentence formation
- **Dual-level Access**: 
  - View complete meaningful sentences
  - Click individual sub-portions to jump to specific timestamps

### 3. Grammar & Phrase Analysis
- **Phrasal Verb Detection**: Identifies compound expressions (get up, get off, etc.) as single units
- **Prepositional Phrases**: Highlights phrase structure patterns
- **Word-level Explanations**: Detailed breakdown of difficult vocabulary
- **Difficulty Levels**: Beginner, Intermediate, Advanced classification

### 4. Beautiful Interactive Panel
- **Real-time Subtitle Streaming**: Follows video playback synchronously
- **Color-coded Phrases**: Visual highlighting by type (phrasal verbs, prepositional, compound)
- **Hover Tooltips**: Quick explanations without expanding
- **Expandable Grammar Details**: Full grammatical analysis with examples
- **Professional Design**: Premium typography with Google Fonts (Poppins + Lora)

### 5. Smart Selection & Saving
- **Text Selection**: Select any phrase or word from the panel
- **Context Preservation**: Saves both the phrase and full sentence context
- **Timestamp Precision**: Records phrase timing and full sentence timing
- **API Integration**: Sends saved materials to your backend
- **Local Backup**: Saves in browser storage for offline access

### 6. Audio Clip Extraction (YouTube)
- **Web Audio API**: Captures video audio streams
- **Trimmed Clips**: Saves only the relevant portion with precise timestamps
- **IndexedDB Storage**: Stores audio locally in browser
- **Playback Ready**: Generated blob URLs for immediate playback

### 7. Configuration & Settings
- **Custom LLM Endpoint**: Works with any OpenAI-compatible API (OpenAI, Anthropic, Ollama, etc.)
- **Bearer Token Auth**: Secure API communication
- **Backend API Integration**: Send learning materials to your server
- **User Preferences**: Theme, language, auto-save options

## Installation

### Prerequisites
- Chrome/Chromium browser (version 91+)
- Node.js 16+
- npm

### Setup Steps

1. **Clone or navigate to the project:**
```bash
cd /Users/talhaocakci/projects/language_extension
```

2. **Install dependencies:**
```bash
npm install
```

3. **Build the extension:**
```bash
npm run build
```

4. **Load in Chrome:**
- Open `chrome://extensions/`
- Enable "Developer mode" (top right)
- Click "Load unpacked"
- Select the `dist` folder from this project

5. **Configure Settings:**
- Click the extension icon in Chrome toolbar
- Go to "Settings" tab
- Enter your LLM API endpoint and key
- (Optional) Enter your backend API endpoint
- Click "Save Settings"

## Configuration

### LLM Setup (Required for AI Features)

The extension needs an LLM endpoint for grammar analysis and sentence grouping. Options:

**OpenAI:**
```
Endpoint: https://api.openai.com/v1/chat/completions
Model: gpt-4 or gpt-3.5-turbo
API Key: Your OpenAI API key
```

**Anthropic Claude:**
```
Endpoint: https://api.anthropic.com/v1/messages (if available)
Model: claude-3-opus
API Key: Your Anthropic API key
```

**Ollama (Local LLM):**
```
Endpoint: http://localhost:11434/api/chat
Model: mistral, neural-chat, etc.
API Key: (leave empty if no auth)
```

### Backend API Setup (Optional)

If you want to save learning materials to your own server:

```
API Endpoint: https://your-api.com/api
Bearer Token: Your authentication token
```

Expected POST endpoint: `/learning-materials`

## Usage

### On YouTube:
1. Play any video with subtitles enabled
2. Look for the 📚 button in the video controls (top right)
3. Click it to open the learning panel

### On Netflix:
1. Play any video with subtitles
2. Look for the "📚 Learn" button in the player controls
3. Click to open the learning panel

### In the Panel:
1. **Read Subtitles**: Watch meaningful sentences update as you play
2. **Understand Grammar**: Click "▶ Grammar & Explanation" to expand details
3. **Hover for Quick Help**: Hover over highlighted phrases for instant tooltips
4. **Select & Save**: Click any phrase, then click "💾 Save" when selection appears
5. **Jump to Time**: Click timestamp markers to replay specific sub-portions

## API Payload Structure

When saving a learning material, the extension sends:

```typescript
{
  id: string;                          // UUID
  phrase: string;                      // User-selected text
  meaningfulSentence: string;          // Full context
  grammarAnalysis: {
    sentence: string;
    grammaticalStructure: string;
    phrases: [{
      text: string;
      type: 'phrasal_verb' | 'prepositional' | 'compound' | 'single_word';
      partOfSpeech: string;
      explanation: string;
    }];
    difficulty: 'beginner' | 'intermediate' | 'advanced';
  };
  aiExplanation: string;
  timestamps: {
    phraseStart: number;               // ms
    phraseEnd: number;                 // ms
    sentenceStart: number;             // ms
    sentenceEnd: number;               // ms
  };
  sourceUrl: string;                   // Video URL with timestamp
  platform: 'youtube' | 'netflix';
  videoTitle: string;
  videoUrl: string;
  thumbnailUrl?: string;
  audioClipUrl?: string;               // Browser storage blob URL
  savedAt: ISO8601Timestamp;
}
```

## URL Generation

The extension generates platform-specific URLs for source tracking:

**YouTube:**
```
https://www.youtube.com/watch?v={VIDEO_ID}&t={SECONDS}s
```

**Netflix:**
```
https://www.netflix.com/watch/{SESSION_ID}
(Timestamp stored locally in browser storage)
```

## Development

### Project Structure
```
src/
├── background/          # Service worker & core logic
│   ├── service-worker.ts
│   ├── subtitle-extractor.ts
│   ├── ai-processor.ts
│   └── storage-manager.ts
├── content/            # Content scripts for injecting into pages
│   ├── youtube-injector.ts
│   ├── netflix-injector.ts
│   └── subtitle-detector.ts
├── panel/              # Side panel UI (React)
│   ├── components/
│   ├── index.tsx
│   └── panel.css
├── popup/              # Settings popup
│   ├── index.tsx
│   └── popup.css
├── types/              # TypeScript interfaces
├── utils/              # Utility functions
└── manifest.json       # Extension configuration
```

### Building

**Development (watch mode):**
```bash
npm run dev
```

**Production build:**
```bash
npm run build
```

**Type checking:**
```bash
npm run type-check
```

## Storage

The extension uses three storage mechanisms:

1. **Chrome Storage Sync** (encrypted):
   - User preferences
   - Saved learning materials metadata
   - Syncs across Chrome profile

2. **LocalStorage**:
   - Recent subtitles cache
   - Video metadata cache
   - Session-specific data
   - TTL-based expiration

3. **IndexedDB** (for large files):
   - Full learning materials with AI analysis
   - Audio blob files
   - Offline access

## Browser Compatibility

- **Chrome/Edge**: Version 91+
- **Brave**: 1.26+
- **Opera**: 77+
- **Chromium-based browsers**: Latest versions

## Limitations

### Netflix
- Audio extraction limited due to DRM protection
- Timestamp-based URL navigation not supported (manual navigation only)
- Some content may have subtitle detection delays

### General
- Requires user to configure LLM endpoint
- LLM quality depends on chosen model
- Some platforms may block subtitle access due to CORS/DRM

## Security

- ✓ API keys stored securely in Chrome Storage
- ✓ All LLM communication over HTTPS
- ✓ Content script isolation prevents injection attacks
- ✓ No access to browser history or sensitive data
- ✓ Bearer token authentication for API calls

## Performance

- Subtitle processing: < 1 second (heuristic), < 3 seconds (with AI)
- Grammar analysis: 1-2 seconds per sentence (LLM dependent)
- Audio extraction: Real-time with video playback
- Storage: ~100KB per learning material (without audio)
- Audio clips: 500KB - 2MB per minute depending on quality

## Troubleshooting

**Subtitles not appearing:**
- Ensure subtitles are enabled in the video player
- Reload the page and try again
- Check browser console for errors

**Grammar analysis not working:**
- Verify LLM endpoint is correct and accessible
- Check API key is valid
- Ensure endpoint is reachable from your network
- Check CORS settings if using remote LLM

**Save not working:**
- Verify API endpoint configuration if using backend
- Check browser console for error messages
- Materials are always saved locally regardless of API

**Audio extraction failing (YouTube):**
- Some videos may have audio restrictions
- Ensure video has audio stream
- Check browser permissions for audio

## Future Enhancements

- [ ] Spaced repetition system for learning
- [ ] Pronunciation guide with TTS
- [ ] Quiz generation from saved materials
- [ ] Community phrase sharing
- [ ] Mobile app companion
- [ ] Custom dictionary integration
- [ ] Translation overlay
- [ ] Progress tracking and statistics

## License

MIT License - Feel free to use, modify, and distribute

## Support

For issues, feature requests, or contributions, please create an issue or pull request.

## Credits

Built with:
- React 18
- TypeScript
- Chrome Extension APIs (Manifest V3)
- Web Audio API
- IndexedDB

---

Happy learning! 📚
