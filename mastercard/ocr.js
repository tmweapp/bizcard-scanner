// ════════════════════════════════════════════════════════════════
//  BIZCARD SCANNER v4 — Vercel Serverless OCR Engine
//  Supports: Google Cloud Vision, OCR.space, Tesseract fallback
//  Config: Set GOOGLE_VISION_KEY or OCR_SPACE_KEY in Vercel Env
// ════════════════════════════════════════════════════════════════

'use strict';

// Max image size: 4MB base64 (~3MB raw)
const MAX_IMAGE_SIZE = 4 * 1024 * 1024;
// Allowed origins (set ALLOWED_ORIGINS env var, comma-separated)
const DEFAULT_ORIGIN = '*';

module.exports = async function handler(req, res) {
  // ─── CORS ───
  const allowedOrigins = process.env.ALLOWED_ORIGINS || DEFAULT_ORIGIN;
  const origin = req.headers.origin || '*';

  if (allowedOrigins !== '*') {
    const origins = allowedOrigins.split(',').map(o => o.trim());
    if (origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', origins[0]);
    }
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  try {
    const { image, probe } = req.body || {};

    // ─── Probe request (check API availability) ───
    if (probe) {
      const gKey = process.env.GOOGLE_VISION_KEY;
      const oKey = process.env.OCR_SPACE_KEY;
      if (gKey) return res.status(200).json({ engine: 'Google Vision', available: true });
      if (oKey) return res.status(200).json({ engine: 'OCR.space', available: true });
      return res.status(200).json({ engine: 'none', fallback: true, message: 'No API key configured.' });
    }

    // ─── Validate image ───
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "image" field. Expected base64 string.' });
    }

    if (image.length > MAX_IMAGE_SIZE) {
      return res.status(413).json({ error: `Image too large (${(image.length / 1024 / 1024).toFixed(1)}MB). Max ${MAX_IMAGE_SIZE / 1024 / 1024}MB.` });
    }

    // ─── GOOGLE CLOUD VISION ───
    const gKey = process.env.GOOGLE_VISION_KEY;
    if (gKey) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);

      try {
        const response = await fetch(
          `https://vision.googleapis.com/v1/images:annotate?key=${gKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              requests: [{
                image: { content: image },
                features: [
                  { type: 'TEXT_DETECTION', maxResults: 50 },
                  { type: 'DOCUMENT_TEXT_DETECTION' },
                ],
              }],
            }),
            signal: controller.signal,
          }
        );
        clearTimeout(timeout);

        const data = await response.json();

        if (data.error) {
          console.error('[OCR] Google Vision API error:', data.error);
          return res.status(502).json({ error: 'Google Vision API error: ' + (data.error.message || 'Unknown') });
        }

        const result = (data.responses || [])[0];
        if (!result) {
          return res.status(200).json({ engine: 'google-vision', text: '', words: [], blocks: [] });
        }

        // Full text from TEXT_DETECTION
        const fullText = result.textAnnotations?.[0]?.description || '';

        // Individual words with bounding boxes
        const words = (result.textAnnotations || []).slice(1).map(a => ({
          text: a.description,
          vertices: a.boundingPoly?.vertices || [],
          confidence: 0.95,
        }));

        // Structured blocks from DOCUMENT_TEXT_DETECTION
        const blocks = [];
        const fullAnnotation = result.fullTextAnnotation;
        if (fullAnnotation?.pages) {
          for (const page of fullAnnotation.pages) {
            for (const block of (page.blocks || [])) {
              let blockText = '';
              for (const para of (block.paragraphs || [])) {
                let paraText = '';
                for (const word of (para.words || [])) {
                  const wordText = (word.symbols || []).map(s => s.text).join('');
                  paraText += wordText + ' ';
                }
                blockText += paraText.trim() + '\n';
              }
              blocks.push({
                text: blockText.trim(),
                vertices: block.boundingBox?.vertices || [],
                confidence: block.confidence || 0.9,
              });
            }
          }
        }

        return res.status(200).json({
          engine: 'google-vision',
          text: fullText,
          words,
          blocks,
        });
      } catch (fetchErr) {
        clearTimeout(timeout);
        if (fetchErr.name === 'AbortError') {
          return res.status(504).json({ error: 'Google Vision API timeout (25s)' });
        }
        console.error('[OCR] Google Vision fetch error:', fetchErr);
        return res.status(502).json({ error: 'Failed to reach Google Vision API: ' + fetchErr.message });
      }
    }

    // ─── OCR.SPACE ───
    const ocrKey = process.env.OCR_SPACE_KEY;
    if (ocrKey) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);

      try {
        const params = new URLSearchParams();
        params.append('base64Image', 'data:image/jpeg;base64,' + image);
        params.append('language', 'ita');
        params.append('isOverlayRequired', 'true');
        params.append('OCREngine', '2');
        params.append('scale', 'true');
        params.append('isTable', 'true');
        params.append('detectOrientation', 'true');

        const ocrResp = await fetch('https://api.ocr.space/parse/image', {
          method: 'POST',
          headers: { 'apikey': ocrKey },
          body: params,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const ocrData = await ocrResp.json();

        if (ocrData.IsErroredOnProcessing) {
          const errMsg = Array.isArray(ocrData.ErrorMessage) ? ocrData.ErrorMessage[0] : (ocrData.ErrorMessage || 'OCR processing failed');
          return res.status(502).json({ error: 'OCR.space error: ' + errMsg });
        }

        const ocrResult = (ocrData.ParsedResults || [])[0];
        const ocrText = ocrResult?.ParsedText || '';

        const ocrWords = [];
        if (ocrResult?.TextOverlay?.Lines) {
          for (const line of ocrResult.TextOverlay.Lines) {
            for (const w of (line.Words || [])) {
              ocrWords.push({
                text: w.WordText,
                vertices: [
                  { x: w.Left, y: w.Top },
                  { x: w.Left + w.Width, y: w.Top },
                  { x: w.Left + w.Width, y: w.Top + w.Height },
                  { x: w.Left, y: w.Top + w.Height },
                ],
                confidence: 0.85,
              });
            }
          }
        }

        return res.status(200).json({
          engine: 'ocr-space',
          text: ocrText,
          words: ocrWords,
          blocks: [],
        });
      } catch (fetchErr) {
        clearTimeout(timeout);
        if (fetchErr.name === 'AbortError') {
          return res.status(504).json({ error: 'OCR.space API timeout (25s)' });
        }
        console.error('[OCR] OCR.space fetch error:', fetchErr);
        return res.status(502).json({ error: 'Failed to reach OCR.space: ' + fetchErr.message });
      }
    }

    // ─── NO API KEY ───
    return res.status(200).json({
      engine: 'none',
      fallback: true,
      message: 'No OCR API key configured. Set GOOGLE_VISION_KEY or OCR_SPACE_KEY in Vercel environment variables. Client will use Tesseract.js as fallback.',
    });

  } catch (e) {
    console.error('[OCR] Unexpected error:', e);
    return res.status(500).json({ error: 'Internal server error: ' + (e.message || 'Unknown') });
  }
};
