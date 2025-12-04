const express = require('express');
const puppeteer = require('puppeteer-core');
const { google } = require('googleapis');
const stream = require('stream');
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

// DON'T keep a global browser - create fresh for each request
async function createBrowser() {
    console.log("Creating fresh browser instance...");
    
    const browser = await puppeteer.launch({
        executablePath: '/usr/bin/google-chrome-stable',
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process',
            '--no-zygote',
            '--disable-software-rasterizer',
            '--disable-dev-tools',
            '--no-first-run',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-extensions',
            '--disable-sync',
            '--disable-translate',
            '--metrics-recording-only',
            '--mute-audio',
            '--no-default-browser-check',
            '--safebrowsing-disable-auto-update',
            '--window-size=1920,1080'
        ],
        timeout: 60000
    });
    
    console.log("Browser created successfully!");
    return browser;
}

app.get('/health', async (req, res) => {
    res.json({ 
        status: 'ok', 
        service: 'Photopea Worker',
        note: 'Browser created on-demand per request'
    });
});

app.post('/process-psd', async (req, res) => {
    const { psdUrl, modifications } = req.body;
    console.log(`\n=== New Request ===`);
    console.log(`Processing PSD: ${psdUrl}`);
    
    let browser;
    let page;

    try {
        // Create fresh browser for THIS request only
        browser = await createBrowser();
        page = await browser.newPage();
        
        // Set longer timeouts
        page.setDefaultTimeout(120000);

        // Console logging
        page.on('console', msg => console.log('BROWSER:', msg.text()));
        page.on('pageerror', err => console.log('PAGE ERROR:', err.toString()));

        console.log("Navigating to Photopea...");
        
        await page.goto('https://www.photopea.com/', { 
            waitUntil: 'networkidle2',
            timeout: 120000 
        });

        console.log("Waiting for Photopea to initialize...");

        // Wait for app object
        await page.waitForFunction(
            () => typeof window.app !== 'undefined',
            { timeout: 90000 }
        );
        
        console.log("Photopea Ready!");
        await page.waitForTimeout(2000);

        // Setup data transfer
        let finalImageBuffer = null;
        await page.exposeFunction('sendImageToNode', (base64Data) => {
            finalImageBuffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ""), 'base64');
        });

        // Execute automation
        await page.evaluate(async (url, mods) => {
            console.log("Starting PSD processing...");
            
            async function loadBinary(url) {
                const resp = await fetch(url);
                if (!resp.ok) throw new Error("Fetch failed: " + resp.statusText);
                return await resp.arrayBuffer();
            }
            
            console.log("Downloading PSD...");
            const psdBuffer = await loadBinary(url);
            
            console.log("Opening PSD...");
            await window.app.open(psdBuffer, "template.psd");
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            const doc = window.app.activeDocument;
            if (!doc) throw new Error("No active document found");

            console.log("PSD Opened. Layers:", doc.layers.length);

            function findLayer(layers, targetName) {
                if (!layers) return null;
                for (let i = 0; i < layers.length; i++) {
                    if (layers[i].name === targetName) return layers[i];
                    if (layers[i].layers) {
                        const found = findLayer(layers[i].layers, targetName);
                        if (found) return found;
                    }
                }
                return null;
            }

            // Apply modifications
            for (const mod of mods) {
                console.log("Processing layer:", mod.layerName);
                const layer = findLayer(doc.layers, mod.layerName);
                
                if (layer) {
                    if (mod.text && layer.kind === "TEXT") {
                        console.log("Updating text...");
                        layer.textItem.contents = mod.text;
                    } else if (mod.image) {
                        console.log("Replacing image...");
                        doc.activeLayer = layer;
                        const imgBuffer = await loadBinary(mod.image);
                        await window.app.open(imgBuffer, "replacement.jpg", true);
                    }
                } else {
                    console.warn("Layer not found:", mod.layerName);
                }
            }
            
            console.log("Exporting JPG...");
            const jpgBuffer = await doc.saveToOE("jpg");
            
            const blob = new Blob([jpgBuffer]);
            const reader = new FileReader();
            return new Promise((resolve) => {
                reader.onloadend = () => {
                    window.sendImageToNode(reader.result);
                    resolve();
                };
                reader.readAsDataURL(blob);
            });
        }, psdUrl, modifications);

        // Wait for result
        console.log("Waiting for render...");
        const startWait = Date.now();
        while (!finalImageBuffer) {
            if (Date.now() - startWait > 120000) {
                throw new Error("Timeout waiting for image");
            }
            await new Promise(r => setTimeout(r, 1000));
        }

        console.log("Image rendered:", finalImageBuffer.length, "bytes");
        console.log("Uploading to Drive...");

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

        console.log("Success! File ID:", file.data.id);
        
        res.json({ 
            success: true, 
            fileId: file.data.id,
            url: file.data.webViewLink, 
            downloadUrl: file.data.webContentLink 
        });

    } catch (error) {
        console.error("ERROR:", error.message);
        console.error(error.stack);
        res.status(500).json({ 
            success: false, 
            error: error.message
        });
    } finally {
        // ALWAYS close page and browser after each request
        if (page) {
            try { await page.close(); } catch (e) { console.log("Error closing page:", e.message); }
        }
        if (browser) {
            try { 
                await browser.close(); 
                console.log("Browser closed cleanly");
            } catch (e) { 
                console.log("Error closing browser:", e.message); 
            }
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Photopea Worker running on port ${PORT}`);
    console.log(`Browser will be created fresh for each request`);
});
