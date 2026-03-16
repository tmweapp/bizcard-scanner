// ─── REMOTE PHONE (QR + PeerJS) ──────────────────────────────
function initRemoteMode() {
  // KEEP existing session if peer is alive — don't regenerate!
  if (peer && !peer.destroyed && sessionId) {
    $('sessionCode').textContent = sessionId;
    return; // Peer is already connected, don't regenerate
  }

  // Generate session ID only if we don't have one
  if (!sessionId) {
    sessionId = Math.random().toString(36).substring(2, 8).toUpperCase();
  }
  $('sessionCode').textContent = sessionId;
  const baseUrl = location.origin + '/phone?s=' + sessionId;
  $('qrUrl').textContent = baseUrl;

  generateQR(baseUrl);
  setupPeer();
}

function generateQR(url) {
  const canvas = $('qrCanvas');
  const opts = { width: 200, margin: 2, color: { dark: '#000000', light: '#ffffff' }, errorCorrectionLevel: 'M' };

  // Primary: use preloaded QRCode library
  if (window.QRCode && typeof QRCode.toCanvas === 'function') {
    QRCode.toCanvas(canvas, url, opts, (err) => {
      if (err) {
        console.warn('[BizCard] QRCode.toCanvas failed:', err);
        generateQRFallback(url);
      }
    });
    return;
  }

  // Fallback: external QR API
  generateQRFallback(url);
}

function generateQRFallback(url) {
  const canvas = $('qrCanvas');
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    canvas.width = 200;
    canvas.height = 200;
    canvas.getContext('2d').drawImage(img, 0, 0, 200, 200);
  };
  img.onerror = () => {
    // Last resort: draw text on canvas
    const ctx = canvas.getContext('2d');
    canvas.width = 200; canvas.height = 200;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 200, 200);
    ctx.fillStyle = '#333'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('QR non disponibile', 100, 85);
    ctx.fillText('Usa il link sotto:', 100, 105);
    ctx.font = '9px monospace';
    ctx.fillStyle = '#0066cc';
    // Word wrap the URL
    const words = url.split('/');
    let y = 125;
    words.forEach(w => { if (w) { ctx.fillText(w, 100, y); y += 14; } });
  };
  img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(url);
}

function setupPeer() {
  if (peer) {
    try { peer.destroy(); } catch (e) {}
    peer = null;
  }
  peerRetries = 0;

  $('qrDot').className = 'dot waiting';
  $('qrStatusText').textContent = 'Connessione al server PeerJS...';

  peer = new Peer('bizcard-' + sessionId, {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
      ]
    },
    debug: 0,
  });

  peer.on('open', () => {
    $('qrStatusText').textContent = 'Pronto — scansiona il QR dal telefono';
    peerRetries = 0;
  });

  peer.on('connection', (conn) => {
    peerConn = conn;
    $('qrDot').className = 'dot connected';
    $('qrStatusText').textContent = '✅ Telefono connesso!';
    // Only show toast on first connection, not reconnections
    if (!phoneConnected) {
      toast('📱 Telefono connesso!', 'success');
      phoneConnected = true;
    }
    $('btnRemoteSmartScan').disabled = false;

    conn.on('data', (data) => {
      if (data && data.type === 'photo') {
        try { conn.send({ type: 'ack' }); } catch (e) {}
        // Preprocess remote photo same as local for equal OCR quality
        processRemotePhoto(data.image);
      }
    });

    conn.on('close', () => {
      $('qrDot').className = 'dot waiting';
      $('qrStatusText').textContent = '📱 Telefono disconnesso — in attesa di riconnessione...';
      peerConn = null;
      // Don't reset phoneConnected so reconnection won't spam toasts
    });
  });

  peer.on('error', (err) => {
    console.warn('[BizCard] Peer error:', err.type);
    $('qrStatusText').textContent = 'Errore: ' + err.type;

    peerRetries++;
    if (peerRetries < MAX_PEER_RETRIES) {
      setTimeout(() => setupPeer(), Math.min(3000 * peerRetries, 15000));
    } else {
      $('qrStatusText').textContent = '❌ Connessione fallita. Ricarica la pagina.';
    }
  });
}

function cleanupPeer() {
  if (peerConn) { try { peerConn.close(); } catch (e) {} peerConn = null; }
  if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
  phoneConnected = false;
}

// ─── PHONE BRIDGE — Connect to Desktop as Remote Phone ────────
// When the app opens with ?s=XXXXXX, it acts as a remote phone:
// same full app, but also sends captured photos to the desktop.

function initPhoneBridge() {
  const params = new URLSearchParams(location.search);
  const remoteSession = (params.get('s') || params.get('session') || '').toUpperCase();
  if (!remoteSession) return; // No session param = normal desktop mode

  isPhoneBridge = true;
  console.log('[PhoneBridge] Session detected:', remoteSession);

  // Show persistent status bar at top
  const banner = document.createElement('div');
  banner.id = 'phoneBridgeBanner';
  banner.style.cssText = 'background:linear-gradient(135deg,var(--accent),#7c3aed);padding:10px 16px;display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:.82rem;z-index:99;';
  banner.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px">
      <div id="pbDot" style="width:10px;height:10px;border-radius:50%;background:var(--orange);animation:pulse 1s infinite;flex-shrink:0"></div>
      <span id="pbStatus">Connessione al desktop...</span>
    </div>
    <span style="font-size:.72rem;color:rgba(255,255,255,.7)">Sessione: ${remoteSession}</span>
  `;
  // Insert after header
  const header = document.querySelector('header');
  header.parentNode.insertBefore(banner, header.nextSibling);

  // Connect to the desktop peer
  connectPhoneBridge(remoteSession);
}

function connectPhoneBridge(remoteSession, retries = 0) {
  const MAX_RETRIES = 15;
  if (retries >= MAX_RETRIES) {
    updatePhoneBridgeStatus('error', '❌ Connessione fallita dopo ' + MAX_RETRIES + ' tentativi');
    return;
  }

  const phonePeer = new Peer({
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
      ]
    },
    debug: 0,
  });

  phonePeer.on('open', (myId) => {
    console.log('[PhoneBridge] My ID:', myId, '→ connecting to bizcard-' + remoteSession);

    const conn = phonePeer.connect('bizcard-' + remoteSession);
    if (!conn) {
      updatePhoneBridgeStatus('error', 'Impossibile connettersi');
      retries++;
      setTimeout(() => connectPhoneBridge(remoteSession, retries), Math.min(2000 + retries * 1500, 15000));
      return;
    }

    conn.on('open', () => {
      phoneBridgeConn = conn;
      updatePhoneBridgeStatus('connected', '✅ Connesso al desktop — le foto vengono inviate automaticamente');
      toast('📱 Connesso al desktop! Le foto catturate saranno inviate.', 'success');
    });

    conn.on('close', () => {
      phoneBridgeConn = null;
      updatePhoneBridgeStatus('error', '⚠️ Desktop disconnesso — riconnessione...');
      retries++;
      setTimeout(() => connectPhoneBridge(remoteSession, retries), 3000);
    });

    conn.on('data', (data) => {
      if (data && data.type === 'ack') {
        console.log('[PhoneBridge] ACK received from desktop');
      }
    });

    conn.on('error', (e) => {
      console.warn('[PhoneBridge] Connection error:', e);
      updatePhoneBridgeStatus('error', 'Errore: ' + (e.type || e.message));
    });
  });

  phonePeer.on('error', (e) => {
    console.warn('[PhoneBridge] Peer error:', e.type);
    if (e.type === 'peer-unavailable') {
      updatePhoneBridgeStatus('error', 'Desktop non trovato — verifica che sia aperto su "Telefono remoto"');
    } else {
      updatePhoneBridgeStatus('error', 'Errore: ' + e.type);
    }
    retries++;
    setTimeout(() => connectPhoneBridge(remoteSession, retries), Math.min(2000 + retries * 1500, 15000));
  });
}

function updatePhoneBridgeStatus(state, text) {
  const dot = $('pbDot');
  const status = $('pbStatus');
  if (!dot || !status) return;
  status.textContent = text;
  if (state === 'connected') {
    dot.style.background = 'var(--green)';
    dot.style.animation = 'none';
    dot.style.boxShadow = '0 0 8px rgba(34,197,94,.5)';
  } else if (state === 'error') {
    dot.style.background = 'var(--red)';
    dot.style.animation = 'none';
  } else {
    dot.style.background = 'var(--orange)';
    dot.style.animation = 'pulse 1s infinite';
  }
}

// Send photo to desktop when this is a phone bridge
function sendPhotoToDesktop(base64) {
  if (!isPhoneBridge || !phoneBridgeConn || !phoneBridgeConn.open) return;
  try {
    phoneBridgeConn.send({
      type: 'photo',
      image: base64,
      timestamp: Date.now(),
    });
    console.log('[PhoneBridge] Photo sent to desktop (' + Math.round(base64.length / 1024) + 'KB)');
    toast('📤 Foto inviata al desktop', 'info');
  } catch (e) {
    console.warn('[PhoneBridge] Send error:', e);
  }
}

// ─── PROCESS REMOTE PHOTO (same quality as local) ─────────────
function processRemotePhoto(base64) {
  // If remote Smart Scan is active, accumulate instead of processing
  if (remoteSmartActive) {
    remoteSmartBuffer.push(base64);
    const count = remoteSmartBuffer.length;
    toast(`📸 Foto ${count} ricevuta — continua a scattare!`, 'info');
    updateLiveProgress((count / 5) * 45);
    $('ssStatus').textContent = '📸 Foto ' + count + '/5 ricevute';
    $('ssDetail').textContent = `${count} foto ricevute — invia ancora oppure premi "Analizza"`;

    // Auto-trigger analysis if we have enough
    if (count >= 5) {
      $('ssDetail').textContent = `${count} foto — pronto per l'analisi! Premi "Analizza" o invia altre foto.`;
    }
    return;
  }

  toast('📸 Foto ricevuta — elaborazione...', 'info');

  // Load base64 into Image, then draw to canvas for preprocessing
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    if (!useServerOCR) preprocessImage(ctx, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
    const newBase64 = dataUrl.split(',')[1];

    processOCR(newBase64, dataUrl);
  };
  img.onerror = () => {
    const dataUrl = 'data:image/jpeg;base64,' + base64;
    processOCR(base64, dataUrl);
  };
  img.src = 'data:image/jpeg;base64,' + base64;
}

// ─── REMOTE SMART SCAN ───────────────────────────────────────
async function startRemoteSmartScan() {
  if (!openaiApiKey) {
    toast('Inserisci la API Key OpenAI per Smart Scan', 'error');
    $('openaiKeyInput').focus();
    return;
  }
  if (!peerConn || !peerConn.open) {
    toast('Collega prima il telefono', 'error');
    return;
  }

  remoteSmartBuffer = [];
  remoteSmartActive = true;

  // Show overlay
  $('smartScanOverlay').style.display = 'flex';
  $('ssStatus').textContent = '📱 Scatta foto dal telefono!';
  $('ssDetail').textContent = 'Scatta 3-5 foto del biglietto da diversi angoli';
  updateLiveProgress(0);
  showLiveCard();

  // Change stop button to analyze button
  $('btnSmartScanStop').textContent = '🔍 Analizza';
  $('btnSmartScanStop').onclick = () => finishRemoteSmartScan();

  toast('🧠 Smart Scan remoto avviato — scatta foto dal telefono!', 'info');
}

async function finishRemoteSmartScan() {
  remoteSmartActive = false;
  const photos = remoteSmartBuffer;
  remoteSmartBuffer = [];

  if (photos.length === 0) {
    toast('Nessuna foto ricevuta', 'error');
    $('smartScanOverlay').style.display = 'none';
    return;
  }

  $('ssStatus').textContent = '🤖 OCR su ' + photos.length + ' foto...';
  $('btnSmartScanStop').textContent = '⏹ Interrompi';
  $('btnSmartScanStop').onclick = () => { smartScanAborted = true; };

  smartScanAborted = false;

  try {
    const ocrResults = [];

    for (let i = 0; i < photos.length; i++) {
      if (smartScanAborted) break;

      $('ssDetail').textContent = `OCR foto ${i + 1}/${photos.length}...`;
      updateSmartScanRing(45 + (i / photos.length) * 35);

      // Load image, preprocess, OCR
      const dataUrl = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          if (!useServerOCR) preprocessImage(ctx, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.88));
        };
        img.onerror = reject;
        img.src = 'data:image/jpeg;base64,' + photos[i];
      });

      if (i === 0) {
        lastPhotoDataUrl = dataUrl;
        $('photoPreview').src = dataUrl;
      }

      const base64 = dataUrl.split(',')[1];
      try {
        let result;
        if (useServerOCR) {
          const resp = await fetch('/api/ocr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: base64 }),
          });
          result = await resp.json();
          if (result.fallback) { useServerOCR = false; result = await runTesseract(dataUrl); }
        } else {
          result = await runTesseract(dataUrl);
        }
        if (result && result.text) ocrResults.push(result);
      } catch (e) { console.warn('[SmartScan Remote] OCR error:', e); }
    }

    if (smartScanAborted || ocrResults.length === 0) {
      toast(smartScanAborted ? 'Interrotto' : 'Nessun testo rilevato', smartScanAborted ? 'info' : 'error');
      $('smartScanOverlay').style.display = 'none';
      return;
    }

    // Merge + classify
    $('ssStatus').textContent = '🔀 Fusione risultati...';
    updateSmartScanRing(85);

    const mergedText = mergeOcrResults(ocrResults);
    scanCount++;
    saveState();

    classifyBlocks(mergedText);

    // AI Normalize
    if (openaiApiKey && detectedBlocks.length > 0) {
      $('ssStatus').textContent = '✨ Normalizzazione AI...';
      updateSmartScanRing(92);
      await normalizeWithAI();
    }

    // Auto-start session on first scan
    if (!currentSession) startSession();
    currentSession.photoCount += photos.length;

    // Show clean contact card
    $('resultSection').style.display = 'block';
    renderCleanCard();

    updateSmartScanRing(100);
    $('ssStatus').textContent = '✅ Completato!';
    const fieldCount = detectedBlocks.filter(b => b.type !== 'other' && b.type !== 'ignore').length;
    $('ssDetail').textContent = `${fieldCount} campi da ${photos.length} foto`;
    toast('🧠 Smart Scan completato — ' + fieldCount + ' campi!', 'success');
    if (navigator.vibrate) navigator.vibrate([100, 50, 200]);

    setTimeout(() => { $('smartScanOverlay').style.display = 'none'; }, 2500);
  } catch (e) {
    console.error('[SmartScan Remote]', e);
    toast('Errore: ' + e.message, 'error');
    $('smartScanOverlay').style.display = 'none';
  }
}

