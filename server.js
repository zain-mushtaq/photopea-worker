const express = require('express');
const puppeteer = require('puppeteer-core');
const { google } = require('googleapis');
const stream = require('stream');
const fs = require('fs');
const app = express();

app.use(express.json({ limit: '50mb' }));

// 1. Google Drive Auth
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

// 2. Initialize Browser
async function initBrowser() {
    if (browser && browser.isConnected()) return browser;

    console.log("Initializing Browser...");
    
    // Use the Docker image's path
    let execPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (!execPath || !fs.existsSync(execPath)) {
        execPath = '/usr/bin/google-chrome-stable'; // Fallback
    }

    console.log(`Launching Chrome from: ${execPath}`);

    browser = await puppeteer.launch({
        executablePath: execPath,
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--single-process',
            '--no-zygote',
            // FAKE A REAL USER AGENT (Crucial for some sites)
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ]
    });
    
    console.log("Browser Launched Successfully!");
    return browser;
}

// 3. Health Check
app.get('/health', async (req, res) => {
    try {
        if (!browser || !browser.isConnected()) await initBrowser();
    } catch (e) {
        console.error("Health Check Launch Error:", e.message);
    }
    
    res.json({ 
        status: 'ok', 
        service: 'Photopea Worker (Docker)', 
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
        
        // --- FIX: REMOVED RESOURCE INTERCEPTION ---
        // (Allowing all assets to load prevents the app from hanging)

        // --- FIX: CHANGED WAIT CONDITION ---
        // 'domcontentloaded' is much faster than 'networkidle0'
        await page.goto('https://www.photopea.com', { 
            waitUntil: 'domcontentloaded', 
            timeout: 120000 
        });

        console.log("Page loaded. Waiting for Photopea App...");

        // Wait for Photopea to initialize (with long timeout)
        await page.waitForFunction(
            () => window.app && typeof window.app.open === 'function', 
            { timeout: 120000 }
        );

        console.log("Photopea ready. Injecting script...");

        let finalImageBuffer = null;
        await page.exposeFunction('sendImageToNode', (base64Data) => {
            finalImageBuffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ""), 'base64');
        });

        // Automate Photopea
        await page.evaluate(async (url, mods) => {
            console.log("Inside Browser: Downloading PSD...");
            
            async function loadBinary(url) {
                const resp = await fetch(url);
                if (!resp.ok) throw new Error("Failed to fetch: " + url);
                return await resp.arrayBuffer();
            }
            
            const psdBuffer = await loadBinary(url);
            console.log("Inside Browser: Opening PSD...");
            await app.open(psdBuffer, "template.psd");
            
            const doc = app.activeDocument;
            console.log("Inside Browser: PSD Opened. Layers: " + doc.layers.length);

            // Helper to find layers
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

            // Modifications
            for (const mod of mods) {
                const layer = findLayer(doc.layers, mod.layerName);
                if (layer) {
                    if (mod.text && layer.kind === LayerKind.TEXT) {
                        layer.textItem.contents = mod.text;
                    } else if (mod.image) {
                        doc.activeLayer = layer;
                        const imgBuffer = await loadBinary(mod.image);
                        await app.open(imgBuffer, "replacement.jpg", true); 
                    }
                }
            }
            
            console.log("Inside Browser: Saving JPG...");
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

        // Wait for render
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
