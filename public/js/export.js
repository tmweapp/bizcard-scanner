// ─── EXPORT ───────────────────────────────────────────────────
function initExport() {
  $('exportVcard').addEventListener('click', () => {
    if (!contacts.length) { toast('Nessun contatto da esportare', 'error'); return; }
    const ts = new Date().toISOString().slice(0, 10);
    const fname = `contatti_${ts}.vcf`;
    downloadFile(contacts.map(contactToVcard).join('\r\n'), fname, 'text/vcard');
    saveExportHistory('vCard', fname, contacts.length);
    toast(contacts.length + ' contatti esportati come vCard', 'success');
  });

  $('exportCsv').addEventListener('click', () => {
    if (!contacts.length) { toast('Nessun contatto da esportare', 'error'); return; }
    const ts = new Date().toISOString().slice(0, 10);
    const headers = ['Nome', 'Azienda', 'Ruolo', 'Email', 'Cellulare', 'Tel. Fisso', 'Fax', 'Web', 'LinkedIn', 'Indirizzo', 'Città', 'Paese', 'P.IVA', 'C.F.', 'Logo', 'Note', 'Data'];
    const rows = contacts.map(c =>
      [c.name, c.company, c.role, c.email, c.mobile, c.phone, c.fax, c.web, c.linkedin, c.address, c.city, c.country, c.piva, c.cf, c.logo_description, c.notes, c.createdAt].map(csvEsc)
    );
    const csv = '\ufeff' + [headers.map(csvEsc).join(';')].concat(rows.map(r => r.join(';'))).join('\r\n');
    const fname = `contatti_${ts}.csv`;
    downloadFile(csv, fname, 'text/csv');
    saveExportHistory('CSV', fname, contacts.length);
    toast(contacts.length + ' contatti esportati come CSV', 'success');
  });

  $('exportJson').addEventListener('click', () => {
    if (!contacts.length) { toast('Nessun contatto da esportare', 'error'); return; }
    const ts = new Date().toISOString().slice(0, 10);
    const fname = `contatti_${ts}.json`;
    downloadFile(JSON.stringify(contacts, null, 2), fname, 'application/json');
    saveExportHistory('JSON', fname, contacts.length);
    toast(contacts.length + ' contatti esportati come JSON', 'success');
  });

  $('exportWebhook').addEventListener('click', async () => {
    if (!contacts.length) { toast('Nessun contatto da esportare', 'error'); return; }
    if (!settings.webhookUrl) { toast('Configura prima il Webhook CRM nelle Impostazioni', 'error'); return; }
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (settings.webhookAuth) headers['Authorization'] = settings.webhookAuth;
      const resp = await fetch(settings.webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ contacts, timestamp: new Date().toISOString() }),
      });
      if (resp.ok) saveExportHistory('Webhook', settings.webhookUrl, contacts.length);
      toast(resp.ok ? `✅ ${contacts.length} contatti inviati al CRM` : 'Errore: HTTP ' + resp.status, resp.ok ? 'success' : 'error');
    } catch (e) {
      toast('Errore di rete: ' + e.message, 'error');
    }
  });
}

function updateExportState() {
  $('emptyExport').style.display = contacts.length === 0 ? 'block' : 'none';
}

// ─── SETTINGS ─────────────────────────────────────────────────
function initSettings() {
  $('webhookUrl').value = settings.webhookUrl || '';
  $('webhookAuth').value = settings.webhookAuth || '';

  $('btnSaveSettings').addEventListener('click', () => {
    settings.webhookUrl = $('webhookUrl').value.trim();
    settings.webhookAuth = $('webhookAuth').value.trim();
    saveState();
    toast('Impostazioni salvate', 'success');
  });

  $('btnClearAll').addEventListener('click', () => {
    if (!confirm('Eliminare TUTTI i contatti? Questa azione non è reversibile.')) return;
    contacts = [];
    scanCount = 0;
    saveState();
    toast('Tutti i dati sono stati eliminati', 'info');
    renderContacts();
    updateStats();
    updateExportState();
    updateStorageStats();
  });

  $('btnClearExports').addEventListener('click', () => {
    if (!confirm('Cancellare la cronologia delle esportazioni?')) return;
    localStorage.removeItem('bizcard_exports');
    renderExportHistory();
    updateStorageStats();
    toast('Cronologia esportazioni cancellata', 'info');
  });

  updateStorageStats();
}

function updateStorageStats() {
  try {
    let totalBytes = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('bizcard_')) {
        totalBytes += (localStorage.getItem(key) || '').length * 2; // UTF-16
      }
    }
    const kb = (totalBytes / 1024).toFixed(1);
    $('storageUsage').textContent = totalBytes > 1048576
      ? (totalBytes / 1048576).toFixed(1) + ' MB'
      : kb + ' KB';
    const exports = JSON.parse(localStorage.getItem('bizcard_exports') || '[]');
    $('exportCount').textContent = exports.length;
  } catch (e) {
    $('storageUsage').textContent = 'N/D';
  }
}

function updateStats() {
  $('statContacts').textContent = contacts.length;
  $('statScans').textContent = scanCount;
}

