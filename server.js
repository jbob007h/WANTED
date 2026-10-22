// WANTED game server
// One small Node.js program, no extra packages needed:
//  - serves the game page (public/index.html)
//  - runs the live lobby over WebSockets (who's online, hits, knockouts, shots, explosions)
//  - keeps player names unique
//  - recognises the owner by a password you set (ADMIN_PASSWORD)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC = path.join(__dirname, 'public');

// ---------- tiny key/value store for names (saved to data.json) ----------
let store = {};
try { store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { store = {}; }
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { fs.writeFile(DATA_FILE, JSON.stringify(store), () => {}); }, 500);
}
const leases = new Map(); // path -> { holder, until }
const PATH_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}(\/[A-Za-z0-9_\-.~:@+]{1,200}){1,15}$/;
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const OWNER_NAME = 'judahpro5555';

// what a player may read and write
function dbAllowed(client, op, p) {
  const parts = p.split('/');
  if (parts.length % 2 !== 0) return false;                  // documents only
  if (parts[0] === 'names' && parts.length === 2) return true;
  if (parts[0] === 'build' && parts[1] === 'lobby' && parts.length === 2) return op === 'get' || client.admin; // owner's lobby builds: everyone reads, only the owner writes
  if (parts[0] === 'lb' && parts.length === 2) return op === 'get' || parts[1] === client.uid; // leaderboard: read anyone, write only your own row
  if (parts[0] === 'data' && parts[1] === 'users') return parts[2] === client.uid; // your own data only
  return false;
}

// ---------- static files ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/' || url === '') url = '/index.html';
  if (url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  const file = path.normalize(path.join(PUBLIC, url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); return; }
    if (file.endsWith('index.html')) {
      // link previews (Discord, iMessage...) need the full address of the thumbnail
      const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').replace(/[^A-Za-z0-9.:\-]/g, '');
      buf = Buffer.from(buf.toString('utf8').split('__ORIGIN__').join(proto + '://' + host), 'utf8');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
});

// ---------- WebSocket (written by hand so there's nothing to install) ----------
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function frame(text) {
  const payload = Buffer.from(text, 'utf8'), n = payload.length;
  let head;
  if (n < 126) { head = Buffer.alloc(2); head[1] = n; }
  else if (n < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  head[0] = 0x81; // FIN + text
  return Buffer.concat([head, payload]);
}
function control(op, data = Buffer.alloc(0)) { const h = Buffer.from([0x80 | op, data.length]); return Buffer.concat([h, data]); }

const clients = new Map(); // peer -> client
let nextPeer = 1;
const PUBLIC_TOPICS = new Set(['hit', 'ko', 'shot', 'proj', 'boom']);
const ADMIN_TOPICS = new Set(['admin', 'announce']);

function send(c, obj) { if (!c.closed) { try { c.sock.write(frame(JSON.stringify(obj))); } catch (e) {} } }
function broadcast(obj) { const f = frame(JSON.stringify(obj)); for (const c of clients.values()) if (c.ready && !c.closed) { try { c.sock.write(f); } catch (e) {} } }

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket' || !(req.url || '').startsWith('/ws')) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  const peer = 'p' + (nextPeer++).toString(36) + crypto.randomBytes(3).toString('hex');
  const c = { peer, sock, uid: null, admin: false, presence: {}, ready: false, closed: false, buf: Buffer.alloc(0), frag: [], budget: 80, alive: true };
  clients.set(peer, c);

  sock.on('data', chunk => {
    c.buf = Buffer.concat([c.buf, chunk]);
    if (c.buf.length > 1 << 20) { close(); return; }
    while (c.buf.length >= 2) {
      const b0 = c.buf[0], b1 = c.buf[1], fin = b0 & 0x80, op = b0 & 0x0f, masked = b1 & 0x80;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (c.buf.length < 10) return; len = Number(c.buf.readBigUInt64BE(2)); off = 10; }
      if (len > 65536) { close(); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (c.buf.length < need) return;
      let data = c.buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const m = c.buf.subarray(off, off + 4); data = Buffer.from(data); for (let i = 0; i < data.length; i++) data[i] ^= m[i & 3]; }
      c.buf = c.buf.subarray(need);
      if (op === 0x8) { close(); return; }
      if (op === 0x9) { try { sock.write(control(0xA, data)); } catch (e) {} continue; }
      if (op === 0xA) { c.alive = true; continue; }
      if (op === 0x1 || op === 0x0) {
        c.frag.push(data);
        if (fin) { const text = Buffer.concat(c.frag).toString('utf8'); c.frag = []; onMessage(c, text); }
      }
    }
  });
  const close = () => {
    if (c.closed) return; c.closed = true;
    try { sock.end(control(0x8)); } catch (e) {}
    clients.delete(peer);
    if (c.ready) broadcast({ t: 'leave', peer });
  };
  sock.on('close', close); sock.on('error', close);
});

// keep connections healthy (and the host awake while people are playing)
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) { try { c.sock.destroy(); } catch (e) {} continue; }
    c.alive = false; try { c.sock.write(control(0x9)); } catch (e) {}
  }
}, 25000);
// refill each player's message budget (about 60 messages a second, bursts up to 80)
setInterval(() => { for (const c of clients.values()) c.budget = Math.min(80, c.budget + 6); }, 100);

function onMessage(c, text) {
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  if (c.budget <= 0) return; c.budget--;

  if (m.t === 'hello' && !c.ready) {
    c.uid = typeof m.uid === 'string' && /^[a-z0-9]{8,40}$/.test(m.uid) ? m.uid : 'u' + crypto.randomBytes(8).toString('hex');
    c.admin = !!ADMIN_PASSWORD && typeof m.admin === 'string' && m.admin.length > 0 &&
      m.admin.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(m.admin), Buffer.from(ADMIN_PASSWORD));
    c.ready = true;
    send(c, { t: 'welcome', peer: c.peer, uid: c.uid, admin: c.admin,
      peers: [...clients.values()].filter(o => o.ready).map(o => ({ peer: o.peer, by: o.uid, presence: o.presence })) });
    broadcast({ t: 'join', peer: c.peer, by: c.uid, presence: c.presence });
    return;
  }
  if (!c.ready) return;

  if (m.t === 'presence' && m.p && typeof m.p === 'object') {
    const next = { ...c.presence };
    for (const [k, v] of Object.entries(m.p)) { if (v === null) delete next[k]; else next[k] = v; }
    if (JSON.stringify(next).length > 4096) return;
    c.presence = next;
    broadcast({ t: 'pres', peer: c.peer, presence: c.presence });
    return;
  }
  if (m.t === 'emit' && typeof m.topic === 'string') {
    const allowed = PUBLIC_TOPICS.has(m.topic) || (ADMIN_TOPICS.has(m.topic) && c.admin);
    if (!allowed) { if (m.rid) send(c, { t: 'ack', rid: m.rid, ok: false, code: 'not_permitted' }); return; }
    if (JSON.stringify(m.data ?? null).length > 4096) return;
    broadcast({ t: 'msg', topic: m.topic, data: m.data, peer: c.peer, by: c.uid });
    if (m.rid) send(c, { t: 'ack', rid: m.rid, ok: true });
    return;
  }
  // leaderboard list: every row in 'lb', best first, at most 100
  if (m.t === 'db' && m.op === 'list' && m.path === 'lb') {
    const field = ['bs', 'keys', 'kills', 'ws'].includes(m.orderBy) ? m.orderBy : 'bs';
    const n = Math.max(1, Math.min(100, +m.limit || 50));
    const docs = Object.keys(store).filter(k => k.startsWith('lb/')).map(k => ({ id: k.slice(3), data: store[k] }))
      .sort((a, b) => (Number(b.data[field]) || 0) - (Number(a.data[field]) || 0)).slice(0, n);
    send(c, { t: 'dbr', rid: m.rid, ok: true, result: { docs } });
    return;
  }
  if (m.t === 'db' && typeof m.path === 'string' && PATH_RE.test(m.path)) {
    const reply = (ok, result) => send(c, { t: 'dbr', rid: m.rid, ok, result });
    if (!dbAllowed(c, m.op, m.path)) { reply(false, { code: 'invalid_argument' }); return; }
    const p = m.path;
    if (m.op === 'get') { reply(true, p in store ? { exists: true, data: store[p] } : { exists: false }); return; }
    if (m.op === 'set') {
      if (!m.data || typeof m.data !== 'object' || JSON.stringify(m.data).length > (p === 'build/lobby' ? 60000 : 2048)) { reply(false, { code: 'invalid_argument' }); return; }
      if (p.startsWith('names/')) {
        // a name document always belongs to whoever wrote it, and the owner's name is reserved
        const key = p.slice(6), cur = store[p];
        if (cur && cur.uid && cur.uid !== c.uid) { reply(false, { code: 'taken' }); return; }
        if (key === OWNER_NAME && !c.admin) { reply(false, { code: 'reserved' }); return; }
        if (!NAME_RE.test(String(m.data.name || '')) || String(m.data.name).toLowerCase() !== key) { reply(false, { code: 'invalid_argument' }); return; }
        store[p] = { uid: c.uid, name: m.data.name, at: Date.now() };
      } else if (p.startsWith('lb/')) {
        // keep only the leaderboard fields; the server decides who is the owner
        const d = m.data, int = v => Math.max(0, Math.min(1e9, Math.floor(Number(v) || 0)));
        if (!NAME_RE.test(String(d.nm || ''))) { reply(false, { code: 'invalid_argument' }); return; }
        store[p] = { nm: String(d.nm), ws: int(d.ws), bs: int(d.bs), keys: c.admin ? 0 : int(d.keys), kills: int(d.kills), o: c.admin ? 1 : 0, at: Date.now() };
      } else store[p] = m.data;
      persist(); reply(true, {}); return;
    }
    if (m.op === 'delete') {
      if (p.startsWith('names/') && store[p] && store[p].uid !== c.uid) { reply(false, { code: 'invalid_argument' }); return; }
      delete store[p]; persist(); reply(true, {}); return;
    }
    if (m.op === 'acquire') {
      const now = Date.now(), l = leases.get(p), ttl = Math.min(30000, Math.max(500, +m.ttlMs || 5000));
      if (l && l.until > now && l.holder !== c.uid) { reply(true, { acquired: false }); return; }
      leases.set(p, { holder: c.uid, until: now + ttl }); reply(true, { acquired: true }); return;
    }
    reply(false, { code: 'invalid_argument' });
  }
}

server.listen(PORT, () => {
  console.log(`WANTED server running on port ${PORT}`);
  if (!ADMIN_PASSWORD) console.log('No ADMIN_PASSWORD set: nobody will have owner powers until you set one.');
});
