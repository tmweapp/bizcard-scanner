-- ═══════════════════════════════════════════════════════════
--  BizCard Scanner — Supabase Schema
--  Esegui questo SQL nel SQL Editor della dashboard Supabase
-- ═══════════════════════════════════════════════════════════

-- 1. TABELLA CONTATTI
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  name TEXT,
  company TEXT,
  role TEXT,
  email TEXT,
  mobile TEXT,
  phone TEXT,
  fax TEXT,
  web TEXT,
  linkedin TEXT,
  address TEXT,
  city TEXT,
  country TEXT,
  piva TEXT,
  cf TEXT,
  notes TEXT,
  logo_description TEXT,
  photo TEXT,  -- base64 thumbnail
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. TABELLA SESSIONI
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  card_count INTEGER DEFAULT 0,
  card_ids TEXT[], -- array di ID contatti
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. TABELLA CRONOLOGIA ESPORTAZIONI
CREATE TABLE IF NOT EXISTS exports (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id TEXT NOT NULL,
  format TEXT NOT NULL,
  filename TEXT NOT NULL,
  contact_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. INDICI per performance
CREATE INDEX IF NOT EXISTS idx_contacts_device ON contacts(device_id);
CREATE INDEX IF NOT EXISTS idx_contacts_created ON contacts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company);
CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(device_id);
CREATE INDEX IF NOT EXISTS idx_exports_device ON exports(device_id);
CREATE INDEX IF NOT EXISTS idx_exports_created ON exports(created_at DESC);

-- 5. ROW LEVEL SECURITY
-- Ogni dispositivo vede solo i propri dati

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE exports ENABLE ROW LEVEL SECURITY;

-- Policy: chiunque con la anon key può inserire/leggere/aggiornare/eliminare
-- i propri dati (filtrato per device_id lato app)
-- In un contesto senza autenticazione, usiamo policy permissive
-- Il filtro device_id è gestito lato applicazione

CREATE POLICY "Allow all for anon" ON contacts
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all for anon" ON sessions
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all for anon" ON exports
  FOR ALL USING (true) WITH CHECK (true);

-- 6. FUNZIONE per aggiornamento automatico updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER contacts_updated_at
  BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
