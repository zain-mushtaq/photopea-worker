const express = require('express');
const puppeteer = require('puppeteer-core');
const { google } = require('googleapis');
const stream = require('stream');
const fs = require('fs');
const app = express();

app.use(express.json({ limit: '50mb' }));

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

async function initBrowser() {
    if (browser && browser.isConnected()) return browser;

    console.log("Initializing Browser...");
    const execPath = '/usr/bin/google-chrome-stable';

    browser = await puppeteer.launch({
        executablePath: execPath,
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--single-process',
            '--no-zygote',
            '--window-size=1280,720',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ]
    });
    
    console.log("Browser Launched!");
    return browser;
}

app.get('/health', async (req, res) => {
    res.json({ status: 'ok', service: 'Photopea Worker', browserConnected: !!(browser && browser.isConnected()) });
});

app.post('/process-psd', async (req, res) => {
    const { psdUrl, modifications } = req.body;
    console.log(`Processing PSD: ${psdUrl}`);
    let page;

    try {
        const b = await initBrowser();
        page = await b.newPage();

        // 1. ENABLE CONSOLE LOGGING (So we can see errors!)
        page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
        page.on('pageerror', err => console.log('BROWSER ERROR:', err.toString()));

        // 2. RELAXED BLOCKING (Only block Ads, NOT Scripts)
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const url = req.url();
            const type = req.resourceType();
            
            // Block explicit ad domains only
            if (
                url.includes('googleads') || 
                url.includes('doubleclick') || 
                url.includes('googlesyndication') ||
                url.includes('facebook.net') ||
                url.includes('analytics') || 
                type === 'media' // Block videos
            ) {
                req.abort();
            } else {
                req.continue(); // Allow everything else (CSS/Fonts/Scripts)
            }
        });

        console.log("Navigating to Photopea...");
        
        // 3. Wait for Load (Increased Timeout)
        await page.goto('https://www.photopea.com', { 
            waitUntil: 'domcontentloaded', 
            timeout: 90000 
        });

        console.log("Page loaded. Checking for App...");

        // 4. Wait for Photopea Object
        try {
            await page.waitForFunction(() => window.app, { timeout: 60000 });
            console.log("Photopea App Ready!");
        } catch (err) {
            console.error("Photopea failed to init. Dumping page title...");
            const title = await page.title();
            throw new Error(`Photopea did not load. Page Title: ${title}`);
        }

        let finalImageBuffer = null;
        await page.exposeFunction('sendImageToNode', (base64Data) => {
            finalImageBuffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ""), 'base64');
        });

        // 5. Run Automation
        await page.evaluate(async (url, mods) => {
            console.log("Browser: Starting automation...");
            
            async function loadBinary(url) {
                try {
                    const resp = await fetch(url);
                    if (!resp.ok) throw new Error("Fetch failed: " + resp.statusText);
                    return await resp.arrayBuffer();
                } catch (e) {
                    console.error("Download Error:", e);
                    throw e;
                }
            }
            
            const psdBuffer = await loadBinary(url);
            console.log("Browser: Opening PSD (" + psdBuffer.byteLength + " bytes)...");
            
            await window.app.open(psdBuffer, "template.psd");
            const doc = window.app.activeDocument;
            
            if (!doc) throw new Error("Document failed to open in Photopea");

            console.log("Browser: PSD Opened. Processing Layers...");

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

            for (const mod of mods) {
                const layer = findLayer(doc.layers, mod.layerName);
                if (layer) {
                    console.log("Found layer: " + mod.layerName);
                    if (mod.text && layer.kind === LayerKind.TEXT) {
                        layer.textItem.contents = mod.text;
                    } else if (mod.image) {
                        doc.activeLayer = layer;
                        const imgBuffer = await loadBinary(mod.image);
                        await window.app.open(imgBuffer, "replacement.jpg", true); 
                    }
                } else {
                    console.warn("Layer not found: " + mod.layerName);
                }
            }
            
            console.log("Browser: Saving Output...");
            const arrayBuffer = await doc.saveToOE("jpg"); 
            
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
