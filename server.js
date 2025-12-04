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
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-dev-tools',
            '--no-first-run',
            '--no-zygote',
            '--deterministic-fetch',
            '--disable-features=IsolateOrigins',
            '--disable-site-isolation-trials',
            '--window-size=1366,768',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
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

        // Set a longer default timeout for this page
        page.setDefaultTimeout(120000);

        // Enable logging
        page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
        page.on('pageerror', err => console.log('BROWSER ERROR:', err.toString()));

        console.log("Navigating to Photopea...");
        
        // Load Photopea with network idle
        await page.goto('https://www.photopea.com', { 
            waitUntil: 'networkidle2',
            timeout: 120000 
        });

        console.log("Page loaded. Waiting for Photopea to initialize...");

        // Wait for Photopea's main interface
        await page.waitForSelector('body', { timeout: 30000 });
        
        // Add a small delay to ensure JavaScript has executed
        await page.waitForTimeout(2000);

        // Wait for Photopea object (NOT window.app)
        console.log("Waiting for Photopea API...");
        await page.waitForFunction(
            () => typeof window.Photopea !== 'undefined',
            { timeout: 90000 }
        );
        console.log("Photopea API Ready!");

        // Additional wait to ensure Photopea is fully initialized
        await page.waitForTimeout(1000);

        // Setup data transfer
        let finalImageBuffer = null;
        await page.exposeFunction('sendImageToNode', (base64Data) => {
            finalImageBuffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ""), 'base64');
        });

        // Run automation using Photopea's scripting API
        await page.evaluate(async (url, mods) => {
            console.log("Browser: Starting script...");
            
            // Helper function to load binary data
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
            
            // Helper to run Photopea script
            async function runScript(script) {
                return new Promise((resolve, reject) => {
                    window.Photopea.runScript(script, (result) => {
                        if (result && result.error) {
                            reject(new Error(result.error));
                        } else {
                            resolve(result);
                        }
                    });
                });
            }
            
            console.log("Browser: Downloading PSD...");
            const psdBuffer = await loadBinary(url);
            const psdArray = new Uint8Array(psdBuffer);
            
            console.log("Browser: Opening PSD in Photopea...");
            await window.Photopea.openFromBinaryData(psdArray, "template.psd");
            
            // Wait for document to load
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            console.log("Browser: PSD Opened. Applying modifications...");

            // Apply modifications using Photopea's scripting
            for (const mod of mods) {
                console.log("Processing layer:", mod.layerName);
                
                if (mod.text) {
                    // Modify text layer
                    const script = `
                        var doc = app.activeDocument;
                        var layer = doc.layers.getByName("${mod.layerName}");
                        if (layer && layer.kind == "TEXT") {
                            layer.textItem.contents = "${mod.text.replace(/"/g, '\\"')}";
                        }
                    `;
                    await runScript(script);
                } else if (mod.image) {
                    // Replace image in layer
                    const imgBuffer = await loadBinary(mod.image);
                    const imgArray = new Uint8Array(imgBuffer);
                    
                    // Open image as new document
                    await window.Photopea.openFromBinaryData(imgArray, "replacement.jpg");
                    
                    // Copy and paste into target layer
                    const replaceScript = `
                        // Select all in current doc
                        app.activeDocument.selection.selectAll();
                        // Copy
                        app.activeDocument.selection.copy();
                        // Close this doc
                        app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);
                        // Now back in main doc, select target layer
                        var layer = app.activeDocument.layers.getByName("${mod.layerName}");
                        if (layer) {
                            app.activeDocument.activeLayer = layer;
                            // Paste
                            app.activeDocument.paste();
                        }
                    `;
                    await runScript(replaceScript);
                }
            }
            
            console.log("Browser: Saving JPG...");
            
            // Export as JPG using Photopea's API
            const saveScript = `
                var doc = app.activeDocument;
                doc.saveToOE("jpg");
            `;
            await runScript(saveScript);
            
            // Get the saved file data
            const exportedData = await window.Photopea.getArrayBuffer();
            
            // Convert to base64 and send to Node
            const blob = new Blob([exportedData]);
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
        const startWait = Date.now();
        while (!finalImageBuffer) {
            if (Date.now() - startWait > 120000) {
                throw new Error("Timeout waiting for image render");
            }
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
        res.json({ 
            success: true, 
            fileId: file.data.id,
            url: file.data.webViewLink, 
            downloadUrl: file.data.webContentLink 
        });

    } catch (e) {
        console.error("Error:", e);
        res.status(500).json({ success: false, error: e.message, stack: e.stack });
    } finally {
        if (page) {
            await page.close().catch(err => console.log("Error closing page:", err));
        }
    }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, closing browser...');
    if (browser) await browser.close();
    process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker listening on port ${PORT}`));
