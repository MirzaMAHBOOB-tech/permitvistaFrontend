# Environment Variables Setup Guide

## Overview
This frontend uses environment variables to securely store the Google Maps API key. The API key is loaded from a `.env` file locally and from Render environment variables in production.

## Local Development Setup

### Step 1: Create .env file
1. Copy the example file:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and add your Google Maps API key:
   ```
   GOOGLE_MAPS_API_KEY=your_actual_api_key_here
   ```

### Step 2: Generate config.js
Run the build script to generate `static/config.js`:
```bash
node build-config.js
```

### Step 3: Test locally
Open `index.html` in your browser or use a local server. The Google Maps API should work with your key.

## Render Deployment Setup

### Step 1: Add Environment Variable in Render
1. Go to your Render dashboard
2. Navigate to your **permitvista-frontend** service
3. Go to **Settings** → **Environment**
4. Click **Add Environment Variable**
5. Add:
   - **Key**: `GOOGLE_MAPS_API_KEY`
   - **Value**: Your actual Google Maps API key
6. Click **Save Changes**

### Step 2: Deploy
1. The build command in `render.yaml` will automatically run `node build-config.js`
2. This will generate `static/config.js` with your API key from Render's environment variables
3. Your site will deploy with the API key configured

## How It Works

1. **Local Development**: 
   - `.env` file → `build-config.js` reads it → generates `static/config.js`
   
2. **Production (Render)**:
   - Render Environment Variable → `build-config.js` reads it → generates `static/config.js`

3. **Frontend**:
   - `index.html` loads `static/config.js` first
   - Then uses `window.APP_CONFIG.GOOGLE_MAPS_API_KEY` to load Google Maps

## Security Notes

- ✅ `.env` is in `.gitignore` - your API key won't be committed
- ✅ `static/config.js` is in `.gitignore` - generated file won't be committed
- ✅ Only `.env.example` is committed (without real keys)
- ⚠️ Note: The API key will be visible in the browser's JavaScript (this is normal for frontend API keys)
- ⚠️ Make sure to restrict your Google Maps API key to specific domains in Google Cloud Console

## Troubleshooting

### "Google Maps API Key is not configured!" error
- Check that `.env` file exists and has `GOOGLE_MAPS_API_KEY=...`
- Run `node build-config.js` to regenerate config.js
- Check that `static/config.js` exists and contains your key

### Render deployment fails
- Make sure `GOOGLE_MAPS_API_KEY` is set in Render environment variables
- Check build logs to see if `build-config.js` ran successfully
- Verify Node.js is available in Render (it should be by default)

