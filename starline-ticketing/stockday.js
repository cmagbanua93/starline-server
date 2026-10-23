/* ---------------- daily stock: end-of-shift count + 4:45 PM SMS report ----------------
 *
 * Two things, so nobody calls from the field because they ran out:
 *
 * 1. END-OF-SHIFT COUNT. From COUNT_FROM (default 4:00 PM, Manila time) each
 *    technician counts what they physically have — FIC connectors, the metres on
 *    each reel, NAP boxes, cassettes and every other item — and enters it. The app
 *    compares it with what the system says. Differences are flagged red for the
 *    office, who either accept the count (the system is corrected, and logged) or
 *    dismiss it. A technician who worked on a day and did not count it must count
 *    before starting a new job the next working day.
 *
 * 2. DAILY STOCK REPORT BY SMS at REPORT_TIME (default 4:45 PM): each technician
 *    gets their own stock and what to request; the admins get everyone's in one
 *    message, including who has not counted yet. Sent through Semaphore with
 *    SEMAPHORE_API_KEY (the same account billing uses).
 */
const MANILA_OFFSET_MIN = 8 * 60;

function manilaNow() { return new Date(Date.now() + MANILA_OFFSET_MIN * 60000); }       // read with getUTC*
function manilaDay(ts) { const d = new Date((ts || Date.now()) + MANILA_OFFSET_MIN * 60000); return d.toISOString().slice(0, 10); }
function hhmmNow() { const d = manilaNow(); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); }
function prettyDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function normalizePhone(p) {
  let d = String(p || '').replace(/[^\d]/g, '');
  if (d.startsWith('63') && d.length === 12) d = '0' + d.slice(2);
  if (d.length === 10 && d.startsWith('9')) d = '0' + d;
  return /^09\d{9}$/.test(d) ? d : null;
}

module.exports = function stockDay(ctx) {
  const { db, saveDB, logStock, logReel, round2, REEL_EMPTY_M, READING_TOL_M } = ctx;

  db.counts = db.counts || [];
  db.smsLog = db.smsLog || [];
  const cfg = () => {
    db.settings.stockReport = Object.assign({
      enabled: true,
      reportTime: '16:45',
      countFrom: '16:00',
      requireCount: true,
      extraPhones: [],                 // more numbers that get the office summary
      sender: '',                      // Semaphore sender name (blank = Semaphore's default)
      minConnectors: 10,
      minCableMeters: 300,
      itemMins: {},                    // { 'NAP Box': 2, 'Fiber Cassette': 2 }
      lastSentDay: '',
    }, db.settings.stockReport || {});
    return db.settings.stockReport;
  };
  cfg();

  const techs = () => db.users.filter(u => u.role === 'tech');
  const usableReels = u => ((u.inv && u.inv.cables) || []).filter(r => r.state !== 'written_off' && r.state !== 'returning' && r.meters > REEL_EMPTY_M);
  const countableReels = u => ((u.inv && u.inv.cables) || []).filter(r => r.state !== 'written_off');

  /* Item minimums: the ones set in Settings, plus sensible defaults for NAP boxes
     and cassettes so they are watched from day one. */
  function itemMin(name) {
    const mins = cfg().itemMins || {};
    const key = Object.keys(mins).find(k => k.toLowerCase() === String(name).toLowerCase());
    if (key !== undefined) return Number(mins[key]) || 0;
    if (/nap/i.test(name)) return 1;
    if (/cassette/i.test(name)) return 1;
    return 0;
  }
  /* Every item name worth reporting: anything the office stocks or anyone holds. */
  function knownItems() {
    const names = new Map();
    ((db.warehouse && db.warehouse.items) || []).forEach(i => names.set(String(i.name).toLowerCase(), i.name));
    db.users.forEach(u => ((u.inv && u.inv.items) || []).forEach(i => names.set(String(i.name).toLowerCase(), i.name)));
    Object.keys(cfg().itemMins || {}).forEach(n => names.set(n.toLowerCase(), n));
    return [...names.values()];
  }

  /* What a technician has and what they are short of. */
  function stockOf(u) {
    const inv = u.inv || {};
    const reels = usableReels(u);
    const meters = round2(reels.reduce((a, r) => a + (Number(r.meters) || 0), 0));
    const items = knownItems().map(name => {
      const held = ((inv.items || []).find(i => String(i.name).toLowerCase() === name.toLowerCase()) || {}).qty || 0;
      return { name, qty: Number(held) || 0, min: itemMin(name) };
    }).filter(i => i.qty > 0 || i.min > 0);
    const needs = [];
    const c = cfg();
    if ((inv.connectors || 0) < c.minConnectors) needs.push(`FIC connectors (${inv.connectors || 0} left)`);
    if (meters < c.minCableMeters) needs.push(`fiber cable (${meters} m left)`);
    items.forEach(i => { if (i.min > 0 && i.qty < i.min) needs.push(`${i.name} (${i.qty} left)`); });
    return { connectors: inv.connectors || 0, meters, reels: reels.map(r => ({ code: r.code, name: r.name, meters: r.meters })), items, needs };
  }

  /* ---- counting ---- */
  const countFor = (u, day) => db.counts.find(c => c.techId === u.id && (c.days || [c.day]).includes(day));
  function pendingCountDay(u) {
    if (!cfg().requireCount || u.role !== 'tech') return null;
    const today = manilaDay();
    const lw = u.lastWorkDay;
    if (lw && lw < today && !countFor(u, lw)) return lw;
    return null;
  }
  function countOpenToday() { return hhmmNow() >= cfg().countFrom; }

  /* The sheet a technician fills in: what the system thinks they hold (shown only
     after they submit, so the count is a count and not a copy). */
  function sheetFor(u) {
    const inv = u.inv || {};
    return {
      connectors: true,
      reels: countableReels(u).map(r => ({ id: r.id, code: r.code, name: r.name, returning: r.state === 'returning' })),
      items: knownItems().map(name => ({ name })),
    };
  }

  function submitCount(u, body, by) {
    const today = manilaDay();
    const days = [];
    const missed = pendingCountDay(u);
    if (missed) days.push(missed);
    if (countOpenToday() && !countFor(u, today)) days.push(today);
    if (!days.length) throw Object.assign(new Error(`The end-of-day count opens at ${fmt12(cfg().countFrom)}.`), { code: 400 });
    const inv = u.inv || {};
    const num = v => (v === '' || v === null || v === undefined || isNaN(parseFloat(v))) ? null : Math.max(0, round2(v));
    const conn = num(body.connectors);
    if (conn === null) throw Object.assign(new Error('Enter how many FIC connectors you have (0 if none).'), { code: 400 });
    const reelsIn = body.reels || {};
    const itemsIn = body.items || {};
    const reels = countableReels(u).map(r => {
      const counted = num(reelsIn[r.id]);
      return { id: r.id, code: r.code, name: r.name, system: round2(r.meters), counted, diff: counted === null ? null : round2(counted - r.meters) };
    });
    if (reels.some(r => r.counted === null)) throw Object.assign(new Error('Enter the metres on every reel you hold (read the meter mark).'), { code: 400 });
    const items = knownItems().map(name => {
      const sys = Number(((inv.items || []).find(i => String(i.name).toLowerCase() === name.toLowerCase()) || {}).qty || 0);
      const counted = num(itemsIn[name]);
      return { name, system: sys, counted: counted === null ? 0 : counted, diff: (counted === null ? 0 : counted) - sys };
    });
    const connectors = { system: inv.connectors || 0, counted: conn, diff: conn - (inv.connectors || 0) };
    const diffs = [];
    if (connectors.diff) diffs.push(`FIC connectors: counted ${conn}, system ${connectors.system}`);
    reels.forEach(r => { if (Math.abs(r.diff) > READING_TOL_M) diffs.push(`Reel ${r.code}: counted ${r.counted} m, system ${r.system} m`); });
    items.forEach(i => { if (i.diff) diffs.push(`${i.name}: counted ${i.counted}, system ${i.system}`); });
    const rec = {
      id: 'cnt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      techId: u.id, techName: u.name, day: days[days.length - 1], days, at: Date.now(), by,
      connectors, reels, items, diffs, status: diffs.length ? 'diff' : 'ok', note: String(body.note || '').trim(),
    };
    db.counts.push(rec);
    if (db.counts.length > 5000) db.counts = db.counts.slice(-5000);
    saveDB();
    return rec;
  }

  /* Office decision on a count that did not match. */
  function reviewCount(id, action, me) {
    const c = db.counts.find(x => x.id === id);
    if (!c) throw Object.assign(new Error('Count not found'), { code: 404 });
    if (c.review) throw Object.assign(new Error('Already reviewed'), { code: 400 });
    const u = db.users.find(x => x.id === c.techId);
    if (action === 'accept') {
      if (!u) throw Object.assign(new Error('That technician no longer exists'), { code: 400 });
      u.inv = u.inv || { connectors: 0, cables: [], items: [] };
      if (c.connectors.diff) {
        logStock(u, 'connector', 'FIC Connector', c.connectors.diff, 0, 'count', me.name);
        u.inv.connectors = c.connectors.counted;
      }
      c.reels.forEach(rc => {
        const reel = (u.inv.cables || []).find(r => r.id === rc.id);
        if (!reel || Math.abs(rc.diff) <= READING_TOL_M) return;
        const expected = round2(reel.meters);
        reel.meters = rc.counted;
        if (rc.counted <= REEL_EMPTY_M && reel.state === 'open') reel.state = 'empty';
        if (rc.counted > REEL_EMPTY_M && reel.state === 'empty') reel.state = 'open';
        logReel(reel, 'reconciled', { techId: u.id, techName: u.name, expected, counted: rc.counted,
          variance: round2(rc.counted - expected), by: me.name, note: `End-of-day count ${c.day} accepted by the office` });
      });
      c.items.forEach(ic => {
        if (!ic.diff) return;
        u.inv.items = u.inv.items || [];
        let it = u.inv.items.find(i => String(i.name).toLowerCase() === ic.name.toLowerCase());
        if (!it) { it = { name: ic.name, qty: 0 }; u.inv.items.push(it); }
        logStock(u, 'item', ic.name, ic.diff, 0, 'count', me.name);
        it.qty = ic.counted;
        u.inv.items = u.inv.items.filter(i => i.qty > 0);
      });
    } else if (action !== 'dismiss') throw Object.assign(new Error('Unknown action'), { code: 400 });
    c.review = { action, by: me.name, at: Date.now() };
    saveDB();
    return c;
  }

  /* ---- report text ---- */
  function fmt12(hhmm) {
    const [h, m] = String(hhmm || '00:00').split(':').map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  }
  function techLine(u, today) {
    const s = stockOf(u);
    const parts = [`FIC ${s.connectors}`, `Fiber ${s.meters}m`];
    s.items.forEach(i => parts.push(`${i.name} ${i.qty}`));
    const cnt = countFor(u, today);
    const countTxt = cnt ? (cnt.status === 'ok' ? 'count OK' : `count DIFF (${cnt.diffs.length})`) : 'NOT COUNTED';
    return { s, parts, countTxt };
  }
  function techMessage(u, day) {
    const { s, parts, countTxt } = techLine(u, day);
    return `StarLine stock ${prettyDay(day)} - ${u.name}\n${parts.join(', ')}\n` +
      (s.needs.length ? `REQUEST: ${s.needs.join('; ')}\n` : 'Stock OK for tomorrow.\n') +
      `End-of-day ${countTxt === 'NOT COUNTED' ? 'count: NOT DONE yet - please count in the app.' : countTxt + '.'}`;
  }
  function officeMessage(day) {
    const lines = [`StarLine stock report ${prettyDay(day)} ${fmt12(cfg().reportTime)}`];
    techs().forEach(u => {
      const { s, countTxt } = techLine(u, day);
      lines.push(`${u.name}: ${s.needs.length ? 'NEEDS ' + s.needs.join(', ') : 'stock OK'} | ${countTxt}`);
    });
    const w = db.warehouse || {};
    const officeItems = (w.items || []).filter(i => i.qty > 0).map(i => `${i.name} ${i.qty}`);
    const fullReels = (w.cables || []).reduce((a, c) => a + (Number(c.qty) || 0), 0);
    lines.push(`Office: FIC ${w.connectors || 0}, reels ${fullReels}${(w.remnants || []).length ? ' +' + w.remnants.length + ' remnant' : ''}${officeItems.length ? ', ' + officeItems.join(', ') : ''}`);
    return lines.join('\n');
  }
  function preview(day) {
    day = day || manilaDay();
    const officeTo = officePhones();
    return {
      day, reportTime: cfg().reportTime,
      office: { to: officeTo, message: officeMessage(day) },
      techs: techs().map(u => ({ id: u.id, name: u.name, to: normalizePhone(u.phone), message: techMessage(u, day), stock: stockOf(u),
        count: countFor(u, day) || null, pending: pendingCountDay(u) })),
    };
  }
  function officePhones() {
    const set = new Set();
    db.users.filter(u => u.role === 'admin').forEach(u => { const p = normalizePhone(u.phone); if (p) set.add(p); });
    (cfg().extraPhones || []).forEach(p => { const n = normalizePhone(p); if (n) set.add(n); });
    return [...set];
  }

  /* ---- sending ---- */
  async function sms(number, message, kind) {
    const apikey = process.env.SEMAPHORE_API_KEY;
    const entry = { at: Date.now(), to: number, kind, message, status: 'failed', response: '' };
    db.smsLog.push(entry);
    if (db.smsLog.length > 300) db.smsLog = db.smsLog.slice(-300);
    if (!apikey) { entry.response = 'SEMAPHORE_API_KEY is not set on the ticketing service'; return false; }
    const body = new URLSearchParams({ apikey, number, message });
    const sender = cfg().sender || process.env.SEMAPHORE_SENDER || '';
    if (sender) body.set('sendername', sender);
    try {
      const r = await fetch('https://api.semaphore.co/api/v4/messages', { method: 'POST', body, signal: AbortSignal.timeout(20000) });
      const text = await r.text();
      entry.response = text.slice(0, 500);
      entry.status = r.ok && !/error|invalid/i.test(text.slice(0, 200)) ? 'sent' : 'failed';
      return entry.status === 'sent';
    } catch (e) { entry.response = e.message; return false; }
  }
  async function sendReport(day, by) {
    const p = preview(day);
    const out = { day: p.day, sent: 0, failed: 0, skipped: [] };
    for (const t of p.techs) {
      const u = db.users.find(x => x.id === t.id);
      if (!t.to) { out.skipped.push(`${t.name} (no mobile number)`); continue; }
      if (u && u.smsReport === false) { out.skipped.push(`${t.name} (turned off)`); continue; }
      (await sms(t.to, t.message, 'stock-tech')) ? out.sent++ : out.failed++;
    }
    if (!p.office.to.length) out.skipped.push('office summary (no admin mobile number set)');
    for (const n of p.office.to) (await sms(n, p.office.message, 'stock-office')) ? out.sent++ : out.failed++;
    console.log(`[stock] report ${p.day} by ${by}: ${out.sent} sent, ${out.failed} failed, skipped: ${out.skipped.join(', ') || 'none'}`);
    saveDB();
    return out;
  }

  /* Once a day at the report time — and never hours late after a restart. */
  setInterval(() => {
    const c = cfg();
    if (!c.enabled) return;
    const today = manilaDay(), now = hhmmNow();
    if (c.lastSentDay === today || now < c.reportTime) return;
    const [h, m] = c.reportTime.split(':').map(Number);
    const late = (parseInt(now.slice(0, 2), 10) * 60 + parseInt(now.slice(3), 10)) - (h * 60 + m);
    c.lastSentDay = today;            // mark first, so a slow send is not repeated
    saveDB();
    if (late > 120) { console.log(`[stock] ${today}: past ${c.reportTime} by ${late} min when the service started — today's report skipped`); return; }
    sendReport(today, 'schedule').catch(e => console.error('[stock] report failed:', e.message));
  }, 60000).unref?.();

  /* ---- HTTP ---- */
  async function routes(req, res, p, me, isAdmin, json, readBody) {
    if (p === '/api/stock/count-status' && req.method === 'GET') {
      const today = manilaDay();
      return json(res, 200, {
        today, countFrom: cfg().countFrom, open: countOpenToday(), required: cfg().requireCount,
        pendingDay: pendingCountDay(me), doneToday: !!countFor(me, today),
        sheet: me.role === 'tech' ? sheetFor(me) : null,
      });
    }
    if (p === '/api/stock/count' && req.method === 'POST') {
      const b = await readBody(req);
      let who = me;
      if (isAdmin && b.techId) who = db.users.find(u => u.id === b.techId);
      if (!who || who.role !== 'tech') return json(res, 400, { error: 'Only a technician\'s stock is counted.' });
      try {
        const rec = submitCount(who, b, me.name);
        return json(res, 200, { ok: true, count: rec });
      } catch (e) { return json(res, e.code || 500, { error: e.message }); }
    }
    if (!isAdmin) return false;
    if (p === '/api/stock/daily' && req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      const day = url.searchParams.get('day') || manilaDay();
      const review = db.counts.filter(c => c.status === 'diff' && !c.review).slice(-100).reverse();
      const recent = db.counts.slice(-60).reverse();
      return json(res, 200, { settings: cfg(), preview: preview(day), review, recent, smsLog: db.smsLog.slice(-40).reverse(),
        keySet: !!process.env.SEMAPHORE_API_KEY, items: knownItems().map(n => ({ name: n, min: itemMin(n) })) });
    }
    const rv = p.match(/^\/api\/stock\/counts\/([\w.]+)\/(accept|dismiss)$/);
    if (rv && req.method === 'POST') {
      try { return json(res, 200, { ok: true, count: reviewCount(rv[1], rv[2], me) }); }
      catch (e) { return json(res, e.code || 500, { error: e.message }); }
    }
    if (p === '/api/stock/send-now' && req.method === 'POST') {
      return json(res, 200, await sendReport(manilaDay(), me.name));
    }
    if (p === '/api/stock/settings' && req.method === 'POST') {
      const b = await readBody(req);
      const c = cfg();
      const hhmm = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : null;
      if (b.enabled !== undefined) c.enabled = !!b.enabled;
      if (b.requireCount !== undefined) c.requireCount = !!b.requireCount;
      if (hhmm(b.reportTime)) c.reportTime = b.reportTime;
      if (hhmm(b.countFrom)) c.countFrom = b.countFrom;
      if (b.minConnectors !== undefined) c.minConnectors = Math.max(0, parseInt(b.minConnectors, 10) || 0);
      if (b.minCableMeters !== undefined) c.minCableMeters = Math.max(0, parseInt(b.minCableMeters, 10) || 0);
      if (b.sender !== undefined) c.sender = String(b.sender || '').trim().slice(0, 11);
      if (Array.isArray(b.extraPhones)) c.extraPhones = b.extraPhones.map(normalizePhone).filter(Boolean);
      if (b.itemMins && typeof b.itemMins === 'object') {
        c.itemMins = {};
        Object.entries(b.itemMins).forEach(([k, v]) => { const n = String(k).trim(); if (n) c.itemMins[n] = Math.max(0, parseInt(v, 10) || 0); });
      }
      saveDB();
      return json(res, 200, { ok: true, settings: c });
    }
    const ph = p.match(/^\/api\/users\/([\w.]+)\/phone$/);
    if (ph && req.method === 'POST') {
      const b = await readBody(req);
      const u = db.users.find(x => x.id === ph[1]);
      if (!u) return json(res, 404, { error: 'User not found' });
      const raw = String(b.phone || '').trim();
      if (raw && !normalizePhone(raw)) return json(res, 400, { error: 'Enter a mobile number like 09171234567.' });
      u.phone = raw ? normalizePhone(raw) : '';
      if (b.smsReport !== undefined) u.smsReport = !!b.smsReport;
      saveDB();
      return json(res, 200, { ok: true, phone: u.phone });
    }
    return false;
  }

  return { routes, pendingCountDay, manilaDay, preview, sendReport };
};
