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

async function createBrowser() {
    console.log("Creating fresh browser instance...");
    
    const browser = await puppeteer.launch({
        executablePath: '/usr/bin/google-chrome-stable',
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-software-rasterizer',
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
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1920,1080',
            '--disable-crash-reporter',
            '--disable-in-process-stack-traces',
            '--disable-logging',
            '--disable-breakpad',
            '--log-level=3',
            '--user-data-dir=/tmp/chrome-user-data',
            '--data-path=/tmp/chrome-data',
            '--homedir=/tmp',
            '--disk-cache-dir=/tmp/cache',
            // CRITICAL: Enable JavaScript
            '--enable-javascript'
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
        note: 'Browser created on-demand per request',
        timestamp: new Date().toISOString()
    });
});

app.post('/process-psd', async (req, res) => {
    const { psdUrl, modifications } = req.body;
    console.log(`\n=== New Request ===`);
    console.log(`Processing PSD: ${psdUrl}`);
    console.log(`Modifications:`, JSON.stringify(modifications, null, 2));
    
    let browser;
    let page;

    try {
        browser = await createBrowser();
        page = await browser.newPage();
        
        // Longer timeouts
        page.setDefaultTimeout(180000); // 3 minutes
        
        // Make browser appear less bot-like
        await page.evaluateOnNewDocument(() => {
            // Override navigator properties
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false,
            });
            
            // Add chrome object
            window.chrome = {
                runtime: {},
            };
            
            // Override permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
            );
        });

        // Enhanced console logging
        page.on('console', msg => {
            const type = msg.type();
            const text = msg.text();
            console.log(`BROWSER [${type}]:`, text);
        });
        page.on('pageerror', err => console.error('PAGE ERROR:', err.toString()));
        page.on('requestfailed', req => console.log('REQUEST FAILED:', req.url()));

        console.log("Navigating to Photopea...");
        
        await page.goto('https://www.photopea.com/', { 
            waitUntil: 'domcontentloaded',
            timeout: 120000 
        });

        console.log("Page loaded, waiting for Photopea to initialize...");
        
        // IMPROVED: Check multiple conditions for Photopea readiness
        await page.waitForFunction(
            () => {
                // Check if window.app exists and has required methods
                if (typeof window.app === 'undefined') {
                    console.log('Waiting: window.app is undefined');
                    return false;
                }
                
                if (typeof window.app.open !== 'function') {
                    console.log('Waiting: window.app.open is not a function');
                    return false;
                }
                
                console.log('Success: Photopea is ready!');
                return true;
            },
            { 
                timeout: 150000, // 2.5 minutes
                polling: 1000 // Check every second
            }
        );
        
        console.log("✓ Photopea fully initialized!");
        
        // Additional wait for stability
        await page.waitForTimeout(3000);

        // Setup data transfer
        let finalImageBuffer = null;
        await page.exposeFunction('sendImageToNode', (base64Data) => {
            finalImageBuffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ""), 'base64');
        });

        console.log("Starting PSD processing in browser...");

        // Execute automation with better error handling
        const result = await page.evaluate(async (url, mods) => {
            try {
                console.log("=== Browser-side processing started ===");
                
                async function loadBinary(url) {
                    console.log(`Fetching: ${url}`);
                    const resp = await fetch(url);
                    if (!resp.ok) throw new Error(`Fetch failed: ${resp.statusText}`);
                    const buffer = await resp.arrayBuffer();
                    console.log(`✓ Fetched ${buffer.byteLength} bytes`);
                    return buffer;
                }
                
                console.log("Downloading PSD...");
                const psdBuffer = await loadBinary(url);
                
                console.log("Opening PSD in Photopea...");
                await window.app.open(psdBuffer, "template.psd");
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                const doc = window.app.activeDocument;
                if (!doc) throw new Error("No active document found after opening PSD");

                console.log(`✓ PSD opened. Layers: ${doc.layers.length}`);

                function findLayer(layers, targetName) {
                    if (!layers) return null;
                    for (let i = 0; i < layers.length; i++) {
                        if (layers[i].name === targetName) {
                            console.log(`✓ Found layer: ${targetName}`);
                            return layers[i];
                        }
                        if (layers[i].layers) {
                            const found = findLayer(layers[i].layers, targetName);
                            if (found) return found;
                        }
                    }
                    return null;
                }

                // Apply modifications
                for (const mod of mods) {
                    console.log(`Processing modification for layer: ${mod.layerName}`);
                    const layer = findLayer(doc.layers, mod.layerName);
                    
                    if (layer) {
                        if (mod.text && layer.kind === "TEXT") {
                            console.log(`Updating text to: "${mod.text}"`);
                            layer.textItem.contents = mod.text;
                            console.log("✓ Text updated");
                        } else if (mod.image) {
                            console.log(`Replacing image from: ${mod.image}`);
                            doc.activeLayer = layer;
                            const imgBuffer = await loadBinary(mod.image);
                            await window.app.open(imgBuffer, "replacement.jpg", true);
                            console.log("✓ Image replaced");
                        }
                    } else {
                        console.warn(`⚠ Layer not found: ${mod.layerName}`);
                    }
                }
                
                console.log("Exporting to JPG...");
                const jpgBuffer = await doc.saveToOE("jpg");
                console.log(`✓ JPG exported: ${jpgBuffer.byteLength} bytes`);
                
                const blob = new Blob([jpgBuffer]);
                const reader = new FileReader();
                return new Promise((resolve) => {
                    reader.onloadend = () => {
                        window.sendImageToNode(reader.result);
                        console.log("✓ Image sent to Node.js");
                        resolve({ success: true });
                    };
                    reader.readAsDataURL(blob);
                });
            } catch (error) {
                console.error("Browser-side error:", error.message);
                return { success: false, error: error.message };
            }
        }, psdUrl, modifications);

        if (!result.success) {
            throw new Error(`Browser processing failed: ${result.error}`);
        }

        // Wait for result with progress logging
        console.log("Waiting for image data...");
        const startWait = Date.now();
        let lastLog = startWait;
        
        while (!finalImageBuffer) {
            const elapsed = Date.now() - startWait;
            
            if (elapsed > 180000) { // 3 minutes
                throw new Error("Timeout waiting for image (180s)");
            }
            
            // Log progress every 10 seconds
            if (Date.now() - lastLog > 10000) {
                console.log(`Still waiting... (${Math.floor(elapsed/1000)}s elapsed)`);
                lastLog = Date.now();
            }
            
            await new Promise(r => setTimeout(r, 1000));
        }

        console.log(`✓ Image received: ${finalImageBuffer.length} bytes`);
        console.log("Uploading to Google Drive...");

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

        console.log(`✓ Upload complete! File ID: ${file.data.id}`);
        
        res.json({ 
            success: true, 
            fileId: file.data.id,
            url: file.data.webViewLink, 
            downloadUrl: file.data.webContentLink 
        });

    } catch (error) {
        console.error("❌ ERROR:", error.message);
        console.error(error.stack);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    } finally {
        if (page) {
            try { 
                await page.close(); 
                console.log("Page closed");
            } catch (e) { 
                console.log("Error closing page:", e.message); 
            }
        }
        if (browser) {
            try { 
                await browser.close(); 
                console.log("Browser closed cleanly");
            } catch (e) { 
                console.log("Error closing browser:", e.message); 
            }
        }
        console.log("=== Request Complete ===\n");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Photopea Worker running on port ${PORT}`);
    console.log(`Browser will be created fresh for each request`);
    console.log(`Environment: ${process.env.NODE_ENV || 'production'}`);
});
