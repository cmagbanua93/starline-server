/* StarLine Field Ops — standalone server
 * Zero dependencies. Run with:  node server.js
 * Data stored in ./db.json
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');
const PUBLIC = path.join(__dirname, 'public');

/* ---------------- database (JSON file) ---------------- */
let db = { users: [], tickets: [], sessions: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
db.users = db.users || []; db.tickets = db.tickets || []; db.sessions = db.sessions || {};

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
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
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
function publicUser(u) { return { id: u.id, username: u.username, name: u.name, role: u.role }; }

/* ---------------- static files ---------------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };
function serveStatic(req, res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------------- server ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
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

    if (p === '/api/password' && req.method === 'POST') {
      const { oldPassword, newPassword } = await readBody(req);
      if (!checkPassword(String(oldPassword || ''), me.pass)) return json(res, 400, { error: 'Current password is wrong' });
      if (String(newPassword || '').length < 6) return json(res, 400, { error: 'New password must be at least 6 characters' });
      me.pass = hashPassword(String(newPassword)); saveDB();
      return json(res, 200, { ok: true });
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
      const u = { id: 'u' + Date.now() + Math.random().toString(36).slice(2, 6), username, name, role: b.role === 'admin' ? 'admin' : 'tech', pass: hashPassword(password) };
      db.users.push(u); saveDB();
      return json(res, 200, { user: publicUser(u) });
    }
    let m = p.match(/^\/api\/users\/([\w.]+)$/);
    if (m && req.method === 'DELETE') {
      if (!isAdmin) return json(res, 403, { error: 'Admin only' });
      if (m[1] === me.id) return json(res, 400, { error: 'You cannot delete your own account' });
      db.users = db.users.filter(u => u.id !== m[1]);
      Object.keys(db.sessions).forEach(t => { if (db.sessions[t] === m[1]) delete db.sessions[t]; });
      saveDB();
      return json(res, 200, { ok: true });
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
      return json(res, 200, { tickets: list });
    }
    if (p === '/api/tickets' && req.method === 'POST') {
      if (!isAdmin) return json(res, 403, { error: 'Only the admin can create tickets' });
      const b = await readBody(req);
      if (!b.subject || !b.customer) return json(res, 400, { error: 'Subject and customer are required' });
      const seq = String(db.tickets.length + 1).padStart(4, '0');
      const assignee = db.users.find(u => u.id === b.assignedTo);
      const t = {
        id: 'id' + Date.now() + Math.random().toString(36).slice(2, 6),
        number: String(b.number || '').trim() || `TKT-${new Date().getFullYear()}-${seq}`,
        type: b.type === 'repair' ? 'repair' : 'installation',
        subject: String(b.subject).trim(),
        customer: String(b.customer).trim(),
        phone: String(b.phone || '').trim(),
        address: String(b.address || '').trim(),
        message: String(b.message || '').trim(),
        assignedTo: assignee ? assignee.id : null,
        assignedName: assignee ? assignee.name : null,
        status: 'open',
        created: Date.now(),
        completed: null,
        data: {},
        step: 0,
        createdBy: me.name
      };
      if (t.type === 'installation') { t.data.cust_name = t.customer; t.data.cust_address = t.address; t.data.cust_phone = t.phone; }
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
          ['subject', 'customer', 'phone', 'address', 'message', 'number'].forEach(k => { if (b[k] !== undefined) t[k] = String(b[k]).trim(); });
          if (b.assignedTo !== undefined) {
            const a = db.users.find(u => u.id === b.assignedTo);
            t.assignedTo = a ? a.id : null; t.assignedName = a ? a.name : null;
          }
        }
        if (b.data !== undefined) t.data = b.data;
        if (b.step !== undefined) t.step = b.step;
        if (b.status !== undefined && ['open', 'in_progress', 'completed'].includes(b.status)) {
          t.status = b.status;
          t.completed = b.status === 'completed' ? (b.completed || Date.now()) : null;
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
