'use strict';
/* Связь с сервером Marginly.
   Данные лежат на устройстве (localStorage), правки копятся в очереди и уходят на сервер
   при каждом изменении, раз в 30 секунд и при возвращении в приложение. Без сети всё работает,
   синхронизация догонит позже. */

const SESSION_KEY = 'mg:session';

function loadSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { return null; } }
function saveSession(s) { try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch { /* приватный режим */ } }

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; this.user = true; }
}

async function http(path, { method = 'GET', body, token, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(API_BASE + path, { method, headers, body: form || (body !== undefined ? JSON.stringify(body) : undefined) });
  } catch {
    throw new HttpError(0, 'Нет связи с сервером. Проверь интернет');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    let msg = data?.detail || `Ошибка сервера (${res.status})`;
    if (Array.isArray(msg)) msg = 'Проверь заполненные поля';
    throw new HttpError(res.status, msg);
  }
  return data;
}

function makeSyncDb({ token, email, onPlan, onRejected, onStatus, onAuthLost }) {
  const key = 'mg:data:' + email.toLowerCase();
  const load = () => { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } };
  const st = load();
  const docs = new Map(Object.entries(st.docs || {}));
  let shadow = st.shadow || {};        // последнее состояние на сервере
  let pending = st.pending || {};      // path → {data, v}
  let cursor = st.cursor || 0;
  let ver = Math.max(0, ...Object.values(pending).map((p) => p.v));
  const subs = new Set();
  let timer = null, running = false, again = false, backoff = 2000;

  const persist = () => {
    try { localStorage.setItem(key, JSON.stringify({ docs: Object.fromEntries(docs), shadow, pending, cursor })); }
    catch { onStatus?.('full'); }
  };
  const notify = () => setTimeout(() => subs.forEach((f) => f()), 0);
  const snap = (path) => ({ id: path.split('/').pop(), exists: docs.has(path), data: () => docs.get(path), metadata: { fromCache: false, hasPendingWrites: path in pending } });
  const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function write(path, data) {
    if (data === null) docs.delete(path); else docs.set(path, JSON.parse(JSON.stringify(data)));
    pending[path] = { data: data === null ? null : docs.get(path), v: ++ver };
    persist(); notify(); schedule(600);
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(syncNow, ms); }

  async function syncNow() {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        const sent = Object.entries(pending).slice(0, 400).map(([path, p]) => ({ path, data: p.data, v: p.v }));
        const res = await http('/api/sync', { method: 'POST', token, body: { cursor, changes: sent.map(({ path, data }) => ({ path, data })) } });
        const rejected = new Map(res.rejected.map((r) => [r.path, r.reason]));
        for (const s of sent) if (pending[s.path]?.v === s.v) delete pending[s.path];
        for (const ch of res.changes) {
          if (ch.data === null) delete shadow[ch.path]; else shadow[ch.path] = ch.data;
          if (!pending[ch.path]) { if (ch.data === null) docs.delete(ch.path); else docs.set(ch.path, ch.data); }
        }
        for (const path of rejected.keys()) {
          if (pending[path]) continue;
          if (path in shadow) docs.set(path, shadow[path]); else docs.delete(path);
        }
        cursor = res.cursor;
        persist();
        onPlan?.(res.plan);
        if (rejected.size) onRejected?.([...new Set(rejected.values())]);
        notify();
        if (res.more || Object.keys(pending).length) again = true;
      } while (again);
      backoff = 2000;
      onStatus?.('online');
      schedule(30000);
    } catch (e) {
      if (e.status === 401) { onAuthLost?.(); return; }
      onStatus?.('offline');
      schedule(backoff);
      backoff = Math.min(backoff * 2, 60000);
    } finally {
      running = false;
    }
  }

  const docRef = (path) => ({
    id: path.split('/').pop(), path,
    get: async () => snap(path),
    set: async (d) => write(path, d),
    update: async (d) => write(path, { ...(docs.get(path) || {}), ...d }),
    delete: async () => write(path, null),
    onSnapshot: (next) => { const f = () => next(snap(path)); subs.add(f); setTimeout(f, 0); return () => subs.delete(f); },
  });
  const collRef = (c) => ({
    path: c,
    doc: (id) => docRef(`${c}/${id || rid()}`),
    onSnapshot: (next) => {
      const f = () => {
        const l = [...docs.keys()].filter((k) => k.startsWith(c + '/') && k.split('/').length === 2).map(snap);
        next({ docs: l, size: l.length, empty: !l.length, metadata: { fromCache: false, hasPendingWrites: false } });
      };
      subs.add(f); setTimeout(f, 0); return () => subs.delete(f);
    },
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(100); });
  window.addEventListener('online', () => schedule(100));

  return {
    doc: docRef, collection: collRef, syncNow,
    isEmpty: () => cursor === 0 && !docs.size,
    pendingCount: () => Object.keys(pending).length,
    wipe: () => { try { localStorage.removeItem(key); } catch { /* ничего */ } },
  };
}

function makeRemoteAssets(token) {
  return {
    upload: async (blob) => {
      const form = new FormData();
      form.append('file', blob, 'photo.jpg');
      return http('/api/blobs', { method: 'POST', token, form });
    },
    delete: async (id) => http('/api/blobs/' + encodeURIComponent(id), { method: 'DELETE', token }),
  };
}
