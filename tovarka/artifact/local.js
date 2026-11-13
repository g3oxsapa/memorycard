'use strict';
/* Хранилище для Android-приложения: всё лежит в памяти телефона.
   window.Android — мост в MainActivity.java: файл данных, папка фото и запрос курса ЦБ. */

function makeLocalDb(bridge, seed) {
  let raw = {};
  try { raw = JSON.parse(bridge.loadAll() || '{}'); } catch { raw = {}; }
  const docs = new Map(Object.entries(raw));
  if (!docs.size && seed) { for (const [k, v] of Object.entries(seed)) docs.set(k, v); }
  const subs = new Set();
  const persist = () => {
    if (!bridge.saveAll(JSON.stringify(Object.fromEntries(docs)))) throw { code: 'unavailable', message: 'save failed' };
  };
  if (!raw || !Object.keys(raw).length) persist();
  const notify = () => setTimeout(() => subs.forEach((f) => f()), 0);
  const snap = (path) => ({ id: path.split('/').pop(), exists: docs.has(path), data: () => docs.get(path), metadata: { fromCache: false, hasPendingWrites: false } });
  const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const docRef = (path) => ({
    id: path.split('/').pop(), path,
    get: async () => snap(path),
    set: async (d) => { docs.set(path, JSON.parse(JSON.stringify(d))); persist(); notify(); },
    update: async (d) => { docs.set(path, { ...(docs.get(path) || {}), ...JSON.parse(JSON.stringify(d)) }); persist(); notify(); },
    delete: async () => { docs.delete(path); persist(); notify(); },
    onSnapshot: (next) => { const f = () => next(snap(path)); subs.add(f); setTimeout(f, 0); return () => subs.delete(f); },
  });
  const collRef = (c) => ({
    path: c,
    doc: (id) => docRef(`${c}/${id || rid()}`),
    onSnapshot: (next) => {
      const f = () => {
        const list = [...docs.keys()].filter((k) => k.startsWith(c + '/') && k.split('/').length === 2).map(snap);
        next({ docs: list, size: list.length, empty: !list.length, metadata: { fromCache: false, hasPendingWrites: false } });
      };
      subs.add(f); setTimeout(f, 0); return () => subs.delete(f);
    },
  });
  return { doc: docRef, collection: collRef };
}

function makeLocalAssets(bridge) {
  const toBase64 = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  return {
    upload: async (blob) => {
      const id = bridge.savePhoto(await toBase64(blob));
      if (!id) throw { code: 'upstream_error', message: 'photo not saved' };
      return { id, url: '/_blob/' + id, sizeBytes: blob.size, contentType: 'image/jpeg' };
    },
    delete: async (id) => ({ deleted: !!bridge.deletePhoto(String(id)) }),
  };
}

/* Курс юаня ЦБ: запрос делает Java-часть (у WebView нет ограничений CORS там). */
async function refreshCbrRate(bridge, { quiet } = {}) {
  let res;
  try { res = JSON.parse(bridge.fetchCbr() || '{}'); } catch { res = {}; }
  if (!(res.rate > 0)) { if (!quiet) throw new Error('Не удалось получить курс ЦБ. Проверь интернет.'); return null; }
  const cur = { ...DEFAULTS, ...S.settings };
  if (Math.abs(cur.cny_cbr - res.rate) < 0.00005 && cur.cny_cbr_date === res.date) return res;
  const next = { ...cur, cny_cbr: res.rate, cny_cbr_date: res.date };
  S.settings = next;
  await DB.doc('app/settings').set(next);
  return res;
}
