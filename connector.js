// WANTED connector: links the game to its own server.
// The game was built for claude.ai, where it asks the page for a live "room", a small
// name store and an owner check. This file answers those same calls using the WANTED server.
(() => {
  const get = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const put = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const drop = k => { try { localStorage.removeItem(k); } catch (e) {} };

  // a random player id kept in this browser (it owns your claimed name)
  let uid = get('wanted-uid');
  if (!uid || !/^[a-z0-9]{8,40}$/.test(uid)) {
    uid = 'u' + Array.from(crypto.getRandomValues(new Uint8Array(10)), b => b.toString(16).padStart(2, '0')).join('');
    put('wanted-uid', uid);
  }
  // owner login: open the game once with ?admin=YOURPASSWORD (it's remembered); ?logout forgets it
  const qs = new URLSearchParams(location.search);
  if (qs.has('admin')) { put('wanted-admin', qs.get('admin') || ''); history.replaceState(null, '', location.pathname); }
  if (qs.has('logout')) { drop('wanted-admin'); history.replaceState(null, '', location.pathname); }
  const adminPw = get('wanted-admin') || '';

  let ws = null, me = null, isAdmin = false, connected = false, rid = 0, raf = 0, dirty = true;
  let snap = Object.freeze([]);
  const pending = new Map(), peers = new Map(), topicH = {}, peerH = [], myPresence = {};
  let gotWelcome; const welcome = new Promise(r => { gotWelcome = r; });
  const wait = ms => new Promise(r => setTimeout(r, ms));

  function snapshot() {
    if (!dirty) return snap;
    dirty = false;
    snap = Object.freeze([...peers.values()].map(p => Object.freeze({
      peer: p.peer, by: p.by || null, isMe: p.peer === me, sameTab: p.peer === me, kind: 'viewer', guest: false,
      presence: Object.freeze({ ...(p.presence || {}) }), updatedAt: p.updatedAt || Date.now()
    })));
    return snap;
  }
  function notify() {
    dirty = true;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0; const s = snapshot();
      for (const h of peerH) { try { h({ peers: s, joined: [], left: [], updated: [] }); } catch (e) { console.error(e); } }
    });
  }
  const send = o => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const request = o => new Promise((res, rej) => {
    if (!connected) { rej({ code: 'unavailable', message: 'Not connected to the game server' }); return; }
    const id = ++rid; pending.set(id, { res, rej }); send({ ...o, rid: id });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej({ code: 'upstream_error', message: 'No answer from the game server' }); } }, 8000);
  });

  function handle(m) {
    if (m.t === 'welcome') {
      me = m.peer; isAdmin = !!m.admin; connected = true; peers.clear();
      for (const p of m.peers || []) peers.set(p.peer, { ...p, updatedAt: Date.now() });
      if (!peers.has(me)) peers.set(me, { peer: me, by: uid, presence: { ...myPresence } });
      if (Object.keys(myPresence).length) send({ t: 'presence', p: myPresence });
      gotWelcome(); notify(); return;
    }
    if (m.t === 'join' || m.t === 'pres') {
      const p = peers.get(m.peer) || { peer: m.peer };
      p.presence = m.presence || {}; p.updatedAt = Date.now(); if (m.by) p.by = m.by;
      peers.set(m.peer, p); notify(); return;
    }
    if (m.t === 'leave') { peers.delete(m.peer); notify(); return; }
    if (m.t === 'msg') {
      const hs = topicH[m.topic]; if (!hs) return;
      const msg = { topic: m.topic, data: m.data, peer: m.peer, by: m.by || null, isMe: m.peer === me, sameTab: m.peer === me, kind: 'viewer', guest: false };
      for (const h of hs.slice()) { try { h(msg); } catch (e) { console.error(e); } }
      return;
    }
    if (m.t === 'ack' || m.t === 'dbr') {
      const p = pending.get(m.rid); if (!p) return; pending.delete(m.rid);
      if (m.ok) p.res(m.result); else p.rej(m.result && m.result.code ? m.result : { code: m.code || 'not_permitted' });
    }
  }
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try { ws = new WebSocket(proto + '//' + location.host + '/ws'); } catch (e) { setTimeout(connect, 3000); return; }
    ws.onopen = () => send({ t: 'hello', uid, admin: adminPw });
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } handle(m); };
    ws.onclose = () => {
      connected = false; me = null; peers.clear(); notify();
      for (const [, p] of pending) p.rej({ code: 'unavailable' }); pending.clear();
      setTimeout(connect, 2000);
    };
  }
  connect();

  const ADMIN_ONLY = new Set(['admin', 'announce']);
  const room = {
    emit(topic, data) {
      if (ADMIN_ONLY.has(topic)) return isAdmin ? request({ t: 'emit', topic, data }).then(() => {}) : Promise.reject({ code: 'not_permitted' });
      send({ t: 'emit', topic, data }); return Promise.resolve();
    },
    on(topic, fn) { (topicH[topic] = topicH[topic] || []).push(fn); return () => { topicH[topic] = (topicH[topic] || []).filter(f => f !== fn); }; },
    presence(patch) {
      for (const [k, v] of Object.entries(patch || {})) { if (v === null) delete myPresence[k]; else myPresence[k] = v; }
      const p = me && peers.get(me); if (p) { p.presence = { ...myPresence }; dirty = true; }
      send({ t: 'presence', p: patch }); return Promise.resolve();
    },
    peers: () => snapshot(),
    onPeers(fn) { peerH.push(fn); setTimeout(() => { try { fn({ peers: snapshot(), joined: snapshot(), left: [], updated: [] }); } catch (e) {} }, 0); return () => { const i = peerH.indexOf(fn); if (i >= 0) peerH.splice(i, 1); }; },
    connected: () => connected
  };
  // a small query builder: collection('lb').orderBy(field, 'desc').limit(n).get()
  const query = (path, order, n) => ({
    orderBy: (f) => query(path, f, n), limit: (k) => query(path, order, k), where: () => query(path, order, n),
    doc: id => db.doc(path + '/' + id),
    get: () => request({ t: 'db', op: 'list', path, orderBy: order, limit: n }).then(r => {
      const docs = (r.docs || []).map(d => ({ id: d.id, exists: true, data: () => d.data, metadata: { fromCache: false, hasPendingWrites: false } }));
      return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
    })
  });
  const db = {
    collection: path => query(path, null, 50),
    doc(path) {
      const id = String(path).split('/').pop();
      return {
        id, path,
        get: () => request({ t: 'db', op: 'get', path }).then(r => ({ id, exists: !!r.exists, data: () => (r.exists ? r.data : undefined), metadata: { fromCache: false, hasPendingWrites: false } })),
        set: data => request({ t: 'db', op: 'set', path, data }).then(() => {}),
        delete: () => request({ t: 'db', op: 'delete', path }).then(() => {}),
        acquire: o => request({ t: 'db', op: 'acquire', path, ttlMs: o && o.ttlMs })
      };
    }
  };
  const user = {
    isOwner: async () => { await Promise.race([welcome, wait(6000)]); return isAdmin; },
    canEdit: async () => { await Promise.race([welcome, wait(6000)]); return isAdmin; },
    id: async () => uid
  };
  window.claude = {
    use: async name => {
      if (name === 'user') return user;
      if (name === 'room' || name === 'db') { await Promise.race([welcome, wait(6000)]); return name === 'room' ? room : db; }
      return null;
    }
  };
})();
