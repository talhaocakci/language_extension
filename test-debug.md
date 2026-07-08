# Debugging Checklist

## What to Check

1. **Check if popup opens at all**
   - Click extension icon → Does ANY popup appear?
   - Or is it completely blank/stuck?

2. **Check browser console (F12)**
   - Open DevTools: Press F12
   - Go to Console tab
   - Look for red error messages
   - Share any errors you see

3. **Check if 📚 button appears on video**
   - Play a YouTube video
   - Look in video controls (top right)
   - Should appear as 📚 symbol

4. **Check if side panel works**
   - Click the 📚 button
   - Does the right panel open?
   - Does it show any content?

5. **Reload extension**
   - Go to chrome://extensions/
   - Find "Subtitle Learning Extension"
   - Click the reload button (circular arrow)
   - Go back to YouTube
   - Try again

## Common Issues

### Popup won't open
- Extension may have crashed
- Reload from chrome://extensions/

### 📚 button not visible
- Captions must be enabled on video
- Reload the page
- Try a different video

### Side panel blank
- LLM not configured yet
- Go to Settings tab in popup
- Enter API endpoint and key
- Save settings

### Console shows errors
- Share the exact error message
- Will help fix the issue
