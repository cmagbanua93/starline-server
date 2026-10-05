/* One-time move of the ticketing data from another ticketing service (the old
 * Railway project) into this one. Runs before server.js loads its database, and
 * only when IMPORT_FROM and IMPORT_TOKEN are set on this service.
 *
 *   IMPORT_FROM   base URL of the service to copy from, e.g. https://starline-ticketing-production.up.railway.app
 *   IMPORT_TOKEN  must equal BACKUP_TOKEN on that service (it opens its read-only /api/backup)
 *
 * The database is copied ONCE: a marker file next to db.json records it, so a later
 * restart never overwrites newer work. The current db.json is kept as
 * db.json.before-import-<time>. Photos are copied on every start while the
 * variables are set, but only the ones still missing. Remove both variables when done.
 */
const fs = require('fs');
const path = require('path');

const FROM = String(process.env.IMPORT_FROM || '').replace(/\/+$/, '');
const TOKEN = process.env.IMPORT_TOKEN || '';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');
const PHOTO_DIR = process.env.PHOTO_DIR || path.join(path.dirname(DB_FILE), 'photos');
const MARKER = path.join(path.dirname(DB_FILE), '.imported-from-old');

async function main() {
  if (!FROM || !TOKEN) return;
  console.log(`[import] copying ticketing data from ${FROM}`);
  const r = await fetch(FROM + '/api/backup', { headers: { 'x-api-key': TOKEN }, signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`backup endpoint answered HTTP ${r.status} — is BACKUP_TOKEN on the old service equal to IMPORT_TOKEN here?`);
  const backup = await r.json();
  if (!backup || !backup.db || !Array.isArray(backup.db.tickets)) throw new Error('backup has no database in it');

  if (!fs.existsSync(MARKER)) {
    if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, DB_FILE + '.before-import-' + Date.now());
    const tmp = DB_FILE + '.import-tmp';
    fs.writeFileSync(tmp, JSON.stringify(backup.db));
    fs.renameSync(tmp, DB_FILE);
    fs.writeFileSync(MARKER, JSON.stringify({ from: FROM, at: new Date().toISOString(), counts: backup.counts }, null, 2));
    console.log(`[import] database copied: ${JSON.stringify(backup.counts)}`);
  } else {
    console.log('[import] database was already copied earlier — leaving it alone (photos only)');
  }

  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  const names = (backup.photos || []).filter(n => /^[A-Za-z0-9._-]+$/.test(n) && !n.startsWith('.'));
  const missing = names.filter(n => !fs.existsSync(path.join(PHOTO_DIR, n)));
  let done = 0, failed = 0;
  const queue = missing.slice();
  async function worker() {
    while (queue.length) {
      const n = queue.shift();
      try {
        const pr = await fetch(FROM + '/photos/' + encodeURIComponent(n), { signal: AbortSignal.timeout(60000) });
        if (!pr.ok) throw new Error('HTTP ' + pr.status);
        const buf = Buffer.from(await pr.arrayBuffer());
        fs.writeFileSync(path.join(PHOTO_DIR, n + '.part'), buf);
        fs.renameSync(path.join(PHOTO_DIR, n + '.part'), path.join(PHOTO_DIR, n));
        done++;
      } catch (e) { failed++; console.error(`[import] photo ${n}: ${e.message}`); }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  console.log(`[import] photos: ${names.length} on the old service, ${names.length - missing.length} already here, ${done} copied now, ${failed} failed`);
}

main().then(() => process.exit(0)).catch(e => { console.error('[import] FAILED: ' + e.message); process.exit(1); });
