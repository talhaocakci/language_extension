# How to Load the Extension in Chrome

The extension has been built and is ready to use. Follow these steps to load it into Chrome.

## Prerequisites

- ✅ Extension built successfully
- ✅ `dist/` folder exists with all compiled files
- ✅ Chrome/Edge browser installed

## Step 1: Open Chrome Extensions Page

1. Open **Chrome** or **Edge**
2. Type this in the address bar: `chrome://extensions/`
3. Press Enter

You should see the Extensions page.

## Step 2: Enable Developer Mode

In the top-right corner of the Extensions page:
- Look for the toggle labeled "Developer mode"
- Click it to turn it **ON** (it should be blue/highlighted)

## Step 3: Load the Extension

Now you should see three new buttons at the top-left:
- "Load unpacked"
- "Pack extension"
- "Update extensions"

Click the **"Load unpacked"** button.

## Step 4: Select the `dist` Folder

A file browser window will open.

Navigate to: `/Users/talhaocakci/projects/language_extension/dist`

Then click the **"Select Folder"** button (or equivalent).

## Step 5: Extension Loaded!

You should see the extension appear in your extensions list:
- **Name**: "Subtitle Learning Extension"
- **Status**: "Enabled"
- **ID**: (auto-generated)

## Verification

To verify it's working:

1. Look at the Chrome toolbar (top-right of Chrome window)
2. You should see the extension icon (puzzle piece)
3. Click it to see the popup menu

If you don't see the icon:
- Click the extensions icon (puzzle pieces) in the toolbar
- Find "Subtitle Learning Extension"
- Click the pin icon to add it to the toolbar

## Step 6: Configure LLM (Important!)

The extension needs an LLM endpoint to function.

### Option A: Use OpenAI (Recommended)

1. Get API key from https://platform.openai.com/api-keys
2. In Chrome, click the extension icon
3. Go to **Settings** tab
4. Fill in:
   - **LLM Endpoint**: `https://api.openai.com/v1/chat/completions`
   - **LLM API Key**: `sk-...` (your OpenAI key)
   - **LLM Model**: `gpt-4` or `gpt-3.5-turbo`
5. Click **Save Settings**

### Option B: Use Ollama (Free, Local)

1. Install Ollama from https://ollama.ai
2. Run: `ollama pull mistral`
3. Run: `ollama serve` (keeps running in terminal)
4. In extension settings:
   - **LLM Endpoint**: `http://localhost:11434/api/chat`
   - **LLM API Key**: (leave empty)
   - **LLM Model**: `mistral`
5. Click **Save Settings**

## Step 7: Test It!

### Test on YouTube

1. Go to https://www.youtube.com
2. Play any video (must have captions enabled)
3. Look for the **📚** button in the video player (top-right corner)
4. Click it to open the learning panel
5. Wait for subtitles to load

### Test on Netflix

1. Go to https://netflix.com
2. Play any show or movie (with subtitles)
3. Look for the **📚 Learn** button in the player controls
4. Click it to open the learning panel

## Troubleshooting

### "Extension icon not visible"
- Click the puzzle pieces icon in Chrome toolbar
- Find "Subtitle Learning Extension"
- Click the pin icon to show it on toolbar

### "No 📚 button on YouTube"
- Reload the page (F5)
- Enable captions on the video
- Check browser console (F12) for errors

### "Subtitles not appearing"
- Captions must be enabled on the video
- Try a different video
- Check if platform supports subtitles

### "Grammar analysis not working"
- Check LLM endpoint is correct
- Verify API key is valid
- Test that endpoint is accessible
- Check browser console for errors

### "Extension won't load"
- Make sure you built it: `npm run build`
- Check that `dist/` folder exists
- Try "Update extensions" button
- Restart Chrome

## Reload Extension During Development

If you make changes and rebuild:

1. Go back to `chrome://extensions/`
2. Find "Subtitle Learning Extension"
3. Click the **reload** button (circular arrow icon)

This will reload the built files.

## What Happens Next

Once loaded:

1. ✅ Extension appears in Chrome extensions list
2. ✅ Extension icon appears in toolbar
3. ✅ You can configure LLM in settings
4. ✅ 📚 button appears on YouTube videos
5. ✅ 📚 Learn button appears on Netflix
6. ✅ You can use the learning panel on videos

## Next Steps

1. ✅ Extension loaded
2. ✅ LLM configured
3. Watch videos and use the learning panel
4. See [README.md](README.md) for all features
5. (Optional) Set up backend API to save materials

## Quick Links

- [README.md](README.md) - Full documentation
- [QUICK_START.md](QUICK_START.md) - Quick setup
- [SETUP.md](SETUP.md) - Detailed setup
- [BACKEND_API_EXAMPLE.md](BACKEND_API_EXAMPLE.md) - Backend setup

## Support

If you run into issues:

1. **Check the console** (F12) for error messages
2. **Verify LLM endpoint** is accessible
3. **Make sure captions are enabled** on the video
4. **Try reloading** the page
5. **Reload the extension** from chrome://extensions/

---

**You're all set!** Enjoy learning from subtitles. 📚
