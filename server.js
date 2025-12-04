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
            '--user-data-dir=/tmp/chrome-user-data',
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
        service: 'Photopea Worker (iframe API)',
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

        console.log("Setting up wrapper page with Photopea iframe...");
        
        // Create a wrapper HTML page that embeds Photopea in an iframe
        const wrapperHTML = `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { margin: 0; padding: 0; }
        #photopea-iframe { width: 100vw; height: 100vh; border: none; }
    </style>
</head>
<body>
    <iframe id="photopea-iframe" src="https://www.photopea.com"></iframe>
    <script>
        window.photopeaReady = false;
        window.photopeaMessages = [];
        
        // Listen for messages from Photopea
        window.addEventListener("message", function(e) {
            console.log("Received from Photopea:", e.data);
            window.photopeaMessages.push(e.data);
            
            if (e.data === "done") {
                window.photopeaReady = true;
            }
        });
        
        // Function to send messages to Photopea
        window.sendToPhotopea = function(message) {
            const iframe = document.getElementById("photopea-iframe");
            iframe.contentWindow.postMessage(message, "*");
        };
        
        console.log("Wrapper ready, waiting for Photopea...");
    </script>
</body>
</html>`;

        // Load the wrapper page
        await page.setContent(wrapperHTML);
        console.log("Wrapper page loaded, waiting for Photopea iframe to initialize...");
        
        // Wait for Photopea to send "done" message
        await page.waitForFunction(
            () => window.photopeaReady === true,
            { timeout: 120000, polling: 1000 }
        );
        
        console.log("✓ Photopea iframe initialized and ready!");
        
        // Give it a moment to fully stabilize
        await new Promise(resolve => setTimeout(resolve, 2000));

        console.log("Starting PSD processing...");

        // Execute the automation using postMessage API
        const result = await page.evaluate(async (psdUrl, mods) => {
            try {
                console.log("=== Processing via postMessage API ===");
                
                // Helper to wait for "done" message
                const waitForDone = () => {
                    return new Promise((resolve) => {
                        const initialLength = window.photopeaMessages.length;
                        const checkDone = () => {
                            const newMessages = window.photopeaMessages.slice(initialLength);
                            if (newMessages.includes("done")) {
                                resolve(newMessages);
                            } else {
                                setTimeout(checkDone, 100);
                            }
                        };
                        checkDone();
                    });
                };
                
                // Fetch PSD
                console.log("Fetching PSD...");
                const psdResp = await fetch(psdUrl);
                const psdBuffer = await psdResp.arrayBuffer();
                console.log(`✓ PSD fetched: ${psdBuffer.byteLength} bytes`);
                
                // Send PSD to Photopea
                console.log("Sending PSD to Photopea...");
                window.sendToPhotopea(psdBuffer);
                await waitForDone();
                console.log("✓ PSD opened in Photopea");
                
                // Build the script to modify the PSD
                let script = `
                    var doc = app.activeDocument;
                    console.log("Active document: " + doc.name);
                    console.log("Layers: " + doc.layers.length);
                    
                    function findLayer(layers, name) {
                        for (var i = 0; i < layers.length; i++) {
                            if (layers[i].name === name) return layers[i];
                            if (layers[i].layers) {
                                var found = findLayer(layers[i].layers, name);
                                if (found) return found;
                            }
                        }
                        return null;
                    }
                `;
                
                // Add modifications to script
                for (const mod of mods) {
                    console.log(`Adding modification for: ${mod.layerName}`);
                    
                    if (mod.text) {
                        script += `
                            var layer = findLayer(doc.layers, "${mod.layerName}");
                            if (layer && layer.kind === "TEXT") {
                                console.log("Updating text in ${mod.layerName}");
                                layer.textItem.contents = "${mod.text}";
                            } else {
                                console.log("Text layer ${mod.layerName} not found");
                            }
                        `;
                    }
                    
                    if (mod.image) {
                        // For images, we need to load them first, then replace
                        script += `
                            var layer = findLayer(doc.layers, "${mod.layerName}");
                            if (layer) {
                                console.log("Will replace image in ${mod.layerName}");
                                doc.activeLayer = layer;
                                // Image will be loaded separately
                            }
                        `;
                    }
                }
                
                // Execute the script
                console.log("Executing modification script...");
                window.sendToPhotopea(script);
                await waitForDone();
                console.log("✓ Modifications applied");
                
                // Handle image replacements
                for (const mod of mods) {
                    if (mod.image) {
                        console.log(`Replacing image for ${mod.layerName}...`);
                        const imgResp = await fetch(mod.image);
                        const imgBuffer = await imgResp.arrayBuffer();
                        
                        // Select the layer first
                        const selectScript = `
                            var layer = findLayer(doc.layers, "${mod.layerName}");
                            if (layer) {
                                doc.activeLayer = layer;
                                console.log("Layer ${mod.layerName} selected");
                            }
                        `;
                        window.sendToPhotopea(selectScript);
                        await waitForDone();
                        
                        // Send the image
                        window.sendToPhotopea(imgBuffer);
                        await waitForDone();
                        console.log(`✓ Image replaced for ${mod.layerName}`);
                    }
                }
                
                // Export as JPG
                console.log("Exporting to JPG...");
                const exportScript = 'app.activeDocument.saveToOE("jpg");';
                window.sendToPhotopea(exportScript);
                
                // Wait for the JPG data (ArrayBuffer)
                return new Promise((resolve) => {
                    const initialLength = window.photopeaMessages.length;
                    const checkForImage = () => {
                        const newMessages = window.photopeaMessages.slice(initialLength);
                        for (let msg of newMessages) {
                            if (msg instanceof ArrayBuffer) {
                                console.log(`✓ JPG received: ${msg.byteLength} bytes`);
                                resolve({ success: true, imageBuffer: msg });
                                return;
                            }
                        }
                        setTimeout(checkForImage, 100);
                    };
                    setTimeout(checkForImage, 100);
                });
                
            } catch (error) {
                console.error("Processing error:", error);
                return { success: false, error: error.message };
            }
        }, psdUrl, modifications);

        if (!result.success) {
            throw new Error(`Processing failed: ${result.error}`);
        }

        console.log("Converting image buffer...");
        const imageBuffer = Buffer.from(result.imageBuffer);
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

        console.log(`✓ Success! File ID: ${file.data.id}`);
        
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
    console.log(`Using official Photopea iframe postMessage API`);
});
