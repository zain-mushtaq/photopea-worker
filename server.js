const express = require('express');
const puppeteer = require('puppeteer-core'); // Keep puppeteer-core
const { google } = require('googleapis');
const stream = require('stream');
const app = express();

app.use(express.json({ limit: '50mb' }));

// ... (Keep your Google Auth code exactly the same) ...

let browser;

async function initBrowser() {
    if (browser && browser.isConnected()) return browser;

    console.log("Launching System Chrome...");
    
    // NIXPACKS installs Chromium at this path usually
    // We search for it, or hardcode the common path
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

    browser = await puppeteer.launch({
        executablePath: executablePath,
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--single-process'
        ]
    });
    
    console.log("Browser Launched!");
    return browser;
}

// ... (Keep the rest of your app.get and app.post code exactly the same) ...
