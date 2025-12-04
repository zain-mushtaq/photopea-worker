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
        // CRITICAL: Try headless: false with Xvfb (virtual display)
        headless: false, // Changed to false
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
            '--mute-audio',
            '--no-default-browser-check',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1920,1080',
            '--user-data-dir=/tmp/chrome-user-data',
            '--data-path=/tmp/chrome-data',
            '--disk-cache-dir=/tmp/cache',
            // Virtual display
            '--display=:99',
            // Additional anti-detection
            '--disable-infobars',
            '--disable-browser-side-navigation'
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
        
        page.setDefaultTimeout(180000);
        
        // Enhanced anti-detection
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false,
            });
            
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
            });
            
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en'],
            });
            
            window.chrome = {
                runtime: {},
            };
            
            // Override console.debug which Photopea might use for detection
            const originalDebug = console.debug;
            console.debug = function(...args) {
                if (!args[0]?.includes?.('detection')) {
                    originalDebug.apply(console, args);
                }
            };
        });

        // Console logging
        page.on('console', msg => {
            const type = msg.type();
            const text = msg.text();
            console.log(`BROWSER [${type}]:`, text);
        });
        page.on('pageerror', err => console.error('PAGE ERROR:', err.toString()));

        console.log("Navigating to Photopea...");
        
        await page.goto('https://www.photopea.com/', { 
            waitUntil: 'networkidle0',
            timeout: 120000 
        });
        
        console.log("Page loaded. Waiting for Photopea...");

        // Custom polling with Promise-based delay
        let ready = false;
        for (let i = 0; i < 90; i++) {
            const status = await page.evaluate(() => {
                if (typeof window.app !== 'undefined' && typeof window.app.open === 'function') {
                    return { ready: true };
                }
                return { ready: false, message: 'window.app not ready' };
            });
            
            if (status.ready) {
                ready = true;
                console.log("✓ Photopea initialized!");
                break;
            }
            
            if (i % 10 === 0) {
                console.log(`[${i}s] Waiting... ${status.message}`);
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        if (!ready) {
            throw new Error("Photopea did not initialize after 90 seconds");
        }
        
        // Extra stabilization delay
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Setup data transfer
        let finalImageBuffer = null;
        await page.exposeFunction('sendImageToNode', (base64Data) => {
            finalImageBuffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ""), 'base64');
        });

        console.log("Starting PSD processing in browser...");

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
                if (!doc) throw new Error("No active document found");

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

        console.log("Waiting for image data...");
        const startWait = Date.now();
        
        while (!finalImageBuffer && (Date.now() - startWait) < 180000) {
            await new Promise(r => setTimeout(r, 1000));
        }

        if (!finalImageBuffer) {
            throw new Error("Timeout waiting for image");
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
