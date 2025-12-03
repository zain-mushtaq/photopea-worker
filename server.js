const express = require('express');
const puppeteer = require('puppeteer-core');
const { google } = require('googleapis');
const stream = require('stream');
const fs = require('fs');
const app = express();

app.use(express.json({ limit: '50mb' }));

// 1. Google Auth
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: SCOPES,
});
const drive = google.drive({ version: 'v3', auth });

let browser;

// 2. Initialize Browser (Optimized for Low RAM)
async function initBrowser() {
    if (browser && browser.isConnected()) return browser;

    console.log("Initializing Browser...");
    
    // 1. Try the Environment Variable first (Set by Docker Image)
    let execPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    
    // 2. If missing, try standard locations
    if (!execPath || !fs.existsSync(execPath)) {
        execPath = '/usr/bin/google-chrome-stable';
    }

    console.log(`Launching Chrome from: ${execPath}`);

    browser = await puppeteer.launch({
        executablePath: execPath,
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Important for Docker/Railway
            '--single-process', // Saves RAM
            '--no-zygote',
            '--disable-gl-drawing-for-tests', // Disable GPU things
            '--mute-audio',
            '--window-size=800,600', // Small window saves RAM
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ]
    });
    
    console.log("Browser Launched Successfully!");
    return browser;
}

// 3. Health Check
app.get('/health', async (req, res) => {
    try { if (!browser || !browser.isConnected()) await initBrowser(); } catch(e) { console.error(e); }
    res.json({ 
        status: 'ok', 
        service: 'Photopea Worker (Optimized)', 
        browserConnected: !!(browser && browser.isConnected()) 
    });
});

// 4. Process PSD
app.post('/process-psd', async (req, res) => {
    const { psdUrl, modifications } = req.body;
    console.log(`Processing PSD: ${psdUrl}`);
    let page;

    try {
        const b = await initBrowser();
        page = await b.newPage();
        
        // --- AGGRESSIVE RESOURCE BLOCKING (SPEED FIX) ---
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            const url = req.url();
            
            // Block heavy assets and ads to save memory/CPU
            if (
                ['image', 'media', 'font', 'stylesheet'].includes(type) || 
                url.includes('googleads') || 
                url.includes('doubleclick') || 
                url.includes('googlesyndication') ||
                url.includes('facebook') ||
                url.includes('analytics')
            ) {
                req.abort();
            } else {
                req.continue();
            }
        });

        console.log("Navigating to Photopea...");
        
        // Load Photopea (Fast Wait)
        await page.goto('https://www.photopea.com', { 
            waitUntil: 'domcontentloaded', 
            timeout: 60000 // 60s is usually enough for DOM
        });

        console.log("Page loaded. Waiting for App Init...");

        // Wait for the global 'app' object to exist
        await page.waitForFunction(() => window.app, { timeout: 60000 });

        console.log("Photopea App Object Found. Injecting script...");

        let finalImageBuffer = null;
        await page.exposeFunction('sendImageToNode', (base64Data) => {
            finalImageBuffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ""), 'base64');
        });

        // --- AUTOMATION SCRIPT ---
        await page.evaluate(async (url, mods) => {
            console.log("Browser: Downloading PSD...");
            
            async function loadBinary(url) {
                const resp = await fetch(url);
                if (!resp.ok) throw new Error("Failed to fetch: " + url);
                return await resp.arrayBuffer();
            }
            
            const psdBuffer = await loadBinary(url);
            console.log("Browser: Opening PSD...");
            
            // Open the file
            await window.app.open(psdBuffer, "template.psd");
            
            const doc = window.app.activeDocument;
            console.log("Browser: PSD Opened. Layers: " + doc.layers.length);

            // Helper: Recursive Layer Finder
            function findLayer(layers, name) {
                if(!layers) return null;
                for (let i = 0; i < layers.length; i++) {
                    if (layers[i].name === name) return layers[i];
                    if (layers[i].layers) {
                        const found = findLayer(layers[i].layers, name);
                        if (found) return found;
                    }
                }
                return null;
            }

            // Apply Mods
            for (const mod of mods) {
                const layer = findLayer(doc.layers, mod.layerName);
                if (layer) {
                    if (mod.text && layer.kind === LayerKind.TEXT) {
                        layer.textItem.contents = mod.text;
                    } else if (mod.image) {
                        doc.activeLayer = layer;
                        const imgBuffer = await loadBinary(mod.image);
                        await window.app.open(imgBuffer, "replacement.jpg", true); 
                    }
                }
            }
            
            console.log("Browser: Saving JPG...");
            const arrayBuffer = await doc.saveToOE("jpg"); 
            
            // Send back to Node
            const blob = new Blob([arrayBuffer]);
            const reader = new FileReader();
            return new Promise((resolve) => {
                reader.onloadend = () => {
                    window.sendImageToNode(reader.result);
                    resolve();
                };
                reader.readAsDataURL(blob);
            });
        }, psdUrl, modifications);

        // Wait for render response
        const startWait = Date.now();
        while (!finalImageBuffer) {
            if (Date.now() - startWait > 120000) throw new Error("Timeout waiting for image render");
            await new Promise(r => setTimeout(r, 1000));
        }

        console.log("Image rendered. Uploading to Google Drive...");

        const bufferStream = new stream.PassThrough();
        bufferStream.end(finalImageBuffer);

        const fileMetadata = {
            name: `generated_${Date.now()}.jpg`,
            parents: [process.env.GOOGLE_DRIVE_FOLDER_ID]
        };
        
        const media = {
            mimeType: 'image/jpeg',
            body: bufferStream
        };

        const file = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, webViewLink, webContentLink'
        });

        await drive.permissions.create({
            fileId: file.data.id,
            requestBody: { role: 'reader', type: 'anyone' },
        });

        console.log("Done! File ID:", file.data.id);
        res.json({ success: true, url: file.data.webViewLink, downloadUrl: file.data.webContentLink });

    } catch (e) {
        console.error("Error:", e);
        res.status(500).json({ success: false, error: e.message });
    } finally {
        if (page) await page.close();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker listening on port ${PORT}`));
