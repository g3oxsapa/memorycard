'use strict';
/* Данные и расчёты Marginly. Хранилище — DB (см. sync.js), фото — ASSETS.
   Заказы: ordered → shipped → sold, или cancelled / returned (restock | writeoff). */

const DEFAULTS = {
  cny_markup: 0.5, usd_rate: 89.5, cargo_usd_per_kg: 2.9, rf_delivery_rub: 2000,
  stale_days: 14, cny_cbr: 12.3, cny_cbr_date: '',
};
const DEFAULT_CATEGORIES = [
  ['Футболка', 0.3, 2000], ['Худи / свитшот', 0.8, 3000], ['Штаны', 0.6, 2500], ['Куртка / ветровка', 1.0, 3500],
  ['Пуховик', 1.5, 4000], ['Обувь (с коробкой)', 1.5, 4000], ['Аксессуары', 0.2, 1000],
];
const COLLS = ['categories', 'batches', 'items', 'orders', 'expenses', 'photos'];
const STATUS = {
  ordered: 'Заказан', shipped: 'Отправлен', sold: 'Продан', cancelled: 'Отменён', returned: 'Возврат',
};
const S = { settings: {}, ready: false, failed: '', plan: null, email: '' };
COLLS.forEach((c) => (S[c] = new Map()));
let DB = null;
let ASSETS = null;
let API_BASE = '';

const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
function nowIso() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
const todayIso = () => nowIso().slice(0, 10);
const parseTs = (s) => (s ? new Date(String(s).replace(' ', 'T')) : null);
function daysSince(ts) { const d = parseTs(ts); return d && !isNaN(d) ? Math.floor((Date.now() - d) / 86400000) : 0; }

class ApiError extends Error {}
const fail = (msg) => { throw new ApiError(msg); };

/* ───── состояние заказа ───── */
const holdsStock = (o) => ['ordered', 'shipped', 'sold'].includes(o.status) || (o.status === 'returned' && o.return_action === 'writeoff');
const isOpen = (o) => o.status === 'ordered' || o.status === 'shipped';

/* ───── запись ───── */
function clean(o) { const { id, ...rest } = o; return rest; }
async function put(coll, id, data) {
  const body = clean(data);
  S[coll].set(id, { ...body, id });
  await DB.collection(coll).doc(id).set(body);
}
async function patch(coll, id, data) {
  const cur = S[coll].get(id);
  if (!cur) fail('Запись не найдена');
  await put(coll, id, { ...cur, ...data });
}
async function del(coll, id) { S[coll].delete(id); await DB.collection(coll).doc(id).delete(); }
const newId = (coll) => DB.collection(coll).doc().id;
const list = (coll) => [...S[coll].values()];

/* ───── расчёт партии ───── */
function calcBatch(p, items, orders, expenses) {
  const totalWeight = items.reduce((a, i) => a + Math.max(i.qty, 0) * Math.max(i.weight_kg, 0), 0);
  const has = totalWeight > 0;
  const cargo = totalWeight * p.cargo_usd_per_kg * p.usd_rate;
  const rf = has ? p.rf_delivery_rub : 0;
  const logistics = cargo + rf;
  const perKg = has ? logistics / totalWeight : 0;
  const byItem = {};
  orders.forEach((o) => (byItem[o.item_id] ||= []).push(o));

  const calcs = {};
  let buyTotal = 0, plannedRevenue = 0, revenue = 0, soldCost = 0, returnLoss = 0, returnExtra = 0, inTransit = 0;
  const remainingPrices = [];
  for (const it of items) {
    const unitBuy = it.buy_cny * p.cny_rate;
    const unitLog = it.weight_kg * perKg;
    const unitCost = unitBuy + unitLog;
    const os = byItem[it.id] || [];
    const sum = (f, pred) => os.filter(pred).reduce((a, o) => a + f(o), 0);
    const out = sum((o) => o.qty, holdsStock);
    const sold = sum((o) => o.qty, (o) => o.status === 'sold');
    const inOrders = sum((o) => o.qty, isOpen);
    const writtenOff = sum((o) => o.qty, (o) => o.status === 'returned' && o.return_action === 'writeoff');
    const itRevenue = sum((o) => o.price * o.qty - (o.extra_cost || 0), (o) => o.status === 'sold');
    const itReturnCost = sum((o) => o.extra_cost || 0, (o) => o.status === 'returned');
    const itTransit = sum((o) => o.price * o.qty, isOpen);
    const stock = Math.max(it.qty - out, 0);
    const unsold = Math.max(it.qty - sold - writtenOff, 0);
    const itLoss = itReturnCost + writtenOff * unitCost;

    buyTotal += unitBuy * it.qty;
    plannedRevenue += it.sell_price * it.qty;
    revenue += itRevenue;
    soldCost += unitCost * sold;
    returnLoss += itLoss;
    returnExtra += itReturnCost;
    inTransit += itTransit;
    for (let k = 0; k < unsold; k++) remainingPrices.push(it.sell_price);
    const margin = it.sell_price - unitCost;
    calcs[it.id] = {
      qty: it.qty, weight_kg: it.weight_kg, total_weight_kg: r2(it.weight_kg * it.qty),
      unit_buy_rub: r2(unitBuy), unit_logistics_rub: r2(unitLog), unit_cost_rub: r2(unitCost),
      unit_margin_rub: r2(margin), margin_pct: it.sell_price ? r2((margin / it.sell_price) * 100) : 0,
      sold, in_orders: inOrders, written_off: writtenOff, stock,
      revenue_rub: r2(itRevenue), profit_rub: r2(itRevenue - unitCost * sold - itLoss), in_transit_rub: r2(itTransit),
    };
  }
  const totalCost = buyTotal + logistics + expenses;
  const plannedProfit = plannedRevenue - totalCost;
  // окупаемость — живые деньги: получено минус всё потраченное (списанная вещь уже в закупке)
  const payback = revenue - returnExtra - totalCost;
  let breakeven = 0;
  if (payback < 0) {
    breakeven = null;
    let acc = 0;
    const sorted = remainingPrices.sort((a, b) => b - a);
    for (let n = 0; n < sorted.length; n++) { acc += sorted[n]; if (acc >= -payback - 1e-9) { breakeven = n + 1; break; } }
  }
  const unitsTotal = items.reduce((a, i) => a + i.qty, 0);
  const unitsSold = Object.values(calcs).reduce((a, c) => a + c.sold, 0);
  const unitsStock = Object.values(calcs).reduce((a, c) => a + c.stock, 0);
  return {
    calc: {
      total_weight_kg: r2(totalWeight), cargo_rub: r2(cargo), rf_delivery_rub: r2(rf), logistics_rub: r2(logistics),
      logistics_per_kg_rub: r2(perKg), buy_rub: r2(buyTotal), expenses_rub: r2(expenses), total_cost_rub: r2(totalCost),
      units_total: unitsTotal, units_sold: unitsSold, units_left: unitsStock,
      planned_revenue_rub: r2(plannedRevenue), planned_profit_rub: r2(plannedProfit), revenue_rub: r2(revenue),
      return_loss_rub: r2(returnLoss), in_transit_rub: r2(inTransit),
      profit_rub: r2(revenue - soldCost - returnLoss - expenses), payback_rub: r2(payback),
      roi_pct: totalCost ? r2((plannedProfit / totalCost) * 100) : 0, breakeven_units: breakeven,
    },
    items: calcs,
  };
}

/* ───── сборка данных для экрана ───── */
function settingsOut() {
  const s = { ...DEFAULTS, ...S.settings };
  return { ...s, cny_rate: r2(s.cny_cbr + s.cny_markup) };
}
const photoUrl = (p) => (p.url ? API_BASE + p.url : '');
function photosOf(itemId) {
  return list('photos').filter((p) => p.item_id === itemId).sort((a, b) => (a.created_at > b.created_at ? 1 : -1))
    .map((p) => ({ id: p.id, url: photoUrl(p) }));
}
function batchFull(id) {
  const raw = S.batches.get(id);
  if (!raw) fail('Партия не найдена');
  const b = { ...raw };
  const cnyRate = r2(b.cny_cbr + b.cny_markup);
  const cats = S.categories;
  const items = list('items').filter((i) => i.batch_id === id)
    .sort((a, b2) => (a.created_at === b2.created_at ? (a.id > b2.id ? 1 : -1) : a.created_at > b2.created_at ? 1 : -1))
    .map((i) => ({ ...i, listed: !!i.listed, category: cats.get(i.category_id)?.name || null }));
  const ids = new Set(items.map((i) => i.id));
  const orders = list('orders').filter((o) => ids.has(o.item_id));
  const expenses = list('expenses').filter((e) => e.batch_id === id).sort((a, c) => (a.spent_at < c.spent_at ? 1 : -1));
  const res = calcBatch({ cny_rate: cnyRate, usd_rate: b.usd_rate, cargo_usd_per_kg: b.cargo_usd_per_kg, rf_delivery_rub: b.rf_delivery_rub },
    items, orders, expenses.reduce((a, e) => a + e.amount, 0));
  for (const i of items) {
    i.calc = res.items[i.id];
    i.photos = photosOf(i.id);
    i.batch_name = b.name;
    i.batch_status = b.status;
  }
  return { ...b, cny_rate: cnyRate, calc: res.calc, items, expenses, missing_buy_price: items.filter((i) => !(i.buy_cny > 0)).length };
}
const allBatches = () => list('batches').sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)).map((b) => batchFull(b.id));
const outCount = (itemId) => list('orders').filter((o) => o.item_id === itemId && holdsStock(o)).reduce((a, o) => a + o.qty, 0);

/* ───── тариф ───── */
const planLimits = () => S.plan?.limits || null;
const canWrite = () => !S.plan || S.plan.can_write !== false;
function checkLimit(coll) {
  const lim = planLimits();
  if (!lim || !(coll in lim)) return;
  if (S[coll].size >= lim[coll]) {
    fail(coll === 'batches'
      ? `В пробный период — только ${lim.batches} партия. Оформи подписку, чтобы добавить ещё`
      : `В пробный период — до ${lim.items} товаров. Оформи подписку, чтобы добавить ещё`);
  }
}

/* ───── операции ───── */
const READ_OPS = new Set(['settings', 'categories', 'batches', 'batch', 'stock', 'orders', 'expenses', 'dashboard']);
const ops = {
  settings: () => settingsOut(),
  async saveSettings(body) {
    const next = { ...DEFAULTS, ...S.settings };
    for (const [k, v] of Object.entries(body)) if (v !== null && v !== undefined && k in DEFAULTS && k !== 'cny_cbr_date') next[k] = Number(v);
    if (body.cny_cbr != null) next.cny_cbr_date = `вручную ${todayIso()}`;
    S.settings = next;
    await DB.doc('app/settings').set(next);
    return settingsOut();
  },
  async setCbrRate(rate, date) {
    const cur = { ...DEFAULTS, ...S.settings };
    if (String(cur.cny_cbr_date).startsWith('вручную') && cur.cny_cbr_date.endsWith(todayIso())) return false;
    if (Math.abs(cur.cny_cbr - rate) < 0.00005 && cur.cny_cbr_date === date) return false;
    S.settings = { ...cur, cny_cbr: rate, cny_cbr_date: date };
    await DB.doc('app/settings').set(S.settings);
    return true;
  },
  categories: () => list('categories').sort((a, b) => a.sort - b.sort || (a.id > b.id ? 1 : -1)),
  async addDefaultCategories() {
    let n = 0;
    for (const [name, weight_kg, default_price] of DEFAULT_CATEGORIES) await put('categories', `c${n + 1}`, { name, weight_kg, default_price, sort: n++ });
  },
  async addCategory(b) {
    const sort = Math.max(0, ...list('categories').map((c) => c.sort || 0)) + 1;
    await put('categories', newId('categories'), { name: b.name.trim(), weight_kg: b.weight_kg, default_price: b.default_price || 0, sort });
  },
  async saveCategory(id, b) {
    if (!b.name?.trim()) fail('Впиши название типа');
    if (!(b.weight_kg > 0)) fail('Вес должен быть больше нуля');
    await patch('categories', id, { name: b.name.trim(), weight_kg: b.weight_kg, default_price: b.default_price || 0 });
  },
  delCategory: (id) => del('categories', id),

  batches: () => allBatches().map((b) => ({ ...b, items_count: b.items.length })),
  batch: (id) => batchFull(id),
  async createBatch(body) {
    checkLimit('batches');
    const s = settingsOut();
    const status = body.status || 'transit';
    const id = newId('batches');
    const pick = (k) => (body[k] === null || body[k] === undefined || body[k] === '' ? s[k] : Number(body[k]));
    await put('batches', id, {
      name: (body.name || '').trim() || `Партия №${S.batches.size + 1}`, status, created_at: nowIso(),
      received_at: status === 'received' ? nowIso() : null,
      cny_cbr: pick('cny_cbr'), cny_markup: pick('cny_markup'), usd_rate: pick('usd_rate'),
      cargo_usd_per_kg: pick('cargo_usd_per_kg'), rf_delivery_rub: pick('rf_delivery_rub'), note: body.note || '',
    });
    return batchFull(id);
  },
  async saveBatch(id, body) {
    const cur = S.batches.get(id);
    if (!cur) fail('Партия не найдена');
    const data = {};
    for (const k of ['name', 'status', 'note']) if (body[k] != null) data[k] = body[k];
    for (const k of ['cny_cbr', 'cny_markup', 'usd_rate', 'cargo_usd_per_kg', 'rf_delivery_rub']) if (body[k] != null) data[k] = Number(body[k]);
    if ('name' in data) data.name = data.name.trim() || cur.name;
    if (data.status === 'received' && !cur.received_at) data.received_at = nowIso();
    await patch('batches', id, data);
    return batchFull(id);
  },
  async delBatch(id) {
    for (const i of list('items').filter((i) => i.batch_id === id)) await ops.delItem(i.id, true);
    for (const e of list('expenses').filter((e) => e.batch_id === id)) await del('expenses', e.id);
    await del('batches', id);
  },

  async createItem(batchId, b) {
    batchFull(batchId);
    checkLimit('items');
    const cat = b.category_id ? S.categories.get(b.category_id) : null;
    if (b.category_id && !cat) fail('Нет такого типа вещи');
    const weight = b.weight_kg || cat?.weight_kg;
    if (!weight) fail('Выбери тип вещи — по нему ставится вес');
    if (!b.title?.trim()) fail('Впиши название');
    if (!(b.qty >= 1)) fail('Количество — от 1 шт');
    await put('items', newId('items'), {
      batch_id: batchId, category_id: b.category_id || null, title: b.title.trim(), color: (b.color || '').trim(), size: (b.size || '').trim(),
      qty: Math.floor(b.qty), weight_kg: weight, buy_cny: b.buy_cny || 0,
      sell_price: b.sell_price ?? cat?.default_price ?? 0, listed: !!b.listed, note: b.note || '', created_at: nowIso(),
    });
    return batchFull(batchId);
  },
  async saveItem(id, body) {
    const it = S.items.get(id);
    if (!it) fail('Товар не найден');
    const data = {};
    for (const [k, v] of Object.entries(body)) if (v !== null && v !== undefined && k !== 'reserved') data[k] = v;
    if (data.category_id && data.category_id !== it.category_id && body.weight_kg == null) {
      const cat = S.categories.get(data.category_id);
      if (!cat) fail('Нет такого типа вещи');
      data.weight_kg = cat.weight_kg;
    }
    if (data.title !== undefined && !String(data.title).trim()) fail('Впиши название');
    if (data.weight_kg !== undefined && !(data.weight_kg > 0)) fail('Вес должен быть больше нуля');
    if (data.buy_cny !== undefined && data.buy_cny < 0) fail('Цена не может быть отрицательной');
    const qty = data.qty ?? it.qty;
    const out = outCount(id);
    if (qty < 1) fail('Количество — от 1 шт');
    if (qty < out) fail(`${out} шт уже в заказах или проданы — меньше нельзя`);
    if ('listed' in data) data.listed = !!data.listed;
    await patch('items', id, data);
    return batchFull(it.batch_id);
  },
  async delItem(id, quiet) {
    const it = S.items.get(id);
    if (!it) return;
    for (const p of list('photos').filter((p) => p.item_id === id)) await ops.delPhoto(p.id);
    for (const o of list('orders').filter((o) => o.item_id === id)) await del('orders', o.id);
    await del('items', id);
    return quiet ? null : batchFull(it.batch_id);
  },
  stock() {
    const staleDays = settingsOut().stale_days;
    const out = [];
    for (const b of allBatches()) for (const i of b.items) {
      i.days_in_stock = b.status === 'received' ? daysSince(b.received_at) : 0;
      i.stale = b.status === 'received' && i.calc.stock > 0 && i.days_in_stock >= staleDays;
      out.push(i);
    }
    return out;
  },

  async uploadPhotos(itemId, files) {
    if (!ASSETS) fail('Фото сейчас недоступны');
    for (const f of files) {
      const blob = await compress(f);
      const res = await ASSETS.upload(blob);
      await put('photos', newId('photos'), { item_id: itemId, asset_id: res.id, url: res.url, created_at: nowIso() });
    }
    return photosOf(itemId);
  },
  async delPhoto(id) {
    const p = S.photos.get(id);
    if (!p) return;
    await del('photos', id);
    try { await ASSETS?.delete(p.asset_id); } catch { /* удалим при следующей возможности */ }
  },

  /* ── заказы ── */
  async createOrder(itemId, b) {
    const it = S.items.get(itemId);
    if (!it) fail('Товар не найден');
    const qty = Math.floor(b.qty || 0);
    if (qty < 1) fail('Количество — от 1 шт');
    const free = it.qty - outCount(itemId);
    if (qty > free) fail(`В наличии только ${Math.max(free, 0)} шт`);
    const status = b.status === 'sold' ? 'sold' : 'ordered';
    const ts = b.date || nowIso();
    const id = newId('orders');
    await put('orders', id, {
      item_id: itemId, qty, price: b.price ?? it.sell_price, extra_cost: b.extra_cost || 0, status, return_action: null,
      track: (b.track || '').trim(), buyer: (b.buyer || '').trim(), note: b.note || '', channel: b.channel || 'Авито',
      created_at: ts, shipped_at: null, sold_at: status === 'sold' ? ts : null, closed_at: status === 'sold' ? ts : null,
    });
    return { id, batch: batchFull(it.batch_id) };
  },
  async setOrderStatus(id, status, extra = {}) {
    const o = S.orders.get(id);
    if (!o) fail('Заказ не найден');
    const allowed = { ordered: ['shipped', 'sold', 'cancelled'], shipped: ['sold', 'cancelled', 'returned'], sold: ['returned'], returned: [], cancelled: [] };
    if (!allowed[o.status]?.includes(status)) fail(`Из статуса «${STATUS[o.status]}» нельзя перейти в «${STATUS[status]}»`);
    const ts = nowIso();
    const data = { status };
    if (status === 'shipped') { data.shipped_at = ts; if (extra.track != null) data.track = String(extra.track).trim(); }
    if (status === 'sold') { data.sold_at = ts; data.closed_at = ts; }
    if (status === 'cancelled') data.closed_at = ts;
    if (status === 'returned') {
      if (!['restock', 'writeoff'].includes(extra.return_action)) fail('Выбери, что делать с вещью: вернуть на склад или списать');
      data.return_action = extra.return_action;
      data.closed_at = ts;
    }
    await patch('orders', id, data);
  },
  async undoOrderStatus(id, prev) { await put('orders', id, prev); },
  async saveOrder(id, body) {
    const data = {};
    for (const k of ['price', 'extra_cost']) if (body[k] != null) { if (body[k] < 0) fail('Сумма не может быть отрицательной'); data[k] = Number(body[k]); }
    for (const k of ['track', 'buyer', 'note']) if (body[k] != null) data[k] = String(body[k]).trim();
    await patch('orders', id, data);
  },
  delOrder: (id) => del('orders', id),
  orders() {
    const costs = {};
    for (const b of allBatches()) for (const i of b.items) costs[i.id] = i.calc.unit_cost_rub;
    return list('orders').map((o) => {
      const it = S.items.get(o.item_id) || {};
      const b = S.batches.get(it.batch_id) || {};
      const unit = costs[o.item_id] || 0;
      let profit = null;
      if (o.status === 'sold') profit = r2(o.price * o.qty - (o.extra_cost || 0) - unit * o.qty);
      if (o.status === 'returned') profit = -r2((o.extra_cost || 0) + (o.return_action === 'writeoff' ? unit * o.qty : 0));
      return { ...o, title: it.title, color: it.color, size: it.size, batch_id: it.batch_id, batch_name: b.name,
        photo: photosOf(o.item_id)[0]?.url || null, sell_price: it.sell_price, unit_cost_rub: unit, profit_rub: profit };
    }).sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  },

  expenses: () => list('expenses').map((e) => ({ ...e, batch_name: S.batches.get(e.batch_id)?.name || null })).sort((a, b) => (a.spent_at < b.spent_at ? 1 : -1)),
  async addExpense(b) {
    if (!b.title?.trim()) fail('Впиши, на что расход');
    if (!(b.amount > 0)) fail('Сумма должна быть больше нуля');
    await put('expenses', newId('expenses'), { batch_id: b.batch_id || null, title: b.title.trim(), amount: b.amount, spent_at: b.spent_at || nowIso() });
  },
  delExpense: (id) => del('expenses', id),

  dashboard() {
    const s = settingsOut();
    const batches = allBatches();
    const general = list('expenses').filter((e) => !e.batch_id).reduce((a, e) => a + e.amount, 0);
    const total = (k) => batches.reduce((a, b) => a + b.calc[k], 0);
    const invested = total('total_cost_rub') + general;
    const revenue = total('revenue_rub');
    const profit = total('profit_rub') - general;
    const planned = total('planned_profit_rub') - general;

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const start = new Date(today); start.setDate(start.getDate() - ((today.getDay() + 6) % 7) - 49);
    const weeks = Array.from({ length: 8 }, (_, n) => { const d = new Date(start); d.setDate(d.getDate() + n * 7); return { week: d, revenue: 0, profit: 0, units: 0 }; });
    const itemsById = {};
    batches.forEach((b) => b.items.forEach((i) => (itemsById[i.id] = i)));
    for (const o of list('orders')) {
      if (o.status !== 'sold') continue;
      const d = parseTs(o.sold_at || o.created_at); if (!d || isNaN(d)) continue;
      const idx = Math.floor((d - start) / (7 * 86400000));
      if (idx < 0 || idx > 7) continue;
      const net = o.price * o.qty - (o.extra_cost || 0);
      weeks[idx].revenue += net;
      weeks[idx].profit += net - (itemsById[o.item_id]?.calc.unit_cost_rub || 0) * o.qty;
      weeks[idx].units += o.qty;
    }
    const open = list('orders').filter(isOpen);
    const items = Object.values(itemsById);
    const top = items.filter((i) => i.calc.sold > 0)
      .map((i) => ({ id: i.id, title: i.title, color: i.color, sold: i.calc.sold, profit: i.calc.profit_rub }))
      .sort((a, b) => b.profit - a.profit).slice(0, 5);
    const stale = [];
    for (const b of batches) {
      if (b.status !== 'received') continue;
      const days = daysSince(b.received_at);
      if (days < s.stale_days) continue;
      for (const i of b.items) if (i.calc.stock > 0) stale.push({ id: i.id, title: i.title, color: i.color, stock: i.calc.stock, days, batch_id: b.id });
    }
    return {
      settings: s, invested_rub: r2(invested), revenue_rub: r2(revenue), profit_rub: r2(profit), planned_profit_rub: r2(planned),
      payback_rub: r2(revenue - invested), roi_pct: invested ? r2((planned / invested) * 100) : 0,
      units_total: total('units_total'), units_sold: total('units_sold'), units_left: total('units_left'),
      stock_value_rub: r2(items.reduce((a, i) => a + i.calc.stock * i.sell_price, 0)), general_expenses_rub: r2(general),
      open_orders: open.length, open_orders_rub: r2(open.reduce((a, o) => a + o.price * o.qty, 0)),
      shipped_orders: open.filter((o) => o.status === 'shipped').length,
      missing_buy_price: batches.reduce((a, b) => a + b.missing_buy_price, 0),
      weeks: weeks.map((w) => ({ ...w, revenue: r2(w.revenue), profit: r2(w.profit) })), top, stale,
      batches: batches.map((b) => ({ id: b.id, name: b.name, status: b.status, missing_buy_price: b.missing_buy_price, ...b.calc })),
    };
  },
};

/* Обёртка: проверка тарифа и понятные сообщения об ошибках. */
async function api(name, ...args) {
  if (!DB) throw new Error(S.failed || 'Данные ещё загружаются');
  if (!READ_OPS.has(name) && !canWrite()) throw new Error('Пробный период закончился. Оформи подписку, чтобы вносить изменения');
  try { return await ops[name](...args); } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e?.message && e.user) throw new Error(e.message);
    throw new Error('Не получилось сохранить, попробуй ещё раз');
  }
}

/* Подписка на данные: после каждого изменения — перерисовка. */
function connectStore(onChange) {
  DB.doc('app/settings').onSnapshot((snap) => { S.settings = snap.exists ? { ...snap.data() } : {}; onChange(); });
  for (const c of COLLS) {
    DB.collection(c).onSnapshot((snap) => {
      S[c] = new Map(snap.docs.map((d) => [d.id, { ...d.data(), id: d.id }]));
      onChange();
    });
  }
  S.ready = true;
}
