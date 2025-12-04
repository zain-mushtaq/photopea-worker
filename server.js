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
            '--window-size=1920,1080',
            '--user-data-dir=/tmp/chrome-user-data-' + Date.now(), // Unique per request for localStorage
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
        service: 'Photopea Worker (Direct API)',
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

        // Console logging
        page.on('console', msg => console.log(`BROWSER:`, msg.text()));
        page.on('pageerror', err => console.error('PAGE ERROR:', err.toString()));

        console.log("Navigating directly to Photopea...");
        
        // Navigate directly to Photopea (not in iframe, so localStorage works)
        await page.goto('https://www.photopea.com/', { 
            waitUntil: 'networkidle2',
            timeout: 120000 
        });
        
        console.log("Page loaded. Injecting message listener...");
        
        // Inject our message capture system into the page
        await page.evaluate(() => {
            window.photopeaMessages = [];
            window.photopeaReady = false;
            
            // Intercept postMessages from Photopea to itself
            const originalPostMessage = window.postMessage;
            window.postMessage = function(message, targetOrigin) {
                console.log("Photopea message:", message);
                window.photopeaMessages.push(message);
                
                if (message === "done") {
                    window.photopeaReady = true;
                }
                
                // Still call the original
                return originalPostMessage.call(window, message, targetOrigin);
            };
            
            console.log("Message listener injected");
        });
        
        console.log("Waiting for Photopea to initialize...");
        
        // Wait for Photopea to be ready
        await page.waitForFunction(
            () => {
                // Check if Photopea app exists AND is ready
                return typeof app !== 'undefined' && 
                       typeof app.activeDocument !== 'undefined' &&
                       typeof app.open === 'function';
            },
            { timeout: 120000, polling: 1000 }
        );
        
        console.log("✓ Photopea initialized!");
        
        // Extra stability delay
        await new Promise(resolve => setTimeout(resolve, 3000));

        console.log("Starting PSD processing...");

        // Process using direct app object (not postMessage since we're in same context)
        const result = await page.evaluate(async (psdUrl, mods) => {
            try {
                console.log("=== Processing PSD ===");
                
                // Fetch PSD
                console.log("Fetching PSD...");
                const psdResp = await fetch(psdUrl);
                if (!psdResp.ok) throw new Error(`Failed to fetch PSD: ${psdResp.statusText}`);
                const psdBuffer = await psdResp.arrayBuffer();
                console.log(`✓ PSD fetched: ${psdBuffer.byteLength} bytes`);
                
                // Open PSD
                console.log("Opening PSD in Photopea...");
                await app.open(psdBuffer, "template.psd");
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                const doc = app.activeDocument;
                if (!doc) throw new Error("No active document");
                console.log(`✓ PSD opened. Layers: ${doc.layers.length}`);
                
                // Helper function to find layers
                function findLayer(layers, name) {
                    if (!layers) return null;
                    for (let i = 0; i < layers.length; i++) {
                        if (layers[i].name === name) {
                            console.log(`✓ Found layer: ${name}`);
                            return layers[i];
                        }
                        if (layers[i].layers) {
                            const found = findLayer(layers[i].layers, name);
                            if (found) return found;
                        }
                    }
                    return null;
                }
                
                // Apply modifications
                for (const mod of mods) {
                    console.log(`Processing: ${mod.layerName}`);
                    const layer = findLayer(doc.layers, mod.layerName);
                    
                    if (!layer) {
                        console.warn(`⚠ Layer not found: ${mod.layerName}`);
                        continue;
                    }
                    
                    if (mod.text && layer.kind === "TEXT") {
                        console.log(`Updating text to: "${mod.text}"`);
                        layer.textItem.contents = mod.text;
                        console.log("✓ Text updated");
                    }
                    
                    if (mod.image) {
                        console.log(`Replacing image from: ${mod.image}`);
                        doc.activeLayer = layer;
                        
                        // Fetch and open replacement image
                        const imgResp = await fetch(mod.image);
                        if (!imgResp.ok) throw new Error(`Failed to fetch image: ${imgResp.statusText}`);
                        const imgBuffer = await imgResp.arrayBuffer();
                        
                        await app.open(imgBuffer, "replacement.jpg", true);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        console.log("✓ Image replaced");
                    }
                }
                
                // Export to JPG
                console.log("Exporting to JPG...");
                const jpgBuffer = await doc.saveToOE("jpg");
                console.log(`✓ JPG exported: ${jpgBuffer.byteLength} bytes`);
                
                // Convert to base64 for transfer
                const blob = new Blob([jpgBuffer]);
                const reader = new FileReader();
                
                return new Promise((resolve) => {
                    reader.onloadend = () => {
                        const base64 = reader.result.split(',')[1];
                        console.log("✓ Image converted to base64");
                        resolve({ success: true, base64: base64 });
                    };
                    reader.readAsDataURL(blob);
                });
                
            } catch (error) {
                console.error("Processing error:", error.message);
                return { success: false, error: error.message };
            }
        }, psdUrl, modifications);

        if (!result.success) {
            throw new Error(`Processing failed: ${result.error}`);
        }

        console.log("Converting image...");
        const imageBuffer = Buffer.from(result.base64, 'base64');
        console.log(`✓ Final image: ${imageBuffer.length} bytes`);
        
        console.log("Uploading to Google Drive...");
        const bufferStream = new stream.PassThrough();
        bufferStream.end(imageBuffer);

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

        console.log(`✓ SUCCESS! File ID: ${file.data.id}`);
        
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
            error: error.message
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
    console.log(`Using direct Photopea API access`);
});
