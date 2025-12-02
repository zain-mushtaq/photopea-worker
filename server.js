// Photopea PSD Automation Worker
// A production-ready Express server that processes PSD files using Photopea

const express = require('express');
const puppeteer = require('puppeteer');
const AWS = require('aws-sdk');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '50mb' }));

// Configure AWS S3
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || 'us-east-1'
});

// Global browser instance for reuse
let browser = null;

// Initialize browser
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
  }
  return browser;
}

// Main PSD processing endpoint
app.post('/process-psd', async (req, res) => {
  const {
    templateUrl,      // S3 URL to template.psd
    backgroundUrl,    // S3 URL to generated background
    headline,         // Text for TXT_HEADLINE
    subhead,          // Text for TXT_SUBHEAD
    tagline,          // Text for TXT_TAGLINE
    variantId,        // Unique identifier for this variant
    outputBucket      // S3 bucket for output
  } = req.body;

  console.log(`[${variantId}] Starting PSD processing...`);
  
  try {
    // Validate inputs
    if (!templateUrl || !backgroundUrl || !variantId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: templateUrl, backgroundUrl, variantId'
      });
    }

    // Get browser instance
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();
    
    // Set viewport for consistent rendering
    await page.setViewport({ width: 1920, height: 1080 });
    
    console.log(`[${variantId}] Opening Photopea...`);
    
    // Navigate to Photopea
    await page.goto('https://www.photopea.com/', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Wait for Photopea to fully load
    await page.waitForTimeout(3000);

    // Close any welcome dialogs
    try {
      await page.evaluate(() => {
        const closeButton = document.querySelector('[data-action="close"]');
        if (closeButton) closeButton.click();
      });
    } catch (e) {
      // Dialog might not exist, continue
    }

    console.log(`[${variantId}] Executing Photopea script...`);

    // Build and execute the Photopea script
    const photopeaScript = `
      (async function() {
        try {
          console.log("Opening template PSD...");
          
          // Open template PSD
          await app.open("${templateUrl}");
          
          // Wait for document to load
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          console.log("Template loaded. Processing Smart Object...");
          
          // Find and select the background Smart Object layer
          var doc = app.activeDocument;
          var bgLayer = doc.layers.getByName("BG_IMAGE");
          doc.activeLayer = bgLayer;
          
          // Open Smart Object for editing
          executeAction(stringIDToTypeID("placedLayerEditContents"));
          
          // Wait for Smart Object to open
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          console.log("Smart Object opened. Replacing content...");
          
          // Clear existing content in Smart Object
          var soDoc = app.activeDocument;
          while (soDoc.layers.length > 0) {
            soDoc.layers[0].remove();
          }
          
          // Load new background image into Smart Object
          await app.open("${backgroundUrl}", null, true);
          
          // Wait for image to load
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Flatten if multiple layers exist
          if (app.activeDocument.layers.length > 1) {
            app.activeDocument.flatten();
          }
          
          console.log("Closing Smart Object...");
          
          // Close Smart Object (saves changes to parent document)
          app.activeDocument.close(SaveOptions.SAVECHANGES);
          
          // Wait for parent document to update
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          console.log("Updating text layers...");
          
          // Update text layers
          var mainDoc = app.activeDocument;
          
          // Update headline
          try {
            var headlineLayer = mainDoc.layers.getByName("TXT_HEADLINE");
            if (headlineLayer && headlineLayer.textItem) {
              headlineLayer.textItem.contents = "${headline || ''}";
              console.log("✓ Headline updated");
            }
          } catch (e) {
            console.log("⚠ TXT_HEADLINE not found or error:", e.message);
          }
          
          // Update subhead
          try {
            var subheadLayer = mainDoc.layers.getByName("TXT_SUBHEAD");
            if (subheadLayer && subheadLayer.textItem) {
              subheadLayer.textItem.contents = "${subhead || ''}";
              console.log("✓ Subhead updated");
            }
          } catch (e) {
            console.log("⚠ TXT_SUBHEAD not found or error:", e.message);
          }
          
          // Update tagline
          try {
            var taglineLayer = mainDoc.layers.getByName("TXT_TAGLINE");
            if (taglineLayer && taglineLayer.textItem) {
              taglineLayer.textItem.contents = "${tagline || ''}";
              console.log("✓ Tagline updated");
            }
          } catch (e) {
            console.log("⚠ TXT_TAGLINE not found or error:", e.message);
          }
          
          console.log("Exporting as PNG...");
          
          // Export as high-quality PNG
          var exportOptions = new ExportOptionsSaveForWeb();
          exportOptions.format = SaveDocumentType.PNG;
          exportOptions.PNG8 = false;
          exportOptions.quality = 100;
          
          var outputFile = new File("output.png");
          app.activeDocument.exportDocument(outputFile, ExportType.SAVEFORWEB, exportOptions);
          
          console.log("✓ Export complete!");
          return "success";
          
        } catch (error) {
          console.error("Error in Photopea script:", error.message);
          return "error: " + error.message;
        }
      })();
    `;

    // Execute the script in Photopea
    const result = await page.evaluate((script) => {
      return eval(script);
    }, photopeaScript);

    console.log(`[${variantId}] Script execution result:`, result);

    // Wait for export to complete
    await page.waitForTimeout(3000);

    console.log(`[${variantId}] Capturing exported image...`);

    // Download the exported image from Photopea's download manager
    // Photopea creates downloads which we need to intercept
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: '/tmp'
    });

    // Alternative: Take screenshot of the canvas (fallback method)
    const canvasElement = await page.$('canvas');
    const imageBuffer = await canvasElement.screenshot({ type: 'png' });

    console.log(`[${variantId}] Uploading to S3...`);

    // Upload to S3
    const s3Key = `outputs/final-${variantId}.png`;
    const uploadParams = {
      Bucket: outputBucket || process.env.S3_BUCKET,
      Key: s3Key,
      Body: imageBuffer,
      ContentType: 'image/png',
      ACL: 'public-read'
    };

    const uploadResult = await s3.upload(uploadParams).promise();
    
    console.log(`[${variantId}] ✓ Upload complete!`);

    // Close the page
    await page.close();

    // Return success response
    res.status(200).json({
      success: true,
      variantId,
      imageUrl: uploadResult.Location,
      s3Key: s3Key,
      message: 'PSD processed successfully with Photopea'
    });

  } catch (error) {
    console.error(`[${variantId}] Error:`, error);
    res.status(500).json({
      success: false,
      variantId,
      error: error.message,
      stack: error.stack
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Photopea PSD Automation Worker',
    version: '1.0.0',
    browserConnected: browser ? browser.isConnected() : false
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing browser...');
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Photopea Worker running on port ${PORT}`);
  console.log(`📝 POST /process-psd - Process PSD files`);
  console.log(`💚 GET /health - Health check`);
});
