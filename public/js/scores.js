// ════════════════════════════════════════════════════════════════
//  BIZCARD MUSIC SCORE v1 — Multi-page acquisition and study
//  Storage: IndexedDB (images never enter contact localStorage)
//  AI: OpenAI Responses API with image inputs + Structured Outputs
// ════════════════════════════════════════════════════════════════

const SCORE_DB_NAME = 'bizcard_music_scores';
const SCORE_DB_VERSION = 1;
const SCORE_STORE = 'scores';
const SCORE_PRIMARY_MODEL = 'gpt-5.6';
const SCORE_FALLBACK_MODEL = 'gpt-4o';

let scoreDbPromise = null;
let scoreLibrary = [];
let scoreDraft = null;
let activeScore = null;
let scorePageIndex = 0;
let scoreZoom = 100;
let scoreStream = null;
let scoreCaptureActive = false;
let scoreSelection = null; // normalized {x, y, w, h}
let scoreSelectionMode = false;
let scoreSelectionStart = null;
let scoreSelectionCrop = '';
let scoreLastExplanation = null;
let scoreAudioContext = null;
let scoreAudioNodes = [];
let scoreRemoteTimer = null;
let practiceGroups = [];
let practiceGroupIndex = 0;
let practiceMatched = new Set();
let practiceCorrect = 0;
let practiceErrors = 0;
let practicePaused = true;
let practiceMidiAccess = null;
let practiceMicStream = null;
let practiceMicContext = null;
let practiceMicFrame = 0;
let practiceLastMicMidi = null;
let practiceLastMicAt = 0;
let practiceLastAnalysisAt = 0;

const SCORE_RECOGNITION_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    composer: { type: 'string' },
    work_number: { type: 'string' },
    movement: { type: 'string' },
    key: { type: 'string' },
    time_signature: { type: 'string' },
    tempo: { type: 'string' },
    genre: { type: 'string' },
    instrumentation: { type: 'string' },
    confidence: { type: 'number' },
    evidence: { type: 'array', items: { type: 'string' } },
    uncertainty: { type: 'string' },
    page_notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          page_number: { type: 'number' },
          summary: { type: 'string' },
        },
        required: ['page_number', 'summary'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'title', 'composer', 'work_number', 'movement', 'key', 'time_signature',
    'tempo', 'genre', 'instrumentation', 'confidence', 'evidence',
    'uncertainty', 'page_notes',
  ],
  additionalProperties: false,
};

const SCORE_EXPLANATION_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    notation: { type: 'string' },
    hands: {
      type: 'object',
      properties: {
        right: { type: 'string' },
        left: { type: 'string' },
      },
      required: ['right', 'left'],
      additionalProperties: false,
    },
    rhythm: { type: 'string' },
    expression: {
      type: 'object',
      properties: {
        phrasing: { type: 'string' },
        dynamics: { type: 'string' },
        articulation: { type: 'string' },
        pedal: { type: 'string' },
      },
      required: ['phrasing', 'dynamics', 'articulation', 'pedal'],
      additionalProperties: false,
    },
    fingering: { type: 'string' },
    study_steps: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
    playback: {
      type: 'object',
      properties: {
        bpm: { type: 'number' },
        time_signature: { type: 'string' },
        certainty: { type: 'string' },
        events: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              midi: { type: 'number' },
              start_beat: { type: 'number' },
              duration_beats: { type: 'number' },
              velocity: { type: 'number' },
              hand: { type: 'string', enum: ['right', 'left', 'unknown'] },
              system: { type: 'number' },
              x: { type: 'number' },
              y: { type: 'number' },
            },
            required: ['midi', 'start_beat', 'duration_beats', 'velocity', 'hand', 'system', 'x', 'y'],
            additionalProperties: false,
          },
        },
      },
      required: ['bpm', 'time_signature', 'certainty', 'events'],
      additionalProperties: false,
    },
  },
  required: [
    'summary', 'notation', 'hands', 'rhythm', 'expression', 'fingering',
    'study_steps', 'warnings', 'confidence', 'playback',
  ],
  additionalProperties: false,
};

// ─── INITIALIZATION ──────────────────────────────────────────
function initScores() {
  $('btnNewScore').addEventListener('click', startNewScore);
  $('btnNewScoreEmpty').addEventListener('click', startNewScore);
  $('btnScoreCancel').addEventListener('click', returnToScoreLibrary);
  $('btnScoreBack').addEventListener('click', returnToScoreLibrary);
  $('btnScoreCamera').addEventListener('click', startScoreCamera);
  $('btnScoreCapture').addEventListener('click', captureScorePage);
  $('scoreFileInput').addEventListener('change', handleScoreFiles);
  $('btnScoreClearPages').addEventListener('click', clearScoreDraftPages);
  $('btnScoreSaveOnly').addEventListener('click', () => saveDraftScore(true));
  $('btnScoreRecognize').addEventListener('click', recognizeAndSaveScore);
  $('btnScorePrev').addEventListener('click', () => showScorePage(scorePageIndex - 1));
  $('btnScoreNext').addEventListener('click', () => showScorePage(scorePageIndex + 1));
  $('scoreZoom').addEventListener('input', (e) => setScoreZoom(Number(e.target.value)));
  $('btnScoreSelect').addEventListener('click', toggleScoreSelectionMode);
  $('btnScoreExplain').addEventListener('click', explainScoreSelection);
  $('btnScoreDelete').addEventListener('click', deleteActiveScore);
  $('btnScorePlay').addEventListener('click', playScoreSelection);
  $('btnScoreStop').addEventListener('click', stopScorePlayback);
  $('btnScorePractice').addEventListener('click', openScorePractice);
  $('btnScorePracticeClose').addEventListener('click', closeScorePractice);
  $('btnPracticeMidi').addEventListener('click', startPracticeMidi);
  $('btnPracticeMic').addEventListener('click', startPracticeMicrophone);
  $('btnPracticeRestart').addEventListener('click', resetScorePractice);
  $('btnPracticePause').addEventListener('click', toggleScorePracticePause);

  $$('[data-score-question]').forEach(btn => {
    btn.addEventListener('click', () => {
      $('scoreQuestion').value = btn.dataset.scoreQuestion;
      if (scoreSelection) $('btnScoreExplain').disabled = false;
    });
  });

  const layer = $('scoreSelectionLayer');
  layer.addEventListener('pointerdown', beginScoreSelection);
  layer.addEventListener('pointermove', moveScoreSelection);
  layer.addEventListener('pointerup', finishScoreSelection);
  layer.addEventListener('pointercancel', finishScoreSelection);

  scoreDbPromise = openScoreDatabase();
  refreshScoreLibrary();
}

function scoreOnTabOpen() {
  if (currentMode === 'local') stopCamera();
  const captureVisible = $('scoreCaptureView')?.style.display !== 'none';
  if (scoreDraft && captureVisible) {
    scoreCaptureActive = true;
    ensureScoreRemoteConnection();
  }
  refreshScoreLibrary();
}

function scoreOnTabClose() {
  scoreCaptureActive = false;
  stopScoreCamera();
  closeScorePractice();
}

// ─── INDEXEDDB STORAGE ───────────────────────────────────────
function openScoreDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SCORE_DB_NAME, SCORE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SCORE_STORE)) {
        const store = db.createObjectStore(SCORE_STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Archivio spartiti non disponibile'));
  });
}

async function scoreDbGetAll() {
  const db = await scoreDbPromise;
  return new Promise((resolve, reject) => {
    const req = db.transaction(SCORE_STORE, 'readonly').objectStore(SCORE_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function scoreDbPut(score) {
  const db = await scoreDbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SCORE_STORE, 'readwrite');
    tx.objectStore(SCORE_STORE).put(score);
    tx.oncomplete = () => resolve(score);
    tx.onerror = () => reject(tx.error);
  });
}

async function scoreDbDelete(id) {
  const db = await scoreDbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SCORE_STORE, 'readwrite');
    tx.objectStore(SCORE_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// ─── LIBRARY ─────────────────────────────────────────────────
async function refreshScoreLibrary() {
  try {
    scoreLibrary = await scoreDbGetAll();
    scoreLibrary.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    renderScoreLibrary();
  } catch (e) {
    console.error('[Scores] IndexedDB:', e);
    $('scoreLibrary').innerHTML = '<div class="score-confidence">Archivio spartiti non disponibile in questo browser.</div>';
  }
}

function renderScoreLibrary() {
  const list = $('scoreLibrary');
  const empty = $('scoreEmpty');
  if (!scoreLibrary.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  list.innerHTML = scoreLibrary.map(score => {
    const meta = score.metadata || {};
    const title = meta.title || score.manualTitle || 'Spartito senza titolo';
    const composer = meta.composer || score.manualComposer || 'Compositore non riconosciuto';
    const cover = score.pages?.[0]?.thumbDataUrl || score.pages?.[0]?.dataUrl || '';
    const details = [meta.key, meta.tempo, meta.instrumentation].filter(Boolean).slice(0, 2);
    return `<article class="score-library-card" data-score-id="${esc(score.id)}" tabindex="0">
      <div class="score-library-cover">
        ${cover ? `<img src="${cover}" alt="">` : ''}
        <span class="score-library-pages">${score.pages?.length || 0} pagine</span>
      </div>
      <div class="score-library-info">
        <h3>${esc(title)}</h3>
        <p>${esc(composer)}</p>
        <div class="score-library-meta">${details.map(d => `<span>${esc(d)}</span>`).join('')}</div>
      </div>
    </article>`;
  }).join('');

  list.querySelectorAll('[data-score-id]').forEach(card => {
    const open = () => openScore(card.dataset.scoreId);
    card.addEventListener('click', open);
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') open(); });
  });
}

function showScoreView(view) {
  $('scoreLibraryView').style.display = view === 'library' ? 'block' : 'none';
  $('scoreCaptureView').style.display = view === 'capture' ? 'block' : 'none';
  $('scoreViewerView').style.display = view === 'viewer' ? 'block' : 'none';
}

function returnToScoreLibrary() {
  scoreCaptureActive = false;
  if (scoreRemoteTimer) clearInterval(scoreRemoteTimer);
  scoreRemoteTimer = null;
  scoreDraft = null;
  activeScore = null;
  scoreSelection = null;
  scoreSelectionCrop = '';
  stopScoreCamera();
  stopScorePlayback();
  closeScorePractice();
  showScoreView('library');
  refreshScoreLibrary();
}

// ─── MULTI-PAGE ACQUISITION ──────────────────────────────────
function startNewScore() {
  scoreDraft = {
    id: 'score_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    manualTitle: '',
    manualComposer: '',
    metadata: null,
    pages: [],
    annotations: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  scoreCaptureActive = true;
  $('scoreTitleInput').value = '';
  $('scoreComposerInput').value = '';
  showScoreView('capture');
  renderScoreDraftPages();
  ensureScoreRemoteConnection();
}

async function startScoreCamera() {
  try {
    stopCamera();
    stopScoreCamera();
    scoreStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 2560 }, height: { ideal: 1920 } },
      audio: false,
    });
    const video = $('scoreVideo');
    video.srcObject = scoreStream;
    video.style.display = 'block';
    $('scoreCameraPlaceholder').style.display = 'none';
    document.querySelector('.score-camera-guide').style.display = 'block';
    $('btnScoreCapture').disabled = false;
    $('btnScoreCamera').textContent = 'Riavvia camera';
  } catch (e) {
    toast('Fotocamera non disponibile: ' + e.message, 'error');
  }
}

function stopScoreCamera() {
  if (scoreStream) scoreStream.getTracks().forEach(track => track.stop());
  scoreStream = null;
  const video = $('scoreVideo');
  if (video) { video.srcObject = null; video.style.display = 'none'; }
  if ($('scoreCameraPlaceholder')) $('scoreCameraPlaceholder').style.display = 'grid';
  const guide = document.querySelector('.score-camera-guide');
  if (guide) guide.style.display = 'none';
  if ($('btnScoreCapture')) $('btnScoreCapture').disabled = true;
}

async function captureScorePage() {
  const video = $('scoreVideo');
  if (!video.srcObject || !video.videoWidth) return;
  const canvas = document.createElement('canvas');
  const scale = Math.min(2560 / video.videoWidth, 1);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', .9);
  await addScorePageDataUrl(dataUrl, 'camera');
  if (navigator.vibrate) navigator.vibrate(70);
}

async function handleScoreFiles(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = '';
  if (!files.length) return;
  $('scoreProcessing').style.display = 'flex';
  $('scoreProcessingText').textContent = `Importazione di ${files.length} pagine…`;
  for (const file of files) {
    try {
      const dataUrl = await readFileAsDataUrl(file);
      await addScorePageDataUrl(dataUrl, 'file', false);
    } catch (e) {
      toast('Impossibile leggere ' + file.name, 'error');
    }
  }
  $('scoreProcessing').style.display = 'none';
  renderScoreDraftPages();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function addScorePageDataUrl(dataUrl, source, rerender = true) {
  if (!scoreDraft || !scoreCaptureActive) return;
  try {
    const normalized = await resizeScoreImage(dataUrl, 2400, .9);
    const thumb = await resizeScoreImage(normalized.dataUrl, 360, .72);
    scoreDraft.pages.push({
      id: 'page_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      dataUrl: normalized.dataUrl,
      thumbDataUrl: thumb.dataUrl,
      width: normalized.width,
      height: normalized.height,
      source,
      createdAt: new Date().toISOString(),
    });
    scoreDraft.updatedAt = new Date().toISOString();
    if (rerender) renderScoreDraftPages();
  } catch (e) {
    console.error('[Scores] Image import:', e);
    toast('Formato immagine non supportato dal browser', 'error');
  }
}

function resizeScoreImage(dataUrl, maxDimension, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(maxDimension / Math.max(img.naturalWidth, img.naturalHeight), 1);
      const width = Math.max(1, Math.round(img.naturalWidth * scale));
      const height = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      resolve({ dataUrl: canvas.toDataURL('image/jpeg', quality), width, height });
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function renderScoreDraftPages() {
  if (!scoreDraft) return;
  const pages = scoreDraft.pages;
  $('scorePageCounter').textContent = pages.length + (pages.length === 1 ? ' pagina' : ' pagine');
  $('btnScoreSaveOnly').disabled = pages.length === 0;
  $('btnScoreRecognize').disabled = pages.length === 0;
  $('scoreDraftPages').innerHTML = pages.map((page, index) => `
    <div class="score-draft-page" data-page-index="${index}">
      <img src="${page.thumbDataUrl}" alt="Pagina ${index + 1}">
      <span class="score-draft-number">${index + 1}</span>
      <div class="score-draft-actions">
        <button data-score-page-action="left" title="Sposta a sinistra" ${index === 0 ? 'disabled' : ''}>←</button>
        <button data-score-page-action="delete" title="Elimina">🗑</button>
        <button data-score-page-action="right" title="Sposta a destra" ${index === pages.length - 1 ? 'disabled' : ''}>→</button>
      </div>
    </div>`).join('');

  $('scoreDraftPages').querySelectorAll('[data-score-page-action]').forEach(button => {
    button.addEventListener('click', () => {
      const card = button.closest('[data-page-index]');
      const index = Number(card.dataset.pageIndex);
      const action = button.dataset.scorePageAction;
      if (action === 'delete') scoreDraft.pages.splice(index, 1);
      if (action === 'left' && index > 0) [scoreDraft.pages[index - 1], scoreDraft.pages[index]] = [scoreDraft.pages[index], scoreDraft.pages[index - 1]];
      if (action === 'right' && index < scoreDraft.pages.length - 1) [scoreDraft.pages[index + 1], scoreDraft.pages[index]] = [scoreDraft.pages[index], scoreDraft.pages[index + 1]];
      renderScoreDraftPages();
    });
  });
}

function clearScoreDraftPages() {
  if (!scoreDraft?.pages.length) return;
  if (!confirm('Eliminare tutte le pagine acquisite?')) return;
  scoreDraft.pages = [];
  renderScoreDraftPages();
}

// ─── REMOTE PHONE ROUTING ────────────────────────────────────
function ensureScoreRemoteConnection() {
  if (!sessionId) sessionId = Math.random().toString(36).substring(2, 8).toUpperCase();
  const url = location.origin + '/phone?s=' + sessionId;
  $('scoreRemoteCode').textContent = sessionId;
  const canvas = $('scoreQrCanvas');
  renderQRCode(canvas, url, 180);
  if (typeof Peer === 'undefined') {
    $('scoreRemoteStatus').innerHTML = '<span class="dot"></span> Collegamento remoto non disponibile';
    return;
  }
  if (!peer || peer.destroyed) setupPeer();
  scoreUpdateRemoteStatus();
  if (scoreRemoteTimer) clearInterval(scoreRemoteTimer);
  scoreRemoteTimer = setInterval(scoreUpdateRemoteStatus, 1200);
}

function scoreUpdateRemoteStatus() {
  const el = $('scoreRemoteStatus');
  if (!el) return;
  if (peerConn?.open) {
    el.innerHTML = '<span class="dot connected"></span> Telefono connesso — scatta una pagina';
  } else if (peer && !peer.destroyed) {
    el.innerHTML = '<span class="dot waiting"></span> Scansiona il QR dal telefono';
  } else {
    el.innerHTML = '<span class="dot waiting"></span> Preparazione collegamento…';
  }
}

async function acceptRemoteScorePage(base64) {
  if (!scoreCaptureActive || !scoreDraft) return false;
  $('scoreProcessing').style.display = 'flex';
  $('scoreProcessingText').textContent = 'Pagina ricevuta dal telefono…';
  await addScorePageDataUrl('data:image/jpeg;base64,' + base64, 'remote');
  $('scoreProcessing').style.display = 'none';
  toast(`📖 Pagina ${scoreDraft.pages.length} acquisita dal telefono`, 'success');
  scoreUpdateRemoteStatus();
  return true;
}

function captureBridgePage() {
  if (!phoneBridgeConn?.open) {
    toast('Connessione al desktop non pronta', 'error');
    return;
  }
  const video = $('video');
  if (!video.srcObject || !video.videoWidth) {
    toast('Fotocamera non pronta', 'error');
    return;
  }
  const canvas = document.createElement('canvas');
  const scale = Math.min(2560 / video.videoWidth, 1);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const base64 = canvas.toDataURL('image/jpeg', .9).split(',')[1];
  sendPhotoToDesktop(base64);
  if (navigator.vibrate) navigator.vibrate(80);
}

// ─── RECOGNITION ─────────────────────────────────────────────
async function recognizeAndSaveScore() {
  if (!scoreDraft?.pages.length) return;
  scoreDraft.manualTitle = $('scoreTitleInput').value.trim();
  scoreDraft.manualComposer = $('scoreComposerInput').value.trim();
  if (!openaiApiKey) {
    toast('Inserisci la API Key OpenAI per riconoscere lo spartito', 'error');
    $('openaiKeyInput').focus();
    return;
  }

  $('scoreProcessing').style.display = 'flex';
  $('scoreProcessingText').textContent = `Riconoscimento di ${scoreDraft.pages.length} pagine…`;
  $('btnScoreRecognize').disabled = true;
  $('btnScoreSaveOnly').disabled = true;

  try {
    const samplePages = chooseRecognitionPages(scoreDraft.pages);
    const content = [{
      type: 'input_text',
      text: `Riconosci questo spartito musicale. Le immagini sono pagine in ordine. Distingui ciò che è letto da ciò che è dedotto. Se titolo o compositore non sono visibili e non sei sicuro, lascia il campo vuoto e spiega l'incertezza. Dati inseriti dall'utente: titolo "${scoreDraft.manualTitle}", compositore "${scoreDraft.manualComposer}".`,
    }];
    for (let i = 0; i < samplePages.length; i++) {
      const reduced = await resizeScoreImage(samplePages[i].dataUrl, 1600, .78);
      content.push({ type: 'input_text', text: `Pagina campione ${i + 1}:` });
      content.push({ type: 'input_image', image_url: reduced.dataUrl, detail: 'high' });
    }

    scoreDraft.metadata = await callScoreAI({
      schemaName: 'music_score_recognition',
      schema: SCORE_RECOGNITION_SCHEMA,
      instructions: 'Sei un musicologo e pianista esperto nella lettura di partiture. Riconosci opere solo quando esistono indizi visivi sufficienti. Non inventare titoli, compositori, tonalità o numeri d’opera. Rispondi in italiano.',
      content,
    });
    scoreDraft.updatedAt = new Date().toISOString();
    toast('✅ Spartito riconosciuto: ' + (scoreDraft.metadata.title || scoreDraft.manualTitle || 'titolo incerto'), 'success');
    await saveDraftScore(true);
  } catch (e) {
    console.error('[Scores] Recognition:', e);
    toast('Riconoscimento non completato: ' + e.message, 'error');
  } finally {
    $('scoreProcessing').style.display = 'none';
    if (scoreDraft) {
      $('btnScoreRecognize').disabled = !scoreDraft.pages.length;
      $('btnScoreSaveOnly').disabled = !scoreDraft.pages.length;
    }
  }
}

function chooseRecognitionPages(pages) {
  if (pages.length <= 6) return pages;
  const indexes = [0, 1, 2, Math.floor(pages.length / 2), pages.length - 2, pages.length - 1];
  return [...new Set(indexes)].map(index => pages[index]).filter(Boolean);
}

async function saveDraftScore(openAfter) {
  if (!scoreDraft?.pages.length) return;
  scoreDraft.manualTitle = $('scoreTitleInput').value.trim() || scoreDraft.manualTitle;
  scoreDraft.manualComposer = $('scoreComposerInput').value.trim() || scoreDraft.manualComposer;
  if (!scoreDraft.metadata) {
    scoreDraft.metadata = {
      title: scoreDraft.manualTitle || 'Spartito senza titolo', composer: scoreDraft.manualComposer || '',
      work_number: '', movement: '', key: '', time_signature: '', tempo: '', genre: '',
      instrumentation: '', confidence: 0, evidence: [], uncertainty: 'Non ancora analizzato', page_notes: [],
    };
  }
  scoreDraft.updatedAt = new Date().toISOString();
  try {
    await scoreDbPut(scoreDraft);
    const id = scoreDraft.id;
    scoreCaptureActive = false;
    stopScoreCamera();
    toast('📚 Spartito salvato con ' + scoreDraft.pages.length + ' pagine', 'success');
    await refreshScoreLibrary();
    if (openAfter) await openScore(id);
    else returnToScoreLibrary();
  } catch (e) {
    toast('Salvataggio non riuscito: ' + e.message, 'error');
  }
}

async function callScoreAI({ schemaName, schema, instructions, content }) {
  const models = [SCORE_PRIMARY_MODEL, SCORE_FALLBACK_MODEL];
  let lastError = null;
  for (const model of models) {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + openaiApiKey },
      body: JSON.stringify({
        model,
        instructions,
        input: [{ role: 'user', content }],
        text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } },
      }),
    });
    if (response.ok) {
      const data = await response.json();
      const text = extractResponseOutputText(data);
      if (!text) throw new Error('Risposta AI priva di contenuto');
      return JSON.parse(text);
    }
    const errorData = await response.json().catch(() => ({}));
    const message = errorData.error?.message || `HTTP ${response.status}`;
    lastError = new Error(message);
    const modelUnavailable = response.status === 404 || (response.status === 400 && /model|access|permission/i.test(message));
    if (!modelUnavailable) break;
  }
  throw lastError || new Error('Servizio AI non disponibile');
}

function extractResponseOutputText(response) {
  if (response.output_text) return response.output_text;
  for (const item of response.output || []) {
    for (const part of item.content || []) {
      if (part.type === 'output_text' && part.text) return part.text;
      if (part.type === 'refusal' && part.refusal) throw new Error(part.refusal);
    }
  }
  return '';
}

// ─── VIEWER ──────────────────────────────────────────────────
async function openScore(id) {
  activeScore = scoreLibrary.find(score => score.id === id);
  if (!activeScore) {
    await refreshScoreLibrary();
    activeScore = scoreLibrary.find(score => score.id === id);
  }
  if (!activeScore) return;
  scorePageIndex = 0;
  scoreZoom = 100;
  scoreSelection = null;
  scoreSelectionCrop = '';
  scoreLastExplanation = null;
  $('scoreZoom').value = '100';
  const meta = activeScore.metadata || {};
  $('scoreViewerTitle').textContent = meta.title || activeScore.manualTitle || 'Spartito';
  $('scoreViewerMeta').textContent = [meta.composer || activeScore.manualComposer, meta.work_number, meta.key, meta.tempo].filter(Boolean).join(' · ');
  showScoreView('viewer');
  renderScoreThumbs();
  showScorePage(0);
}

function renderScoreThumbs() {
  $('scoreThumbs').innerHTML = (activeScore?.pages || []).map((page, index) => `
    <button class="score-thumb${index === scorePageIndex ? ' active' : ''}" data-score-thumb="${index}">
      <img src="${page.thumbDataUrl || page.dataUrl}" alt="Pagina ${index + 1}"><span>${index + 1}</span>
    </button>`).join('');
  $('scoreThumbs').querySelectorAll('[data-score-thumb]').forEach(button => {
    button.addEventListener('click', () => showScorePage(Number(button.dataset.scoreThumb)));
  });
}

function showScorePage(index) {
  if (!activeScore?.pages?.length) return;
  scorePageIndex = Math.max(0, Math.min(index, activeScore.pages.length - 1));
  const page = activeScore.pages[scorePageIndex];
  $('scorePageImage').src = page.dataUrl;
  $('scorePageLabel').textContent = `Pagina ${scorePageIndex + 1} di ${activeScore.pages.length}`;
  $('btnScorePrev').disabled = scorePageIndex === 0;
  $('btnScoreNext').disabled = scorePageIndex === activeScore.pages.length - 1;
  renderScoreThumbs();
  clearScoreSelectionUi();

  const annotations = (activeScore.annotations || []).filter(a => a.pageIndex === scorePageIndex);
  const latest = annotations[annotations.length - 1];
  if (latest) {
    scoreSelection = latest.selection;
    scoreLastExplanation = latest.result;
    renderScoreSelectionBox();
    updateScoreSelectionPreview();
    renderScoreExplanation(latest.result);
  }
}

function setScoreZoom(value) {
  scoreZoom = Math.max(60, Math.min(240, value || 100));
  $('scorePageStage').style.width = scoreZoom + '%';
}

function toggleScoreSelectionMode() {
  scoreSelectionMode = !scoreSelectionMode;
  $('scoreSelectionLayer').classList.toggle('selecting', scoreSelectionMode);
  $('btnScoreSelect').classList.toggle('active', scoreSelectionMode);
  $('btnScoreSelect').textContent = scoreSelectionMode ? 'Trascina sulla partitura…' : '▣ Seleziona una parte';
}

function pointerToScoreNormalized(event) {
  const rect = $('scorePageImage').getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
  };
}

function beginScoreSelection(event) {
  if (!scoreSelectionMode) return;
  event.preventDefault();
  scoreSelectionStart = pointerToScoreNormalized(event);
  scoreSelection = { x: scoreSelectionStart.x, y: scoreSelectionStart.y, w: 0, h: 0 };
  event.currentTarget.setPointerCapture(event.pointerId);
  renderScoreSelectionBox();
}

function moveScoreSelection(event) {
  if (!scoreSelectionMode || !scoreSelectionStart) return;
  const point = pointerToScoreNormalized(event);
  scoreSelection = {
    x: Math.min(scoreSelectionStart.x, point.x),
    y: Math.min(scoreSelectionStart.y, point.y),
    w: Math.abs(point.x - scoreSelectionStart.x),
    h: Math.abs(point.y - scoreSelectionStart.y),
  };
  renderScoreSelectionBox();
}

async function finishScoreSelection(event) {
  if (!scoreSelectionStart) return;
  scoreSelectionStart = null;
  if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  if (!scoreSelection || scoreSelection.w < .025 || scoreSelection.h < .025) {
    scoreSelection = null;
    clearScoreSelectionUi();
    return;
  }
  scoreSelectionMode = false;
  $('scoreSelectionLayer').classList.remove('selecting');
  $('btnScoreSelect').classList.remove('active');
  $('btnScoreSelect').textContent = '▣ Seleziona una parte';
  renderScoreSelectionBox();
  await updateScoreSelectionPreview();
  $('btnScoreExplain').disabled = false;
}

function renderScoreSelectionBox() {
  const box = $('scoreSelectionBox');
  if (!scoreSelection) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.style.left = (scoreSelection.x * 100) + '%';
  box.style.top = (scoreSelection.y * 100) + '%';
  box.style.width = (scoreSelection.w * 100) + '%';
  box.style.height = (scoreSelection.h * 100) + '%';
}

function clearScoreSelectionUi() {
  scoreSelection = null;
  scoreSelectionCrop = '';
  scoreLastExplanation = null;
  $('scoreSelectionBox').style.display = 'none';
  $('scoreSelectionPreview').innerHTML = '<span>Nessuna parte selezionata</span>';
  $('btnScoreExplain').disabled = true;
  $('scoreExplanation').style.display = 'none';
  $('scorePlayback').style.display = 'none';
}

async function updateScoreSelectionPreview() {
  if (!scoreSelection || !activeScore) return;
  scoreSelectionCrop = await cropScoreSelection(activeScore.pages[scorePageIndex].dataUrl, scoreSelection);
  $('scoreSelectionPreview').innerHTML = `<img src="${scoreSelectionCrop}" alt="Sezione selezionata">`;
}

function cropScoreSelection(dataUrl, selection) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const sx = Math.round(selection.x * img.naturalWidth);
      const sy = Math.round(selection.y * img.naturalHeight);
      const sw = Math.max(1, Math.round(selection.w * img.naturalWidth));
      const sh = Math.max(1, Math.round(selection.h * img.naturalHeight));
      const max = 2200;
      const scale = Math.min(max / Math.max(sw, sh), 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(sw * scale));
      canvas.height = Math.max(1, Math.round(sh * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', .94));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// ─── EXPLANATION + ANNOTATION ────────────────────────────────
async function explainScoreSelection() {
  if (!activeScore || !scoreSelection) return;
  if (!openaiApiKey) {
    toast('Inserisci la API Key OpenAI per chiedere spiegazioni', 'error');
    return;
  }
  if (!scoreSelectionCrop) await updateScoreSelectionPreview();
  const question = $('scoreQuestion').value.trim() || 'Spiegami come leggere, interpretare e studiare questa sezione.';
  $('scoreExplainProcessing').style.display = 'flex';
  $('btnScoreExplain').disabled = true;
  $('scoreExplanation').style.display = 'none';
  stopScorePlayback();

  try {
    const meta = activeScore.metadata || {};
    const result = await callScoreAI({
      schemaName: 'music_score_explanation',
      schema: SCORE_EXPLANATION_SCHEMA,
      instructions: `Sei un insegnante di pianoforte e teoria musicale molto preciso. Spiega in italiano semplice ciò che è realmente visibile. Distingui sempre osservazione e ipotesi. Non fingere di leggere note illeggibili. Per playback produci eventi MIDI soltanto se altezze e ritmo sono abbastanza chiari; altrimenti restituisci events vuoto e spiega il limite in certainty. Per ogni evento indica anche la posizione della testa della nota nell'immagine selezionata: system 0 per la metà superiore, system 1 per quella inferiore; x e y normalizzati da 0 a 1 all'interno della rispettiva metà.`,
      content: [
        {
          type: 'input_text',
          text: `Brano: ${meta.title || activeScore.manualTitle || 'non identificato'}; compositore: ${meta.composer || activeScore.manualComposer || 'non identificato'}; pagina ${scorePageIndex + 1}. Domanda dell'utente: ${question}\nLa prima immagine mostra l'intera pagina come contesto; la seconda è la parte evidenziata da spiegare.`,
        },
        { type: 'input_image', image_url: activeScore.pages[scorePageIndex].dataUrl, detail: 'low' },
        { type: 'input_image', image_url: scoreSelectionCrop, detail: 'high' },
      ],
    });
    scoreLastExplanation = result;
    renderScoreExplanation(result);

    const annotation = {
      id: 'ann_' + Date.now().toString(36),
      pageIndex: scorePageIndex,
      selection: { ...scoreSelection },
      question,
      result,
      createdAt: new Date().toISOString(),
    };
    activeScore.annotations = activeScore.annotations || [];
    activeScore.annotations.push(annotation);
    activeScore.updatedAt = new Date().toISOString();
    await scoreDbPut(activeScore);
  } catch (e) {
    console.error('[Scores] Explanation:', e);
    toast('Spiegazione non disponibile: ' + e.message, 'error');
  } finally {
    $('scoreExplainProcessing').style.display = 'none';
    $('btnScoreExplain').disabled = false;
  }
}

function renderScoreExplanation(result) {
  if (!result) return;
  const e = result.expression || {};
  const steps = (result.study_steps || []).map(step => `<li>${esc(step)}</li>`).join('');
  const warnings = (result.warnings || []).map(w => `<li>${esc(w)}</li>`).join('');
  $('scoreExplanation').innerHTML = `
    <h4>In sintesi</h4><p>${esc(result.summary)}</p>
    <h4>Segni e notazione</h4><p>${esc(result.notation)}</p>
    <h4>Mano destra</h4><p>${esc(result.hands?.right || '')}</p>
    <h4>Mano sinistra</h4><p>${esc(result.hands?.left || '')}</p>
    <h4>Ritmo</h4><p>${esc(result.rhythm)}</p>
    <h4>Interpretazione</h4><p>${esc([e.phrasing, e.dynamics, e.articulation, e.pedal].filter(Boolean).join(' '))}</p>
    <h4>Diteggiatura</h4><p>${esc(result.fingering)}</p>
    ${steps ? `<h4>Metodo di studio</h4><ol>${steps}</ol>` : ''}
    ${warnings ? `<h4>Attenzione</h4><ul>${warnings}</ul>` : ''}
    <div class="score-confidence">Affidabilità della lettura: ${Math.round(Math.max(0, Math.min(1, Number(result.confidence) || 0)) * 100)}%</div>`;
  $('scoreExplanation').style.display = 'block';

  const events = result.playback?.events || [];
  $('scorePlayback').style.display = events.length ? 'flex' : 'none';
  if (events.length) {
    $('scorePlaybackNote').textContent = result.playback.certainty || 'Ricostruzione indicativa della sezione';
  }
}

// ─── LIVE SCORE FOLLOWER (LOCAL, NO AI STREAMING) ───────────
let practiceInputMode = '';

async function openScorePractice() {
  const events = scoreLastExplanation?.playback?.events || [];
  if (events.length && !scoreSelectionCrop && scoreSelection) await updateScoreSelectionPreview();
  if (!events.length || !scoreSelectionCrop) {
    toast('Prima seleziona due righi e chiedi la spiegazione della sezione', 'info');
    return;
  }
  practiceGroups = buildPracticeGroups(events);
  if (!practiceGroups.length) return;
  try {
    const rows = await splitPracticeRows(scoreSelectionCrop);
    $('scorePracticeRow0').src = rows[0];
    $('scorePracticeRow1').src = rows[1];
  } catch (e) {
    toast('Impossibile preparare il leggio: ' + e.message, 'error');
    return;
  }
  $('scorePracticeOverlay').style.display = 'block';
  document.body.style.overflow = 'hidden';
  renderPracticeMarkers();
  resetScorePractice();
}

function closeScorePractice() {
  const overlay = $('scorePracticeOverlay');
  if (!overlay) return;
  stopPracticeInput();
  overlay.style.display = 'none';
  document.body.style.overflow = '';
}

function buildPracticeGroups(sourceEvents) {
  const events = sourceEvents
    .filter(e => Number.isFinite(Number(e.midi)))
    .map(e => ({ ...e, midi: Math.round(Number(e.midi)), start_beat: Math.max(0, Number(e.start_beat) || 0) }))
    .sort((a, b) => a.start_beat - b.start_beat || a.midi - b.midi);
  const maxBeat = Math.max(...events.map(e => e.start_beat), 1);
  const groups = [];
  for (const event of events) {
    let group = groups.find(g => Math.abs(g.beat - event.start_beat) < .04);
    if (!group) { group = { beat: event.start_beat, events: [], error: false }; groups.push(group); }
    const progress = event.start_beat / maxBeat;
    const hasSystem = Number(event.system) === 0 || Number(event.system) === 1;
    event.system = hasSystem ? Number(event.system) : Math.min(1, Math.floor(progress * 2));
    event.x = Number.isFinite(Number(event.x)) ? clamp01(Number(event.x)) : clamp01((progress * 2) % 1);
    event.y = Number.isFinite(Number(event.y)) ? clamp01(Number(event.y)) : .5;
    group.events.push(event);
  }
  return groups;
}

function splitPracticeRows(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const half = Math.max(1, Math.floor(img.naturalHeight / 2));
      const rows = [0, 1].map(index => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = index === 0 ? half : img.naturalHeight - half;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, index === 0 ? 0 : half, img.naturalWidth, canvas.height, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', .94);
      });
      resolve(rows);
    };
    img.onerror = () => reject(new Error('immagine non leggibile'));
    img.src = dataUrl;
  });
}

function renderPracticeMarkers() {
  const containers = [$('scorePracticeMarkers0'), $('scorePracticeMarkers1')];
  containers.forEach(el => { el.innerHTML = ''; });
  practiceGroups.forEach((group, groupIndex) => {
    group.events.forEach((event, eventIndex) => {
      const marker = document.createElement('span');
      marker.className = 'score-note-marker';
      marker.dataset.practiceGroup = groupIndex;
      marker.dataset.practiceEvent = eventIndex;
      marker.style.left = (event.x * 100) + '%';
      marker.style.top = (event.y * 100) + '%';
      containers[event.system].appendChild(marker);
    });
  });
  const maxMilestones = 20;
  const count = Math.min(maxMilestones, practiceGroups.length);
  $('scoreMilestones').innerHTML = Array.from({ length: count }, (_, i) =>
    `<span class="score-milestone" data-milestone="${i}"></span>`).join('');
}

function resetScorePractice() {
  practiceGroupIndex = 0;
  practiceMatched = new Set();
  practiceCorrect = 0;
  practiceErrors = 0;
  practiceGroups.forEach(group => { group.error = false; });
  $$('.score-note-marker').forEach(marker => marker.className = 'score-note-marker');
  practicePaused = !practiceInputMode;
  $('btnPracticePause').disabled = !practiceInputMode;
  $('btnPracticePause').textContent = practicePaused ? '▶ Riprendi' : '⏸ Pausa';
  setPracticeMessage(practiceInputMode ? 'Pronto: suona la prima nota.' : 'Scegli come ascoltare ciò che suoni.');
  updatePracticeUi();
}

function updatePracticeUi() {
  const total = Math.max(1, practiceGroups.length);
  const complete = practiceGroupIndex >= practiceGroups.length;
  const progress = complete ? 100 : Math.round((practiceGroupIndex / total) * 100);
  $('scorePracticeProgress').textContent = progress + '%';
  $('scorePracticeCorrect').textContent = practiceCorrect;
  $('scorePracticeErrors').textContent = practiceErrors;
  $$('.score-note-marker.current').forEach(marker => marker.classList.remove('current'));

  if (!complete) {
    const group = practiceGroups[practiceGroupIndex];
    group.events.forEach((event, index) => {
      if (!practiceMatched.has(event.midi)) getPracticeMarker(practiceGroupIndex, index)?.classList.add('current');
    });
    const system = group.events[0]?.system || 0;
    $$('[data-practice-row]').forEach((row, index) => row.classList.toggle('active', index === system));
  } else {
    practicePaused = true;
    setPracticeMessage(`Sezione completata: ${practiceCorrect} note corrette, ${practiceErrors} errori.`, practiceErrors ? 'wrong' : 'correct');
  }

  const milestones = $$('.score-milestone');
  milestones.forEach((marker, index) => {
    const start = Math.floor(index * total / milestones.length);
    const end = Math.max(start + 1, Math.floor((index + 1) * total / milestones.length));
    const hasError = practiceGroups.slice(start, end).some(group => group.error);
    marker.className = 'score-milestone';
    if (end <= practiceGroupIndex) marker.classList.add(hasError ? 'error' : 'done');
    else if (start <= practiceGroupIndex && practiceGroupIndex < end) marker.classList.add('current');
  });
}

function acceptPracticeMidi(midi) {
  if (practicePaused || practiceGroupIndex >= practiceGroups.length) return;
  midi = Math.round(Number(midi));
  const group = practiceGroups[practiceGroupIndex];
  const expected = new Set(group.events.map(event => event.midi));

  if (expected.has(midi)) {
    if (practiceMatched.has(midi)) return;
    practiceMatched.add(midi);
    group.events.forEach((event, index) => {
      if (event.midi === midi) getPracticeMarker(practiceGroupIndex, index)?.classList.add('correct');
    });
    practiceCorrect++;
    setPracticeMessage(`✓ ${midiToItalianNote(midi)} corretta`, 'correct');
    if ([...expected].every(note => practiceMatched.has(note))) {
      practiceGroupIndex++;
      practiceMatched = new Set();
    }
    updatePracticeUi();
    return;
  }

  const lookAhead = practiceGroups.slice(practiceGroupIndex + 1, practiceGroupIndex + 3)
    .findIndex(next => next.events.some(event => event.midi === midi));
  if (lookAhead >= 0) {
    const target = practiceGroupIndex + lookAhead + 1;
    while (practiceGroupIndex < target) markPracticeGroupWrong(practiceGroupIndex++);
    practiceMatched = new Set();
    updatePracticeUi();
    acceptPracticeMidi(midi);
    return;
  }

  practiceErrors++;
  group.error = true;
  group.events.forEach((_event, index) => {
    const marker = getPracticeMarker(practiceGroupIndex, index);
    marker?.classList.add('wrong');
    setTimeout(() => marker?.classList.remove('wrong'), 650);
  });
  const expectedNames = [...expected].map(midiToItalianNote).join(' + ');
  setPracticeMessage(`✕ Hai suonato ${midiToItalianNote(midi)} — atteso ${expectedNames}`, 'wrong');
  updatePracticeUi();
}

function markPracticeGroupWrong(index) {
  const group = practiceGroups[index];
  if (!group) return;
  group.error = true;
  practiceErrors++;
  group.events.forEach((_event, eventIndex) => getPracticeMarker(index, eventIndex)?.classList.add('wrong'));
}

function getPracticeMarker(groupIndex, eventIndex) {
  return document.querySelector(`[data-practice-group="${groupIndex}"][data-practice-event="${eventIndex}"]`);
}

function setPracticeMessage(message, state = '') {
  const el = $('scorePracticeMessage');
  el.textContent = message;
  el.className = 'score-practice-message' + (state ? ' ' + state : '');
}

async function startPracticeMidi() {
  if (!navigator.requestMIDIAccess) {
    toast('Web MIDI non è supportato da questo browser. Usa Chrome/Edge oppure il microfono.', 'error');
    return;
  }
  stopPracticeInput();
  try {
    practiceMidiAccess = await navigator.requestMIDIAccess();
    practiceInputMode = 'midi';
    const connectInputs = () => practiceMidiAccess.inputs.forEach(input => { input.onmidimessage = handlePracticeMidiMessage; });
    connectInputs();
    practiceMidiAccess.onstatechange = connectInputs;
    practicePaused = false;
    $('scorePracticeInput').textContent = `MIDI · ${practiceMidiAccess.inputs.size} dispositivo/i`;
    $('btnPracticePause').disabled = false;
    $('btnPracticePause').textContent = '⏸ Pausa';
    setPracticeMessage(practiceMidiAccess.inputs.size ? 'MIDI connesso: suona la prima nota.' : 'Collega e accendi la tastiera MIDI.');
    updatePracticeUi();
  } catch (e) {
    toast('Connessione MIDI non riuscita: ' + e.message, 'error');
  }
}

function handlePracticeMidiMessage(message) {
  const [status, note, velocity] = message.data;
  if ((status & 0xf0) === 0x90 && velocity > 0) acceptPracticeMidi(note);
}

async function startPracticeMicrophone() {
  stopPracticeInput();
  try {
    practiceMicStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    practiceMicContext = new AudioCtx();
    const analyser = practiceMicContext.createAnalyser();
    analyser.fftSize = 2048;
    practiceMicContext.createMediaStreamSource(practiceMicStream).connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    practiceInputMode = 'microphone';
    practicePaused = false;
    practiceLastMicMidi = null;
    practiceLastAnalysisAt = 0;
    $('scorePracticeInput').textContent = 'MIC · locale';
    $('btnPracticePause').disabled = false;
    $('btnPracticePause').textContent = '⏸ Pausa';
    setPracticeMessage('Microfono attivo: suona una nota alla volta.');

    const listen = () => {
      if (!practiceMicContext) return;
      const analysisNow = performance.now();
      if (!practicePaused && analysisNow - practiceLastAnalysisAt >= 80) {
        practiceLastAnalysisAt = analysisNow;
        analyser.getFloatTimeDomainData(buffer);
        const frequency = detectPracticePitch(buffer, practiceMicContext.sampleRate);
        if (frequency) {
          const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
          if (midi !== practiceLastMicMidi || analysisNow - practiceLastMicAt > 550) {
            practiceLastMicMidi = midi;
            practiceLastMicAt = analysisNow;
            acceptPracticeMidi(midi);
          }
        }
      }
      practiceMicFrame = requestAnimationFrame(listen);
    };
    listen();
  } catch (e) {
    toast('Microfono non disponibile: ' + e.message, 'error');
  }
}

function detectPracticePitch(buffer, sampleRate) {
  let rms = 0;
  for (const value of buffer) rms += value * value;
  if (Math.sqrt(rms / buffer.length) < .015) return 0;
  const minOffset = Math.floor(sampleRate / 1100);
  const maxOffset = Math.min(Math.floor(sampleRate / 55), buffer.length / 2);
  let bestOffset = 0;
  let bestCorrelation = 0;
  for (let offset = minOffset; offset <= maxOffset; offset++) {
    let correlation = 0;
    for (let i = 0; i < buffer.length - offset; i++) correlation += buffer[i] * buffer[i + offset];
    if (correlation > bestCorrelation) { bestCorrelation = correlation; bestOffset = offset; }
  }
  return bestOffset && bestCorrelation > .01 ? sampleRate / bestOffset : 0;
}

function toggleScorePracticePause() {
  if (!practiceInputMode) return;
  practicePaused = !practicePaused;
  $('btnPracticePause').textContent = practicePaused ? '▶ Riprendi' : '⏸ Pausa';
  setPracticeMessage(practicePaused ? 'Esecuzione in pausa.' : 'Ascolto ripreso.');
}

function stopPracticeInput() {
  if (practiceMidiAccess) {
    practiceMidiAccess.inputs.forEach(input => { input.onmidimessage = null; });
    practiceMidiAccess.onstatechange = null;
  }
  practiceMidiAccess = null;
  if (practiceMicFrame) cancelAnimationFrame(practiceMicFrame);
  practiceMicFrame = 0;
  if (practiceMicStream) practiceMicStream.getTracks().forEach(track => track.stop());
  practiceMicStream = null;
  if (practiceMicContext) { try { practiceMicContext.close(); } catch (e) {} }
  practiceMicContext = null;
  practiceInputMode = '';
  practicePaused = true;
  const input = $('scorePracticeInput');
  if (input) input.textContent = 'In attesa';
  const pause = $('btnPracticePause');
  if (pause) { pause.disabled = true; pause.textContent = '⏸ Pausa'; }
}

function midiToItalianNote(midi) {
  const names = ['Do', 'Do♯', 'Re', 'Re♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];
  return names[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

function clamp01(value) { return Math.max(0, Math.min(1, value)); }

// ─── DIDACTIC PLAYBACK ───────────────────────────────────────
function playScoreSelection() {
  const playback = scoreLastExplanation?.playback;
  if (!playback?.events?.length) {
    toast('La sezione non contiene note ricostruibili con sufficiente affidabilità', 'info');
    return;
  }
  stopScorePlayback();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) { toast('Audio non supportato da questo browser', 'error'); return; }
  scoreAudioContext = new AudioCtx();
  const bpm = Math.max(30, Math.min(220, Number(playback.bpm) || 80));
  const secondsPerBeat = 60 / bpm;
  const now = scoreAudioContext.currentTime + .08;
  let lastEnd = 0;

  playback.events.slice(0, 180).forEach(event => {
    const midi = Math.round(Number(event.midi));
    if (midi < 21 || midi > 108) return;
    const startBeat = Math.max(0, Number(event.start_beat) || 0);
    const durationBeat = Math.max(.08, Math.min(16, Number(event.duration_beats) || .5));
    const start = now + startBeat * secondsPerBeat;
    const duration = durationBeat * secondsPerBeat;
    const velocity = Math.max(.08, Math.min(1, (Number(event.velocity) || 70) / 127));
    const osc = scoreAudioContext.createOscillator();
    const gain = scoreAudioContext.createGain();
    osc.type = event.hand === 'left' ? 'triangle' : 'sine';
    osc.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
    gain.gain.setValueAtTime(.0001, start);
    gain.gain.exponentialRampToValueAtTime(.14 * velocity, start + .018);
    gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
    osc.connect(gain).connect(scoreAudioContext.destination);
    osc.start(start);
    osc.stop(start + duration + .03);
    scoreAudioNodes.push(osc, gain);
    lastEnd = Math.max(lastEnd, startBeat * secondsPerBeat + duration);
  });
  $('btnScorePlay').disabled = true;
  setTimeout(() => { if ($('btnScorePlay')) $('btnScorePlay').disabled = false; }, Math.ceil((lastEnd + .2) * 1000));
}

function stopScorePlayback() {
  scoreAudioNodes.forEach(node => { try { node.stop?.(); node.disconnect?.(); } catch (e) {} });
  scoreAudioNodes = [];
  if (scoreAudioContext) { try { scoreAudioContext.close(); } catch (e) {} }
  scoreAudioContext = null;
  if ($('btnScorePlay')) $('btnScorePlay').disabled = false;
}

async function deleteActiveScore() {
  if (!activeScore) return;
  const title = activeScore.metadata?.title || activeScore.manualTitle || 'questo spartito';
  if (!confirm(`Eliminare "${title}" e tutte le sue pagine?`)) return;
  try {
    await scoreDbDelete(activeScore.id);
    toast('Spartito eliminato', 'info');
    returnToScoreLibrary();
  } catch (e) {
    toast('Eliminazione non riuscita', 'error');
  }
}
