// ════════════════════════════════════════════════════════════════
//  BIZCARD SCANNER v4 — PROFESSIONAL OCR BUSINESS CARD SCANNER
//  Architecture: Photo → Preprocess → OCR API → Classify → Edit
// ════════════════════════════════════════════════════════════════

// ─── CONFIGURATION ────────────────────────────────────────────
const FIELD_TYPES = [
  { key: 'name',    icon: '👤', label: 'Nome',        req: true  },
  { key: 'company', icon: '🏢', label: 'Azienda',     req: true  },
  { key: 'email',   icon: '📧', label: 'Email',       req: true  },
  { key: 'mobile',  icon: '📱', label: 'Cellulare',   req: true  },
  { key: 'phone',   icon: '📞', label: 'Tel. fisso',  req: false },
  { key: 'role',    icon: '💼', label: 'Ruolo',       req: false },
  { key: 'web',     icon: '🌐', label: 'Web',         req: false },
  { key: 'address', icon: '📍', label: 'Indirizzo',   req: false },
  { key: 'city',    icon: '📌', label: 'Città',       req: false },
  { key: 'country', icon: '🏳️', label: 'Paese/Stato', req: false },
  { key: 'piva',    icon: '🏛️', label: 'P.IVA',       req: false },
  { key: 'cf',      icon: '🆔', label: 'C.F.',        req: false },
  { key: 'fax',     icon: '📠', label: 'Fax',         req: false },
  { key: 'linkedin',icon: '💼', label: 'LinkedIn',    req: false },
  { key: 'other',   icon: '📝', label: 'Altro',       req: false },
  { key: 'ignore',  icon: '🚫', label: 'Ignora',      req: false },
];

// Classification patterns — ordered by reliability
const RE = {
  email:    /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/,
  cf:       /\b[A-Z]{6}\d{2}[A-EHLMPRST]\d{2}[A-Z]\d{3}[A-Z]\b/i,
  piva:     /(?:P\.?\s*I\.?V\.?A\.?\s*[:.;]?\s*|IT\s*)(\d{11})/i,
  address:  /(?:via|viale|v\.le|corso|c\.so|piazza|p\.za|p\.zza|largo|vicolo|strada|contrada|loc\.|localit[àa]|street|st\.|avenue|ave\.|boulevard|blvd|road|rd\.|straße|str\.|rue|calle)\s+[^\n]{3,60}/i,
  web:      /(?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}(?:\/[^\s]*)?/i,
  linkedin: /(?:linkedin\.com\/in\/|linkedin\.com\/company\/)[^\s]+/i,
  // Mobile: keyword-based (cell, cellulare, mob, mobile, MOB, whatsapp) or Italian mobile prefix 3XX
  mobile:   /(?:(?:cell(?:ulare)?|mob(?:ile|\.)?|whatsapp|wa|m\b)[.:\s]*(?:\+?\d[\d\s.\-()]{7,18}))|(?:(?:\+?39\s*)?3\d{2}[\s.\-]?\d{3,4}[\s.\-]?\d{3,4})/i,
  phone:    /(?:(?:tel(?:efono)?|phone|ph\.|ufficio|office|sede|fisso|t\.)[.:\s]*)?(?:\+?\d{1,3}[\s.\-]?)?(?:\(?\d{2,4}\)?[\s.\-]?)\d{2,4}[\s.\-]?\d{3,4}[\s.\-]?\d{0,4}/i,
  fax:      /(?:fax|facsimile)[.:\s]*(?:\+?\d{1,3}[\s.\-]?)?(?:\(?\d{2,4}\)?[\s.\-]?)\d{2,4}[\s.\-]?\d{3,4}/i,
};

const ROLES = [
  'ceo','cto','cfo','coo','cio','cmo','cpo',
  'direttore','director','manager','responsabile','presidente','vicepresidente',
  'founder','co-founder','cofondatore','fondatore',
  'ingegnere','engineer','architetto','avvocato','dottore','dott\\.?ssa','dott',
  'consulente','consultant','analyst','analista','designer',
  'developer','sviluppatore','programmatore',
  'sales','marketing','hr','account',
  'amministratore','delegato','socio','partner',
  'legale','tecnico','commerciale','operativo',
  'segretari[oa]','coordinat(?:ore|rice)','referente',
];

const COMPANY_KW = [
  'srl','s\\.r\\.l','spa','s\\.p\\.a','snc','s\\.n\\.c','sas','s\\.a\\.s',
  'ltd','llc','inc','gmbh','corp','ag','plc','sa',
  'group','gruppo','studio','associati','consulting','solutions','services','servizi',
  'technology','technologies','digital','media','creative',
  'soc\\.?\\s*coop','scarl','onlus','fondazione','agenzia','agency',
  'impresa','ditta','laboratorio','officina','bottega',
];

const TITLE_PREFIX = /^(?:dott\.?(?:ssa)?|ing\.?|arch\.?|avv\.?|rag\.?|geom\.?|prof\.?(?:ssa)?|sig\.?(?:ra)?|mr\.?|mrs\.?|ms\.?|dr\.?)\s+/i;

const AVATAR_COLORS = ['#3b82f6','#8b5cf6','#ec4899','#f59e0b','#22c55e','#06b6d4','#f43f5e','#a855f7'];

// Country → ISO 3166 → Flag emoji
const COUNTRY_FLAGS = {
  'italia':'IT','italy':'IT','it':'IT','ita':'IT',
  'germania':'DE','germany':'DE','deutschland':'DE','de':'DE',
  'francia':'FR','france':'FR','fr':'FR',
  'spagna':'ES','spain':'ES','españa':'ES','es':'ES',
  'regno unito':'GB','united kingdom':'GB','uk':'GB','gb':'GB','england':'GB',
  'stati uniti':'US','united states':'US','usa':'US','us':'US',
  'svizzera':'CH','switzerland':'CH','schweiz':'CH','ch':'CH',
  'austria':'AT','at':'AT',
  'belgio':'BE','belgium':'BE','be':'BE',
  'olanda':'NL','paesi bassi':'NL','netherlands':'NL','nl':'NL',
  'portogallo':'PT','portugal':'PT','pt':'PT',
  'grecia':'GR','greece':'GR','gr':'GR',
  'polonia':'PL','poland':'PL','pl':'PL',
  'romania':'RO','ro':'RO',
  'svezia':'SE','sweden':'SE','se':'SE',
  'norvegia':'NO','norway':'NO','no':'NO',
  'danimarca':'DK','denmark':'DK','dk':'DK',
  'finlandia':'FI','finland':'FI','fi':'FI',
  'irlanda':'IE','ireland':'IE','ie':'IE',
  'canada':'CA','ca':'CA',
  'australia':'AU','au':'AU',
  'brasile':'BR','brazil':'BR','br':'BR',
  'argentina':'AR','ar':'AR',
  'messico':'MX','mexico':'MX','mx':'MX',
  'giappone':'JP','japan':'JP','jp':'JP',
  'cina':'CN','china':'CN','cn':'CN',
  'india':'IN','in':'IN',
  'corea del sud':'KR','south korea':'KR','kr':'KR',
  'russia':'RU','ru':'RU',
  'turchia':'TR','turkey':'TR','türkiye':'TR','tr':'TR',
  'emirati arabi':'AE','uae':'AE','ae':'AE',
  'arabia saudita':'SA','saudi arabia':'SA','sa':'SA',
  'israele':'IL','israel':'IL','il':'IL',
  'egitto':'EG','egypt':'EG','eg':'EG',
  'sudafrica':'ZA','south africa':'ZA','za':'ZA',
  'marocco':'MA','morocco':'MA','ma':'MA',
  'tunisia':'TN','tn':'TN',
  'croazia':'HR','croatia':'HR','hr':'HR',
  'slovenia':'SI','si':'SI',
  'repubblica ceca':'CZ','czech republic':'CZ','czechia':'CZ','cz':'CZ',
  'ungheria':'HU','hungary':'HU','hu':'HU',
  'slovacchia':'SK','slovakia':'SK','sk':'SK',
  'bulgaria':'BG','bg':'BG',
  'lussemburgo':'LU','luxembourg':'LU','lu':'LU',
  'malta':'MT','mt':'MT',
  'cipro':'CY','cyprus':'CY','cy':'CY',
  'lituania':'LT','lithuania':'LT','lt':'LT',
  'lettonia':'LV','latvia':'LV','lv':'LV',
  'estonia':'EE','ee':'EE',
  'monaco':'MC','mc':'MC',
  'san marino':'SM','sm':'SM',
  'colombia':'CO','co':'CO',
  'cile':'CL','chile':'CL','cl':'CL',
  'singapore':'SG','sg':'SG',
  'thailandia':'TH','thailand':'TH','th':'TH',
  'indonesia':'ID','id_country':'ID',
  'malesia':'MY','malaysia':'MY','my':'MY',
  'filippine':'PH','philippines':'PH','ph':'PH',
  'nuova zelanda':'NZ','new zealand':'NZ','nz':'NZ',
};

function countryToFlag(country) {
  if (!country) return '';
  const iso = COUNTRY_FLAGS[country.toLowerCase().trim()];
  if (!iso) {
    // Try matching partial (first word)
    const first = country.toLowerCase().trim().split(/[\s,]+/)[0];
    const isoPartial = COUNTRY_FLAGS[first];
    if (isoPartial) return String.fromCodePoint(...[...isoPartial].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
    return '';
  }
  return String.fromCodePoint(...[...iso].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

let contactSortField = 'date'; // 'date' | 'country' | 'company' | 'name'
let contactSortAsc = true;

// ─── STATE ────────────────────────────────────────────────────
let contacts = [];
let scanCount = 0;
let settings = { webhookUrl: '', webhookAuth: '' };
let currentMode = 'local';
let currentStream = null;
let facingMode = 'environment';
let torchEnabled = false;
let tesseractWorker = null;
let tesseractReady = false;
let useServerOCR = false;
let serverEngine = '';
let peer = null;
let peerConn = null;
let sessionId = '';
let peerRetries = 0;
const MAX_PEER_RETRIES = 10;
let phoneConnected = false;
let lastPhotoDataUrl = null; // Store photo with contact
let detectedBlocks = []; // [{ text, type, confidence }]
let openaiApiKey = ''; // Stored in memory only (not in localStorage for security)
let remoteSmartBuffer = []; // Accumulate remote photos for Smart Scan
let remoteSmartActive = false; // Whether we're collecting for Smart Scan
let phoneBridgeConn = null;    // PeerJS connection to desktop (when this device is the phone)
let isPhoneBridge = false;     // True when running as remote phone (?s= param detected)

// ─── DOM HELPERS ──────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

