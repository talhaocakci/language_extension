# Quick Start Guide

Get the extension running in 5 minutes.

## 1. Install & Build (2 minutes)

```bash
cd /Users/talhaocakci/projects/language_extension
npm install
npm run build
```

## 2. Load in Chrome (1 minute)

1. Open `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `dist` folder
5. ✅ Extension loaded!

## 3. Configure LLM (2 minutes)

### Choose Your LLM

**Option A: OpenAI (Recommended)**
- Get API key: https://platform.openai.com/api-keys
- Endpoint: `https://api.openai.com/v1/chat/completions`
- Model: `gpt-4`

**Option B: Free Local (Ollama)**
```bash
# Install Ollama from https://ollama.ai, then:
ollama pull mistral
ollama serve
```
- Endpoint: `http://localhost:11434/api/chat`
- Model: `mistral`

### Set in Extension

1. Click extension icon in Chrome
2. Go to **Settings** tab
3. Enter:
   - **LLM Endpoint**: (from above)
   - **LLM API Key**: (your key)
   - **LLM Model**: (from above)
4. Click **Save Settings** ✅

## 4. Test It (Optional)

1. Go to YouTube: https://www.youtube.com
2. Play any video with captions
3. Look for 📚 button (top right of video)
4. Click to open learning panel
5. Wait for subtitles to load

## 5. Development (Optional)

**Auto-rebuild on changes:**
```bash
npm run dev
```

**Type checking:**
```bash
npm run type-check
```

## Common Issues

| Issue | Solution |
|-------|----------|
| "Extension not loading" | Run `npm run build`, reload in chrome://extensions |
| "Subtitles not working" | Enable captions in video, try a different video |
| "Grammar analysis fails" | Check LLM endpoint and API key in settings |
| "No 📚 button showing" | Reload page, check console (F12) for errors |

## Next Steps

- Read [README.md](README.md) for full features
- Read [SETUP.md](SETUP.md) for detailed setup
- Check [BACKEND_API_EXAMPLE.md](BACKEND_API_EXAMPLE.md) to save your own database

## File Structure

```
dist/                 ← Load this into Chrome
src/
├── background/       ← Core logic
├── content/          ← Scripts injected into pages
├── panel/            ← Side panel UI
├── popup/            ← Settings popup
└── types/            ← TypeScript definitions
```

## Commands

```bash
npm install          # Install dependencies
npm run build        # Build for production
npm run dev          # Build with auto-reload
npm run type-check   # Check TypeScript
```

## Environment Variables (Optional)

Create `.env` file:
```
REACT_APP_LLM_ENDPOINT=https://api.openai.com/v1/chat/completions
REACT_APP_LLM_API_KEY=sk-...
REACT_APP_LLM_MODEL=gpt-4
```

Then rebuild: `npm run build`

---

**That's it!** The extension is ready to use. Start learning from videos! 📚
