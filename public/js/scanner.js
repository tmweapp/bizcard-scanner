// ─── CHECK SERVER OCR API ─────────────────────────────────────
async function checkOcrApi() {
  try {
    // Send minimal probe request
    const r = await fetch('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ probe: true }),
    });
    const d = await r.json();
    if (d.fallback) {
      useServerOCR = false;
      $('ocrApiStatus').textContent = '⚠️ Nessuna API key — Tesseract.js locale';
      $('ocrEngineActive').textContent = 'Tesseract.js (browser)';
    } else {
      useServerOCR = true;
      serverEngine = d.engine || 'server';
      $('ocrApiStatus').textContent = '✅ API configurata';
      $('ocrEngineActive').textContent = serverEngine;
    }
  } catch (e) {
    useServerOCR = false;
    $('ocrApiStatus').textContent = '⚠️ API non raggiungibile';
    $('ocrEngineActive').textContent = 'Tesseract.js (browser)';
  }
}

async function initTesseractFallback() {
  try {
    tesseractWorker = await Tesseract.createWorker('ita+eng', 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          const p = $('ocrProgress');
          if (p) p.style.width = Math.round(m.progress * 100) + '%';
        }
      }
    });
    tesseractReady = true;
  } catch (e) {
    console.warn('[BizCard] Tesseract init failed:', e);
  }
}

// ─── TAB NAVIGATION ───────────────────────────────────────────
function initTabs() {
  $$('nav button').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('nav button').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
      $$('.panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      $('panel-' + btn.dataset.tab).classList.add('active');

      if (btn.dataset.tab === 'contacts') renderContacts();
      if (btn.dataset.tab === 'export') updateExportState();
      if (btn.dataset.tab === 'settings') updateStats();
    });
  });
}

// ─── MODE SWITCHING ───────────────────────────────────────────
function initModes() {
  $$('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode));
    btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchMode(btn.dataset.mode); } });
  });
}

function switchMode(mode) {
  // Cleanup previous mode — but DON'T destroy peer (keep phone connected!)
  // if (currentMode === 'remote' && mode !== 'remote') cleanupPeer();
  if (currentMode === 'local' && mode !== 'local') stopCamera();

  currentMode = mode;
  $$('.mode-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-checked', 'false'); });
  document.querySelector(`[data-mode="${mode}"]`).classList.add('active');
  document.querySelector(`[data-mode="${mode}"]`).setAttribute('aria-checked', 'true');

  $('viewLocal').style.display = mode === 'local' ? 'block' : 'none';
  $('viewRemote').style.display = mode === 'remote' ? 'block' : 'none';
  $('viewUpload').style.display = mode === 'upload' ? 'block' : 'none';

  if (mode === 'local') startCamera();
  if (mode === 'remote') initRemoteMode();
}

// ─── LOCAL CAMERA ─────────────────────────────────────────────
function initScanner() {
  startCamera();
  $('btnSmartScan').addEventListener('click', startSmartScan);
  $('btnSmartScanStop').addEventListener('click', () => { smartScanAborted = true; });
  $('btnFlip').addEventListener('click', () => { facingMode = facingMode === 'environment' ? 'user' : 'environment'; startCamera(); });
  $('btnTorch').addEventListener('click', toggleTorch);

  // Upload handlers
  const dz = $('dropZone');
  const fi = $('fileInputUpload');
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('dragover'); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith('image/')) processFile(f); });
  fi.addEventListener('change', (e) => { const f = e.target.files[0]; if (f) processFile(f); fi.value = ''; });

  // Session controls
  $('btnScanNext').addEventListener('click', () => { autoSaveAndContinue(); scanNext(); });
  $('btnEndSession').addEventListener('click', () => { autoSaveAndContinue(); endSession(); });
  $('btnNewSession').addEventListener('click', () => { $('sessionSummary').style.display = 'none'; scanNext(); });
  $('btnExportSession').addEventListener('click', exportSessionData);
  $('btnRemoteSmartScan').addEventListener('click', startRemoteSmartScan);

  // Photo preview zoom toggle
  $('photoPreview').addEventListener('click', function() { this.classList.toggle('zoomed'); });
}

async function startCamera() {
  const v = $('video'), ph = $('placeholder'), bf = $('btnFlip'), bt = $('btnTorch');
  try {
    if (currentStream) currentStream.getTracks().forEach(t => t.stop());
    const constraints = {
      video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    v.srcObject = stream;
    currentStream = stream;
    v.style.display = 'block';
    ph.style.display = 'none';
    bf.style.display = 'inline-flex';
    $('btnSmartScan').disabled = false;

    // Check torch support
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    bt.style.display = caps.torch ? 'inline-flex' : 'none';
  } catch (e) {
    console.warn('[Camera] Access failed:', e.message);
    v.style.display = 'none';
    ph.style.display = 'flex';
    bf.style.display = 'none';
    bt.style.display = 'none';
    // Enable scan button anyway — user can switch to Upload or Remote mode
    $('btnSmartScan').disabled = false;
  }
}

function stopCamera() {
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
}

async function toggleTorch() {
  if (!currentStream) return;
  const track = currentStream.getVideoTracks()[0];
  torchEnabled = !torchEnabled;
  try {
    await track.applyConstraints({ advanced: [{ torch: torchEnabled }] });
    $('btnTorch').textContent = torchEnabled ? '🔦 On' : '🔦 Flash';
  } catch (e) { torchEnabled = false; }
}

function captureLocalPhoto() {
  const video = $('video');
  if (!video.srcObject || video.videoWidth === 0) return;

  // Flash animation
  const guide = $('cameraGuide');
  guide.classList.add('flash');
  setTimeout(() => guide.classList.remove('flash'), 400);

  // Haptic feedback
  if (navigator.vibrate) navigator.vibrate(50);

  const canvas = document.createElement('canvas');
  const scale = Math.min(1920 / video.videoWidth, 1);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // Preprocess for better OCR
  if (!useServerOCR) preprocessImage(ctx, canvas.width, canvas.height);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
  const base64 = dataUrl.split(',')[1];

  // Phone bridge: also send to desktop
  if (isPhoneBridge) sendPhotoToDesktop(base64);

  processOCR(base64, dataUrl);
}

function processFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    const base64 = dataUrl.split(',')[1];
    if (isPhoneBridge) sendPhotoToDesktop(base64);
    processOCR(base64, dataUrl);
  };
  reader.readAsDataURL(file);
}

// ─── IMAGE PREPROCESSING (for Tesseract) ──────────────────────
function preprocessImage(ctx, w, h) {
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;

  // 1. Auto-contrast (histogram stretch)
  let min = 255, max = 0;
  for (let i = 0; i < data.length; i += 16) { // sample every 4th pixel for speed
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (gray < min) min = gray;
    if (gray > max) max = gray;
  }
  const range = (max - min) || 1;
  if (range < 200) { // only if low contrast
    const factor = 255 / range;
    for (let i = 0; i < data.length; i += 4) {
      data[i]     = Math.min(255, Math.max(0, (data[i] - min) * factor));
      data[i + 1] = Math.min(255, Math.max(0, (data[i + 1] - min) * factor));
      data[i + 2] = Math.min(255, Math.max(0, (data[i + 2] - min) * factor));
    }
  }

  // 2. Slight sharpen via unsharp mask approximation
  // We use a simple contrast boost instead of full convolution for performance
  const sharpenAmount = 0.3;
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const midDiff = gray - 128;
    data[i]     = Math.min(255, Math.max(0, data[i] + midDiff * sharpenAmount));
    data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + midDiff * sharpenAmount));
    data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + midDiff * sharpenAmount));
  }

  ctx.putImageData(imageData, 0, 0);
}

