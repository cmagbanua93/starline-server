/* StarLine Field Ops — standalone server
 * Zero dependencies. Run with:  node server.js
 * Data stored in ./db.json
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');
const PUBLIC = path.join(__dirname, 'public');
/* photos live next to the database (on the mounted volume), NOT inside db.json */
const PHOTO_DIR = process.env.PHOTO_DIR || path.join(path.dirname(DB_FILE), 'photos');
/* Everything here lives in one JSON file on one volume. BACKUP_TOKEN opens a
   read-only endpoint so a scheduled job elsewhere can keep copies off this disk. */
const BACKUP_TOKEN = process.env.BACKUP_TOKEN || '';
/* The monitoring service already knows who each PPPoE account belongs to (it
   joins the billing export to the router every cycle) and whether they are
   online right now. Tickets ask it rather than keeping a second customer list. */
const MONITOR_URL = (process.env.MONITOR_URL || '').replace(/\/$/, '');
const MONITOR_TOKEN = process.env.MONITOR_TOKEN || '';
try { fs.mkdirSync(PHOTO_DIR, { recursive: true }); } catch (e) { console.error('Cannot create photo dir:', e.message); }

/* ---------------- database (JSON file) ---------------- */
let db = { users: [], tickets: [], sessions: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
db.users = db.users || []; db.tickets = db.tickets || []; db.sessions = db.sessions || {};
db.settings = db.settings || { plans: [] };
db.requests = db.requests || [];
/* every movement of stock out of the warehouse to a technician, so "how much was
   released vs how much was used" can be answered exactly */
db.stockLog = db.stockLog || [];

/* ---------------- repair issue types ----------------
 * Each reported repair issue drives a different technician workflow. `flow` picks
 * the step template the app runs; admins can add their own issues and choose which
 * template they follow. */
const REPAIR_FLOWS = ['modem', 'connector', 'nap_reading', 'fiber_cut', 'main_nap', 'generic'];
const DEFAULT_REPAIR_ISSUES = [
  { id: 'ri_modem', label: 'Modem / ONU issue — needs repair or replacement', flow: 'modem' },
  { id: 'ri_connector', label: 'Defective connector', flow: 'connector' },
  { id: 'ri_reading', label: 'High reading — check the NAP box', flow: 'nap_reading' },
  { id: 'ri_fibercut', label: 'Fiber cut — NAP box to subscriber', flow: 'fiber_cut' },
  { id: 'ri_mainnap', label: 'Main NAP problem', flow: 'main_nap' }
];
if (!Array.isArray(db.settings.repairIssues) || !db.settings.repairIssues.length) {
  db.settings.repairIssues = DEFAULT_REPAIR_ISSUES.slice();
} else {
  /* tolerate an older plain-string list */
  db.settings.repairIssues = db.settings.repairIssues.map((x, i) => {
    if (typeof x === 'string') return { id: 'ri' + i + Date.now().toString(36), label: x, flow: 'generic' };
    return { id: x.id || 'ri' + i + Date.now().toString(36), label: String(x.label || ''), flow: REPAIR_FLOWS.includes(x.flow) ? x.flow : 'generic' };
  }).filter(x => x.label);
}

/* ---------------- elapsed-time helper ----------------
 * Stored as text as well as milliseconds so every screen (and any export) shows
 * the same wording without recomputing it. */
function humanDuration(ms) {
  if (!(ms > 0)) return 'less than a minute';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'less than a minute';
  if (mins < 60) return mins + (mins === 1 ? ' minute' : ' minutes');
  const hrs = Math.floor(mins / 60), rm = mins % 60;
  if (hrs < 48) return hrs + (hrs === 1 ? ' hour' : ' hours') + (rm ? ' ' + rm + (rm === 1 ? ' minute' : ' minutes') : '');
  const days = Math.floor(hrs / 24), rh = hrs % 24;
  return days + (days === 1 ? ' day' : ' days') + (rh ? ' ' + rh + (rh === 1 ? ' hour' : ' hours') : '');
}
/* warehouse/office stock: cables are reel types {id, name, meters (per reel), qty (pcs)};
   items are any other stock {id, name, qty} */
db.warehouse = db.warehouse || { connectors: 0, cables: [], items: [] };
db.warehouse.items = db.warehouse.items || [];
/* inventory model: { connectors: N, cables: [{id, name, meters}] } — migrate old flat cable number */
db.users.forEach(u => {
  u.inv = u.inv || {};
  if (u.inv.connectors === undefined) u.inv.connectors = 0;
  if (!Array.isArray(u.inv.cables)) u.inv.cables = [];
  if (!Array.isArray(u.inv.items)) u.inv.items = [];
  if (typeof u.inv.cable === 'number') {
    if (u.inv.cable > 0) u.inv.cables.push({ id: 'r' + Date.now() + Math.random().toString(36).slice(2, 6), name: 'Stock cable', meters: u.inv.cable });
    delete u.inv.cable;
  }
});

let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DB_FILE, JSON.stringify(db), err => { if (err) console.error('DB save failed:', err.message); });
  }, 150);
}

function flushDB() {
  clearTimeout(saveTimer);
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) {}
}
process.on('SIGINT', () => { flushDB(); process.exit(0); });
process.on('SIGTERM', () => { flushDB(); process.exit(0); });

/* ---------------- photo storage (FIX 3) ----------------
 * Photos used to be kept as base64 data: URLs inside ticket.data, which meant
 * every copy of a ticket carried its images. They are now written once to
 * PHOTO_DIR, named by content hash, and referenced by a short "/photos/<hash>.jpg"
 * URL that the browser can cache forever.
 */
const IMG_EXT = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const DATA_URL_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/;

function storeDataUrl(dataUrl) {
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) return null;
  let buf;
  try { buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64'); } catch (e) { return null; }
  if (!buf.length) return null;
  const file = crypto.createHash('sha1').update(buf).digest('hex') + (IMG_EXT[m[1].toLowerCase()] || '.bin');
  const full = path.join(PHOTO_DIR, file);
  try { if (!fs.existsSync(full)) fs.writeFileSync(full, buf); }
  catch (e) { console.error('Photo write failed:', e.message); return null; }
  return '/photos/' + file;
}

/* Walk an object and replace every inline data:image/... string with a /photos/ URL.
   Returns true if anything was moved out. */
function externalizePhotos(node, depth) {
  depth = depth || 0;
  if (!node || typeof node !== 'object' || depth > 6) return false;
  let changed = false;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (typeof v === 'string') {
      if (v.startsWith('data:image/')) {
        const url = storeDataUrl(v);
        if (url) { node[k] = url; changed = true; }
      }
    } else if (v && typeof v === 'object') {
      if (externalizePhotos(v, depth + 1)) changed = true;
    }
  }
  return changed;
}

/* One-time migration: pull every base64 image already sitting in db.json out to disk.
   A full copy of the original database is written next to it first, so this is
   reversible: stop the service, restore the .bak over db.json, redeploy the old build. */
(function migratePhotos() {
  const needsMigration = db.tickets.some(t => t.data && JSON.stringify(t.data).includes('data:image/'));
  if (!needsMigration) return;

  const backup = DB_FILE + '.pre-photo-migration.bak';
  try {
    if (!fs.existsSync(backup)) {
      fs.copyFileSync(DB_FILE, backup);
      console.log(`Backed up original database -> ${backup} (${(fs.statSync(backup).size / 1048576).toFixed(2)} MB)`);
    }
  } catch (e) {
    console.error('ABORTING MIGRATION — could not write backup:', e.message);
    return;   // never rewrite the database without a safety copy
  }

  let n = 0;
  db.tickets.forEach(t => { if (t.data && externalizePhotos(t.data)) n++; });
  if (n) {
    flushDB();
    console.log(`Moved inline photos out of ${n} ticket(s) -> ${PHOTO_DIR}`);
    try { console.log(`db.json is now ${(fs.statSync(DB_FILE).size / 1048576).toFixed(2)} MB`); } catch (e) {}
  }
})();

/* ---------------- password helpers ---------------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
  return salt + ':' + hash;
}
function checkPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}

/* Seed default admin on first run */
if (!db.users.length) {
  db.users.push({
    id: 'u' + Date.now(),
    username: 'admin',
    name: 'Administrator',
    role: 'admin',
    pass: hashPassword('admin123')
  });
  saveDB();
  console.log('Created default admin account -> username: admin  password: admin123');
  console.log('CHANGE THIS PASSWORD after first login (Technicians page > Change my password).');
}

/* ---------------- http helpers ---------------- */
/* Already-compressed payloads: gzipping them just burns CPU. */
const NO_GZIP = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/x-icon']);

/* Central writer: gzips when the client asked for it and it actually helps (FIX 4). */
function sendBody(req, res, code, body, type, extra) {
  const headers = Object.assign({ 'Content-Type': type }, extra || {});
  if (!Buffer.isBuffer(body)) body = Buffer.from(body);
  if (body.length > 1024 && !NO_GZIP.has(type) && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    let gz = null;
    try { gz = zlib.gzipSync(body, { level: 6 }); } catch (e) {}
    if (gz && gz.length < body.length) {
      body = gz;
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = headers['Vary'] ? headers['Vary'] + ', Accept-Encoding' : 'Accept-Encoding';
    }
  }
  headers['Content-Length'] = body.length;
  res.writeHead(code, headers);
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}

function json(res, code, obj) {
  return sendBody(res.req, res, code, Buffer.from(JSON.stringify(obj)), 'application/json');
}

/* Same as json(), but tags the payload so an unchanged poll costs a 304 with no
   body instead of the whole list (FIX 2). */
function jsonCached(req, res, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const etag = '"' + crypto.createHash('sha1').update(body).digest('base64') + '"';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'no-cache' });
    return res.end();
  }
  return sendBody(req, res, 200, body, 'application/json', { 'ETag': etag, 'Cache-Control': 'no-cache' });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 40 * 1024 * 1024) { reject(new Error('Payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function auth(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token || !db.sessions[token]) return null;
  const user = db.users.find(u => u.id === db.sessions[token]);
  return user ? { user, token } : null;
}
function publicUser(u) { return { id: u.id, username: u.username, name: u.name, role: u.role, inv: u.inv || { connectors: 0, cables: [], items: [] } }; }

/* ---------------- customer lookup (via the monitoring service) ----------------
 * The API key stays on this server: the technician's browser never sees it, and
 * a monitoring outage degrades to "lookup unavailable" rather than blocking the
 * job — the customer name can always still be typed by hand.
 */
function lookupError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function monitorLookup(pathAndQuery) {
  if (!MONITOR_URL || !MONITOR_TOKEN) {
    throw lookupError('Customer lookup is not set up yet (MONITOR_URL / MONITOR_TOKEN).', 503);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch(MONITOR_URL + pathAndQuery, {
      headers: { 'x-api-key': MONITOR_TOKEN },
      signal: controller.signal
    });
    let body = {};
    try { body = JSON.parse(await r.text()); } catch (e) {}
    if (!r.ok) throw lookupError(body.error || ('Lookup failed (HTTP ' + r.status + ')'), r.status === 404 ? 404 : 502);
    return body;
  } catch (err) {
    if (err.code) throw err;
    throw lookupError(
      err.name === 'AbortError'
        ? 'The monitoring service did not answer in time.'
        : 'Cannot reach the monitoring service right now.',
      502
    );
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- ticket list shaping (FIX 1) ----------------
 * The list endpoint must never carry image payloads. Every other field is kept
 * so the dashboard, tech list and usage report still render from the list alone;
 * only inline data: blobs are dropped. Post-migration the images are short
 * /photos/ URLs, so nothing is stripped and _partial is false.
 */
function isInlineBlob(v) { return typeof v === 'string' && v.startsWith('data:'); }

function lightData(data) {
  if (!data || typeof data !== 'object') return { data: data, stripped: false };
  let stripped = false;
  const out = Array.isArray(data) ? [] : {};
  for (const k of Object.keys(data)) {
    const v = data[k];
    if (isInlineBlob(v)) { stripped = true; continue; }
    if (v && typeof v === 'object') {
      const inner = lightData(v);
      if (inner.stripped) stripped = true;
      out[k] = inner.data;
    } else out[k] = v;
  }
  return { data: out, stripped };
}

function ticketSummary(t) {
  const light = lightData(t.data);
  const s = Object.assign({}, t, { data: light.data });
  if (light.stripped) s._partial = true;   // client re-fetches the full ticket when opened
  return s;
}
/* Records stock leaving the warehouse for a technician. `qty` is pieces (reels for
   cable) and `meters` the cable length that represents, so the usage report can
   compare metres released against metres consumed. */
function logStock(tech, kind, name, qty, meters, source, by) {
  const q = parseFloat(qty) || 0;
  if (!tech || !q) return;
  db.stockLog.push({
    id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    techId: tech.id, techName: tech.name,
    kind, name: String(name || '').trim() || (kind === 'connector' ? 'FIC Connector' : ''),
    qty: q, meters: parseFloat(meters) || 0,
    source: source || 'direct', by: by || ''
  });
  if (db.stockLog.length > 5000) db.stockLog = db.stockLog.slice(-5000);
}

function addItemTo(u, name, qty) {
  u.inv = u.inv || { connectors: 0, cables: [], items: [] };
  u.inv.items = u.inv.items || [];
  const n = String(name || '').trim();
  const q = parseInt(qty) || 0;
  if (!n || q === 0) return;
  const ex = u.inv.items.find(i => i.name.toLowerCase() === n.toLowerCase());
  if (ex) { ex.qty += q; if (ex.qty <= 0) u.inv.items = u.inv.items.filter(i => i !== ex); }
  else if (q > 0) u.inv.items.push({ name: n, qty: q });
}
function addStockTo(u, cableName, cableMeters, connectors) {
  u.inv = u.inv || { connectors: 0, cables: [] };
  u.inv.cables = u.inv.cables || [];
  const name = String(cableName || '').trim();
  const meters = parseFloat(cableMeters) || 0;
  if (name && meters > 0) u.inv.cables.push({ id: 'r' + Date.now() + Math.random().toString(36).slice(2, 6), name, meters: Math.round(meters * 100) / 100 });
  u.inv.connectors = (u.inv.connectors || 0) + (parseInt(connectors) || 0);
}

/* ---------------- static files ---------------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };
function serveStatic(req, res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    sendBody(req, res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

/* Stored photos: content-addressed, so they can be cached forever (FIX 3).
   The 40-hex-character name is the capability — these URLs are unguessable but
   not session-checked, because <img src> cannot send the Bearer token. */
function servePhoto(req, res, urlPath) {
  const name = path.basename(urlPath);
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) { res.writeHead(404); return res.end('Not found'); }
  const file = path.join(PHOTO_DIR, name);
  if (!file.startsWith(PHOTO_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    sendBody(req, res, 200, data, MIME[path.extname(file)] || 'application/octet-stream', {
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
  });
}

/* ---------------- server ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    if (p.startsWith('/photos/')) return servePhoto(req, res, p);
    if (!p.startsWith('/api/')) return serveStatic(req, res, p);

    /* ---- login ---- */
    if (p === '/api/login' && req.method === 'POST') {
      const { username, password } = await readBody(req);
      const user = db.users.find(u => u.username === String(username || '').trim().toLowerCase());
      if (!user || !checkPassword(String(password || ''), user.pass))
        return json(res, 401, { error: 'Wrong username or password' });
      const token = crypto.randomBytes(24).toString('hex');
      db.sessions[token] = user.id; saveDB();
      return json(res, 200, { token, user: publicUser(user) });
    }

    /* ---- backup (machine-to-machine, own token, read-only) ----
       Returns the whole database plus the list of photo files, so a scheduled
       job can store a dated copy somewhere other than this volume. */
    if (p === '/api/backup' && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!BACKUP_TOKEN) return json(res, 503, { error: 'Backups are disabled: set BACKUP_TOKEN on this service.' });
      const supplied = Buffer.from(String(req.headers['x-api-key'] || ''));
      const expected = Buffer.from(BACKUP_TOKEN);
      const ok = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
      if (!ok) return json(res, 401, { error: 'Bad or missing API key' });

      let photos = [];
      try { photos = fs.readdirSync(PHOTO_DIR).filter(n => !n.startsWith('.')); } catch (e) {}
      return json(res, 200, {
        takenAt: new Date().toISOString(),
        counts: {
          tickets: db.tickets.length,
          users: db.users.length,
          requests: db.requests.length,
          stockLog: db.stockLog.length,
          photos: photos.length
        },
        photos,
        db
      });
    }

    /* ---- everything below requires auth ---- */
    const session = auth(req);
    if (!session) return json(res, 401, { error: 'Not logged in' });
    const me = session.user;
    const isAdmin = me.role === 'admin';

    if (p === '/api/logout' && req.method === 'POST') {
      delete db.sessions[session.token]; saveDB();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/me' && req.method === 'GET') return json(res, 200, { user: publicUser(me) });

    /* ---- customer lookup for the ticket screens ----
       Any logged-in user may search; the key never leaves this server. */
    if (p === '/api/lookup/customers' && req.method === 'GET') {
      try {
        const q = url.searchParams.get('q') || '';
        return json(res, 200, await monitorLookup('/api/customers?limit=15&q=' + encodeURIComponent(q)));
      } catch (e) {
        return json(res, e.code || 500, { error: e.message });
      }
    }
    const lookupOne = p.match(/^\/api\/lookup\/customers\/(.+)$/);
    if (lookupOne && req.method === 'GET') {
      try {
        return json(res, 200, await monitorLookup('/api/customers/' + encodeURIComponent(decodeURIComponent(lookupOne[1]))));
      } catch (e) {
        return json(res, e.code || 500, { error: e.message });
      }
    }

    if (p === '/api/password' && req.method === 'POST') {
      const { oldPassword, newPassword } = await readBody(req);
      if (!checkPassword(String(oldPassword || ''), me.pass)) return json(res, 400, { error: 'Current password is wrong' });
      if (String(newPassword || '').length < 6) return json(res, 400, { error: 'New password must be at least 6 characters' });
      me.pass = hashPassword(String(newPassword)); saveDB();
      return json(res, 200, { ok: true });
    }

    /* ---- settings (plans) ---- */
    if (p === '/api/settings' && req.method === 'GET') return json(res, 200, { settings: db.settings });
    if (p === '/api/settings' && req.method === 'PUT') {
      if (!isAdmin) return json(res, 403, { error: 'Admin only' });
      const b = await readBody(req);
      if (Array.isArray(b.plans)) db.settings.plans = b.plans.map(x => String(x).trim()).filter(Boolean);
      if (Array.isArray(b.repairIssues)) {
        db.settings.repairIssues = b.repairIssues.map((x, i) => ({
          id: (x && x.id) || 'ri' + i + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
          label: String((x && x.label) || '').trim(),
          flow: (x && REPAIR_FLOWS.includes(x.flow)) ? x.flow : 'generic'
        })).filter(x => x.label);
      }
      saveDB();
      return json(res, 200, { settings: db.settings });
    }

    /* ---- warehouse inventory ---- */
    if (p === '/api/warehouse' && req.method === 'GET') return json(res, 200, { warehouse: db.warehouse });
    if (p === '/api/warehouse' && req.method === 'POST') {
      if (!isAdmin) return json(res, 403, { error: 'Admin only' });
      const b = await readBody(req);
      const name = String(b.cableName || '').trim();
      const meters = parseFloat(b.reelMeters) || 0;
      const qty = parseInt(b.qty) || 0;
      if (name && meters > 0 && qty !== 0) {
        const existing = db.warehouse.cables.find(c => c.name.toLowerCase() === name.toLowerCase() && c.meters === meters);
        if (existing) { existing.qty += qty; if (existing.qty <= 0) db.warehouse.cables = db.warehouse.cables.filter(c => c !== existing); }
        else if (qty > 0) db.warehouse.cables.push({ id: 'w' + Date.now() + Math.random().toString(36).slice(2, 6), name, meters, qty });
      }
      if (b.connectors !== undefined) db.warehouse.connectors = Math.max(0, (db.warehouse.connectors || 0) + (parseInt(b.connectors) || 0));
      /* generic items (modems, clamps, hooks, patch cords, ...) */
      const itemName = String(b.itemName || '').trim();
      const itemQty = parseInt(b.itemQty) || 0;
      if (itemName && itemQty !== 0) {
        const ex = db.warehouse.items.find(i => i.name.toLowerCase() === itemName.toLowerCase());
        if (ex) { ex.qty += itemQty; if (ex.qty <= 0) db.warehouse.items = db.warehouse.items.filter(i => i !== ex); }
        else if (itemQty > 0) db.warehouse.items.push({ id: 'i' + Date.now() + Math.random().toString(36).slice(2, 6), name: itemName, qty: itemQty });
      }
      if (b.removeCable) db.warehouse.cables = db.warehouse.cables.filter(c => c.id !== b.removeCable);
      if (b.removeItem) db.warehouse.items = db.warehouse.items.filter(i => i.id !== b.removeItem);
      saveDB();
      return json(res, 200, { warehouse: db.warehouse });
    }

    /* ---- material requests ---- */
    if (p === '/api/requests' && req.method === 'GET') {
      const list = isAdmin ? db.requests : db.requests.filter(r => r.techId === me.id);
      return json(res, 200, { requests: list });
    }
    if (p === '/api/requests' && req.method === 'POST') {
      const b = await readBody(req);
      const kind = String(b.kind || '').trim();       // 'cable' | 'connector' | 'item'
      const name = String(b.name || b.cableName || '').trim();
      const qty = parseInt(b.qty || b.cableReels || b.connectors) || 0;
      if (!['cable', 'connector', 'item'].includes(kind)) return json(res, 400, { error: 'Select an item to request' });
      if (qty <= 0) return json(res, 400, { error: 'Enter a quantity greater than zero' });
      let cableMeters = 0;
      if (kind === 'cable') {
        const wh = db.warehouse.cables.find(c => c.name.toLowerCase() === name.toLowerCase());
        if (!wh) return json(res, 400, { error: 'That cable type is not in the warehouse inventory' });
        cableMeters = qty * wh.meters;
      }
      if (kind === 'item') {
        const wh = db.warehouse.items.find(i => i.name.toLowerCase() === name.toLowerCase());
        if (!wh) return json(res, 400, { error: 'That item is not in the warehouse inventory' });
      }
      const r = {
        id: 'q' + Date.now() + Math.random().toString(36).slice(2, 6),
        techId: me.id, techName: me.name,
        kind, name: kind === 'connector' ? 'FIC Connector' : name, qty, cableMeters,
        note: String(b.note || '').trim(),
        status: 'pending', created: Date.now()
      };
      db.requests.push(r); saveDB();
      return json(res, 200, { request: r });
    }
    let m = p.match(/^\/api\/requests\/([\w.]+)$/);
    if (m && req.method === 'PUT') {
      const r = db.requests.find(x => x.id === m[1]);
      if (!r) return json(res, 404, { error: 'Request not found' });
      const b = await readBody(req);
      const action = b.action;
      if (action === 'cancel') {
        if (r.techId !== me.id && !isAdmin) return json(res, 403, { error: 'Not your request' });
        if (r.status !== 'pending') return json(res, 400, { error: 'Only pending requests can be cancelled' });
        r.status = 'cancelled';
      } else {
        if (!isAdmin) return json(res, 403, { error: 'Admin only' });
        if (action === 'approve') {
          if (r.status !== 'pending') return json(res, 400, { error: 'Only pending requests can be approved' });
          r.status = 'approved';
        } else if (action === 'reject') {
          if (!['pending', 'approved'].includes(r.status)) return json(res, 400, { error: 'Already processed' });
          r.status = 'rejected';
        } else if (action === 'release') {
          if (!['pending', 'approved'].includes(r.status)) return json(res, 400, { error: 'Already processed' });
          const tech = db.users.find(u => u.id === r.techId);
          if (!tech) return json(res, 400, { error: 'Technician no longer exists' });
          /* take the items out of warehouse stock and move to the technician */
          const kind = r.kind || (r.cableName ? 'cable' : 'connector');       // legacy support
          const name = r.name || r.cableName;
          const qty = r.qty || r.cableReels || r.connectors || 0;
          if (kind === 'cable' && name && qty > 0) {
            const wh = db.warehouse.cables.find(c => c.name.toLowerCase() === name.toLowerCase());
            if (!wh) return json(res, 400, { error: 'No "' + name + '" cable in warehouse inventory. Add it first (Requests tab > Warehouse Inventory).' });
            if (wh.qty < qty) return json(res, 400, { error: 'Not enough stock: request needs ' + qty + ' reel(s) of ' + wh.name + ' (' + wh.meters + ' m/reel) but warehouse has only ' + wh.qty + '.' });
            wh.qty -= qty;
            if (wh.qty <= 0) db.warehouse.cables = db.warehouse.cables.filter(c => c !== wh);
            for (let i = 0; i < qty; i++) addStockTo(tech, wh.name, wh.meters, 0);
            logStock(tech, 'cable', wh.name, qty, qty * wh.meters, 'request', me.name);
          } else if (kind === 'connector' && qty > 0) {
            if ((db.warehouse.connectors || 0) < qty) return json(res, 400, { error: 'Not enough FIC connectors in warehouse: requested ' + qty + ', available ' + (db.warehouse.connectors || 0) + '.' });
            db.warehouse.connectors -= qty;
            addStockTo(tech, '', 0, qty);
            logStock(tech, 'connector', 'FIC Connector', qty, 0, 'request', me.name);
          } else if (kind === 'item' && name && qty > 0) {
            const wh = db.warehouse.items.find(i => i.name.toLowerCase() === name.toLowerCase());
            if (!wh) return json(res, 400, { error: 'No "' + name + '" in warehouse inventory. Add it first.' });
            if (wh.qty < qty) return json(res, 400, { error: 'Not enough stock: requested ' + qty + ' of ' + wh.name + ' but warehouse has only ' + wh.qty + '.' });
            wh.qty -= qty;
            if (wh.qty <= 0) db.warehouse.items = db.warehouse.items.filter(i => i !== wh);
            addItemTo(tech, wh.name, qty);
            logStock(tech, 'item', wh.name, qty, 0, 'request', me.name);
          }
          /* legacy combined requests (cable + connectors in one) */
          if (!r.kind && r.cableName && r.connectors > 0) {
            if ((db.warehouse.connectors || 0) < r.connectors) return json(res, 400, { error: 'Not enough FIC connectors in warehouse.' });
            db.warehouse.connectors -= r.connectors;
            addStockTo(tech, '', 0, r.connectors);
            logStock(tech, 'connector', 'FIC Connector', r.connectors, 0, 'request', me.name);
          }
          r.status = 'released'; r.released = Date.now();
        } else return json(res, 400, { error: 'Unknown action' });
        r.decidedBy = me.name;
      }
      r.updated = Date.now();
      saveDB();
      return json(res, 200, { request: r });
    }

    /* ---- stock ledger: what was released to whom ---- */
    if (p === '/api/stocklog' && req.method === 'GET') {
      const list = isAdmin ? db.stockLog : db.stockLog.filter(s => s.techId === me.id);
      return json(res, 200, { stockLog: list });
    }

    /* ---- users (admin) ---- */
    if (p === '/api/users' && req.method === 'GET') {
      if (!isAdmin) return json(res, 403, { error: 'Admin only' });
      return json(res, 200, { users: db.users.map(publicUser) });
    }
    if (p === '/api/users' && req.method === 'POST') {
      if (!isAdmin) return json(res, 403, { error: 'Admin only' });
      const b = await readBody(req);
      const username = String(b.username || '').trim().toLowerCase();
      const name = String(b.name || '').trim();
      const password = String(b.password || '');
      if (!username || !name || password.length < 6)
        return json(res, 400, { error: 'Name, username and a password of 6+ characters are required' });
      if (db.users.some(u => u.username === username)) return json(res, 400, { error: 'Username already taken' });
      const u = { id: 'u' + Date.now() + Math.random().toString(36).slice(2, 6), username, name, role: b.role === 'admin' ? 'admin' : 'tech', pass: hashPassword(password), inv: { connectors: 0, cables: [], items: [] } };
      db.users.push(u); saveDB();
      return json(res, 200, { user: publicUser(u) });
    }
    m = p.match(/^\/api\/users\/([\w.]+)$/);
    if (m && req.method === 'DELETE') {
      if (!isAdmin) return json(res, 403, { error: 'Admin only' });
      if (m[1] === me.id) return json(res, 400, { error: 'You cannot delete your own account' });
      db.users = db.users.filter(u => u.id !== m[1]);
      Object.keys(db.sessions).forEach(t => { if (db.sessions[t] === m[1]) delete db.sessions[t]; });
      saveDB();
      return json(res, 200, { ok: true });
    }
    m = p.match(/^\/api\/users\/([\w.]+)\/inventory$/);
    if (m && req.method === 'POST') {
      if (!isAdmin) return json(res, 403, { error: 'Admin only' });
      const b = await readBody(req);
      const u = db.users.find(x => x.id === m[1]);
      if (!u) return json(res, 404, { error: 'User not found' });
      addStockTo(u, b.cableName, b.cableMeters, b.connectors);
      /* stock handed over directly (not through a request) still belongs in the ledger */
      if (String(b.cableName || '').trim() && (parseFloat(b.cableMeters) || 0) > 0)
        logStock(u, 'cable', b.cableName, 1, b.cableMeters, 'direct', me.name);
      if ((parseInt(b.connectors) || 0) > 0)
        logStock(u, 'connector', 'FIC Connector', parseInt(b.connectors), 0, 'direct', me.name);
      if (b.itemName !== undefined && b.itemQty !== undefined) {
        addItemTo(u, b.itemName, b.itemQty);
        if ((parseInt(b.itemQty) || 0) > 0) logStock(u, 'item', b.itemName, parseInt(b.itemQty), 0, 'direct', me.name);
      }
      if (b.removeReel) { u.inv.cables = (u.inv.cables || []).filter(r => r.id !== b.removeReel); }
      if (b.setReelId && b.setReelMeters !== undefined) {
        const reel = (u.inv.cables || []).find(r => r.id === b.setReelId);
        if (reel) reel.meters = Math.round((parseFloat(b.setReelMeters) || 0) * 100) / 100;
      }
      saveDB();
      return json(res, 200, { user: publicUser(u) });
    }

    m = p.match(/^\/api\/users\/([\w.]+)\/password$/);
    if (m && req.method === 'POST') {
      if (!isAdmin) return json(res, 403, { error: 'Admin only' });
      const b = await readBody(req);
      const u = db.users.find(x => x.id === m[1]);
      if (!u) return json(res, 404, { error: 'User not found' });
      if (String(b.newPassword || '').length < 6) return json(res, 400, { error: 'Password must be at least 6 characters' });
      u.pass = hashPassword(String(b.newPassword)); saveDB();
      return json(res, 200, { ok: true });
    }

    /* ---- tickets ---- */
    if (p === '/api/tickets' && req.method === 'GET') {
      const list = isAdmin ? db.tickets : db.tickets.filter(t => t.assignedTo === me.id);
      /* summaries only, and a 304 when nothing has changed since the last poll */
      return jsonCached(req, res, { tickets: list.map(ticketSummary) });
    }
    if (p === '/api/tickets' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.subject || !b.customer) return json(res, 400, { error: 'Subject and customer are required' });
      const seq = String(db.tickets.length + 1).padStart(4, '0');
      /* Technicians may raise their own jobs, but only ever for themselves —
         they cannot assign work to a colleague, and they cannot delete anything. */
      const assignee = isAdmin ? db.users.find(u => u.id === b.assignedTo) : me;
      const t = {
        id: 'id' + Date.now() + Math.random().toString(36).slice(2, 6),
        number: String(b.number || '').trim() || `TKT-${new Date().getFullYear()}-${seq}`,
        type: ['repair', 'nap_install'].includes(b.type) ? b.type : 'installation',
        priority: [1, 2, 3].includes(parseInt(b.priority)) ? parseInt(b.priority) : 3,
        subject: String(b.subject).trim(),
        customer: String(b.customer).trim(),
        phone: String(b.phone || '').trim(),
        address: String(b.address || '').trim(),
        message: String(b.message || '').trim(),
        /* Set when the customer was picked from billing rather than typed.
           pppoeUsername is the key everything else joins on. */
        accountNo: String(b.accountNo || '').trim(),
        pppoeUsername: String(b.pppoeUsername || '').trim().toLowerCase(),
        assignedTo: assignee ? assignee.id : null,
        assignedName: assignee ? assignee.name : null,
        status: 'open',
        created: Date.now(),
        started: null,
        completed: null,
        data: {},
        step: 0,
        createdBy: me.name,
        createdByRole: me.role
      };
      /* a repair carries the reported issue, which decides the technician's steps */
      if (t.type === 'repair') {
        const issue = (db.settings.repairIssues || []).find(x => x.id === b.issueId || x.label === b.issue);
        t.issueId = issue ? issue.id : null;
        t.issue = issue ? issue.label : String(b.issue || '').trim();
        t.issueFlow = issue ? issue.flow : 'generic';
      }
      if (t.type === 'installation') {
        t.data.cust_name = t.customer; t.data.cust_address = t.address; t.data.cust_phone = t.phone;
        if (t.accountNo) t.data.cust_account = t.accountNo;   // step 9 starts pre-filled
      }
      db.tickets.push(t); saveDB();
      return json(res, 200, { ticket: t });
    }
    m = p.match(/^\/api\/tickets\/([\w.]+)$/);
    if (m) {
      const t = db.tickets.find(x => x.id === m[1]);
      if (!t) return json(res, 404, { error: 'Ticket not found' });
      if (!isAdmin && t.assignedTo !== me.id) return json(res, 403, { error: 'Not your ticket' });

      if (req.method === 'GET') return json(res, 200, { ticket: t });

      if (req.method === 'PUT') {
        const b = await readBody(req);
        if (isAdmin) {
          ['subject', 'customer', 'phone', 'address', 'message', 'number', 'accountNo'].forEach(k => { if (b[k] !== undefined) t[k] = String(b[k]).trim(); });
          if (b.pppoeUsername !== undefined) t.pppoeUsername = String(b.pppoeUsername).trim().toLowerCase();
          if (b.assignedTo !== undefined) {
            const a = db.users.find(u => u.id === b.assignedTo);
            t.assignedTo = a ? a.id : null; t.assignedName = a ? a.name : null;
          }
          if (b.priority !== undefined && [1, 2, 3].includes(parseInt(b.priority))) t.priority = parseInt(b.priority);
          /* re-classifying a repair swaps in that issue's step list */
          if (b.issueId !== undefined && t.type === 'repair') {
            const issue = (db.settings.repairIssues || []).find(x => x.id === b.issueId);
            const wasFlow = t.issueFlow;
            t.issueId = issue ? issue.id : null;
            t.issue = issue ? issue.label : '';
            t.issueFlow = issue ? issue.flow : 'generic';
            if (t.issueFlow !== wasFlow && t.status !== 'completed') t.step = 0;
          }
        }
        if (b.data !== undefined) {
          /* a client that is still holding a summary must not be able to blank out
             photos it never received */
          const incoming = b.data && typeof b.data === 'object' ? b.data : {};
          externalizePhotos(incoming);                       // base64 -> /photos/ URL (FIX 3)
          const prev = t.data || {};
          Object.keys(prev).forEach(k => {
            const pv = prev[k], nv = incoming[k];
            if (pv && typeof pv === 'object' && pv.img && nv && typeof nv === 'object' && nv.img === undefined) nv.img = pv.img;
          });
          t.data = incoming;
        }
        if (b.step !== undefined) t.step = b.step;
        if (b.status !== undefined && ['open', 'in_progress', 'completed'].includes(b.status)) {
          t.status = b.status;
          /* ---- job clock ----
             starts the moment the technician picks the job up, so the closing
             remark measures actual work time, not how long it sat in the queue */
          if (b.status !== 'open' && !t.started) t.started = b.started || Date.now();
          t.completed = b.status === 'completed' ? (b.completed || Date.now()) : null;
          if (b.status === 'completed') {
            const startTs = t.started || t.created;
            t.durationMs = Math.max(0, t.completed - startTs);
            t.durationText = humanDuration(t.durationMs);
            t.data = t.data || {};
            t.data.auto_remark = 'Completed in ' + t.durationText + ' from the time the technician started work.';
          } else {
            /* reopened — the old closing figures no longer describe this job */
            delete t.durationMs; delete t.durationText;
            if (t.data) delete t.data.auto_remark;
          }
          /* Deduct materials from the technician's inventory once, on first completion */
          if (b.status === 'completed' && !t.invApplied && t.assignedTo) {
            const tech = db.users.find(u => u.id === t.assignedTo);
            if (tech) {
              tech.inv = tech.inv || { connectors: 0, cables: [] };
              tech.inv.cables = tech.inv.cables || [];
              let cableUsed = 0;
              if (t.data && t.data.cable_start !== undefined && t.data.cable_end !== undefined) {
                cableUsed = (parseFloat(t.data.cable_start) || 0) - (parseFloat(t.data.cable_end) || 0);
                if (cableUsed < 0) cableUsed = 0;
                t.data.cable_used = Math.round(cableUsed * 100) / 100;
              } else if (t.data && t.data.cable_length) {
                cableUsed = parseFloat(t.data.cable_length) || 0;
                t.data.cable_used = Math.round(cableUsed * 100) / 100;
              }
              /* deduct from the specific reel the technician selected */
              if (cableUsed > 0 && t.data && t.data.cable_reel) {
                const reel = tech.inv.cables.find(r => r.id === t.data.cable_reel);
                if (reel) {
                  reel.meters = Math.round((reel.meters - cableUsed) * 100) / 100;
                  t.data.cable_reel_name = reel.name;
                }
              }
              const connUsed = parseInt(t.data && t.data.connectors) || 0;
              tech.inv.connectors = tech.inv.connectors - connUsed;
              /* issued items (modems, clamps, patch cords, ...) consumed on this job */
              const usedItems = Array.isArray(t.data && t.data.items_used) ? t.data.items_used : [];
              const cleanItems = [];
              usedItems.forEach(it => {
                const name = String((it && it.name) || '').trim();
                const q = parseInt(it && it.qty) || 0;
                if (!name || q <= 0) return;
                addItemTo(tech, name, -q);
                cleanItems.push({ name, qty: q });
              });
              if (cleanItems.length) t.data.items_used = cleanItems;
              t.invApplied = true;
            }
          }
        }
        t.updated = Date.now(); t.updatedBy = me.name;
        saveDB();
        return json(res, 200, { ticket: t });
      }
      if (req.method === 'DELETE') {
        if (!isAdmin) return json(res, 403, { error: 'Admin only' });
        db.tickets = db.tickets.filter(x => x.id !== m[1]); saveDB();
        return json(res, 200, { ok: true });
      }
    }

    return json(res, 404, { error: 'Unknown endpoint' });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  const nets = require('os').networkInterfaces();
  console.log('StarLine Field Ops server running:');
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const name of Object.keys(nets))
    for (const net of nets[name])
      if (net.family === 'IPv4' && !net.internal)
        console.log(`  Network: http://${net.address}:${PORT}   <- technicians on the same Wi-Fi/LAN use this`);
});
