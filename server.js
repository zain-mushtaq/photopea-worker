const express = require('express');
const puppeteer = require('puppeteer-core');
const { google } = require('googleapis');
const stream = require('stream');
const fs = require('fs');
const app = express();

// Allow large payloads (for big PSD JSON data if needed)
app.use(express.json({ limit: '50mb' }));

// 1. Google Drive Auth
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        // Handle private key newlines correctly
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
    
    // 1. Try the Environment Variable first (Set by Docker Image)
    let execPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    
    // 2. If missing, try standard locations
    if (!execPath || !fs.existsSync(execPath)) {
        const possiblePaths = [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser'
        ];
        execPath = possiblePaths.find(path => fs.existsSync(path));
    }

    if (!execPath) {
        throw new Error("CRITICAL: Could not find Google Chrome executable. Please check Dockerfile.");
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
            '--no-zygote'
        ]
    });
    
    console.log("Browser Launched Successfully!");
    return browser;
}

// 3. Health Check
app.get('/health', async (req, res) => {
    try {
        // Try to launch if not ready
        if (!browser || !browser.isConnected()) await initBrowser();
    } catch (e) {
        console.error("Health Check Launch Error:", e.message);
    }
    
    res.json({ 
        status: 'ok', 
        service: 'Photopea Worker', 
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
        
        // Speed Optimization: Block fonts/images/css
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['font', 'stylesheet', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        // Go to Photopea (Increased Timeout to 2 mins)
        await page.goto('https://www.photopea.com', { 
            waitUntil: 'networkidle0', 
            timeout: 120000 
        });

        // Wait for App Ready (Increased Timeout)
        await page.waitForFunction(
            () => window.app && typeof window.app.open === 'function', 
            { timeout: 120000 }
        );

        let finalImageBuffer = null;
        await page.exposeFunction('sendImageToNode', (base64Data) => {
            finalImageBuffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ""), 'base64');
        });

        // Inject Script
        await page.evaluate(async (url, mods) => {
            async function loadBinary(url) {
                const resp = await fetch(url);
                return await resp.arrayBuffer();
            }
            const psdBuffer = await loadBinary(url);
            await app.open(psdBuffer, "template.psd");
            const doc = app.activeDocument;

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
                    if (mod.text && layer.kind === LayerKind.TEXT) {
                        layer.textItem.contents = mod.text;
                    } else if (mod.image) {
                        doc.activeLayer = layer;
                        const imgBuffer = await loadBinary(mod.image);
                        await app.open(imgBuffer, "replacement.jpg", true); 
                    }
                }
            }
            
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

        // Wait for Render (Increased Timeout to 2 mins)
        const startWait = Date.now();
        while (!finalImageBuffer) {
            if (Date.now() - startWait > 120000) throw new Error("Timeout waiting for image render");
            await new Promise(r => setTimeout(r, 500));
        }

        console.log("Image rendered. Uploading to Google Drive...");

        // Upload to Google Drive
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

        // Make Public
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

// Start Server (Using ENV Port)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker listening on port ${PORT}`));
