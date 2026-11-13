'use strict';
/* Хранилище и расчёты для версии на claude.ai.
   Повторяет серверное API (app/main.py), но данные лежат в db артефакта,
   а фото — в его assets. Расчёты — копия app/calc.py. */

const DEFAULTS = {
  cny_markup: 0.5, usd_rate: 89.5, cargo_usd_per_kg: 2.9, rf_delivery_rub: 2000,
  stale_days: 14, cny_cbr: 11.0, cny_cbr_date: '',
};
const COLLS = ['categories', 'batches', 'items', 'sales', 'expenses', 'photos'];
const S = { settings: {}, ready: false, failed: '' };
COLLS.forEach((c) => (S[c] = new Map()));
let DB = null;
let ASSETS = null;

const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
function nowIso() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
const todayIso = () => nowIso().slice(0, 10);
const parseTs = (s) => (s ? new Date(String(s).replace(' ', 'T')) : null);
function daysSince(ts) { const d = parseTs(ts); return d && !isNaN(d) ? Math.floor((Date.now() - d) / 86400000) : 0; }

class ApiError extends Error {}
const fail = (msg) => { throw new ApiError(msg); };

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

/* ───── расчёт партии (копия calc.py) ───── */
function calcBatch(p, items, sales, expenses) {
  const totalWeight = items.reduce((a, i) => a + Math.max(i.qty, 0) * Math.max(i.weight_kg, 0), 0);
  const has = totalWeight > 0;
  const cargo = totalWeight * p.cargo_usd_per_kg * p.usd_rate;
  const rf = has ? p.rf_delivery_rub : 0;
  const logistics = cargo + rf;
  const perKg = has ? logistics / totalWeight : 0;
  const active = sales.filter((s) => !s.returned);
  const byItem = {};
  active.forEach((s) => (byItem[s.item_id] ||= []).push(s));

  const calcs = {};
  let buyTotal = 0, plannedRevenue = 0, revenue = 0, soldCost = 0;
  const remainingPrices = [];
  for (const it of items) {
    const unitBuy = it.buy_cny * p.cny_rate;
    const unitLog = it.weight_kg * perKg;
    const unitCost = unitBuy + unitLog;
    const ss = byItem[it.id] || [];
    const sold = ss.reduce((a, s) => a + s.qty, 0);
    const itRevenue = ss.reduce((a, s) => a + s.price * s.qty - (s.extra_cost || 0), 0);
    const stock = Math.max(it.qty - sold - (it.reserved || 0), 0);
    const unsold = Math.max(it.qty - sold, 0);
    buyTotal += unitBuy * it.qty;
    plannedRevenue += it.sell_price * it.qty;
    revenue += itRevenue;
    soldCost += unitCost * sold;
    for (let k = 0; k < unsold; k++) remainingPrices.push(it.sell_price);
    const margin = it.sell_price - unitCost;
    calcs[it.id] = {
      qty: it.qty, weight_kg: it.weight_kg, total_weight_kg: r2(it.weight_kg * it.qty),
      unit_buy_rub: r2(unitBuy), unit_logistics_rub: r2(unitLog), unit_cost_rub: r2(unitCost),
      unit_margin_rub: r2(margin), margin_pct: it.sell_price ? r2((margin / it.sell_price) * 100) : 0,
      sold, reserved: it.reserved || 0, stock, revenue_rub: r2(itRevenue), profit_rub: r2(itRevenue - unitCost * sold),
    };
  }
  const totalCost = buyTotal + logistics + expenses;
  const plannedProfit = plannedRevenue - totalCost;
  const payback = revenue - totalCost;
  let breakeven = 0;
  if (payback < 0) {
    breakeven = null;
    let acc = 0;
    const sorted = remainingPrices.sort((a, b) => b - a);
    for (let n = 0; n < sorted.length; n++) { acc += sorted[n]; if (acc >= -payback - 1e-9) { breakeven = n + 1; break; } }
  }
  const unitsTotal = items.reduce((a, i) => a + i.qty, 0);
  const unitsSold = Object.values(calcs).reduce((a, c) => a + c.sold, 0);
  return {
    calc: {
      total_weight_kg: r2(totalWeight), cargo_rub: r2(cargo), rf_delivery_rub: r2(rf), logistics_rub: r2(logistics),
      logistics_per_kg_rub: r2(perKg), buy_rub: r2(buyTotal), expenses_rub: r2(expenses), total_cost_rub: r2(totalCost),
      units_total: unitsTotal, units_sold: unitsSold, units_left: Math.max(unitsTotal - unitsSold, 0),
      planned_revenue_rub: r2(plannedRevenue), planned_profit_rub: r2(plannedProfit), revenue_rub: r2(revenue),
      profit_rub: r2(revenue - soldCost - expenses), payback_rub: r2(payback),
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
const photoUrl = (p) => `/_blob/${p.asset_id}`;
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
    .map((i) => ({ ...i, reserved: i.reserved || 0, listed: !!i.listed, category: cats.get(i.category_id)?.name || null }));
  const ids = new Set(items.map((i) => i.id));
  const sales = list('sales').filter((s) => ids.has(s.item_id));
  const expenses = list('expenses').filter((e) => e.batch_id === id).sort((a, c) => (a.spent_at < c.spent_at ? 1 : -1));
  const res = calcBatch({ cny_rate: cnyRate, usd_rate: b.usd_rate, cargo_usd_per_kg: b.cargo_usd_per_kg, rf_delivery_rub: b.rf_delivery_rub },
    items, sales, expenses.reduce((a, e) => a + e.amount, 0));
  for (const i of items) {
    i.calc = res.items[i.id];
    i.photos = photosOf(i.id);
    i.batch_name = b.name;
    i.batch_status = b.status;
  }
  return { ...b, cny_rate: cnyRate, calc: res.calc, items, expenses, missing_buy_price: items.filter((i) => !(i.buy_cny > 0)).length };
}
const allBatches = () => list('batches').sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)).map((b) => batchFull(b.id));
function soldCount(itemId) { return list('sales').filter((s) => s.item_id === itemId && !s.returned).reduce((a, s) => a + s.qty, 0); }

/* ───── операции ───── */
const ops = {
  settings: () => settingsOut(),
  async saveSettings(body) {
    const next = { ...DEFAULTS, ...S.settings };
    for (const [k, v] of Object.entries(body)) if (v !== null && v !== undefined && k in DEFAULTS) next[k] = Number(v);
    if (body.cny_cbr != null) next.cny_cbr_date = `вручную ${todayIso()}`;
    S.settings = next;
    await DB.doc('app/settings').set(next);
    return settingsOut();
  },
  categories: () => list('categories').sort((a, b) => a.sort - b.sort || (a.id > b.id ? 1 : -1)),
  async addDefaultCategories() {
    const defs = [['Футболка', 0.3, 2000], ['Худи / свитшот', 0.8, 3000], ['Штаны', 0.6, 2500], ['Куртка / ветровка', 1.0, 3500],
      ['Пуховик', 1.5, 4000], ['Обувь (с коробкой)', 1.5, 4000], ['Аксессуары', 0.2, 1000]];
    let n = 0;
    for (const [name, weight_kg, default_price] of defs) await put('categories', newId('categories'), { name, weight_kg, default_price, sort: n++ });
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
    const items = list('items').filter((i) => i.batch_id === id);
    for (const i of items) await ops.delItem(i.id, true);
    for (const e of list('expenses').filter((e) => e.batch_id === id)) await del('expenses', e.id);
    await del('batches', id);
  },

  async createItem(batchId, b) {
    batchFull(batchId);
    const cat = b.category_id ? S.categories.get(b.category_id) : null;
    if (b.category_id && !cat) fail('Нет такого типа вещи');
    const weight = b.weight_kg || cat?.weight_kg;
    if (!weight) fail('Выбери тип вещи — по нему ставится вес');
    if (!b.title?.trim()) fail('Впиши название');
    if (!(b.qty >= 1)) fail('Количество — от 1 шт');
    await put('items', newId('items'), {
      batch_id: batchId, category_id: b.category_id || null, title: b.title.trim(), color: (b.color || '').trim(), size: (b.size || '').trim(),
      qty: Math.floor(b.qty), weight_kg: weight, buy_cny: b.buy_cny || 0,
      sell_price: b.sell_price ?? cat?.default_price ?? 0, reserved: 0, listed: !!b.listed, note: b.note || '', created_at: nowIso(),
    });
    return batchFull(batchId);
  },
  async saveItem(id, body) {
    const it = S.items.get(id);
    if (!it) fail('Товар не найден');
    const data = {};
    for (const [k, v] of Object.entries(body)) if (v !== null && v !== undefined) data[k] = v;
    if (data.category_id && data.category_id !== it.category_id && body.weight_kg == null) {
      const cat = S.categories.get(data.category_id);
      if (!cat) fail('Нет такого типа вещи');
      data.weight_kg = cat.weight_kg;
    }
    if (data.title !== undefined && !String(data.title).trim()) fail('Впиши название');
    if (data.weight_kg !== undefined && !(data.weight_kg > 0)) fail('Вес должен быть больше нуля');
    if (data.buy_cny !== undefined && data.buy_cny < 0) fail('Цена не может быть отрицательной');
    const qty = data.qty ?? it.qty;
    const sold = soldCount(id);
    if (qty < 1) fail('Количество — от 1 шт');
    if (qty < sold) fail(`Уже продано ${sold} шт — меньше нельзя`);
    if ((data.reserved ?? it.reserved ?? 0) < 0) fail('Бронь не может быть меньше нуля');
    if ((data.reserved ?? it.reserved ?? 0) > qty - sold) fail('Бронь больше, чем осталось');
    if ('listed' in data) data.listed = !!data.listed;
    await patch('items', id, data);
    return batchFull(it.batch_id);
  },
  async delItem(id, quiet) {
    const it = S.items.get(id);
    if (!it) return;
    for (const p of list('photos').filter((p) => p.item_id === id)) await ops.delPhoto(p.id);
    for (const s of list('sales').filter((s) => s.item_id === id)) await del('sales', s.id);
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
    if (!ASSETS) fail('Фото может добавлять только владелец страницы');
    for (const f of files) {
      const blob = await compress(f);
      let res;
      try { res = await ASSETS.upload(blob, { type: blob.type || 'image/jpeg' }); } catch (e) {
        fail(e?.code === 'too_large' ? 'Фото слишком большое' : e?.code === 'unsupported_type' ? 'Это не картинка (нужен JPG, PNG или WebP)' : 'Не получилось загрузить фото, попробуй ещё раз');
      }
      await put('photos', newId('photos'), { item_id: itemId, asset_id: res.id, created_at: nowIso() });
    }
    return photosOf(itemId);
  },
  async delPhoto(id) {
    const p = S.photos.get(id);
    if (!p) return;
    await del('photos', id);
    try { await ASSETS?.delete(p.asset_id); } catch { /* файл мог уже быть удалён */ }
  },

  async createSale(itemId, b) {
    const it = S.items.get(itemId);
    if (!it) fail('Товар не найден');
    const qty = Math.floor(b.qty || 0);
    if (qty < 1) fail('Сколько продал — от 1 шт');
    const free = it.qty - soldCount(itemId) - (it.reserved || 0);
    const available = free + (b.from_reserved ? it.reserved || 0 : 0);
    if (qty > available) fail(`В наличии только ${Math.max(available, 0)} шт`);
    if (b.from_reserved) await patch('items', itemId, { reserved: Math.max((it.reserved || 0) - qty, 0) });
    await put('sales', newId('sales'), {
      item_id: itemId, qty, price: b.price ?? it.sell_price, extra_cost: b.extra_cost || 0,
      sold_at: b.sold_at || nowIso(), channel: b.channel || 'Авито', note: b.note || '', returned: false,
    });
    return batchFull(it.batch_id);
  },
  sales() {
    const costs = {};
    for (const b of allBatches()) for (const i of b.items) costs[i.id] = i.calc.unit_cost_rub;
    return list('sales').map((s) => {
      const it = S.items.get(s.item_id) || {};
      const b = S.batches.get(it.batch_id) || {};
      const unit = costs[s.item_id] || 0;
      return { ...s, returned: !!s.returned, title: it.title, color: it.color, size: it.size, batch_id: it.batch_id, batch_name: b.name,
        unit_cost_rub: unit, profit_rub: s.returned ? 0 : r2(s.price * s.qty - (s.extra_cost || 0) - unit * s.qty) };
    }).sort((a, b) => (a.sold_at < b.sold_at ? 1 : a.sold_at > b.sold_at ? -1 : 0));
  },
  async saveSale(id, body) {
    const s = S.sales.get(id);
    if (!s) fail('Продажа не найдена');
    if (body.returned === false && s.returned) {
      const it = S.items.get(s.item_id);
      if (soldCount(s.item_id) + s.qty + (it.reserved || 0) > it.qty) fail('Этот товар уже продан повторно — отменить возврат нельзя');
    }
    await patch('sales', id, body);
  },
  delSale: (id) => del('sales', id),

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
    for (const sale of list('sales')) {
      if (sale.returned) continue;
      const d = parseTs(sale.sold_at); if (!d || isNaN(d)) continue;
      const idx = Math.floor((d - start) / (7 * 86400000));
      if (idx < 0 || idx > 7) continue;
      const net = sale.price * sale.qty - (sale.extra_cost || 0);
      weeks[idx].revenue += net;
      weeks[idx].profit += net - (itemsById[sale.item_id]?.calc.unit_cost_rub || 0) * sale.qty;
      weeks[idx].units += sale.qty;
    }
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
      missing_buy_price: batches.reduce((a, b) => a + b.missing_buy_price, 0),
      weeks: weeks.map((w) => ({ ...w, revenue: r2(w.revenue), profit: r2(w.profit) })), top, stale,
      batches: batches.map((b) => ({ id: b.id, name: b.name, status: b.status, missing_buy_price: b.missing_buy_price, ...b.calc })),
    };
  },
};

/* Обёртка: любая ошибка хранилища превращается в понятное сообщение. */
async function api(name, ...args) {
  if (!DB) throw new Error(S.failed || 'Хранилище ещё загружается');
  try { return await ops[name](...args); } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e?.code === 'quota_exceeded') throw new Error('Место в хранилище закончилось — удали старые фото или партии');
    if (e?.code === 'invalid_argument') throw new Error('Сохранять может только владелец страницы');
    throw new Error('Не получилось сохранить, попробуй ещё раз');
  }
}

/* ───── подключение к db ───── */
function connectStore(onChange) {
  const pending = new Set(['settings', ...COLLS]);
  const done = (k, fromCache) => { if (!fromCache) pending.delete(k); if (!pending.size && !S.ready) { S.ready = true; clearTimeout(timer); } onChange(); };
  const timer = setTimeout(() => { if (!S.ready) { S.failed = 'Данные долго не загружаются. Проверь интернет.'; onChange(); } }, 10000);
  const onErr = (e) => { S.failed = e?.code === 'revoked' ? 'Доступ к данным закрыт' : 'Связь с хранилищем потеряна. Обнови страницу.'; onChange(); };
  DB.doc('app/settings').onSnapshot((snap) => { S.settings = snap.exists ? { ...snap.data() } : {}; done('settings', snap.metadata.fromCache); }, onErr);
  for (const c of COLLS) {
    DB.collection(c).onSnapshot((snap) => {
      S[c] = new Map(snap.docs.map((d) => [d.id, { ...d.data(), id: d.id }]));
      done(c, snap.metadata.fromCache);
    }, onErr);
  }
}
