// ─── SESSION MANAGEMENT ──────────────────────────────────────
let currentSession = null;
let sessionTimerInterval = null;

function startSession() {
  currentSession = {
    startedAt: new Date(),
    endedAt: null,
    cardIds: [],
    photoCount: 0,
  };
  $('sessionBanner').style.display = 'flex';
  $('sessionCardCount').textContent = '0';
  $('sessionTimer').textContent = '00:00';
  $('sessionSummary').style.display = 'none';

  // Start timer
  sessionTimerInterval = setInterval(() => {
    if (!currentSession) return;
    const elapsed = Math.floor((Date.now() - currentSession.startedAt.getTime()) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    $('sessionTimer').textContent = m + ':' + s;
  }, 1000);
}

function endSession() {
  if (!currentSession) return;
  currentSession.endedAt = new Date();
  clearInterval(sessionTimerInterval);
  sessionTimerInterval = null;

  // Hide scan UI, show summary
  $('sessionBanner').style.display = 'none';
  $('resultSection').style.display = 'none';
  $('sessionSummary').style.display = 'block';

  // Calculate stats
  const duration = Math.floor((currentSession.endedAt - currentSession.startedAt) / 1000);
  const m = Math.floor(duration / 60);
  const s = duration % 60;

  $('sessionStats').innerHTML = `
    <div class="session-stat">
      <div class="session-stat-value">${currentSession.cardIds.length}</div>
      <div class="session-stat-label">Contatti acquisiti</div>
    </div>
    <div class="session-stat">
      <div class="session-stat-value">${m > 0 ? m + 'm ' : ''}${s}s</div>
      <div class="session-stat-label">Durata sessione</div>
    </div>
    <div class="session-stat">
      <div class="session-stat-value">${currentSession.photoCount}</div>
      <div class="session-stat-label">Foto scattate</div>
    </div>
    <div class="session-stat">
      <div class="session-stat-value">${new Date(currentSession.startedAt).toLocaleTimeString('it-IT', {hour:'2-digit', minute:'2-digit'})}</div>
      <div class="session-stat-label">Ora inizio</div>
    </div>
  `;

  // Save session metadata to localStorage
  const sessions = JSON.parse(localStorage.getItem('bizcard_sessions') || '[]');
  sessions.push({
    startedAt: currentSession.startedAt.toISOString(),
    endedAt: currentSession.endedAt.toISOString(),
    cardIds: currentSession.cardIds,
    photoCount: currentSession.photoCount,
  });
  localStorage.setItem('bizcard_sessions', JSON.stringify(sessions));

  toast('📊 Sessione completata — ' + currentSession.cardIds.length + ' contatti!', 'success');
}

function autoSaveAndContinue() {
  // Auto-save the current card
  const contact = buildContactFromBlocks();
  if (!contact) {
    toast('Nessun dato da salvare', 'error');
    return;
  }

  // Start session if not started
  if (!currentSession) startSession();

  contacts.push(contact);
  currentSession.cardIds.push(contact.id);
  currentSession.photoCount++;
  saveState();

  // Update UI: contacts list, stats, export state
  renderContacts();
  updateStats();
  updateExportState();

  // Update session banner
  $('sessionCardCount').textContent = currentSession.cardIds.length;

  // Show success row
  $('scanResultRow').style.display = 'flex';
  const name = contact.name || contact.email || contact.company || 'Contatto';
  $('scanResultText').textContent = name + ' — salvato';
  $('scanResultCount').textContent = '#' + currentSession.cardIds.length;

  toast('✅ ' + name + ' salvato!', 'success');
  if (navigator.vibrate) navigator.vibrate(200);
}

function buildContactFromBlocks() {
  const contact = {
    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 7),
    createdAt: new Date().toISOString(),
    source: currentMode,
  };

  // Store photo thumbnail
  if (lastPhotoDataUrl) {
    try {
      const thumbCanvas = document.createElement('canvas');
      const thumbImg = $('photoPreview');
      const thumbScale = Math.min(400 / thumbImg.naturalWidth, 400 / thumbImg.naturalHeight, 1);
      thumbCanvas.width = Math.round(thumbImg.naturalWidth * thumbScale);
      thumbCanvas.height = Math.round(thumbImg.naturalHeight * thumbScale);
      thumbCanvas.getContext('2d').drawImage(thumbImg, 0, 0, thumbCanvas.width, thumbCanvas.height);
      contact.photo = thumbCanvas.toDataURL('image/jpeg', 0.6);
    } catch (e) {}
  }

  FIELD_TYPES.forEach(ft => {
    if (ft.key === 'other' || ft.key === 'ignore') return;
    const values = detectedBlocks.filter(b => b.type === ft.key).map(b => b.text).join(', ');
    contact[ft.key] = values;
  });

  const others = detectedBlocks.filter(b => b.type === 'other');
  if (others.length) contact.notes = others.map(b => b.text).join('; ');

  if (window._lastLogoDescription) {
    contact.logo_description = window._lastLogoDescription;
    window._lastLogoDescription = null;
  }

  // Validation
  if (!contact.name && !contact.email && !contact.phone && !contact.mobile) return null;

  // Duplicate check (silent skip)
  const dup = findDuplicate(contact);
  if (dup) contact.possibleDuplicate = dup.id;

  return contact;
}

function scanNext() {
  // Reset scan state but keep session active
  detectedBlocks = [];
  lastPhotoDataUrl = null;
  window._lastLogoDescription = null;
  $('resultSection').style.display = 'none';
  $('ocrStatus').style.display = 'none';
  $('cleanCard').classList.remove('visible');
  $('cleanCardFields').innerHTML = '';
  $('scanResultRow').style.display = 'none';
}

function exportSessionData() {
  if (!currentSession || currentSession.cardIds.length === 0) {
    toast('Nessun dato da esportare', 'error');
    return;
  }
  // Switch to export tab
  document.querySelector('[data-tab="export"]').click();
}

// ─── SAVE CONTACT ─────────────────────────────────────────────
function saveContact() {
  const contact = {
    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 7),
    createdAt: new Date().toISOString(),
    source: currentMode, // 'local', 'remote', or 'upload'
  };

  // Store photo thumbnail (compressed to ~50KB for localStorage)
  if (lastPhotoDataUrl) {
    try {
      const thumbCanvas = document.createElement('canvas');
      const thumbImg = $('photoPreview');
      const thumbScale = Math.min(400 / thumbImg.naturalWidth, 400 / thumbImg.naturalHeight, 1);
      thumbCanvas.width = Math.round(thumbImg.naturalWidth * thumbScale);
      thumbCanvas.height = Math.round(thumbImg.naturalHeight * thumbScale);
      thumbCanvas.getContext('2d').drawImage(thumbImg, 0, 0, thumbCanvas.width, thumbCanvas.height);
      contact.photo = thumbCanvas.toDataURL('image/jpeg', 0.6);
    } catch (e) { /* photo save failed, continue without it */ }
  }

  FIELD_TYPES.forEach(ft => {
    if (ft.key === 'other' || ft.key === 'ignore') return;
    const values = detectedBlocks
      .filter(b => b.type === ft.key)
      .map(b => b.text)
      .join(', ');
    contact[ft.key] = values;
  });

  // Collect "other" as notes
  const others = detectedBlocks.filter(b => b.type === 'other');
  if (others.length) contact.notes = others.map(b => b.text).join('; ');

  // Store logo description if available
  if (window._lastLogoDescription) {
    contact.logo_description = window._lastLogoDescription;
    window._lastLogoDescription = null;
  }

  // Validation
  if (!contact.name && !contact.email && !contact.phone && !contact.mobile) {
    toast('Assegna almeno un nome, email o telefono', 'error');
    return;
  }

  // Duplicate check
  const duplicate = findDuplicate(contact);
  if (duplicate) {
    if (!confirm(`Contatto simile trovato: "${duplicate.name || duplicate.email}"\n\nVuoi salvare comunque?`)) return;
  }

  contacts.push(contact);
  saveState();
  renderContacts();
  updateStats();
  updateExportState();
  toast('✅ Salvato: ' + (contact.name || contact.email || contact.phone), 'success');
  if (navigator.vibrate) navigator.vibrate(200);
  resetScan();
}

function findDuplicate(contact) {
  return contacts.find(c => {
    if (contact.email && c.email && contact.email.toLowerCase() === c.email.toLowerCase()) return true;
    if (contact.phone && c.phone) {
      const d1 = contact.phone.replace(/\D/g, '');
      const d2 = c.phone.replace(/\D/g, '');
      if (d1.length >= 7 && d2.length >= 7 && (d1.endsWith(d2.slice(-7)) || d2.endsWith(d1.slice(-7)))) return true;
    }
    if (contact.name && c.name && contact.name.toLowerCase() === c.name.toLowerCase()) return true;
    return false;
  });
}

function resetScan() {
  if (arActive) stopARScan();
  scanNext();
}

// ─── CONTACTS ─────────────────────────────────────────────────
function initContacts() {
  $('searchInput').addEventListener('input', renderContacts);

  // Sort buttons
  $$('.sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const field = btn.dataset.sort;
      if (contactSortField === field) {
        contactSortAsc = !contactSortAsc;
      } else {
        contactSortField = field;
        contactSortAsc = true;
      }
      // Update UI
      $$('.sort-btn').forEach(b => { b.classList.remove('active', 'desc'); });
      btn.classList.add('active');
      if (!contactSortAsc) btn.classList.add('desc');
      btn.querySelector('.sort-arrow').textContent = contactSortAsc ? '↓' : '↑';
      renderContacts();
    });
  });
}

function sortContacts(arr) {
  const dir = contactSortAsc ? 1 : -1;
  return [...arr].sort((a, b) => {
    if (contactSortField === 'date') return dir * ((b._ts || 0) - (a._ts || 0));
    const va = (a[contactSortField] || '').toLowerCase();
    const vb = (b[contactSortField] || '').toLowerCase();
    if (!va && vb) return 1;
    if (va && !vb) return -1;
    return dir * va.localeCompare(vb);
  });
}

function renderContacts() {
  const query = $('searchInput').value.toLowerCase();
  const list = $('contactList');
  const empty = $('emptyContacts');

  let filtered = contacts.map(c => ({ ...c, _ts: c.id ? parseInt(c.id) || 0 : 0 })).filter(c => {
    if (!query) return true;
    return [c.name, c.company, c.email, c.phone, c.role, c.city, c.country]
      .some(v => v && v.toLowerCase().includes(query));
  });

  filtered = sortContacts(filtered);

  if (!filtered.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    $('contactSortBar').style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  $('contactSortBar').style.display = 'flex';

  list.innerHTML = filtered.map(c => {
    const initials = (c.name || c.email || '?').substring(0, 2).toUpperCase();
    const color = AVATAR_COLORS[Math.abs(hashCode(c.id)) % AVATAR_COLORS.length];
    const flag = countryToFlag(c.country);
    const sourceIcon = c.source === 'remote' ? '📱' : c.source === 'upload' ? '📁' : '📷';

    // Build location string
    const locationParts = [c.city, c.country].filter(Boolean);
    const locationStr = locationParts.join(', ');

    // Build link pills
    const pills = [];
    if (c.email) c.email.split(',').forEach(e => {
      const et = e.trim();
      pills.push(`<a href="mailto:${esc(et)}">📧 ${esc(et)}</a>`);
    });
    if (c.mobile) c.mobile.split(',').forEach(p => {
      const pt = p.trim(); const num = pt.replace(/[^\d+]/g, '');
      pills.push(`<a href="tel:${num}">📱 ${esc(pt)}</a>`);
    });
    if (c.phone) c.phone.split(',').forEach(p => {
      const pt = p.trim(); const num = pt.replace(/[^\d+]/g, '');
      pills.push(`<a href="tel:${num}">📞 ${esc(pt)}</a>`);
    });
    if (c.web) pills.push(`<a href="${esc(c.web.startsWith('http') ? c.web : 'https://' + c.web)}" target="_blank">🌐 ${esc(c.web.replace(/^https?:\/\/(www\.)?/, ''))}</a>`);
    if (c.linkedin) pills.push(`<a href="${esc(c.linkedin.startsWith('http') ? c.linkedin : 'https://' + c.linkedin)}" target="_blank">💼 LinkedIn</a>`);
    if (c.address) pills.push(`<span>📍 ${esc(c.address)}</span>`);
    if (c.piva) pills.push(`<span>🏛️ ${esc(c.piva)}</span>`);
    if (c.cf) pills.push(`<span>🆔 ${esc(c.cf)}</span>`);
    if (c.fax) pills.push(`<span>📠 ${esc(c.fax)}</span>`);

    return `<div class="contact-item" role="listitem">
      ${c.photo
        ? `<img src="${c.photo}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;flex-shrink:0;box-shadow:0 2px 8px rgba(0,0,0,.25)" alt="">`
        : `<div class="contact-avatar" style="background:${color}">${esc(initials)}</div>`
      }
      <div class="contact-info">
        <div class="contact-name">${esc(c.name || 'Senza nome')} <span class="source-icon">${sourceIcon}</span></div>
        ${c.role ? `<div class="contact-role">${esc(c.role)}</div>` : ''}
        ${c.company ? `<div class="contact-company"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v3"/></svg> ${esc(c.company)}</div>` : ''}
        ${locationStr ? `<div class="contact-city"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> ${esc(locationStr)}</div>` : ''}
        ${pills.length ? `<div class="contact-links">${pills.join('')}</div>` : ''}
      </div>
      ${flag ? `<span class="contact-flag">${flag}</span>` : ''}
      <div class="contact-actions">
        <button title="Scarica vCard" data-action="vcard" data-id="${c.id}">📇</button>
        <button title="Copia info" data-action="copy" data-id="${c.id}">📋</button>
        <button title="Elimina" data-action="delete" data-id="${c.id}">🗑️</button>
      </div>
    </div>`;
  }).join('');

  // Event delegation for contact actions
  list.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action === 'vcard') exportSingleVcard(id);
      if (action === 'copy') copyContactToClipboard(id);
      if (action === 'delete') deleteContact(id);
    });
  });
}

function deleteContact(id) {
  if (!confirm('Eliminare questo contatto?')) return;
  contacts = contacts.filter(c => c.id !== id);
  saveState();
  renderContacts();
  updateStats();
  updateExportState();
  toast('Contatto eliminato', 'info');
}

function exportSingleVcard(id) {
  const c = contacts.find(x => x.id === id);
  if (!c) return;
  downloadFile(contactToVcard(c), (c.name || 'contatto') + '.vcf', 'text/vcard');
  toast('vCard scaricata', 'success');
}

function copyContactToClipboard(id) {
  const c = contacts.find(x => x.id === id);
  if (!c) return;
  const lines = [];
  if (c.name) lines.push(c.name);
  if (c.role) lines.push(c.role);
  if (c.company) lines.push(c.company);
  if (c.email) lines.push('Email: ' + c.email);
  if (c.mobile) lines.push('Cell: ' + c.mobile);
  if (c.phone) lines.push('Tel: ' + c.phone);
  if (c.web) lines.push('Web: ' + c.web);
  if (c.linkedin) lines.push('LinkedIn: ' + c.linkedin);
  if (c.address) lines.push('Ind: ' + c.address);
  if (c.city) lines.push('Città: ' + c.city);
  if (c.country) lines.push('Paese: ' + c.country);
  if (c.piva) lines.push('P.IVA: ' + c.piva);
  if (c.fax) lines.push('Fax: ' + c.fax);
  navigator.clipboard.writeText(lines.join('\n')).then(
    () => toast('Copiato negli appunti', 'success'),
    () => toast('Copia non riuscita', 'error')
  );
}

