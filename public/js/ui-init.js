// ─── INITIALIZATION ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadState();
  initTabs();
  initModes();
  initScanner();
  initContacts();
  initExport();
  initSettings();
  initAdvancedExport();
  initApiKeyBar();
  checkOcrApi();
  initTesseractFallback();
  initPhoneBridge(); // Detect ?s= param and auto-connect to desktop
  // Supabase: init after all UI is ready (async, non-blocking)
  setTimeout(() => initSupabase(), 500);
});

function loadState() {
  try {
    const c = localStorage.getItem('bizcard_contacts');
    if (c) contacts = JSON.parse(c);
    const s = localStorage.getItem('bizcard_settings');
    if (s) settings = { ...settings, ...JSON.parse(s) };
    scanCount = parseInt(localStorage.getItem('bizcard_scans') || '0');
  } catch (e) { /* corrupt data, start fresh */ }
}

function saveState() {
  try {
    localStorage.setItem('bizcard_contacts', JSON.stringify(contacts));
    localStorage.setItem('bizcard_settings', JSON.stringify(settings));
    localStorage.setItem('bizcard_scans', String(scanCount));
  } catch (e) { /* storage full or blocked */ }
  // Async cloud sync (fire & forget)
  if (supabaseReady) debouncedCloudSync();
}

// ─── API KEY BAR ──────────────────────────────────────────────
function initApiKeyBar() {
  const input = $('openaiKeyInput');
  const btnSave = $('btnSaveKey');
  const btnToggle = $('btnToggleKey');
  const status = $('apiKeyStatus');

  // Load from localStorage (encrypted/obfuscated for basic protection)
  try {
    const stored = localStorage.getItem('bizcard_oai_key');
    if (stored) {
      openaiApiKey = atob(stored); // decode
      input.value = openaiApiKey;
      $('apiKeyBar').classList.add('has-key');
      status.textContent = '✅ Chiave salvata';
      status.className = 'api-key-status';
    }
  } catch (e) { /* no stored key */ }

  // Save key
  btnSave.addEventListener('click', () => {
    const key = input.value.trim();
    if (!key) {
      // Clear key
      openaiApiKey = '';
      localStorage.removeItem('bizcard_oai_key');
      $('apiKeyBar').classList.remove('has-key');
      status.textContent = '';
      toast('API Key rimossa', 'info');
      return;
    }
    if (!key.startsWith('sk-')) {
      toast('La chiave OpenAI deve iniziare con "sk-"', 'error');
      status.textContent = '❌ Formato non valido';
      status.className = 'api-key-status error';
      return;
    }
    openaiApiKey = key;
    // Store encoded in localStorage
    try { localStorage.setItem('bizcard_oai_key', btoa(key)); } catch (e) {}
    $('apiKeyBar').classList.add('has-key');
    status.textContent = '✅ Chiave salvata';
    status.className = 'api-key-status';
    toast('API Key OpenAI salvata', 'success');
    // Clear the visible value and show dots
    input.type = 'password';
  });

  // Toggle visibility
  btnToggle.addEventListener('click', () => {
    if (input.type === 'password') {
      input.type = 'text';
      btnToggle.textContent = '🙈';
    } else {
      input.type = 'password';
      btnToggle.textContent = '👁️';
    }
  });

  // Enter key to save
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnSave.click();
  });
}

// ─── UTILITIES ────────────────────────────────────────────────
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function csvEsc(v) {
  if (!v) return '""';
  return '"' + v.replace(/"/g, '""') + '"';
}

function contactToVcard(c) {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  if (c.name) {
    const parts = c.name.split(/\s+/);
    const last = parts.pop() || '';
    const first = parts.join(' ');
    lines.push('N:' + last + ';' + first + ';;;', 'FN:' + c.name);
  }
  if (c.company) lines.push('ORG:' + c.company);
  if (c.role) lines.push('TITLE:' + c.role);
  if (c.email) c.email.split(',').map(e => e.trim()).forEach(e => lines.push('EMAIL;TYPE=WORK:' + e));
  if (c.mobile) c.mobile.split(',').map(p => p.trim()).forEach(p => lines.push('TEL;TYPE=CELL:' + p));
  if (c.phone) c.phone.split(',').map(p => p.trim()).forEach(p => lines.push('TEL;TYPE=WORK,VOICE:' + p));
  if (c.fax) c.fax.split(',').map(f => f.trim()).forEach(f => lines.push('TEL;TYPE=WORK,FAX:' + f));
  if (c.web) lines.push('URL:' + c.web);
  if (c.linkedin) lines.push('URL;TYPE=LINKEDIN:' + c.linkedin);
  // ADR format: PO;ext;street;city;region;zip;country
  const adrParts = [
    '', '', // PO box, ext address
    c.address || '',
    c.city || '',
    '', // region
    '', // zip
    c.country || '',
  ];
  if (c.address || c.city || c.country) lines.push('ADR;TYPE=WORK:' + adrParts.join(';'));
  const notes = [];
  if (c.piva) notes.push('P.IVA: ' + c.piva);
  if (c.cf) notes.push('C.F.: ' + c.cf);
  if (c.logo_description) notes.push('Logo: ' + c.logo_description);
  if (c.notes) notes.push(c.notes);
  if (notes.length) lines.push('NOTE:' + notes.join(' | '));
  lines.push('END:VCARD');
  return lines.join('\r\n');
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── ADVANCED EXPORT ENGINE ──────────────────────────────────
// Supports: CSV, TSV, Custom separator, JSON, JSONL, XML, XLSX, vCard
// With column selection and live preview

const EXPORT_COLUMNS = [
  { key: 'name',     label: 'Nome',       essential: true },
  { key: 'company',  label: 'Azienda',    essential: true },
  { key: 'role',     label: 'Ruolo',      essential: false },
  { key: 'email',    label: 'Email',      essential: true },
  { key: 'mobile',   label: 'Cellulare',  essential: true },
  { key: 'phone',    label: 'Tel. Fisso', essential: false },
  { key: 'fax',      label: 'Fax',        essential: false },
  { key: 'web',      label: 'Web',        essential: false },
  { key: 'linkedin', label: 'LinkedIn',   essential: false },
  { key: 'address',  label: 'Indirizzo',  essential: false },
  { key: 'city',     label: 'Città',      essential: true },
  { key: 'country',  label: 'Paese',      essential: true },
  { key: 'piva',     label: 'P.IVA',      essential: false },
  { key: 'cf',       label: 'C.F.',       essential: false },
  { key: 'logo_description', label: 'Logo', essential: false },
  { key: 'notes',    label: 'Note',       essential: false },
  { key: 'createdAt', label: 'Data',      essential: false },
];

let advExportFormat = 'csv';
let advExportCols = EXPORT_COLUMNS.map(c => c.key);

function initAdvancedExport() {
  const backdrop = $('exportModalBackdrop');
  const close = $('exportModalClose');

  $('btnAdvancedExport').addEventListener('click', () => {
    if (!contacts.length) { toast('Nessun contatto da esportare', 'error'); return; }
    $('exportRecordCount').textContent = contacts.length + ' contatti';
    backdrop.classList.add('visible');
    updateExportPreview();
  });

  close.addEventListener('click', () => backdrop.classList.remove('visible'));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.classList.remove('visible'); });

  // Format buttons
  $$('#exportFormatGrid .export-format-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#exportFormatGrid .export-format-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      advExportFormat = btn.dataset.format;

      // Show/hide separator section
      const sepFormats = ['csv', 'tsv', 'custom'];
      $('exportSepSection').style.display = sepFormats.includes(advExportFormat) ? '' : 'none';

      // Show/hide columns section (not for vCard)
      $('exportColSection').style.display = advExportFormat === 'vcard' ? 'none' : '';

      // Auto-set separator for TSV
      if (advExportFormat === 'tsv') $('exportSepSelect').value = '\\t';
      else if (advExportFormat === 'csv') $('exportSepSelect').value = ',';

      updateExportPreview();
    });
  });

  // Separator select
  $('exportSepSelect').addEventListener('change', () => {
    $('exportSepCustom').style.display = $('exportSepSelect').value === 'custom' ? '' : 'none';
    updateExportPreview();
  });
  $('exportSepCustom').addEventListener('input', updateExportPreview);

  // Column checkboxes
  const grid = $('exportColumnsGrid');
  EXPORT_COLUMNS.forEach(col => {
    const label = document.createElement('label');
    label.className = 'export-col-check';
    label.innerHTML = `<input type="checkbox" checked data-col="${col.key}"> ${col.label}`;
    label.querySelector('input').addEventListener('change', () => {
      advExportCols = [...$$('#exportColumnsGrid input:checked')].map(cb => cb.dataset.col);
      updateExportPreview();
    });
    grid.appendChild(label);
  });

  $('exportColAll').addEventListener('click', () => {
    $$('#exportColumnsGrid input').forEach(cb => cb.checked = true);
    advExportCols = EXPORT_COLUMNS.map(c => c.key);
    updateExportPreview();
  });

  $('exportColNone').addEventListener('click', () => {
    $$('#exportColumnsGrid input').forEach(cb => cb.checked = false);
    advExportCols = [];
    updateExportPreview();
  });

  $('exportColEssential').addEventListener('click', () => {
    $$('#exportColumnsGrid input').forEach(cb => {
      const col = EXPORT_COLUMNS.find(c => c.key === cb.dataset.col);
      cb.checked = col ? col.essential : false;
    });
    advExportCols = EXPORT_COLUMNS.filter(c => c.essential).map(c => c.key);
    updateExportPreview();
  });

  // Download button
  $('btnExportDownload').addEventListener('click', executeAdvancedExport);
}

function getExportSeparator() {
  const val = $('exportSepSelect').value;
  if (val === 'custom') return $('exportSepCustom').value || ',';
  if (val === '\\t') return '\t';
  return val;
}

function getExportHeaders() {
  return advExportCols.map(key => {
    const col = EXPORT_COLUMNS.find(c => c.key === key);
    return col ? col.label : key;
  });
}

function getFilteredData(maxRows) {
  const data = maxRows ? contacts.slice(0, maxRows) : contacts;
  return data.map(c => {
    const row = {};
    advExportCols.forEach(key => { row[key] = c[key] || ''; });
    return row;
  });
}

function escapeForSep(v, sep) {
  if (!v) return '';
  // Always quote for clean, safe output
  return '"' + v.replace(/"/g, '""') + '"';
}

function generateDelimited(data, sep) {
  const headers = getExportHeaders();
  const headerLine = headers.map(h => escapeForSep(h, sep)).join(sep);
  const rows = data.map(row =>
    advExportCols.map(key => escapeForSep(row[key] || '', sep)).join(sep)
  );
  return '\ufeff' + [headerLine, ...rows].join('\r\n');
}

function generateJSON(data) {
  return JSON.stringify(data, null, 2);
}

function generateJSONL(data) {
  return data.map(row => JSON.stringify(row)).join('\n');
}

function generateXML(data) {
  const escXml = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<contacts>\n';
  data.forEach(row => {
    xml += '  <contact>\n';
    advExportCols.forEach(key => {
      const tag = key.replace(/_/g, '-');
      xml += `    <${tag}>${escXml(row[key])}</${tag}>\n`;
    });
    xml += '  </contact>\n';
  });
  xml += '</contacts>';
  return xml;
}

function generateXLSX(data) {
  // Build XLSX using SheetJS (loaded on demand)
  const headers = getExportHeaders();
  const wsData = [headers];
  data.forEach(row => {
    wsData.push(advExportCols.map(key => row[key] || ''));
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  // Auto-width columns
  ws['!cols'] = headers.map((h, i) => {
    let maxW = h.length;
    data.forEach(row => {
      const v = row[advExportCols[i]] || '';
      if (v.length > maxW) maxW = v.length;
    });
    return { wch: Math.min(maxW + 2, 40) };
  });
  XLSX.utils.book_append_sheet(wb, ws, 'Contatti');
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
}

function generateVcardFiltered() {
  return contacts.map(contactToVcard).join('\r\n');
}

function updateExportPreview() {
  const preview = $('exportPreview');
  if (!contacts.length || !advExportCols.length) {
    preview.textContent = advExportCols.length ? 'Nessun contatto' : 'Seleziona almeno una colonna';
    return;
  }

  const data = getFilteredData(2);

  try {
    switch (advExportFormat) {
      case 'csv':
      case 'tsv':
      case 'custom':
        preview.textContent = generateDelimited(data, getExportSeparator());
        break;
      case 'json':
        preview.textContent = generateJSON(data);
        break;
      case 'jsonl':
        preview.textContent = generateJSONL(data);
        break;
      case 'xml':
        preview.textContent = generateXML(data);
        break;
      case 'xlsx':
        preview.textContent = '[XLSX] — Foglio Excel con ' + contacts.length + ' righe e ' + advExportCols.length + ' colonne.\nAnteprima non disponibile per formato binario.';
        break;
      case 'vcard':
        const vcards = contacts.slice(0, 2).map(contactToVcard).join('\r\n\r\n');
        preview.textContent = vcards;
        break;
    }
  } catch (e) {
    preview.textContent = 'Errore: ' + e.message;
  }
}

let sheetJSLoaded = false;

async function loadSheetJS() {
  if (sheetJSLoaded) return;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = () => { sheetJSLoaded = true; resolve(); };
    s.onerror = () => reject(new Error('Impossibile caricare SheetJS'));
    document.head.appendChild(s);
  });
}

async function executeAdvancedExport() {
  if (!contacts.length) { toast('Nessun contatto', 'error'); return; }
  if (!advExportCols.length && advExportFormat !== 'vcard') {
    toast('Seleziona almeno una colonna', 'error'); return;
  }

  const data = getFilteredData();
  const ts = new Date().toISOString().slice(0, 10);

  try {
    switch (advExportFormat) {
      case 'csv': {
        const content = generateDelimited(data, getExportSeparator());
        downloadFile(content, `contatti_${ts}.csv`, 'text/csv');
        break;
      }
      case 'tsv': {
        const content = generateDelimited(data, '\t');
        downloadFile(content, `contatti_${ts}.tsv`, 'text/tab-separated-values');
        break;
      }
      case 'custom': {
        const sep = getExportSeparator();
        const content = generateDelimited(data, sep);
        downloadFile(content, `contatti_${ts}.txt`, 'text/plain');
        break;
      }
      case 'json': {
        downloadFile(generateJSON(data), `contatti_${ts}.json`, 'application/json');
        break;
      }
      case 'jsonl': {
        downloadFile(generateJSONL(data), `contatti_${ts}.jsonl`, 'application/x-ndjson');
        break;
      }
      case 'xml': {
        downloadFile(generateXML(data), `contatti_${ts}.xml`, 'application/xml');
        break;
      }
      case 'xlsx': {
        toast('Caricamento SheetJS...', 'info');
        await loadSheetJS();
        const xlsxData = generateXLSX(data);
        const blob = new Blob([xlsxData], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `contatti_${ts}.xlsx`;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a); URL.revokeObjectURL(url);
        break;
      }
      case 'vcard': {
        downloadFile(generateVcardFiltered(), `contatti_${ts}.vcf`, 'text/vcard');
        break;
      }
    }

    saveExportHistory(advExportFormat.toUpperCase(), `contatti_${ts}.${advExportFormat === 'vcard' ? 'vcf' : advExportFormat}`, contacts.length);
    toast(`✅ ${contacts.length} contatti esportati come ${advExportFormat.toUpperCase()}`, 'success');
    $('exportModalBackdrop').classList.remove('visible');

  } catch (e) {
    toast('Errore export: ' + e.message, 'error');
    console.error('[Export]', e);
  }
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return h;
}

// ─── EXPORT HISTORY (localStorage) ────────────────────────────
function saveExportHistory(format, filename, count) {
  try {
    const history = JSON.parse(localStorage.getItem('bizcard_exports') || '[]');
    history.unshift({
      id: Date.now(),
      format: format,
      filename: filename,
      count: count,
      date: new Date().toISOString(),
    });
    // Keep last 50
    if (history.length > 50) history.length = 50;
    localStorage.setItem('bizcard_exports', JSON.stringify(history));
    renderExportHistory();
  } catch (e) { console.warn('[ExportHistory]', e); }
}

function renderExportHistory() {
  const history = JSON.parse(localStorage.getItem('bizcard_exports') || '[]');
  const container = $('exportHistoryList');
  const wrap = $('exportHistory');
  if (!history.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';

  const formatIcons = { CSV: '📊', TSV: '📋', JSON: '🔧', JSONL: '📝', XML: '📄', XLSX: '📗', VCARD: '📇', CUSTOM: '✂️', WEBHOOK: '🔗' };

  container.innerHTML = history.slice(0, 10).map(h => {
    const d = new Date(h.date);
    const dateStr = d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
    const timeStr = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    const icon = formatIcons[h.format.toUpperCase()] || '📄';
    return `<div class="export-history-item">
      <span class="eh-icon">${icon}</span>
      <div class="eh-info">
        <div class="eh-title">${h.filename}</div>
        <div class="eh-meta">${h.format} · ${h.count} contatti · ${dateStr} ${timeStr}</div>
      </div>
    </div>`;
  }).join('');
}

// ─── PWA: SERVICE WORKER & INSTALL ───────────────────────────
let deferredInstallPrompt = null;

function initPWA() {
  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('[SW] Registered:', reg.scope))
      .catch(err => console.warn('[SW] Registration failed:', err));
  }

  // Listen for install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    // Show custom install banner
    const dismissed = localStorage.getItem('bizcard_pwa_dismissed');
    if (!dismissed) {
      $('pwaInstallBanner').style.display = 'block';
    }
  });

  // Install button
  $('btnPwaInstall').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const result = await deferredInstallPrompt.userChoice;
    if (result.outcome === 'accepted') {
      toast('✅ App installata!', 'success');
    }
    deferredInstallPrompt = null;
    $('pwaInstallBanner').style.display = 'none';
  });

  // Dismiss button
  $('btnPwaDismiss').addEventListener('click', () => {
    $('pwaInstallBanner').style.display = 'none';
    localStorage.setItem('bizcard_pwa_dismissed', '1');
  });

  // Detect if already installed
  window.addEventListener('appinstalled', () => {
    $('pwaInstallBanner').style.display = 'none';
    deferredInstallPrompt = null;
    toast('✅ BizCard Scanner installata sul dispositivo!', 'success');
  });

  // iOS Safari: show manual install hint
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (isIOS && !isStandalone) {
    const dismissed = localStorage.getItem('bizcard_pwa_dismissed');
    if (!dismissed) {
      setTimeout(() => {
        toast('💡 Per installare: tocca Condividi ⬆️ → Aggiungi a Home', 'info', 6000);
      }, 3000);
    }
  }

  // Render export history on load
  renderExportHistory();
}

// Init PWA on load
initPWA();

function toast(msg, type = 'success', duration = 3500) {
  const container = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  el.setAttribute('role', 'alert');
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    el.style.transition = 'all .3s';
    setTimeout(() => el.remove(), 300);
  }, duration);
}
