# Setup Guide - Subtitle Learning Chrome Extension

This guide will walk you through setting up the extension from scratch.

## Prerequisites

- **Chrome/Chromium** version 91 or higher
- **Node.js** version 16 or higher
- **npm** (comes with Node.js)
- A **text editor** (VS Code recommended)
- An **LLM API key** (OpenAI, Anthropic, Ollama, etc.)

## Step 1: Initial Setup

### 1.1 Install Dependencies

```bash
cd /Users/talhaocakci/projects/language_extension
npm install
```

This installs:
- React 18
- TypeScript
- Webpack build tools
- Chrome Extension types

### 1.2 Build the Extension

```bash
npm run build
```

Output files will be created in the `dist/` directory.

**For development with auto-rebuild:**
```bash
npm run dev
```

## Step 2: Load Extension into Chrome

### 2.1 Open Chrome Extensions Page

1. Open Chrome
2. Go to `chrome://extensions/` in the address bar
3. Enable "Developer mode" toggle in the top right

### 2.2 Load the Extension

1. Click "Load unpacked" button
2. Navigate to and select the `dist` folder from this project
3. The extension should appear in your Chrome toolbar

## Step 3: Configure LLM (Required)

The extension needs an LLM endpoint for grammar analysis. Choose one:

### Option A: OpenAI (Recommended for Production)

1. Create OpenAI account at https://platform.openai.com
2. Go to API keys: https://platform.openai.com/api-keys
3. Create a new API key
4. In Chrome, click extension icon → Settings
5. Fill in:
   - **LLM Endpoint**: `https://api.openai.com/v1/chat/completions`
   - **LLM API Key**: Your OpenAI API key
   - **LLM Model**: `gpt-4` or `gpt-3.5-turbo`
6. Click "Save Settings"

**Cost:** ~$0.10-$0.50 per 1000 sentences analyzed

### Option B: Anthropic Claude (Alternative)

1. Sign up at https://claude.ai
2. Get API access at https://console.anthropic.com
3. Create an API key
4. In Chrome extension settings:
   - **LLM Endpoint**: `https://api.anthropic.com/v1/messages`
   - **LLM API Key**: Your Anthropic API key
   - **LLM Model**: `claude-3-opus-20240229`

### Option C: Ollama (Free, Local)

Best for privacy and no API costs.

#### Installation:

1. Download Ollama: https://ollama.ai
2. Install and run Ollama
3. In terminal:
   ```bash
   ollama pull mistral
   ollama serve
   ```
   (Runs on http://localhost:11434)

4. In Chrome extension settings:
   - **LLM Endpoint**: `http://localhost:11434/api/chat`
   - **LLM API Key**: (leave empty)
   - **LLM Model**: `mistral`

**Cost:** Free, runs on your computer

### Option D: LocalAI (Alternative Local Option)

1. Install LocalAI: https://localai.io/
2. Configure according to their docs
3. Set endpoint to your LocalAI server URL

## Step 4: (Optional) Configure Backend API

If you want to save learning materials to your own server:

### 4.1 Create API Endpoints

Your backend should implement:

```
POST /learning-materials
  Body: SavedLearningMaterial
  Returns: { id: string }

GET /learning-materials/:id
  Returns: SavedLearningMaterial

DELETE /learning-materials/:id
  Returns: { success: boolean }

PATCH /learning-materials/:id
  Body: Partial<SavedLearningMaterial>
  Returns: SavedLearningMaterial
```

See [README.md](README.md#api-payload-structure) for payload details.

### 4.2 Configure in Extension

1. Click extension icon → Settings
2. Fill in:
   - **API Endpoint**: `https://your-api.com/api`
   - **API Token**: Your bearer token
3. Click "Save Settings"

**Note:** If not configured, materials are still saved locally in browser.

## Step 5: Test the Extension

### Test on YouTube:

1. Go to https://www.youtube.com
2. Play any video with captions enabled
3. Look for 📚 button in video controls (top right)
4. Click it to open the learning panel
5. Wait for subtitles to load and process

### Test on Netflix:

1. Go to https://www.netflix.com
2. Play any movie/show with subtitles
3. Look for "📚 Learn" button in player controls
4. Click to open the learning panel

### If Not Working:

**Check browser console for errors:**
1. Press `F12` to open developer tools
2. Go to Console tab
3. Look for red error messages
4. Common issues:
   - "LLM not configured" → Set up LLM in extension settings
   - "Content script error" → Reload the page
   - "CORS error" → Check LLM endpoint is accessible

## Step 6: Development Workflow

### Making Changes:

1. Edit TypeScript files in `src/`
2. Run `npm run dev` (auto-rebuilds on changes)
3. Reload extension in Chrome:
   - Go to chrome://extensions
   - Find "Subtitle Learning Extension"
   - Click reload icon ⟳
4. Refresh the video page to see changes

### Type Checking:

```bash
npm run type-check
```

### Build for Production:

```bash
npm run build
```

## Step 7: Production Deployment

When ready to share:

1. Build the extension:
   ```bash
   npm run build
   ```

2. Package for distribution:
   - Zip the `dist/` folder
   - Upload to Chrome Web Store or share directly

3. For Chrome Web Store listing:
   - Create developer account at https://chrome.google.com/webstore/
   - Upload the extension
   - Add screenshots and description
   - Set privacy policy (if collecting data)

## Configuration Files

### manifest.json
- Extension metadata
- Permissions
- Content script configuration
- Update this only if adding new features/permissions

### webpack.config.js
- Build configuration
- Entry points and output paths
- Usually doesn't need changes

### tsconfig.json
- TypeScript compilation settings
- Module resolution
- Library targets

## File Structure Quick Reference

```
dist/                       # Built extension (don't edit)
src/
├── background/              # Service worker logic
├── content/                 # Scripts injected into pages
├── panel/                   # Side panel UI
├── popup/                   # Settings popup
├── types/                   # TypeScript interfaces
├── utils/                   # Utility functions
└── manifest.json            # Extension config

config/                     # Example configs
public/                     # Icons and assets
```

## Troubleshooting

### "Subtitles not appearing"
- Subtitles must be enabled in video player
- Not all videos have captions
- Try a different video to test

### "Grammar analysis not working"
- Check LLM endpoint is correct
- Verify API key is valid
- Test endpoint in Postman or curl
- Check browser console for errors

### "Extension not loading"
- Run `npm run build` to rebuild
- Reload extension in chrome://extensions
- Clear cache: Settings → Clear browsing data

### "CORS errors"
- If using local LLM, ensure it accepts cross-origin requests
- For remote APIs, they should handle CORS
- If building your own API, add CORS headers

### "Extension crashes"
- Check browser console (F12)
- Look for JavaScript errors
- Reload the page
- Restart Chrome if needed

## Performance Tips

### For Faster Processing:

1. **Use a faster LLM model:**
   - `gpt-3.5-turbo` (faster, cheaper)
   - Smaller local models (mistral 7B)

2. **Disable AI features temporarily:**
   - Heuristic-only grouping is instant
   - Grammar analysis is optional

3. **Close other extensions:**
   - Reduces Chrome memory usage
   - Faster overall performance

### For Better Accuracy:

1. **Use a larger/better model:**
   - GPT-4 (best but slower)
   - Claude 3 Opus (very good)

2. **Use English language videos:**
   - Trained models work best with English
   - Other languages work but accuracy varies

## Getting Help

1. **Check the README.md** for feature details
2. **Enable Developer Mode** for debugging (F12)
3. **Review config examples** in `config/` folder
4. **Check type definitions** in `src/types/` for API structure

## Next Steps

1. ✅ Setup complete
2. Test on a YouTube video
3. Save your first learning material
4. Explore the grammar analysis features
5. (Optional) Set up your own backend API
6. (Optional) Integrate with your learning management system

---

Happy language learning! 📚
