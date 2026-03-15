// Vercel Serverless Function — OCR Engine
// Supports: Google Cloud Vision API, OCR.space, local fallback
// Set GOOGLE_VISION_KEY or OCR_SPACE_KEY in Vercel Environment Variables

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { image } = req.body; // base64 string (no data: prefix)
    if (!image) return res.status(400).json({ error: 'No image provided' });

    // ============ GOOGLE CLOUD VISION ============
    const gKey = process.env.GOOGLE_VISION_KEY;
    if (gKey) {
      const response = await fetch(
        'https://vision.googleapis.com/v1/images:annotate?key=' + gKey,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requests: [{
              image: { content: image },
              features: [
                { type: 'TEXT_DETECTION', maxResults: 50 },
                { type: 'DOCUMENT_TEXT_DETECTION' }
              ]
            }]
          })
        }
      );

      const data = await response.json();
      if (data.error) return res.status(500).json({ error: data.error.message });

      const result = (data.responses || [])[0];
      if (!result) return res.status(200).json({ engine: 'google-vision', text: '', lines: [], words: [] });

      // Full text
      var fullText = '';
      if (result.textAnnotations && result.textAnnotations[0]) {
        fullText = result.textAnnotations[0].description || '';
      }

      // Words with bounding boxes
      var words = (result.textAnnotations || []).slice(1).map(function(a) {
        return {
          text: a.description,
          vertices: a.boundingPoly ? a.boundingPoly.vertices : [],
          confidence: 0.95
        };
      });

      // Structured blocks from DOCUMENT_TEXT_DETECTION
      var blocks = [];
      var fa = result.fullTextAnnotation;
      if (fa && fa.pages) {
        fa.pages.forEach(function(page) {
          (page.blocks || []).forEach(function(block) {
            var blockText = '';
            (block.paragraphs || []).forEach(function(para) {
              var paraText = '';
              (para.words || []).forEach(function(word) {
                var wt = (word.symbols || []).map(function(s) { return s.text; }).join('');
                paraText += wt + ' ';
              });
              blockText += paraText.trim() + '\n';
            });
            blocks.push({
              text: blockText.trim(),
              vertices: block.boundingBox ? block.boundingBox.vertices : [],
              confidence: block.confidence || 0.9
            });
          });
        });
      }

      return res.status(200).json({
        engine: 'google-vision',
        text: fullText,
        words: words,
        blocks: blocks
      });
    }

    // ============ OCR.SPACE ============
    var ocrKey = process.env.OCR_SPACE_KEY;
    if (ocrKey) {
      var params = new URLSearchParams();
      params.append('base64Image', 'data:image/jpeg;base64,' + image);
      params.append('language', 'ita');
      params.append('isOverlayRequired', 'true');
      params.append('OCREngine', '2');
      params.append('scale', 'true');
      params.append('isTable', 'true');

      var ocrResp = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        headers: { 'apikey': ocrKey },
        body: params
      });

      var ocrData = await ocrResp.json();

      if (ocrData.IsErroredOnProcessing) {
        return res.status(500).json({ error: (ocrData.ErrorMessage || ['OCR failed'])[0] });
      }

      var ocrResult = (ocrData.ParsedResults || [])[0];
      var ocrText = ocrResult ? (ocrResult.ParsedText || '') : '';

      var ocrWords = [];
      if (ocrResult && ocrResult.TextOverlay && ocrResult.TextOverlay.Lines) {
        ocrResult.TextOverlay.Lines.forEach(function(line) {
          (line.Words || []).forEach(function(w) {
            ocrWords.push({
              text: w.WordText,
              vertices: [
                { x: w.Left, y: w.Top },
                { x: w.Left + w.Width, y: w.Top },
                { x: w.Left + w.Width, y: w.Top + w.Height },
                { x: w.Left, y: w.Top + w.Height }
              ],
              confidence: 0.85
            });
          });
        });
      }

      return res.status(200).json({
        engine: 'ocr-space',
        text: ocrText,
        words: ocrWords,
        blocks: []
      });
    }

    // ============ NO API KEY — signal fallback to Tesseract.js ============
    return res.status(200).json({
      engine: 'none',
      fallback: true,
      message: 'No OCR API key. Set GOOGLE_VISION_KEY or OCR_SPACE_KEY in Vercel env vars. Using local Tesseract.js.'
    });

  } catch (e) {
    console.error('OCR API Error:', e);
    return res.status(500).json({ error: e.message });
  }
};
