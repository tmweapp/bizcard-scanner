// ─── SUPABASE CLOUD SYNC ──────────────────────────────────────
const SUPABASE_URL = 'https://hgcscjekdqifwnczrhqj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhnY3NjamVrZHFpZnduY3pyaHFqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2NDkxMjAsImV4cCI6MjA4OTIyNTEyMH0.d0SlxojBgv9mvuKQZ5-DBRouhn-J7IYSV2ITDS_RZVc';

let sbClient = null;
let supabaseReady = false;
let deviceId = '';
let syncInProgress = false;
let syncTimer = null;

function getDeviceId() {
  let id = localStorage.getItem('bizcard_device_id');
  if (!id) {
    id = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 10);
    localStorage.setItem('bizcard_device_id', id);
  }
  return id;
}

function initSupabase() {
  deviceId = getDeviceId();
  if ($('deviceIdDisplay')) $('deviceIdDisplay').textContent = deviceId;

  try {
    if (typeof window.supabase !== 'undefined' && window.supabase.createClient) {
      sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      supabaseReady = true;
      updateCloudStatus('connected');
      console.log('[Supabase] Initialized, device:', deviceId);
      // Initial sync — pull from cloud then push local
      syncWithCloud();
    } else {
      console.warn('[Supabase] Client library not loaded');
      updateCloudStatus('offline');
    }
  } catch (e) {
    console.error('[Supabase] Init error:', e);
    updateCloudStatus('error');
  }

  // Force sync button
  if ($('btnForceSync')) {
    $('btnForceSync').addEventListener('click', () => {
      if (!supabaseReady) { toast('Supabase non connesso', 'error'); return; }
      syncWithCloud(true);
    });
  }
}

function updateCloudStatus(status) {
  const el = $('cloudSyncStatus');
  if (!el) return;
  const states = {
    connected: '🟢 Connesso',
    syncing: '🔄 Sincronizzazione...',
    synced: '✅ Sincronizzato',
    offline: '⚫ Offline (solo locale)',
    error: '🔴 Errore connessione',
  };
  el.textContent = states[status] || status;
}

function updateLastSyncTime() {
  const el = $('lastSyncTime');
  if (!el) return;
  const now = new Date();
  el.textContent = now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
    ' — ' + now.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
  localStorage.setItem('bizcard_last_sync', now.toISOString());
}

// Debounced sync — waits 2s after last change before syncing
function debouncedCloudSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncWithCloud(), 2000);
}

async function syncWithCloud(force = false) {
  if (!supabaseReady || !sbClient || syncInProgress) return;
  syncInProgress = true;
  updateCloudStatus('syncing');

  try {
    // ── PULL: Get cloud contacts for this device ──
    const { data: cloudContacts, error: pullErr } = await sbClient
      .from('contacts')
      .select('*')
      .eq('device_id', deviceId)
      .order('created_at', { ascending: false });

    if (pullErr) throw pullErr;

    // ── MERGE: Cloud → Local (add contacts we don't have locally) ──
    if (cloudContacts && cloudContacts.length) {
      const localIds = new Set(contacts.map(c => c.id));
      let added = 0;
      cloudContacts.forEach(cc => {
        if (!localIds.has(cc.id)) {
          // Cloud has a contact we don't — add to local
          contacts.push(cloudContactToLocal(cc));
          added++;
        }
      });
      if (added > 0) {
        // Save to localStorage without triggering another sync
        try {
          localStorage.setItem('bizcard_contacts', JSON.stringify(contacts));
        } catch (e) {}
        renderContacts();
        updateStats();
        updateExportState();
        console.log(`[Supabase] Pulled ${added} new contacts from cloud`);
      }
    }

    // ── PUSH: Local → Cloud (upsert all local contacts) ──
    if (contacts.length) {
      const cloudIds = new Set((cloudContacts || []).map(c => c.id));
      const toUpsert = contacts
        .filter(c => force || !cloudIds.has(c.id))
        .map(c => localContactToCloud(c));

      if (toUpsert.length) {
        const { error: pushErr } = await sbClient
          .from('contacts')
          .upsert(toUpsert, { onConflict: 'id' });
        if (pushErr) throw pushErr;
        console.log(`[Supabase] Pushed ${toUpsert.length} contacts to cloud`);
      }
    }

    // ── PUSH: Delete from cloud contacts that were deleted locally ──
    if (cloudContacts && cloudContacts.length) {
      const localIds = new Set(contacts.map(c => c.id));
      const toDelete = cloudContacts.filter(cc => !localIds.has(cc.id)).map(cc => cc.id);
      if (toDelete.length) {
        await sbClient.from('contacts').delete().in('id', toDelete);
        console.log(`[Supabase] Deleted ${toDelete.length} contacts from cloud`);
      }
    }

    // ── SYNC EXPORT HISTORY ──
    await syncExportHistory();

    updateCloudStatus('synced');
    updateLastSyncTime();

  } catch (e) {
    console.error('[Supabase] Sync error:', e);
    updateCloudStatus('error');
    // Don't show toast for background sync failures — silent fallback to local
    if (force) toast('Errore sync: ' + (e.message || e), 'error');
  } finally {
    syncInProgress = false;
  }
}

async function syncExportHistory() {
  if (!supabaseReady || !sbClient) return;
  try {
    const localExports = JSON.parse(localStorage.getItem('bizcard_exports') || '[]');
    if (!localExports.length) return;

    // Get existing cloud exports for this device
    const { data: cloudExports } = await sbClient
      .from('exports')
      .select('id, created_at')
      .eq('device_id', deviceId);

    const cloudIds = new Set((cloudExports || []).map(e => String(e.id)));

    // Push new exports that aren't in cloud
    const toInsert = localExports
      .filter(e => !cloudIds.has(String(e.id)))
      .map(e => ({
        id: e.id,
        device_id: deviceId,
        format: e.format,
        filename: e.filename,
        contact_count: e.count,
        created_at: e.date,
      }));

    if (toInsert.length) {
      await sbClient.from('exports').insert(toInsert);
    }
  } catch (e) {
    console.warn('[Supabase] Export sync error:', e);
  }
}

// ── Data conversion helpers ──
function localContactToCloud(c) {
  return {
    id: c.id,
    device_id: deviceId,
    name: c.name || null,
    company: c.company || null,
    role: c.role || null,
    email: c.email || null,
    mobile: c.mobile || null,
    phone: c.phone || null,
    fax: c.fax || null,
    web: c.web || null,
    linkedin: c.linkedin || null,
    address: c.address || null,
    city: c.city || null,
    country: c.country || null,
    piva: c.piva || null,
    cf: c.cf || null,
    notes: c.notes || null,
    logo_description: c.logo_description || null,
    photo: c.photo || null,
    source: c.source || null,
    created_at: c.createdAt || new Date().toISOString(),
  };
}

function cloudContactToLocal(cc) {
  return {
    id: cc.id,
    name: cc.name || '',
    company: cc.company || '',
    role: cc.role || '',
    email: cc.email || '',
    mobile: cc.mobile || '',
    phone: cc.phone || '',
    fax: cc.fax || '',
    web: cc.web || '',
    linkedin: cc.linkedin || '',
    address: cc.address || '',
    city: cc.city || '',
    country: cc.country || '',
    piva: cc.piva || '',
    cf: cc.cf || '',
    notes: cc.notes || '',
    logo_description: cc.logo_description || '',
    photo: cc.photo || '',
    source: cc.source || '',
    createdAt: cc.created_at,
  };
}

