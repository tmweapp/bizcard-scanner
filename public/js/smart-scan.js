// ─── SMART SCAN ENGINE ────────────────────────────────────────
// Captures multiple frames, scores quality, runs OCR on best frames,
// merges results, then auto-normalizes with AI.

const SMART_SCAN_CONFIG = {
  totalFrames: 30,         // Total frames to capture
  captureIntervalMs: 150,  // ms between frames (~6.6 fps over ~4.5s)
  topFrames: 3,            // Best frames to OCR
  autoNormalize: true,     // Auto-run AI normalization at the end
};

let smartScanActive = false;
let smartScanAborted = false;

async function startSmartScan() {
  const video = $('video');
  if (!video.srcObject || video.videoWidth === 0) {
    // No camera — suggest alternatives
    if (currentMode === 'local') {
      toast('📷 Camera non disponibile — usa "File" o "Remoto"', 'info');
      // Auto-switch to upload mode
      document.querySelector('[data-mode="upload"]').click();
    }
    return;
  }

  if (!openaiApiKey) {
    toast('Inserisci la API Key OpenAI per Smart Scan', 'error');
    $('openaiKeyInput').focus();
    return;
  }

  smartScanActive = true;
  smartScanAborted = false;

  // UI setup
  $('smartScanOverlay').style.display = 'flex';
  $('btnSmartScan').classList.add('scanning');
  $('btnSmartScan').disabled = true;
  showLiveCard();
  $('ssStatus').textContent = '📸 Acquisizione frame...';
  $('ssDetail').textContent = 'Tieni fermo il biglietto nella guida';
  updateLiveProgress(0);

  if (navigator.vibrate) navigator.vibrate(100);

  try {
    // ── PHASE 1: Burst Capture ──
    const frames = await captureFrameBurst(video);
    if (smartScanAborted) return cleanupSmartScan();

    // Notify user: card can be removed now
    toast('✅ Foto acquisite — puoi rimuovere il biglietto!', 'success', 4000);
    $('ssStatus').textContent = '🧠 Elaborazione in corso...';

    // ── PHASE 2: Quality Scoring ──
    $('ssStatus').textContent = '🔍 Analisi qualità frame...';
    $('ssDetail').textContent = `${frames.length} frame catturati — selezione migliori`;
    const scored = frames.map((f, i) => ({
      ...f,
      index: i,
      quality: scoreFrameQuality(f.imageData, f.width, f.height),
    }));

    // Sort by quality descending, pick top N
    scored.sort((a, b) => b.quality - a.quality);
    const bestFrames = scored.slice(0, SMART_SCAN_CONFIG.topFrames);

    $('ssDetail').textContent = `Top ${bestFrames.length} frame — qualità: ${bestFrames.map(f => f.quality.toFixed(0)).join(', ')}`;
    if (smartScanAborted) return cleanupSmartScan();

    // ── PHASE 3: Multi-frame OCR ──
    $('ssStatus').textContent = '🤖 OCR su frame migliori...';
    updateLiveProgress(50);

    const ocrResults = [];
    for (let i = 0; i < bestFrames.length; i++) {
      if (smartScanAborted) return cleanupSmartScan();

      $('ssDetail').textContent = `OCR frame ${i + 1}/${bestFrames.length}...`;
      updateLiveProgress(50 + (i / bestFrames.length) * 30);

      const frame = bestFrames[i];
      const canvas = document.createElement('canvas');
      canvas.width = frame.width;
      canvas.height = frame.height;
      const ctx = canvas.getContext('2d');
      ctx.putImageData(frame.imageData, 0, 0);

      // Preprocess
      if (!useServerOCR) preprocessImage(ctx, canvas.width, canvas.height);

      const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
      const base64 = dataUrl.split(',')[1];

      // Store best frame as preview photo
      if (i === 0) {
        lastPhotoDataUrl = dataUrl;
        $('photoPreview').src = dataUrl;
      }

      try {
        let result;
        if (useServerOCR) {
          const resp = await fetch('/api/ocr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: base64 }),
          });
          result = await resp.json();
          if (result.fallback) {
            useServerOCR = false;
            result = await runTesseract(dataUrl);
          }
        } else {
          result = await runTesseract(dataUrl);
        }
        if (result && result.text) ocrResults.push(result);
      } catch (e) {
        console.warn('[SmartScan] OCR failed on frame ' + i, e);
      }
    }

    if (ocrResults.length === 0) {
      toast('Nessun testo rilevato su nessun frame', 'error');
      return cleanupSmartScan();
    }

    // ── PHASE 4: Merge OCR Results ──
    $('ssStatus').textContent = '🔀 Fusione risultati...';
    updateLiveProgress(85);

    const mergedText = mergeOcrResults(ocrResults);
    scanCount++;
    saveState();

    classifyBlocks(mergedText);
    populateLiveCardFromBlocks();

    // ── PHASE 5: Auto AI Normalization ──
    if (openaiApiKey && detectedBlocks.length > 0) {
      $('ssStatus').textContent = '✨ AI sta raffinando...';
      $('ssDetail').textContent = 'Pulizia e arricchimento dati...';
      updateLiveProgress(92);

      await normalizeWithAI();
      refineLiveCardFromBlocks();
      updateLiveProgress(100);
    } else {
      updateLiveProgress(100);
    }

    // Auto-start session on first scan
    if (!currentSession) startSession();
    currentSession.photoCount += ocrResults.length;

    // Show clean contact card
    $('resultSection').style.display = 'block';
    renderCleanCard();

    // Done!
    $('ssStatus').textContent = '✅ Completato!';
    const fieldCount = detectedBlocks.filter(b => b.type !== 'other' && b.type !== 'ignore').length;
    $('ssDetail').textContent = `${fieldCount} campi rilevati`;
    if (navigator.vibrate) navigator.vibrate([100, 50, 200]);

    toast('🧠 Smart Scan completato — ' + fieldCount + ' campi trovati!', 'success');

    // Auto-hide overlay after 2s
    setTimeout(() => {
      if ($('smartScanOverlay').style.display !== 'none') {
        $('smartScanOverlay').style.display = 'none';
      }
    }, 2000);

  } catch (e) {
    console.error('[SmartScan] Error:', e);
    toast('Errore Smart Scan: ' + e.message, 'error');
  } finally {
    cleanupSmartScan();
  }
}

function cleanupSmartScan() {
  smartScanActive = false;
  $('btnSmartScan').classList.remove('scanning');
  $('btnSmartScan').disabled = false;
  if (smartScanAborted) {
    $('smartScanOverlay').style.display = 'none';
    toast('Smart Scan interrotto', 'info');
  }
}

function updateSmartScanRing(percent) {
  // Legacy ring removed — redirect to live progress bar
  updateLiveProgress(percent);
}

// ── Burst Capture ──
function captureFrameBurst(video) {
  return new Promise((resolve) => {
    const frames = [];
    const config = SMART_SCAN_CONFIG;
    let count = 0;

    const scale = Math.min(1920 / video.videoWidth, 1);
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tempCtx = tempCanvas.getContext('2d');

    const captureFrame = () => {
      if (smartScanAborted || count >= config.totalFrames) {
        resolve(frames);
        return;
      }

      tempCtx.drawImage(video, 0, 0, w, h);
      const imageData = tempCtx.getImageData(0, 0, w, h);
      frames.push({ imageData, width: w, height: h });

      count++;
      updateLiveProgress((count / config.totalFrames) * 45);
      $('ssStatus').textContent = '📸 Frame ' + count + '/' + config.totalFrames;

      // Flash guide briefly every 5 frames
      if (count % 5 === 0) {
        const guide = $('cameraGuide');
        guide.classList.add('flash');
        setTimeout(() => guide.classList.remove('flash'), 100);
      }

      setTimeout(captureFrame, config.captureIntervalMs);
    };

    captureFrame();
  });
}

// ── Frame Quality Scoring ──
// Higher score = better quality (sharper, better contrast, good brightness)
function scoreFrameQuality(imageData, width, height) {
  const data = imageData.data;
  const pixels = width * height;

  // Sample every 8th pixel for performance
  let sumGray = 0;
  let sumGraySq = 0;
  let edgeSum = 0;
  let sampleCount = 0;

  for (let y = 1; y < height - 1; y += 4) {
    for (let x = 1; x < width - 1; x += 4) {
      const idx = (y * width + x) * 4;
      const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      sumGray += gray;
      sumGraySq += gray * gray;

      // Laplacian edge detection (simplified)
      const idxUp = ((y - 1) * width + x) * 4;
      const idxDown = ((y + 1) * width + x) * 4;
      const idxLeft = (y * width + (x - 1)) * 4;
      const idxRight = (y * width + (x + 1)) * 4;

      const grayUp = 0.299 * data[idxUp] + 0.587 * data[idxUp + 1] + 0.114 * data[idxUp + 2];
      const grayDown = 0.299 * data[idxDown] + 0.587 * data[idxDown + 1] + 0.114 * data[idxDown + 2];
      const grayLeft = 0.299 * data[idxLeft] + 0.587 * data[idxLeft + 1] + 0.114 * data[idxLeft + 2];
      const grayRight = 0.299 * data[idxRight] + 0.587 * data[idxRight + 1] + 0.114 * data[idxRight + 2];

      const laplacian = Math.abs(grayUp + grayDown + grayLeft + grayRight - 4 * gray);
      edgeSum += laplacian;
      sampleCount++;
    }
  }

  if (sampleCount === 0) return 0;

  const meanGray = sumGray / sampleCount;
  const variance = (sumGraySq / sampleCount) - (meanGray * meanGray);
  const sharpness = edgeSum / sampleCount;

  // Brightness penalty (too dark or too bright is bad)
  const brightnessPenalty = Math.abs(meanGray - 128) / 128; // 0=perfect, 1=extreme
  const brightnessScore = (1 - brightnessPenalty) * 30;

  // Contrast score (higher variance = more contrast = better for OCR)
  const contrastScore = Math.min(variance / 2, 35);

  // Sharpness score (more edges = sharper image)
  const sharpnessScore = Math.min(sharpness / 2, 35);

  return brightnessScore + contrastScore + sharpnessScore;
}

// ── Merge Multiple OCR Results ──
// Uses voting: lines that appear in multiple OCR results get priority
function mergeOcrResults(ocrResults) {
  if (ocrResults.length === 1) return ocrResults[0].text;

  // Collect all unique lines across results
  const lineVotes = new Map(); // normalized line → { original, count, sources }

  ocrResults.forEach((result, srcIdx) => {
    const lines = result.text.split('\n').map(l => l.trim()).filter(l => l.length > 1);
    lines.forEach(line => {
      // Normalize for comparison (lowercase, remove extra spaces)
      const norm = line.toLowerCase().replace(/\s+/g, ' ');
      if (lineVotes.has(norm)) {
        const entry = lineVotes.get(norm);
        entry.count++;
        entry.sources.add(srcIdx);
        // Keep the version with more content (probably more accurate)
        if (line.length > entry.original.length) entry.original = line;
      } else {
        lineVotes.set(norm, {
          original: line,
          count: 1,
          sources: new Set([srcIdx]),
        });
      }
    });
  });

  // Sort by vote count (descending), then by original appearance order
  const sorted = [...lineVotes.values()]
    .sort((a, b) => b.count - a.count);

  // Include lines that appear in at least 1 source (but prioritize multi-source)
  // Remove near-duplicates (lines that are substrings of others)
  const finalLines = [];
  const used = new Set();

  for (const entry of sorted) {
    const norm = entry.original.toLowerCase().replace(/\s+/g, ' ');
    let isDuplicate = false;

    for (const existing of finalLines) {
      const existNorm = existing.toLowerCase().replace(/\s+/g, ' ');
      if (existNorm.includes(norm) || norm.includes(existNorm)) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      finalLines.push(entry.original);
    }
  }

  return finalLines.join('\n');
}

// ─── AR SCAN ENGINE ──────────────────────────────────────────
// Overlay that reconstructs the business card in real-time on top of the video feed.
// Detects card edges, tracks position, progressively reveals text as AI reads it,
// shows 3D card flip animation on completion.

let arActive = false;
let arAnimFrame = null;
let arDetectedFields = {};  // { name: 'Mario Rossi', email: 'mario@...', ... }
let arFieldProgress = {};   // { name: 1.0, email: 0.5, ... } — 0 to 1 for typewriter
let arCardRect = null;      // { x, y, w, h } in canvas coords
let arPhase = 'detecting';  // 'detecting' | 'reading' | 'normalizing' | 'complete'
let arOcrRuns = 0;
let arBestFrame = null;

const AR_CONFIG = {
  scanIntervalMs: 800,      // How often to grab frames for OCR
  maxOcrPasses: 5,           // Max OCR passes before moving to AI
  minFieldsForComplete: 3,   // Minimum fields to consider "complete"
  typewriterSpeed: 0.05,     // How fast letters appear (per frame)
};

async function startARScan() {
  const video = $('video');
  if (!video.srcObject || video.videoWidth === 0) {
    toast('Camera non pronta', 'error');
    return;
  }
  if (!openaiApiKey) {
    toast('Inserisci la API Key OpenAI per AR Scan', 'error');
    $('openaiKeyInput').focus();
    return;
  }

  arActive = true;
  arDetectedFields = {};
  arFieldProgress = {};
  arCardRect = null;
  arPhase = 'detecting';
  arOcrRuns = 0;
  arBestFrame = null;

  // Setup canvas
  const canvas = $('arCanvas');
  const cameraArea = canvas.parentElement;
  canvas.width = cameraArea.offsetWidth * (window.devicePixelRatio || 1);
  canvas.height = cameraArea.offsetHeight * (window.devicePixelRatio || 1);
  canvas.style.width = '100%';
  canvas.style.height = '100%';

  // UI
  $('btnSmartScan').disabled = true;
  $('arHud').style.display = 'block';
  $('arCompleteCard').classList.remove('visible', 'flip');
  $('cameraGuide').style.display = 'none';

  // Show field HUD
  updateARHudFields();

  if (navigator.vibrate) navigator.vibrate(50);
  toast('✨ AR Scan avviato — inquadra il biglietto', 'info');

  // Start render loop
  arRenderLoop();

  // Start OCR scanning loop
  arScanLoop(video);
}

function stopARScan() {
  arActive = false;
  if (arAnimFrame) cancelAnimationFrame(arAnimFrame);
  arAnimFrame = null;

  $('btnSmartScan').disabled = false;
  $('cameraGuide').style.display = '';
  $('arHud').style.display = 'none';

  // Clear canvas
  const canvas = $('arCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ── AR Render Loop — draws the overlay every frame ──
function arRenderLoop() {
  if (!arActive) return;

  const canvas = $('arCanvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const dpr = window.devicePixelRatio || 1;

  ctx.clearRect(0, 0, W, H);

  // Detect card region (center-biased rectangle)
  if (!arCardRect) {
    arCardRect = {
      x: W * 0.06,
      y: H * 0.19,
      w: W * 0.88,
      h: H * 0.62,
    };
  }
  const r = arCardRect;

  if (arPhase === 'detecting') {
    // Scanning animation — pulsing corners
    drawScanningCorners(ctx, r, Date.now());
  } else if (arPhase === 'reading' || arPhase === 'normalizing') {
    // Semi-transparent card overlay
    drawCardOverlay(ctx, r, dpr);
    // Progressive typewriter text
    drawProgressiveText(ctx, r, dpr);
  }

  // Update progress
  updateARProgress();

  arAnimFrame = requestAnimationFrame(arRenderLoop);
}

function drawScanningCorners(ctx, r, time) {
  const pulse = Math.sin(time / 300) * 0.3 + 0.7;
  const cornerLen = Math.min(r.w, r.h) * 0.1;
  const lineW = 3;

  ctx.strokeStyle = `rgba(34, 197, 94, ${pulse})`;
  ctx.lineWidth = lineW;
  ctx.lineCap = 'round';

  // Scan line sweeping
  const scanY = r.y + (r.h * ((time % 2000) / 2000));
  ctx.save();
  ctx.globalAlpha = 0.3;
  const scanGrad = ctx.createLinearGradient(r.x, scanY - 2, r.x, scanY + 2);
  scanGrad.addColorStop(0, 'transparent');
  scanGrad.addColorStop(0.5, 'rgba(34,197,94,0.6)');
  scanGrad.addColorStop(1, 'transparent');
  ctx.fillStyle = scanGrad;
  ctx.fillRect(r.x, scanY - 8, r.w, 16);
  ctx.restore();

  // Corner brackets
  const corners = [
    [r.x, r.y], [r.x + r.w, r.y],
    [r.x, r.y + r.h], [r.x + r.w, r.y + r.h],
  ];
  corners.forEach(([cx, cy], i) => {
    const dx = (i % 2 === 0) ? 1 : -1;
    const dy = (i < 2) ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(cx + dx * cornerLen, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + dy * cornerLen);
    ctx.stroke();
  });
}

function drawCardOverlay(ctx, r, dpr) {
  // Semi-transparent card background
  ctx.save();

  // Card shape with rounded corners
  const radius = 12 * dpr;
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, radius);

  // Frosted glass effect
  ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
  ctx.fill();

  // Glowing border
  const borderAlpha = arPhase === 'normalizing' ? 0.8 : 0.4;
  const borderColor = arPhase === 'normalizing' ? '59, 130, 246' : '34, 197, 94';
  ctx.strokeStyle = `rgba(${borderColor}, ${borderAlpha})`;
  ctx.lineWidth = 2 * dpr;
  ctx.stroke();

  // Corner accents
  ctx.strokeStyle = `rgba(${borderColor}, 0.9)`;
  ctx.lineWidth = 3 * dpr;
  const cl = Math.min(r.w, r.h) * 0.08;
  [[r.x, r.y, 1, 1], [r.x + r.w, r.y, -1, 1], [r.x, r.y + r.h, 1, -1], [r.x + r.w, r.y + r.h, -1, -1]].forEach(([cx, cy, dx, dy]) => {
    ctx.beginPath();
    ctx.moveTo(cx + dx * cl, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + dy * cl);
    ctx.stroke();
  });

  ctx.restore();
}

function drawProgressiveText(ctx, r, dpr) {
  ctx.save();

  const padding = 16 * dpr;
  const x0 = r.x + padding;
  let y = r.y + padding;
  const maxW = r.w - padding * 2;

  // Layout: Name (large), Role, Company, then smaller fields
  const fieldLayout = [
    { key: 'name', size: 16 * dpr, weight: '700', color: '#ffffff' },
    { key: 'role', size: 10 * dpr, weight: '400', color: '#60a5fa' },
    { key: 'company', size: 11 * dpr, weight: '600', color: '#cbd5e1' },
    { key: '_spacer', size: 8 * dpr },
    { key: 'email', size: 9 * dpr, weight: '400', color: '#94a3b8', icon: '📧' },
    { key: 'mobile', size: 9 * dpr, weight: '400', color: '#94a3b8', icon: '📱' },
    { key: 'phone', size: 9 * dpr, weight: '400', color: '#94a3b8', icon: '📞' },
    { key: 'web', size: 9 * dpr, weight: '400', color: '#94a3b8', icon: '🌐' },
    { key: 'address', size: 8.5 * dpr, weight: '400', color: '#64748b', icon: '📍' },
    { key: 'city', size: 8.5 * dpr, weight: '400', color: '#64748b', icon: '📌' },
    { key: 'country', size: 8.5 * dpr, weight: '400', color: '#64748b', icon: '🏳️' },
  ];

  fieldLayout.forEach(fl => {
    if (fl.key === '_spacer') { y += fl.size; return; }

    const text = arDetectedFields[fl.key];
    if (!text) return;

    // Progress for typewriter effect
    if (!arFieldProgress[fl.key]) arFieldProgress[fl.key] = 0;
    arFieldProgress[fl.key] = Math.min(1, arFieldProgress[fl.key] + AR_CONFIG.typewriterSpeed);
    const progress = arFieldProgress[fl.key];
    const visibleChars = Math.floor(text.length * progress);
    const displayText = text.substring(0, visibleChars);

    if (!displayText) return;

    ctx.font = `${fl.weight} ${fl.size}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.fillStyle = fl.color;
    ctx.globalAlpha = 0.6 + progress * 0.4;

    const prefix = fl.icon ? fl.icon + ' ' : '';
    // Emoji rendering needs a slightly different font size
    if (fl.icon) {
      ctx.font = `${fl.size}px -apple-system`;
      ctx.fillText(prefix, x0, y + fl.size);
      ctx.font = `${fl.weight} ${fl.size}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.fillText(displayText, x0 + fl.size * 2, y + fl.size);
    } else {
      ctx.fillText(displayText, x0, y + fl.size);
    }

    // Cursor blink at end if still typing
    if (progress < 1) {
      const textW = ctx.measureText(prefix + displayText).width;
      if (Math.floor(Date.now() / 400) % 2 === 0) {
        ctx.fillStyle = fl.color;
        ctx.fillRect(x0 + textW + 2, y + 3, 2 * dpr, fl.size);
      }
    }

    y += fl.size + 4 * dpr;
  });

  ctx.restore();
}

function updateARProgress() {
  const requiredFields = ['name', 'company', 'email', 'mobile', 'phone', 'role', 'web', 'address', 'city', 'country'];
  const found = requiredFields.filter(k => arDetectedFields[k]);
  const pct = Math.min(100, Math.round((found.length / AR_CONFIG.minFieldsForComplete) * 100));

  $('arHudPct').textContent = Math.min(pct, 100) + '%';
  $('arHudFill').style.width = Math.min(pct, 100) + '%';

  // Update HUD field badges
  updateARHudFields();
}

function updateARHudFields() {
  const fields = [
    { key: 'name', label: 'Nome' }, { key: 'company', label: 'Azienda' },
    { key: 'email', label: 'Email' }, { key: 'mobile', label: 'Cell' },
    { key: 'phone', label: 'Tel' }, { key: 'role', label: 'Ruolo' },
    { key: 'web', label: 'Web' }, { key: 'address', label: 'Ind.' },
    { key: 'city', label: 'Città' }, { key: 'country', label: 'Paese' },
  ];
  $('arHudFields').innerHTML = fields.map(f =>
    `<span class="ar-field${arDetectedFields[f.key] ? ' found' : ''}">${f.label}</span>`
  ).join('');
}

// ── AR OCR Loop — periodically grabs frames and processes them ──
async function arScanLoop(video) {
  if (!arActive) return;

  while (arActive && arPhase !== 'complete') {
    if (arPhase === 'detecting') {
      // First pass: grab a frame and run OCR to find text
      arPhase = 'reading';
    }

    if (arPhase === 'reading') {
      const frameData = captureARFrame(video);
      if (frameData) {
        arOcrRuns++;
        try {
          let ocrResult;
          if (useServerOCR) {
            const resp = await fetch('/api/ocr', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ image: frameData.base64 }),
            });
            ocrResult = await resp.json();
            if (ocrResult.fallback) {
              useServerOCR = false;
              ocrResult = await runTesseract(frameData.dataUrl);
            }
          } else {
            ocrResult = await runTesseract(frameData.dataUrl);
          }

          if (ocrResult && ocrResult.text && ocrResult.text.trim()) {
            // Classify and merge into arDetectedFields
            mergeARFields(ocrResult.text);
            // Store best frame
            if (!arBestFrame) arBestFrame = frameData;
          }
        } catch (e) {
          console.warn('[AR] OCR error:', e);
        }
      }

      // Check if we have enough data or maxed out passes
      const fieldCount = Object.keys(arDetectedFields).filter(k => arDetectedFields[k]).length;
      if (fieldCount >= AR_CONFIG.minFieldsForComplete || arOcrRuns >= AR_CONFIG.maxOcrPasses) {
        // Move to AI normalization phase
        arPhase = 'normalizing';
        await arNormalizeWithAI();
        break;
      }

      // Wait before next scan
      await new Promise(r => setTimeout(r, AR_CONFIG.scanIntervalMs));
    }
  }
}

function captureARFrame(video) {
  try {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1920 / video.videoWidth, 1);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (!useServerOCR) preprocessImage(ctx, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
    return { dataUrl, base64: dataUrl.split(',')[1] };
  } catch (e) { return null; }
}

function mergeARFields(rawText) {
  // Quick classify and merge
  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 1);
  lines.forEach((line, idx) => {
    const result = classifyLine(line, idx, lines.length);
    if (result.type !== 'other' && result.type !== 'ignore' && result.confidence > 0.5) {
      if (!arDetectedFields[result.type] || result.confidence > 0.8) {
        arDetectedFields[result.type] = line;
        // Reset typewriter for new/updated fields
        arFieldProgress[result.type] = 0;
      }
    }
  });
}

async function arNormalizeWithAI() {
  if (!openaiApiKey || !arActive) return;

  // Build data from AR fields
  const currentData = { ...arDetectedFields };

  try {
    const userContent = [];
    const hasImage = arBestFrame && arBestFrame.dataUrl;

    if (hasImage) {
      userContent.push({
        type: 'text',
        text: `ANALIZZA questa immagine di biglietto da visita e normalizza i dati. Leggi direttamente dall'immagine, i dati OCR sono solo riferimento:\n${JSON.stringify(currentData, null, 2)}`,
      });
      userContent.push({
        type: 'image_url',
        image_url: { url: arBestFrame.dataUrl, detail: 'high' },
      });
    } else {
      userContent.push({ type: 'text', text: 'Normalizza:\n' + JSON.stringify(currentData, null, 2) });
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + openaiApiKey,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: AI_NORMALIZE_PROMPT + '\n\n⚠️ HAI L\'IMMAGINE. Leggi direttamente, OCR è secondario. Aggiungi "logo_description" se vedi un logo.' },
          { role: 'user', content: userContent },
        ],
        temperature: 0.1,
        max_tokens: 2000,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (content) {
        const jsonStr = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        const normalized = JSON.parse(jsonStr);

        // Update AR fields with normalized data — triggers typewriter for new fields
        Object.keys(normalized).forEach(key => {
          if (normalized[key] && key !== 'logo_description') {
            if (arDetectedFields[key] !== normalized[key]) {
              arFieldProgress[key] = 0; // Reset typewriter
            }
            arDetectedFields[key] = normalized[key];
          }
        });
        if (normalized.logo_description) {
          window._lastLogoDescription = normalized.logo_description;
        }

        // Also populate the main detectedBlocks for saving
        lastPhotoDataUrl = arBestFrame ? arBestFrame.dataUrl : null;
        if (lastPhotoDataUrl) $('photoPreview').src = lastPhotoDataUrl;

        const mergedText = Object.values(arDetectedFields).filter(Boolean).join('\n');
        classifyBlocks(mergedText);
        applyNormalizedData(normalized);
        $('resultSection').style.display = 'block';
        renderCleanCard();
        scanCount++;
        saveState();
      }
    }
  } catch (e) {
    console.error('[AR] AI error:', e);
  }

  // Trigger completion
  arPhase = 'complete';
  await arShowCompletion();
}

async function arShowCompletion() {
  if (!arActive) return;

  // Wait for typewriter to finish
  await new Promise(r => setTimeout(r, 1500));

  // Build the 3D card front
  const f = arDetectedFields;
  let cardHtml = '';
  if (f.name) cardHtml += `<div class="ar-cf-name">${esc(f.name)}</div>`;
  if (f.role) cardHtml += `<div class="ar-cf-role">${esc(f.role)}</div>`;
  if (f.company) cardHtml += `<div class="ar-cf-company">${esc(f.company)}</div>`;
  const lines = [
    f.email ? ['📧', f.email] : null,
    f.mobile ? ['📱', f.mobile] : null,
    f.phone ? ['📞', f.phone] : null,
    f.web ? ['🌐', f.web] : null,
    f.address ? ['📍', f.address] : null,
    (f.city || f.country) ? ['📌', [f.city, f.country].filter(Boolean).join(', ')] : null,
  ].filter(Boolean);
  lines.forEach(([icon, text]) => {
    cardHtml += `<div class="ar-cf-line"><span class="ar-cf-icon">${icon}</span>${esc(text)}</div>`;
  });
  if (window._lastLogoDescription) {
    cardHtml += `<div class="ar-cf-logo">🏷️ ${esc(window._lastLogoDescription)}</div>`;
  }

  $('arCardFront').innerHTML = cardHtml;

  // Show card with entrance animation
  const card = $('arCompleteCard');
  card.classList.add('visible');

  if (navigator.vibrate) navigator.vibrate([100, 80, 100, 80, 200]);
  $('arHudPct').textContent = '100%';
  $('arHudFill').style.width = '100%';
  $('arHud').querySelector('.ar-hud-label').textContent = '✅ COMPLETO';

  // Flip to green check after 2.5s
  setTimeout(() => {
    card.classList.add('flip');
    toast('✅ Biglietto acquisito al 100%!', 'success');
  }, 2500);

  // Clean up after 5s
  setTimeout(() => {
    $('arHud').style.display = 'none';
    card.classList.remove('visible', 'flip');
    stopARScan();
  }, 5500);
}

