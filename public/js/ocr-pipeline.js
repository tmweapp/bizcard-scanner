// ─── OCR PROCESSING ───────────────────────────────────────────
async function processOCR(base64, dataUrl) {
  const os = $('ocrStatus');
  os.style.display = 'flex';
  os.className = 'ocr-status processing';
  $('ocrStatusText').textContent = 'Analisi OCR in corso...';
  $('ocrProgress').style.width = '0';
  lastPhotoDataUrl = dataUrl; // Store for saving with contact
  $('photoPreview').src = dataUrl;
  $('photoPreview').classList.remove('zoomed');

  let ocrResult = null;

  try {
    if (useServerOCR) {
      $('ocrStatusText').textContent = `Invio a ${serverEngine}...`;
      $('ocrProgress').style.width = '30%';

      const resp = await fetch('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64 }),
      });
      ocrResult = await resp.json();
      $('ocrProgress').style.width = '80%';

      if (ocrResult.fallback) {
        useServerOCR = false;
        ocrResult = await runTesseract(dataUrl);
      }
    } else {
      ocrResult = await runTesseract(dataUrl);
    }
  } catch (e) {
    console.warn('[BizCard] Server OCR failed, falling back to Tesseract:', e);
    try {
      ocrResult = await runTesseract(dataUrl);
    } catch (e2) {
      os.className = 'ocr-status error';
      $('ocrStatusText').textContent = '❌ Errore OCR: ' + e2.message;
      return;
    }
  }

  scanCount++;
  saveState();

  if (!ocrResult || !ocrResult.text || !ocrResult.text.trim()) {
    os.className = 'ocr-status error';
    $('ocrStatusText').textContent = '⚠️ Nessun testo rilevato. Prova con una foto più nitida e con buona illuminazione.';
    return;
  }

  $('ocrProgress').style.width = '80%';

  // ── DUAL FACE: intercept before classification ──
  if (dualFaceMode && !dualFacePending) {
    // Face 1 captured — store text and wait for face 2
    dualFacePending = ocrResult.text;
    $('ocrProgress').style.width = '100%';
    os.className = 'ocr-status ready';
    $('ocrStatusText').textContent = '✅ Fronte acquisito — ora scansiona il retro';
    setTimeout(() => { os.style.display = 'none'; }, 2000);
    advanceDualFaceUI();
    toast('Fronte acquisito! Ora scansiona il retro del biglietto', 'success');
    return;
  }

  let finalText = ocrResult.text;
  if (dualFaceMode && dualFacePending) {
    // Face 2 captured — merge both faces
    finalText = dualFacePending + '\n' + ocrResult.text;
    dualFacePending = null;
    resetDualFaceUI();
    toast('Entrambe le facciate acquisite! Elaborazione...', 'success');
  }

  classifyBlocks(finalText);

  // Auto AI Normalization
  if (openaiApiKey && detectedBlocks.length > 0) {
    $('ocrStatusText').textContent = '✨ Normalizzazione AI...';
    await normalizeWithAI();
  }

  $('ocrProgress').style.width = '100%';
  os.className = 'ocr-status ready';
  $('ocrStatusText').textContent = '✅ Analisi completata';
  setTimeout(() => { os.style.display = 'none'; }, 2000);

  // Auto-start session on first scan
  if (!currentSession) startSession();
  currentSession.photoCount++;

  // Show clean contact card
  $('resultSection').style.display = 'block';
  renderCleanCard();
}

async function runTesseract(dataUrl) {
  if (!tesseractReady) {
    $('ocrStatusText').textContent = 'Caricamento Tesseract.js...';
    await initTesseractFallback();
  }
  if (!tesseractWorker) throw new Error('Tesseract non disponibile');

  $('ocrStatusText').textContent = 'Analisi con Tesseract.js (locale)...';
  const result = await tesseractWorker.recognize(dataUrl);
  return {
    engine: 'tesseract-local',
    text: result.data.text || '',
    words: (result.data.words || []).map(w => ({
      text: w.text,
      confidence: w.confidence / 100,
    })),
    blocks: [],
  };
}

// ─── TEXT CLASSIFICATION ENGINE ───────────────────────────────
function cleanOcrLine(line) {
  // Remove common OCR icon artifacts: ®, ©, |, \, }, {, §, «, », [], and stray symbols
  let clean = line
    .replace(/[®©§«»\[\]{}|\\¬~^`<>]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // If a line has too many non-alphanumeric characters (>40%), it's noise
  const alphaNum = clean.replace(/[^a-zA-Z0-9àèéìòùÀÈÉÌÒÙäöüÄÖÜñÑ@.+\-_/,:; ]/g, '');
  if (clean.length > 10 && alphaNum.length / clean.length < 0.5) {
    // Try to salvage a phone number from the noise
    const phoneInNoise = clean.match(/\+?\d[\d\s.\-()]{7,18}/);
    if (phoneInNoise) return phoneInNoise[0].trim();
    return '';
  }
  return clean;
}

function classifyBlocks(rawText) {
  detectedBlocks = [];

  const lines = rawText.split('\n')
    .map(l => cleanOcrLine(l.trim()))
    .filter(l => l.length > 1);

  // First pass: classify each line with confidence scoring
  const classified = lines.map((line, idx) => {
    const result = classifyLine(line, idx, lines.length);
    return { text: line, type: result.type, confidence: result.confidence };
  });

  // Second pass: resolve conflicts (e.g., multiple names)
  const typeCounts = {};
  classified.forEach(b => { typeCounts[b.type] = (typeCounts[b.type] || 0) + 1; });

  // If we have too many "name" detections, keep only the highest confidence one
  if (typeCounts.name > 2) {
    let bestNameIdx = -1;
    let bestNameConf = 0;
    classified.forEach((b, i) => {
      if (b.type === 'name' && b.confidence > bestNameConf) {
        bestNameConf = b.confidence;
        bestNameIdx = i;
      }
    });
    classified.forEach((b, i) => {
      if (b.type === 'name' && i !== bestNameIdx) {
        // Downgrade to company or role based on position
        b.type = i < lines.length / 2 ? 'role' : 'company';
        b.confidence *= 0.6;
      }
    });
  }

  // If no name was detected, check if the first line looks like one
  if (!typeCounts.name && classified.length > 0) {
    const first = classified[0];
    if (first.type === 'other' || first.type === 'company') {
      const words = first.text.split(/\s+/);
      if (words.length >= 2 && words.length <= 4 && !/\d/.test(first.text)) {
        first.type = 'name';
        first.confidence = 0.5;
      }
    }
  }

  detectedBlocks = classified;
}

function classifyLine(text, lineIndex, totalLines) {
  const t = text.trim();
  if (t.length < 2) return { type: 'ignore', confidence: 0.9 };

  // ── High confidence patterns ──

  // Email (very reliable)
  if (RE.email.test(t)) return { type: 'email', confidence: 0.98 };

  // Codice Fiscale (very reliable pattern)
  if (RE.cf.test(t)) return { type: 'cf', confidence: 0.97 };

  // P.IVA (very reliable with keyword)
  if (RE.piva.test(t)) return { type: 'piva', confidence: 0.96 };

  const low = t.toLowerCase();

  // Fax (check before generic phone)
  if (RE.fax.test(t)) return { type: 'fax', confidence: 0.85 };

  // LinkedIn
  if (RE.linkedin.test(t)) return { type: 'linkedin', confidence: 0.95 };

  // ── Medium confidence patterns ──

  // Address (keyword-based, reliable)
  if (RE.address.test(t)) return { type: 'address', confidence: 0.88 };

  // Role (keyword matching)
  const roleRegex = new RegExp('\\b(' + ROLES.join('|') + ')\\b', 'i');
  if (roleRegex.test(t)) return { type: 'role', confidence: 0.82 };

  // Mobile phone (keyword: cell/cellulare/mob/MOB/mobile/whatsapp, or IT mobile prefix 3XX)
  if (RE.mobile.test(t)) {
    const digits = t.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15) {
      return { type: 'mobile', confidence: 0.88 };
    }
  }

  // Explicit mobile keywords even with flexible format
  if (/(?:^|\s|:)(?:cell(?:ulare)?|mob(?:ile|\.)?|m\s*[:.])\s*\+?\d/i.test(t)) {
    const digits = t.replace(/\D/g, '');
    if (digits.length >= 7) return { type: 'mobile', confidence: 0.90 };
  }

  // Phone — check if it's a mobile by prefix even without keyword
  const phoneMatch = t.match(RE.phone);
  if (phoneMatch) {
    const digits = phoneMatch[0].replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15 && t.length < 40) {
      // Italian mobile: +39 3XX or just 3XX...
      const isMobile = /(?:^|\+?39\s*)?3\d{2}/.test(phoneMatch[0].replace(/[\s.\-()]/g, ''))
        || /(?:^|\s)(?:cell(?:ulare)?|mob(?:ile|\.)?|whatsapp|wa)\b/i.test(t);
      // International mobile hints: +44 7, +49 1, +33 6/7
      const intlMobile = /\+44\s*7|\+49\s*1[567]|\+33\s*[67]|\+34\s*[67]|\+86\s*1[3-9]|\+81\s*[789]0/.test(phoneMatch[0].replace(/[\s.\-]/g, ''));

      if (isMobile || intlMobile) {
        return { type: 'mobile', confidence: 0.85 };
      }
      return { type: 'phone', confidence: 0.80 };
    }
  }

  // Website (must have TLD, not be email)
  if (RE.web.test(t) && !t.includes('@') && t.includes('.') && t.length < 80) {
    return { type: 'web', confidence: 0.78 };
  }

  // ── Heuristic patterns ──

  // Company (keyword-based)
  const companyRegex = new RegExp('\\b(' + COMPANY_KW.join('|') + ')\\b', 'i');
  if (companyRegex.test(t)) return { type: 'company', confidence: 0.82 };
  if (/[&]/.test(t) && t.length < 50 && t.length > 3) return { type: 'company', confidence: 0.55 };

  // Name heuristics
  const cleaned = t.replace(TITLE_PREFIX, '');
  const letters = (cleaned.match(/[a-zA-ZàèéìòùÀÈÉÌÒÙáóúÁÓÚüñ]/g) || []).length;
  const letterRatio = letters / Math.max(cleaned.length, 1);
  const words = cleaned.split(/\s+/).filter(w => w.length > 0);
  const hasDigits = /\d/.test(cleaned);
  const allCapStart = words.filter(w => /^[A-ZÀÈÉÌÒÙÁÓÚ]/.test(w)).length;

  // Strong name signal: 2-4 capitalized words, no digits, mostly letters, near top
  if (letterRatio > 0.8 && words.length >= 2 && words.length <= 4 && !hasDigits && cleaned.length < 45) {
    const positionBoost = lineIndex < 3 ? 0.15 : 0;
    if (allCapStart >= 2) return { type: 'name', confidence: 0.75 + positionBoost };
    if (TITLE_PREFIX.test(t)) return { type: 'name', confidence: 0.80 };
    return { type: 'name', confidence: 0.55 + positionBoost };
  }

  // Weaker name signal
  if (letterRatio > 0.7 && words.length >= 2 && words.length <= 3 && !hasDigits && allCapStart >= 2) {
    return { type: 'name', confidence: 0.50 };
  }

  // Generic text → likely company
  if (letterRatio > 0.5 && t.length > 3 && t.length < 60 && !hasDigits) {
    return { type: 'company', confidence: 0.35 };
  }

  // Short numbers or garbage
  if (t.length < 3 || /^\d+$/.test(t)) return { type: 'ignore', confidence: 0.7 };

  return { type: 'other', confidence: 0.2 };
}

// ─── RENDER TEXT BLOCKS ───────────────────────────────────────
function renderBlocks() {
  const container = $('textBlocksContainer');
  let html = '';

  detectedBlocks.forEach((block, i) => {
    const ft = FIELD_TYPES.find(f => f.key === block.type) || FIELD_TYPES[10]; // 'other'
    const typeClass = block.type === 'ignore' ? '' : (ft.req ? 'required' : 'assigned');
    const confPercent = Math.round(block.confidence * 100);
    const confColor = confPercent >= 80 ? 'var(--green)' : confPercent >= 50 ? 'var(--orange)' : 'var(--fg4)';

    html += `<div class="text-block${block.type === 'ignore' ? ' ignored' : ''}" data-i="${i}" role="listitem">
      <span class="tb-icon">${ft.icon}</span>
      <span class="tb-text" contenteditable="false" data-i="${i}" title="Doppio click per modificare">${esc(block.text)}</span>
      <span class="tb-conf" style="color:${confColor}" title="Confidenza">${confPercent}%</span>
      <span class="tb-type ${typeClass}" data-i="${i}" title="Clicca per cambiare tipo">${ft.label} ▾</span>
    </div>`;
  });

  container.innerHTML = html;

  // Event: change type
  container.querySelectorAll('.tb-type').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      showTypeDropdown(parseInt(el.dataset.i), el);
    });
  });

  // Event: double-click to edit text
  container.querySelectorAll('.tb-text').forEach(el => {
    el.addEventListener('dblclick', () => {
      el.contentEditable = 'true';
      el.focus();
      // Select all text
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });

    el.addEventListener('blur', () => {
      el.contentEditable = 'false';
      const idx = parseInt(el.dataset.i);
      const newText = el.textContent.trim();
      if (newText && detectedBlocks[idx]) {
        detectedBlocks[idx].text = newText;
        // Re-classify with new text
        const result = classifyLine(newText, idx, detectedBlocks.length);
        if (detectedBlocks[idx].type === detectedBlocks[idx].type) {
          // Only auto-reclassify if user hasn't manually changed it
        }
        renderFieldSummary();
      }
    });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      if (e.key === 'Escape') { el.contentEditable = 'false'; }
    });
  });
}

function showTypeDropdown(idx, anchor) {
  // Remove existing dropdown
  const existing = document.querySelector('.type-dropdown');
  if (existing) existing.remove();

  const dd = document.createElement('div');
  dd.className = 'type-dropdown';
  dd.setAttribute('role', 'listbox');

  FIELD_TYPES.forEach(ft => {
    const btn = document.createElement('button');
    btn.textContent = ft.icon + ' ' + ft.label + (ft.req ? ' *' : '');
    btn.setAttribute('role', 'option');
    if (detectedBlocks[idx] && detectedBlocks[idx].type === ft.key) {
      btn.classList.add('active-type');
    }
    btn.addEventListener('click', () => {
      detectedBlocks[idx].type = ft.key;
      detectedBlocks[idx].confidence = 1.0; // Manual assignment = 100%
      dd.remove();
      renderBlocks();
      renderFieldSummary();
    });
    dd.appendChild(btn);
  });

  const rect = anchor.getBoundingClientRect();
  dd.style.top = (rect.bottom + 4) + 'px';
  dd.style.right = (window.innerWidth - rect.right) + 'px';

  // Ensure dropdown stays within viewport
  document.body.appendChild(dd);
  const ddRect = dd.getBoundingClientRect();
  if (ddRect.bottom > window.innerHeight) {
    dd.style.top = (rect.top - ddRect.height - 4) + 'px';
  }

  // Close on outside click
  setTimeout(() => {
    const closer = (e) => {
      if (!dd.contains(e.target)) { dd.remove(); document.removeEventListener('click', closer); }
    };
    document.addEventListener('click', closer);
  }, 10);
}

function renderFieldSummary() {
  const container = $('fieldRows');
  let html = '';

  FIELD_TYPES.filter(f => f.key !== 'other' && f.key !== 'ignore').forEach(ft => {
    const values = detectedBlocks
      .filter(b => b.type === ft.key)
      .map(b => b.text)
      .join(', ');

    html += `<div class="fs-row">
      <span class="fs-label">${ft.icon} ${ft.label}${ft.req ? '<span class="fs-required"> *</span>' : ''}</span>
      <span class="fs-value${values ? '' : ' empty'}">${values ? esc(values) : '—'}</span>
    </div>`;
  });

  container.innerHTML = html;
}

// ─── LIVE CARD BUILDER ───────────────────────────────────────
function showLiveCard() {
  // Reset live card to skeleton state
  $('liveName').innerHTML = '<div class="shimmer-line" style="width:70%"></div>';
  $('liveRole').innerHTML = '<div class="shimmer-line" style="width:50%"></div>';
  $('liveCompany').innerHTML = '<div class="shimmer-line" style="width:60%"></div>';
  $('liveCardBody').innerHTML = '';
  $('liveFlag').style.display = 'none';
  $('liveCard').style.display = 'block';
}

function updateLiveProgress(pct) {
  $('ssTopFill').style.width = pct + '%';
}

function updateLiveField(key, value, icon) {
  if (!value) return;

  // Header fields
  if (key === 'name') {
    $('liveName').textContent = value;
    $('liveName').classList.add('refined');
    setTimeout(() => $('liveName').classList.remove('refined'), 600);
    return;
  }
  if (key === 'role') {
    $('liveRole').textContent = value;
    $('liveRole').classList.add('refined');
    setTimeout(() => $('liveRole').classList.remove('refined'), 600);
    return;
  }
  if (key === 'company') {
    $('liveCompany').textContent = value;
    $('liveCompany').classList.add('refined');
    setTimeout(() => $('liveCompany').classList.remove('refined'), 600);
    return;
  }

  // Country → show flag
  if (key === 'country') {
    const iso = getCountryISO(value);
    if (iso) {
      $('liveFlagImg').src = 'https://flagcdn.com/w80/' + iso + '.png';
      $('liveFlag').style.display = 'block';
    }
  }

  // Body fields — add or update
  const container = $('liveCardBody');
  let existing = container.querySelector('[data-key="' + key + '"]');
  if (existing) {
    const valEl = existing.querySelector('.live-body-value');
    valEl.textContent = value;
    existing.classList.add('refined');
    setTimeout(() => existing.classList.remove('refined'), 600);
  } else {
    const row = document.createElement('div');
    row.className = 'live-body-field';
    row.dataset.key = key;
    row.style.animationDelay = (container.children.length * 80) + 'ms';
    row.innerHTML = '<span class="live-body-icon">' + (icon || '📌') + '</span>' +
      '<div class="live-body-content">' +
        '<div class="live-body-label">' + key + '</div>' +
        '<div class="live-body-value">' + value + '</div>' +
      '</div>';
    container.appendChild(row);
  }
}

function populateLiveCardFromBlocks() {
  // Called after classifyBlocks — show raw classified data on live card
  const fieldIcons = {};
  FIELD_TYPES.forEach(ft => { fieldIcons[ft.key] = ft.icon; });

  FIELD_TYPES.forEach(ft => {
    if (ft.key === 'other' || ft.key === 'ignore') return;
    const values = detectedBlocks
      .filter(b => b.type === ft.key)
      .map(b => b.text)
      .filter(Boolean);
    if (values.length) {
      updateLiveField(ft.key, values.join(', '), ft.icon);
    }
  });
}

function refineLiveCardFromBlocks() {
  // Called after AI normalization — update with refined data + glow
  const fieldIcons = {};
  FIELD_TYPES.forEach(ft => { fieldIcons[ft.key] = ft.icon; });

  const delay = 100;
  let i = 0;
  FIELD_TYPES.forEach(ft => {
    if (ft.key === 'other' || ft.key === 'ignore') return;
    const values = detectedBlocks
      .filter(b => b.type === ft.key)
      .map(b => b.text)
      .filter(Boolean);
    if (values.length) {
      setTimeout(() => {
        updateLiveField(ft.key, values.join(', '), ft.icon);
      }, i * delay);
      i++;
    }
  });
}

// ─── COUNTRY → ISO FLAG MAP ──────────────────────────────────
const COUNTRY_ISO = {
  // Italian names
  'italia':'it','germania':'de','francia':'fr','spagna':'es','regno unito':'gb','inghilterra':'gb',
  'svizzera':'ch','austria':'at','belgio':'be','olanda':'nl','paesi bassi':'nl','portogallo':'pt',
  'grecia':'gr','svezia':'se','norvegia':'no','danimarca':'dk','finlandia':'fi','irlanda':'ie',
  'polonia':'pl','romania':'ro','ungheria':'hu','repubblica ceca':'cz','slovacchia':'sk',
  'croazia':'hr','slovenia':'si','serbia':'rs','bulgaria':'bg','lussemburgo':'lu','malta':'mt',
  'cipro':'cy','estonia':'ee','lettonia':'lv','lituania':'lt','islanda':'is','turchia':'tr',
  'russia':'ru','ucraina':'ua','bielorussia':'by','moldavia':'md','albania':'al','kosovo':'xk',
  'macedonia del nord':'mk','montenegro':'me','bosnia':'ba','bosnia ed erzegovina':'ba',
  'stati uniti':'us','usa':'us','canada':'ca','messico':'mx','brasile':'br','argentina':'ar',
  'cile':'cl','colombia':'co','peru':'pe','perù':'pe','venezuela':'ve','ecuador':'ec',
  'uruguay':'uy','paraguay':'py','bolivia':'bo','costa rica':'cr','panama':'pa','cuba':'cu',
  'repubblica dominicana':'do','guatemala':'gt','honduras':'hn','el salvador':'sv','nicaragua':'ni',
  'cina':'cn','giappone':'jp','corea del sud':'kr','corea del nord':'kp','india':'in',
  'indonesia':'id','filippine':'ph','vietnam':'vn','thailandia':'th','malesia':'my',
  'singapore':'sg','taiwan':'tw','hong kong':'hk','macao':'mo','mongolia':'mn',
  'pakistan':'pk','bangladesh':'bd','sri lanka':'lk','nepal':'np','myanmar':'mm',
  'cambogia':'kh','laos':'la','brunei':'bn','timor est':'tl',
  'arabia saudita':'sa','emirati arabi':'ae','emirati arabi uniti':'ae','qatar':'qa',
  'kuwait':'kw','bahrein':'bh','oman':'om','yemen':'ye','iraq':'iq','iran':'ir',
  'israele':'il','palestina':'ps','giordania':'jo','libano':'lb','siria':'sy',
  'egitto':'eg','marocco':'ma','tunisia':'tn','algeria':'dz','libia':'ly',
  'sudafrica':'za','sud africa':'za','nigeria':'ng','kenya':'ke','etiopia':'et',
  'ghana':'gh','tanzania':'tz','uganda':'ug','mozambico':'mz','angola':'ao',
  'camerun':'cm','costa d\'avorio':'ci','senegal':'sn','madagascar':'mg','congo':'cd',
  'australia':'au','nuova zelanda':'nz','fiji':'fj','papua nuova guinea':'pg',
  // English names
  'italy':'it','germany':'de','france':'fr','spain':'es','united kingdom':'gb','england':'gb',
  'great britain':'gb','switzerland':'ch','netherlands':'nl','portugal':'pt','greece':'gr',
  'sweden':'se','norway':'no','denmark':'dk','finland':'fi','ireland':'ie','poland':'pl',
  'romania':'ro','hungary':'hu','czech republic':'cz','czechia':'cz','slovakia':'sk',
  'croatia':'hr','serbia':'rs','bulgaria':'bg','luxembourg':'lu','iceland':'is',
  'turkey':'tr','türkiye':'tr','russia':'ru','ukraine':'ua','belarus':'by',
  'united states':'us','united states of america':'us','brazil':'br','chile':'cl',
  'colombia':'co','peru':'pe','costa rica':'cr','dominican republic':'do',
  'china':'cn','japan':'jp','south korea':'kr','north korea':'kp','india':'in',
  'indonesia':'id','philippines':'ph','thailand':'th','malaysia':'my','singapore':'sg',
  'taiwan':'tw','mongolia':'mn','pakistan':'pk','bangladesh':'bd','sri lanka':'lk',
  'cambodia':'kh','saudi arabia':'sa','united arab emirates':'ae','uae':'ae',
  'qatar':'qa','kuwait':'kw','bahrain':'bh','iraq':'iq','iran':'ir','israel':'il',
  'jordan':'jo','lebanon':'lb','syria':'sy','egypt':'eg','morocco':'ma',
  'tunisia':'tn','algeria':'dz','libya':'ly','south africa':'za','nigeria':'ng',
  'kenya':'ke','ethiopia':'et','ghana':'gh','tanzania':'tz','australia':'au',
  'new zealand':'nz',
  // German names
  'deutschland':'de','frankreich':'fr','spanien':'es','vereinigtes königreich':'gb',
  'österreich':'at','belgien':'be','niederlande':'nl','schweden':'se','norwegen':'no',
  'dänemark':'dk','finnland':'fi','irland':'ie','griechenland':'gr','tschechien':'cz',
  'slowakei':'sk','kroatien':'hr','serbien':'rs','bulgarien':'bg','rumänien':'ro',
  'ungarn':'hu','luxemburg':'lu','vereinigte staaten':'us','brasilien':'br',
  'argentinien':'ar','mexiko':'mx','kolumbien':'co','china':'cn','indien':'in',
  'südafrika':'za','ägypten':'eg','marokko':'ma','australien':'au','neuseeland':'nz',
  // French names
  'allemagne':'de','espagne':'es','royaume-uni':'gb','suisse':'ch','autriche':'at',
  'belgique':'be','pays-bas':'nl','suède':'se','norvège':'no','danemark':'dk',
  'finlande':'fi','irlande':'ie','grèce':'gr','pologne':'pl','roumanie':'ro',
  'hongrie':'hu','états-unis':'us','brésil':'br','argentine':'ar','mexique':'mx',
  'chine':'cn','japon':'jp','inde':'in','afrique du sud':'za','égypte':'eg',
  'maroc':'ma','tunisie':'tn','algérie':'dz','australie':'au','nouvelle-zélande':'nz',
  // Spanish names
  'alemania':'de','francia':'fr','españa':'es','reino unido':'gb','suiza':'ch',
  'países bajos':'nl','suecia':'se','noruega':'no','dinamarca':'dk','finlandia':'fi',
  'irlanda':'ie','grecia':'gr','hungría':'hu','estados unidos':'us','brasil':'br',
  'japón':'jp','corea del sur':'kr','sudáfrica':'za','egipto':'eg','marruecos':'ma',
  // Portuguese names
  'alemanha':'de','espanha':'es','reino unido':'gb','suíça':'ch','países baixos':'nl',
  'suécia':'se','noruega':'no','dinamarca':'dk','finlândia':'fi','irlanda':'ie',
  'grécia':'gr','hungria':'hu','estados unidos':'us','japão':'jp','china':'cn',
  'índia':'in','áfrica do sul':'za','egito':'eg','marrocos':'ma','austrália':'au',
  // Common abbreviations
  'uk':'gb','gb':'gb','us':'us','usa':'us','uae':'ae','rsa':'za','prc':'cn','rok':'kr',
  'ch':'ch','de':'de','fr':'fr','es':'es','it':'it','nl':'nl','at':'at','be':'be',
  'pt':'pt','pl':'pl','se':'se','no':'no','dk':'dk','fi':'fi','ie':'ie','cz':'cz',
  'jp':'jp','cn':'cn','kr':'kr','in':'in','au':'au','nz':'nz','br':'br','ar':'ar',
  'mx':'mx','ca':'ca','za':'za','eg':'eg','ma':'ma','tn':'tn','tr':'tr','ru':'ru',
  'il':'il','sg':'sg','hk':'hk','tw':'tw','th':'th','my':'my','id':'id','ph':'ph',
  'vn':'vn',
};

function getCountryISO(countryStr) {
  if (!countryStr) return null;
  // Clean: remove parentheses content, trim
  let c = countryStr.replace(/\(.*?\)/g, '').trim().toLowerCase();
  // Direct match
  if (COUNTRY_ISO[c]) return COUNTRY_ISO[c];
  // Try without accents
  const noAccent = c.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (COUNTRY_ISO[noAccent]) return COUNTRY_ISO[noAccent];
  // Try partial match (country name contains one of our keys)
  for (const [name, code] of Object.entries(COUNTRY_ISO)) {
    if (name.length > 3 && c.includes(name)) return code;
  }
  // If it's already a 2-letter code
  if (c.length === 2 && /^[a-z]{2}$/.test(c)) return c;
  return null;
}

// ─── CLEAN CONTACT CARD RENDERER ──────────────────────────────
function renderCleanCard() {
  // Extract field values from detectedBlocks
  const fields = {};
  FIELD_TYPES.forEach(ft => {
    if (ft.key === 'other' || ft.key === 'ignore') return;
    const values = detectedBlocks
      .filter(b => b.type === ft.key)
      .map(b => b.text)
      .filter(Boolean);
    if (values.length) fields[ft.key] = values.join(', ');
  });

  // Header: name, role, company
  $('ccName').textContent = fields.name || 'Nome non rilevato';
  $('ccName').classList.toggle('placeholder', !fields.name);
  $('ccRole').textContent = fields.role || '';
  $('ccRole').style.display = fields.role ? 'block' : 'none';
  $('ccCompany').textContent = fields.company || '';
  $('ccCompany').style.display = fields.company ? 'block' : 'none';

  // Build field rows (skip name/role/company — already in header)
  const skipKeys = ['name', 'role', 'company'];
  const fieldOrder = ['email', 'mobile', 'phone', 'web', 'linkedin', 'address', 'city', 'country', 'piva', 'cf', 'fax', 'notes'];
  const container = $('cleanCardFields');
  let html = '';

  fieldOrder.forEach(key => {
    if (!fields[key]) return;
    const ft = FIELD_TYPES.find(f => f.key === key);
    if (!ft) return;

    // Make actionable links
    let valueHtml = esc(fields[key]);
    if (key === 'email') {
      valueHtml = fields[key].split(',').map(e => {
        const em = e.trim();
        return `<a href="mailto:${em}" class="cc-link">${esc(em)}</a>`;
      }).join(', ');
    } else if (key === 'mobile' || key === 'phone' || key === 'fax') {
      // Handle multiple numbers separated by comma
      valueHtml = fields[key].split(',').map(p => {
        const pt = p.trim();
        const num = pt.replace(/[^\d+]/g, '');
        return `<a href="tel:${num}" class="cc-link">${esc(pt)}</a>`;
      }).join(', ');
    } else if (key === 'web') {
      valueHtml = `<a href="${fields[key]}" target="_blank" rel="noopener" class="cc-link">${esc(fields[key])}</a>`;
    } else if (key === 'linkedin') {
      valueHtml = `<a href="${fields[key]}" target="_blank" rel="noopener" class="cc-link">${esc(fields[key])}</a>`;
    }

    html += `<div class="cc-field">
      <span class="cc-field-icon">${ft.icon}</span>
      <div class="cc-field-content">
        <div class="cc-field-label">${ft.label}</div>
        <div class="cc-field-value">${valueHtml}</div>
      </div>
    </div>`;
  });

  container.innerHTML = html;

  // Logo description
  if (window._lastLogoDescription) {
    $('ccLogo').textContent = '🏷️ ' + window._lastLogoDescription;
    $('ccLogo').style.display = 'block';
  } else {
    $('ccLogo').style.display = 'none';
  }

  // 3D Flag from country
  const isoCode = getCountryISO(fields.country);
  if (isoCode) {
    const flagUrl = `https://flagcdn.com/w160/${isoCode}.png`;
    $('ccFlagImg').src = flagUrl;
    $('ccFlagImg').alt = fields.country;
    $('ccFlagCountry').textContent = fields.country;
    $('ccFlagWrap').style.display = 'flex';
    // Preload to avoid flicker
    const preload = new Image();
    preload.src = flagUrl;
  } else {
    $('ccFlagWrap').style.display = 'none';
  }

  // Show card with animation
  $('cleanCard').classList.add('visible');
}

// ─── AI NORMALIZATION ──────────────────────────────────────────
const AI_NORMALIZE_PROMPT = `Sei un sistema di data enrichment per un CRM/database commerciale. Ricevi dati OCR grezzi da biglietti da visita e devi restituire dati COMPLETI, PULITI e STRUTTURATI per un database professionale.

═══ CAMPI E REGOLE ═══

1. **name**: Title Case (es. "MARIO ROSSI" → "Mario Rossi"). Rimuovi titoli (Dott., Ing., Avv.) e spostali nel ruolo.
2. **company**: Formatta correttamente. Mantieni forma giuridica standard (S.r.l., S.p.A., Ltd., GmbH, Inc.). Se riconosci l'azienda, usa il nome ufficiale.
3. **email**: Minuscolo, rimuovi spazi. ⚠️ ESTRAI TUTTE le email presenti, SEMPRE. Se ci sono 2, 3 o più email, separale con virgola. Non scartarne MAI nessuna.
4. **mobile**: ⚠️ ESTRAI TUTTI i numeri di CELLULARE trovati, SEMPRE, separati da virgola. Identifica cellulari da: etichette "Cell", "Mob", "MOB", "Mobile", "Cellulare", "WhatsApp", "WA" → è cellulare. Prefissi mobili: IT 3XX, US/CA +1, UK +44 7XXX, DE +49 1XXX, FR +33 6/7, ES +34 6/7, CN +86 1XX, JP +81 70/80/90. Formato internazionale (+39 3XX XXX XXXX per Italia). Se ci sono 2 o più cellulari, mettili TUTTI separati da virgola.
5. **phone**: ⚠️ ESTRAI TUTTI i numeri di TELEFONO FISSO / sede, SEMPRE, separati da virgola. Tutto ciò che NON è cellulare (prefissi fissi: IT 0X, US area codes, UK 01/02/03, ecc.). Se dice "Tel", "Office", "Ufficio", "Sede", "T.", "Ph." → fisso. Se ci sono 2+ numeri fissi, mettili TUTTI.
6. **role**: Titolo professionale completo in lingua originale + traduzione italiana tra parentesi se non italiano. Es: "Chief Technology Officer (Direttore Tecnologico)". Espandi abbreviazioni: "amm. del." → "Amministratore Delegato", "CEO" → "CEO (Amministratore Delegato)".
7. **web**: URL completo con https://. Minuscolo. Se c'è solo dominio nell'email (es. mario@acme.com), deduci "https://www.acme.com".
8. **address**: Solo via/numero/CAP. Formatta: Via/Piazza/Straße/Street ecc. + numero + CAP.
9. **city**: Città + eventuale provincia/stato. DEDUCI dal CAP se non esplicita: "20121" → "Milano (MI)", "10001" → "New York, NY", "SW1A" → "London". Per Italia aggiungi sempre sigla provincia.
10. **country**: Paese completo. DEDUCI SEMPRE se non presente: dal prefisso telefonico (+39→Italia, +1→USA/Canada, +44→UK, +49→Germania, +86→Cina, +81→Giappone), dal dominio email (.it→Italia, .de→Germania, .jp→Giappone, .cn→Cina), dal CAP, dalla lingua del biglietto, dalla forma giuridica (S.r.l.→Italia, GmbH→Germania/Austria, Ltd→UK, Inc→USA). Formato: "Italia", "United States", "Deutschland", ecc.
11. **piva**: P.IVA/VAT Number. Italia: "IT" + 11 cifre. Altro: prefisso paese + numero (DE + 9 cifre, GB + 9 cifre, ecc.).
12. **cf**: Codice Fiscale italiano (MAIUSCOLO) o equivalente estero (SSN, NIF, TIN, Steuernummer).
13. **fax**: Formato internazionale come telefono fisso.
14. **linkedin**: URL profilo LinkedIn se presente, o deducibile dal nome + azienda (NON inventare, solo se c'è un indizio nel biglietto).
15. **notes**: Info aggiuntive utili commercialmente: settore attività, specializzazioni, certificazioni, sedi multiple, orari.

═══ LINGUE E TRADUZIONI ═══
- Se il biglietto è in caratteri non latini (cinese 中文, giapponese 日本語, coreano 한국어, arabo العربية, ebraico עברית, thai ไทย, russo кириллица, hindi हिन्दी, ecc.):
  • Trascrivi OGNI campo in caratteri latini (romanizzazione)
  • Per nomi: usa la romanizzazione standard (Pinyin per cinese, Romaji per giapponese, Revised Romanization per coreano)
  • Aggiungi la versione originale tra parentesi: es. "Tanaka Yuki (田中 優希)"
  • Per aziende: nome romanizzato + originale tra parentesi
  • Traduci il ruolo in italiano

═══ DEDUZIONE INTELLIGENTE ═══
- DEDUCI città e paese da QUALSIASI indizio: CAP, prefisso telefonico, dominio email, lingua, forma giuridica
- Se l'indirizzo contiene una città nota (Milano, Roma, New York, London, Tokyo, Shanghai...) estraila nel campo city
- Se manca il paese ma c'è un prefisso +39 → Italia, +1 → USA, ecc.
- Se manca il web ma c'è un'email aziendale → deduci il sito
- Distingui SEMPRE cellulare da fisso basandoti su etichette (Cell/Mob/MOB/Mobile/Cellulare → mobile, Tel/Ufficio/Office/Sede → fisso) e prefissi
- Se c'è un solo numero e non è chiaro, mettilo in "mobile" (più utile commercialmente)
- ⚠️ REGOLA CRITICA: NON PERDERE MAI nessun numero di telefono e nessuna email. Se il biglietto ha 3 numeri, devono apparire TUTTI nel JSON (distribuiti tra mobile, phone, fax). Se ha 2 email, entrambe nel campo email separate da virgola. OGNI dato di contatto è prezioso.

═══ CORREZIONE OCR ═══
- Correggi errori OCR tipici: 0↔O, 1↔l↔I, 5↔S, 8↔B, rn↔m
- Se un'email sembra sbagliata (es. "mario@acme,com") correggila
- Se un numero ha caratteri extra (es. "Tel: +39 02-1234 567") puliscilo

═══ FORMATO RISPOSTA ═══
Rispondi SOLO con JSON valido, nessun testo aggiuntivo:
{
  "name": "",
  "company": "",
  "email": "",
  "mobile": "",
  "phone": "",
  "role": "",
  "web": "",
  "address": "",
  "city": "",
  "country": "",
  "piva": "",
  "cf": "",
  "fax": "",
  "linkedin": "",
  "notes": ""
}`;

async function normalizeWithAI() {
  if (!openaiApiKey) {
    toast('Inserisci la tua API Key OpenAI nel campo in alto', 'error');
    $('openaiKeyInput').focus();
    $('apiKeyBar').scrollIntoView({ behavior: 'smooth' });
    return;
  }

  if (!detectedBlocks.length) {
    toast('Nessun dato da normalizzare', 'error');
    return;
  }

  // Build current data from detected blocks
  const currentData = {};
  FIELD_TYPES.forEach(ft => {
    if (ft.key === 'other' || ft.key === 'ignore') return;
    const values = detectedBlocks
      .filter(b => b.type === ft.key)
      .map(b => b.text)
      .join(', ');
    currentData[ft.key] = values;
  });
  const others = detectedBlocks.filter(b => b.type === 'other');
  if (others.length) currentData.notes = others.map(b => b.text).join('; ');

  // Show loading state (button removed — normalization is now automatic)

  try {
    // Build messages — if we have the photo, use GPT-4o with vision for logo detection
    const userContent = [];
    const hasImage = lastPhotoDataUrl && lastPhotoDataUrl.startsWith('data:image');
    let model = 'gpt-4o-mini';

    if (hasImage) {
      model = 'gpt-4o-mini'; // supports vision, cost-effective
      userContent.push({
        type: 'text',
        text: `ANALIZZA QUESTA IMMAGINE di un biglietto da visita con MASSIMA PRECISIONE.

ISTRUZIONI:
1. LEGGI direttamente dall'immagine OGNI testo visibile (sei il lettore primario, non fidarti solo dell'OCR)
2. CONFRONTA con i dati OCR sotto — l'OCR potrebbe avere errori, TU sei più preciso
3. IDENTIFICA il logo aziendale: descrivi forma, colori, simboli
4. ESTRAI testo che l'OCR potrebbe aver perso (testo piccolo, colorato, ruotato, in overlay sul logo)
5. Se il biglietto è in lingua non latina, TRASCRIVI in caratteri latini + originale tra parentesi

Dati OCR di riferimento (potrebbero contenere errori):
${JSON.stringify(currentData, null, 2)}

Rispondi con il JSON completo. Il campo "logo_description" deve descrivere il logo se visibile.`,
      });
      userContent.push({
        type: 'image_url',
        image_url: { url: lastPhotoDataUrl, detail: 'high' },
      });
    } else {
      userContent.push({
        type: 'text',
        text: 'Normalizza questi dati del biglietto da visita:\n\n' + JSON.stringify(currentData, null, 2),
      });
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + openaiApiKey,
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: AI_NORMALIZE_PROMPT + (hasImage ? '\n\n⚠️ HAI L\'IMMAGINE DEL BIGLIETTO. Sei il lettore PRIMARIO — leggi direttamente dall\'immagine con precisione massima. L\'OCR è solo un riferimento secondario. Aggiungi sempre "logo_description" nel JSON se vedi un logo.' : '') },
          { role: 'user', content: userContent },
        ],
        temperature: 0.1,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      if (response.status === 401) {
        toast('API Key OpenAI non valida. Verifica la chiave.', 'error');
        $('apiKeyStatus').textContent = '❌ Chiave non valida';
        $('apiKeyStatus').className = 'api-key-status error';
      } else if (response.status === 429) {
        toast('Limite richieste OpenAI raggiunto. Riprova tra poco.', 'error');
      } else {
        toast('Errore OpenAI: ' + (errData.error?.message || response.status), 'error');
      }
      return;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      toast('Risposta AI vuota', 'error');
      return;
    }

    // Parse the JSON response (handle markdown code blocks)
    let normalized;
    try {
      const jsonStr = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      normalized = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error('[BizCard] AI response parse error:', content);
      toast('Errore nel parsing della risposta AI', 'error');
      return;
    }

    // Apply normalized data back to detectedBlocks
    applyNormalizedData(normalized);

    toast('✅ Dati normalizzati con AI!', 'success');
    $('apiKeyStatus').textContent = '✅ Funzionante';
    $('apiKeyStatus').className = 'api-key-status';

  } catch (e) {
    console.error('[BizCard] AI normalization error:', e);
    if (e.name === 'TypeError' && e.message.includes('fetch')) {
      toast('Errore di rete. Verifica la connessione.', 'error');
    } else {
      toast('Errore AI: ' + e.message, 'error');
    }
  } finally {
    // normalization complete (automatic pipeline)
  }
}

function applyNormalizedData(normalized) {
  const fieldKeys = FIELD_TYPES.filter(f => f.key !== 'other' && f.key !== 'ignore').map(f => f.key);

  // Handle migration: if AI returns "mobile" but old blocks have "phone" that looks like a mobile
  // Also handle old "phone" field being split into mobile + phone by AI
  if (normalized.mobile && !normalized.phone) {
    // Check if existing phone blocks should become mobile
    detectedBlocks.forEach(b => {
      if (b.type === 'phone') {
        const digits = b.text.replace(/\D/g, '');
        // Italian mobile: starts with 3, international: various patterns
        if (/^(?:\+?39\s*)?3/.test(b.text) || /^(?:cell|mob|whatsapp)/i.test(b.text)) {
          b.type = 'mobile';
        }
      }
    });
  }

  // Multi-value fields: AI can return comma-separated values for these
  const multiValueFields = new Set(['email', 'mobile', 'phone', 'fax']);

  fieldKeys.forEach(key => {
    const newValue = (normalized[key] || '').trim();
    if (!newValue) return;

    const existingBlocks = detectedBlocks.filter(b => b.type === key);

    if (existingBlocks.length > 0) {
      // For multi-value fields, merge ALL values into the first block (comma-separated from AI)
      existingBlocks[0].text = newValue;
      existingBlocks[0].confidence = 0.99;
      for (let i = 1; i < existingBlocks.length; i++) {
        existingBlocks[i].type = 'ignore';
        existingBlocks[i].confidence = 0.5;
      }
    } else {
      // AI discovered a new field — create a new block
      // First try to reassign an 'other' or 'ignore' block
      const reuseBlock = detectedBlocks.find(b => b.type === 'other' || b.type === 'ignore');
      if (reuseBlock) {
        reuseBlock.text = newValue;
        reuseBlock.type = key;
        reuseBlock.confidence = 0.95;
      } else {
        // Create brand new block (AI-inferred data like city, country)
        detectedBlocks.push({
          text: newValue,
          type: key,
          confidence: 0.92,
        });
      }
    }
  });

  // Handle notes
  if (normalized.notes) {
    const existingNotes = detectedBlocks.find(b => b.type === 'other');
    if (existingNotes) {
      existingNotes.text = normalized.notes;
    } else {
      detectedBlocks.push({ text: normalized.notes, type: 'other', confidence: 0.90 });
    }
  }

  // Store logo description in metadata (accessible when saving contact)
  if (normalized.logo_description) {
    window._lastLogoDescription = normalized.logo_description;
  }
}

