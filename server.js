const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { google } = require('googleapis');
const stream = require('stream');
const app = express();

app.use(express.json({ limit: '50mb' }));

// 1. Setup Google Drive Auth
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        // Fix newline characters in private key for Railway environment variables
        private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'), 
    },
    scopes: SCOPES,
});
const drive = google.drive({ version: 'v3', auth });

let browser;

async function initBrowser() {
    // Check if browser is already running and connected
    if (browser && browser.isConnected()) return browser;

    console.log("Launching Lightweight Browser...");
    
    // Use @sparticuz/chromium to locate the binary (much faster setup)
    const executablePath = await chromium.executablePath();

    browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: executablePath,
        headless: chromium.headless,
        ignoreHTTPSErrors: true
    });
    
    console.log("Browser Launched!");
    return browser;
}

app.get('/health', async (req, res) => {
    const isConnected = !!(browser && browser.isConnected());
    res.json({ status: 'ok', service: 'Photopea Worker (Lightweight)', browserConnected: isConnected });
});

app.post('/process-psd', async (req, res) => {
    const { psdUrl, modifications } = req.body;
    console.log(`Processing PSD: ${psdUrl}`);
    let page;

    try {
        const b = await initBrowser();
        page = await b.newPage();
        
        // Optimizations
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['font', 'stylesheet', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await page.goto('https://www.photopea.com', { waitUntil: 'networkidle0', timeout: 60000 });
        await page.waitForFunction(() => window.app && typeof window.app.open === 'function');

        let finalImageBuffer = null;
        await page.exposeFunction('sendImageToNode', (base64Data) => {
            finalImageBuffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ""), 'base64');
        });

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

        const startWait = Date.now();
        while (!finalImageBuffer) {
            if (Date.now() - startWait > 45000) throw new Error("Timeout waiting for image render");
            await new Promise(r => setTimeout(r, 500));
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

        // Make file public so n8n can see it
        await drive.permissions.create({
            fileId: file.data.id,
            requestBody: {
                role: 'reader',
                type: 'anyone',
            },
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
