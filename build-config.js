#!/usr/bin/env node
/**
 * Build script to generate config.js from environment variables
 * This allows us to use .env files for local development
 * and Render environment variables for production
 */

const fs = require('fs');
const path = require('path');

// Read from .env file if it exists (for local development)
let googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY;

// Try to read from .env file for local development
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath) && !googleMapsApiKey) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  const envLines = envContent.split('\n');
  for (const line of envLines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key.trim() === 'GOOGLE_MAPS_API_KEY') {
        googleMapsApiKey = valueParts.join('=').trim();
        break;
      }
    }
  }
}

// Validate API key
if (!googleMapsApiKey) {
  console.error('ERROR: GOOGLE_MAPS_API_KEY is not set!');
  console.error('Please set it in .env file or as an environment variable.');
  process.exit(1);
}

// Generate config.js
const configContent = `// Auto-generated config file - DO NOT EDIT MANUALLY
// This file is generated from environment variables during build
window.APP_CONFIG = {
  GOOGLE_MAPS_API_KEY: "${googleMapsApiKey}"
};
`;

const configPath = path.join(__dirname, 'static', 'config.js');

// Ensure the static directory exists
const staticDir = path.join(__dirname, 'static');
if (!fs.existsSync(staticDir)) {
  fs.mkdirSync(staticDir, { recursive: true });
}

fs.writeFileSync(configPath, configContent, 'utf8');

console.log('✓ Generated config.js successfully');
console.log('✓ Google Maps API Key configured');
console.log(`✓ Config file written to: ${configPath}`);
console.log(`✓ File exists: ${fs.existsSync(configPath)}`);

