'use strict';

/* ───────────── утилиты ───────────── */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const rub = (v) => `${nf0.format(Math.round(v || 0))} ₽`;
const sgn = (v) => (v > 0.5 ? 'pos' : v < -0.5 ? 'neg' : '');
const rubS = (v) => `<span class="${sgn(v)}">${v > 0.5 ? '+' : ''}${rub(v)}</span>`;
const kg = (v) => `${nf2.format(v)} кг`;
const fmtDate = (s) => (s ? new Date(s.replace(' ', 'T')).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '');
const itemName = (i) => [i.title, i.color, i.size && `р. ${i.size}`].filter(Boolean).join(' · ');
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c; };

let toastTimer;
function toast(msg, action) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-btn'; b.textContent = action.label;
    b.onclick = async () => { t.hidden = true; clearTimeout(toastTimer); try { await action.run(); } catch (e) { toast(e.message); } };
    t.append(b);
  }
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), action ? 6000 : 2600);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

/* ───────────── окно-шторка ───────────── */
function openSheet(title, html, onMount) {
  $('#sheet-title').textContent = title;
  $('#sheet-body').innerHTML = html;
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
  onMount?.($('#sheet-body'));
  const first = $('#sheet-body [autofocus]');
  if (first && matchMedia('(min-width: 700px)').matches) first.focus();
}
function closeSheet() { $('#sheet').hidden = true; document.body.style.overflow = ''; }
$('#sheet').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSheet(); $('#lightbox').hidden = true; } });
function showPhoto(url) { const lb = $('#lightbox'); $('img', lb).src = url; lb.hidden = false; }
$('#lightbox').addEventListener('click', () => ($('#lightbox').hidden = true));

function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else if (el.type === 'number') o[el.name] = el.value === '' ? null : Number(el.value);
    else o[el.name] = el.value;
  }
  return o;
}

/* ───────────── фото: сжатие на устройстве ───────────── */
async function compress(file, max = 1600) {
  if (!file.type.startsWith('image/')) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return blob ? new File([blob], 'photo.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}
/* ───────────── роутер ───────────── */
const routes = [
  [/^$/, 'home', viewHome],
  [/^batches$/, 'batches', viewBatches],
  [/^batch-(.+)$/, 'batches', viewBatch],
  [/^stock$/, 'stock', viewStock],
  [/^reply$/, 'reply', viewReply],
  [/^sales$/, 'sales', viewSales],
  [/^options$/, 'options', viewSettings],
];
const view = $('#view');
let current = null;

async function render() {
  const path = location.hash.slice(1);
  if (!S.ready) {
    view.innerHTML = S.failed ? `<div class="empty"><b>Не получилось открыть данные</b>${esc(S.failed)}</div>`
      : '<div class="empty"><b>Загружаю твои партии…</b>Склад, продажи и фото подтягиваются из хранилища.</div>';
    return;
  }
  for (const [re, nav, fn] of routes) {
    const m = path.match(re);
    if (!m) continue;
    $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === nav));
    current = () => fn(...m.slice(1));
    try { await current(); } catch (e) { view.innerHTML = `<div class="empty"><b>Не получилось открыть</b>${esc(e.message)}<br><a href="#">На главную</a></div>`; }
    return;
  }
  location.hash = '';
}
const rerender = () => (current ? current().catch((e) => toast(e.message)) : render());
window.addEventListener('hashchange', () => { closeSheet(); window.scrollTo(0, 0); render(); });

let renderTimer;
function onStoreChange() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    const a = document.activeElement;
    if (a && view.contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) { a.addEventListener('blur', onStoreChange, { once: true }); return; }
    if (location.hash === '#reply' && current) return; // не мешаем, пока пишется ответ
    if (!current || !S.ready) render(); else rerender();
  }, 120);
}

function ask(msg, yes = 'Удалить') {
  return new Promise((resolve) => {
    openSheet('Точно?', `<p style="margin-top:0">${esc(msg)}</p><div class="row"><button class="danger" id="ask-yes">${esc(yes)}</button><button id="ask-no">Отмена</button></div>`, (el) => {
      $('#ask-yes', el).onclick = () => { closeSheet(); resolve(true); };
      $('#ask-no', el).onclick = () => { closeSheet(); resolve(false); };
    });
  });
}

/* ───────────── главная ───────────── */
async function viewHome() {
  const d = await api('dashboard');
  const s = d.settings;
  const paid = d.invested_rub > 0 ? Math.min(100, (d.revenue_rub / d.invested_rub) * 100) : 0;
  view.innerHTML = `
    <div class="page-head"><h1>Главная</h1>
      <span class="chip" title="Курс юаня для выкупа">¥ ${nf2.format(s.cny_cbr)} + ${nf2.format(s.cny_markup)} = <b>${nf2.format(s.cny_rate)} ₽</b></span></div>
    ${d.missing_buy_price ? `<div class="alert" style="margin-bottom:12px"><div>У ${d.missing_buy_price} ${plural(d.missing_buy_price, 'позиции', 'позиций', 'позиций')} не вбита цена выкупа в юанях — прибыль пока посчитана без неё. <a href="#batches">Вбить цены</a></div></div>` : ''}
    <div class="grid kpis">
      <div class="card kpi hero"><div class="label">Чистая прибыль с продаж</div><div class="value num">${rubS(d.profit_rub)}</div>
        <div class="hint">Если продашь всё по своим ценам — ${rubS(d.planned_profit_rub)} · ROI ${nf0.format(d.roi_pct)}%</div></div>
      <div class="card kpi"><div class="label">Вложено</div><div class="value num">${rub(d.invested_rub)}</div><div class="hint">выкуп + карго + доставка + расходы</div></div>
      <div class="card kpi"><div class="label">Получено</div><div class="value num">${rub(d.revenue_rub)}</div><div class="hint">${d.units_sold} шт продано</div></div>
      <div class="card kpi"><div class="label">${d.payback_rub >= 0 ? 'Отбито, в плюсе на' : 'До окупаемости'}</div><div class="value num ${d.payback_rub >= 0 ? 'pos' : ''}">${rub(Math.abs(d.payback_rub))}</div>
        <div class="progress"><div style="width:${paid}%"></div></div></div>
      <div class="card kpi"><div class="label">На складе</div><div class="value num">${d.units_left} шт</div><div class="hint">на ${rub(d.stock_value_rub)} по ценам продажи</div></div>
    </div>

    <div class="section"><h3>Продажи по неделям</h3><div class="card">${chart(d.weeks)}</div></div>

    <div class="section"><h3>Партии</h3>
      ${d.batches.length ? d.batches.map((b) => {
        const pct = b.total_cost_rub ? Math.min(100, (b.revenue_rub / b.total_cost_rub) * 100) : 0;
        return `<a class="card list-link" href="#batch-${b.id}">
          <div class="row"><b>${esc(b.name)}</b>${statusChip(b.status)}${b.missing_buy_price ? '<span class="chip warn">нет цен ¥</span>' : ''}<span class="spacer"></span><span class="num">${rubS(b.profit_rub)}</span></div>
          <div class="small muted" style="margin-top:4px">Продано ${b.units_sold} из ${b.units_total} · вложено ${rub(b.total_cost_rub)} · получено ${rub(b.revenue_rub)}
          ${b.payback_rub < 0 ? (b.breakeven_units != null ? ` · отбить: ещё ${b.breakeven_units} шт` : ' · не отбивается по текущим ценам') : ' · <span class="pos">отбита</span>'}</div>
          <div class="progress"><div style="width:${pct}%"></div></div></a>`;
      }).join('') : '<div class="card empty"><b>Партий пока нет</b><a href="#batches">Создать первую</a></div>'}
    </div>

    ${d.stale.length ? `<div class="section"><h3>Залежались (больше ${s.stale_days} дн.)</h3><div class="card">
      ${d.stale.map((i) => `<a class="row list-link" style="padding:4px 0" href="#batch-${i.batch_id}"><span>${esc(itemName(i))}</span><span class="spacer"></span><span class="chip warn">${i.stock} шт · ${i.days} дн.</span></a>`).join('')}
      <div class="small muted" style="margin-top:6px">Можно снизить цену или поднять объявление.</div></div></div>` : ''}

    ${d.top.length ? `<div class="section"><h3>Самые прибыльные</h3><div class="card">
      ${d.top.map((i, n) => `<div class="row" style="padding:4px 0"><span class="muted num">${n + 1}.</span><span>${esc(itemName(i))}</span><span class="spacer"></span><span class="small muted">${i.sold} шт</span><b class="num">${rubS(i.profit)}</b></div>`).join('')}
    </div></div>` : ''}`;
}

function chart(weeks) {
  const max = Math.max(1, ...weeks.map((w) => Math.max(w.revenue, w.profit)));
  const h = (v) => `${Math.max(0, (v / max) * 100)}%`;
  const cols = weeks.map((w) => {
    const label = new Date(w.week).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    return `<div class="col" title="Неделя с ${label}: выручка ${rub(w.revenue)}, прибыль ${rub(w.profit)}, ${w.units} шт">
      <div class="bars"><i style="height:${h(w.revenue)}"></i><i class="profit" style="height:${h(w.profit)}"></i></div>
      <span>${label}</span></div>`;
  }).join('');
  const empty = weeks.every((w) => !w.revenue);
  return `<div class="chart" role="img" aria-label="Выручка и прибыль по неделям">${cols}</div>
    <div class="legend"><span><i style="background:var(--ink)"></i>Выручка</span><span><i style="background:var(--tape)"></i>Прибыль</span>${empty ? '<span>· продаж пока нет</span>' : ''}</div>`;
}

const statusChip = (s) => (s === 'received' ? '<span class="chip ok">получена</span>' : '<span class="chip accent">в пути</span>');

/* ───────────── партии ───────────── */
async function viewBatches() {
  const list = await api('batches');
  view.innerHTML = `
    <div class="page-head"><h1>Партии</h1><button class="primary" id="new-batch">+ Новая партия</button></div>
    ${list.length ? list.map((b) => `
      <a class="card list-link" href="#batch-${b.id}">
        <div class="row"><b>${esc(b.name)}</b>${statusChip(b.status)}${b.missing_buy_price ? `<span class="chip warn">нет цен ¥ у ${b.missing_buy_price}</span>` : ''}<span class="spacer"></span><span class="small muted">${fmtDate(b.created_at)}</span></div>
        <div class="calc two small" style="margin-top:10px">
          <span class="k">Вещей</span><span class="v">${b.calc.units_total} шт · ${kg(b.calc.total_weight_kg)}</span>
          <span class="k">Вложено</span><span class="v">${rub(b.calc.total_cost_rub)}</span>
          <span class="k">Прибыль план</span><span class="v">${rubS(b.calc.planned_profit_rub)}</span>
          <span class="k">Прибыль факт</span><span class="v">${rubS(b.calc.profit_rub)}</span>
        </div></a>`).join('') : '<div class="card empty"><b>Партий пока нет</b>Создай партию, когда закажешь товар из Китая</div>'}`;
  $('#new-batch').onclick = () => batchForm();
}

async function batchForm(b) {
  const s = await api('settings');
  const v = b || { name: '', status: 'transit', note: '', cny_cbr: s.cny_cbr, cny_markup: s.cny_markup, usd_rate: s.usd_rate, cargo_usd_per_kg: s.cargo_usd_per_kg, rf_delivery_rub: s.rf_delivery_rub };
  openSheet(b ? 'Партия' : 'Новая партия', `
    <form id="bf">
      <label class="f"><span>Название</span><input name="name" value="${esc(v.name)}" placeholder="Например: Партия №2" autofocus></label>
      <label class="f"><span>Статус</span><select name="status"><option value="transit" ${v.status === 'transit' ? 'selected' : ''}>В пути</option><option value="received" ${v.status === 'received' ? 'selected' : ''}>Получена</option></select></label>
      <div class="f-row">
        <label class="f"><span>Юань ЦБ, ₽</span><input name="cny_cbr" type="number" step="0.0001" min="0" value="${v.cny_cbr}"></label>
        <label class="f"><span>Наценка к юаню, ₽</span><input name="cny_markup" type="number" step="0.01" value="${v.cny_markup}"></label>
      </div>
      <div class="f-row three">
        <label class="f"><span>Доллар карго, ₽</span><input name="usd_rate" type="number" step="0.01" min="0" value="${v.usd_rate}"></label>
        <label class="f"><span>Карго, $/кг</span><input name="cargo_usd_per_kg" type="number" step="0.01" min="0" value="${v.cargo_usd_per_kg}"></label>
        <label class="f"><span>Доставка РФ, ₽</span><input name="rf_delivery_rub" type="number" step="1" min="0" value="${v.rf_delivery_rub}"></label>
      </div>
      <p class="hint-line">Курсы запоминаются в партии и не меняются сами, чтобы старые расчёты не «плыли».${b && b.cny_cbr !== s.cny_cbr ? ` <a href="#" id="use-rate">Подставить сегодняшний курс ЦБ (${nf2.format(s.cny_cbr)})</a>` : ''}</p>
      <label class="f"><span>Заметка</span><textarea name="note" rows="2" placeholder="Трек-номер, у кого заказывал…">${esc(v.note)}</textarea></label>
      <button class="primary block">${b ? 'Сохранить' : 'Создать партию'}</button>
      ${b ? '<button type="button" class="danger block" id="del-batch" style="margin-top:8px">Удалить партию</button>' : ''}
    </form>`, (el) => {
    $('#bf', el).onsubmit = guard(async (e) => {
      e.preventDefault();
      const data = formData(e.target);
      const r = b ? await api('saveBatch', b.id, data) : await api('createBatch', data);
      closeSheet();
      if (b) rerender(); else location.hash = `#batch-${r.id}`;
    });
    $('#use-rate', el)?.addEventListener('click', (e) => { e.preventDefault(); $('[name=cny_cbr]', el).value = s.cny_cbr; e.target.remove(); });
    if (b) $('#del-batch', el).onclick = guard(async () => {
      if (!(await ask(`Удалить «${b.name}» вместе со всеми товарами, фото и продажами?`))) return batchForm(b);
      await api('delBatch', b.id);
      closeSheet(); location.hash = '#batches';
    });
  });
}

async function viewBatch(id) {
  const b = await api('batch', id);
  const c = b.calc;
  view.innerHTML = `
    <a class="back" href="#batches">‹ Партии</a>
    <div class="page-head"><div class="row"><h1>${esc(b.name)}</h1>${statusChip(b.status)}</div>
      <div class="row">${b.status === 'transit' ? '<button class="sm" id="recv">Пришла</button>' : ''}<button class="sm" id="edit-batch">Курсы и настройки</button></div></div>
    ${b.note ? `<p class="muted" style="margin-top:-8px">${esc(b.note)}</p>` : ''}
    ${b.missing_buy_price ? `<div class="alert" style="margin-bottom:12px">Вбей цену выкупа в юанях у ${b.missing_buy_price} ${plural(b.missing_buy_price, 'позиции', 'позиций', 'позиций')} — поле подсвечено ниже.</div>` : ''}

    <div class="card">
      <div class="calc two">
        <span class="k">Общий вес</span><span class="v">${kg(c.total_weight_kg)}</span>
        <span class="k">Карго (${nf2.format(b.cargo_usd_per_kg)} $/кг × ${nf2.format(b.usd_rate)} ₽)</span><span class="v">${rub(c.cargo_rub)}</span>
        <span class="k">Доставка по РФ</span><span class="v">${rub(c.rf_delivery_rub)}</span>
        <span class="k">Логистика на 1 кг</span><span class="v">${rub(c.logistics_per_kg_rub)}</span>
        <span class="k">Выкуп (¥ по ${nf2.format(b.cny_rate)} ₽)</span><span class="v">${rub(c.buy_rub)}</span>
        <span class="k">Прочие расходы</span><span class="v">${rub(c.expenses_rub)}</span>
        <span class="sep"></span>
        <span class="k strong">Всего вложено</span><span class="v strong">${rub(c.total_cost_rub)}</span>
        <span class="k strong">Выручка, если продать всё</span><span class="v strong">${rub(c.planned_revenue_rub)}</span>
        <span class="k strong">Прибыль план</span><span class="v strong">${rubS(c.planned_profit_rub)}</span>
        <span class="k">ROI план</span><span class="v">${nf0.format(c.roi_pct)}%</span>
        <span class="sep"></span>
        <span class="k">Продано</span><span class="v">${c.units_sold} из ${c.units_total} шт</span>
        <span class="k">Получено</span><span class="v">${rub(c.revenue_rub)}</span>
        <span class="k strong">Прибыль факт</span><span class="v strong">${rubS(c.profit_rub)}</span>
        <span class="k">${c.payback_rub >= 0 ? 'Партия отбита' : 'Чтобы отбить партию'}</span><span class="v">${c.payback_rub >= 0 ? `<span class="pos">в плюсе на ${rub(c.payback_rub)}</span>` : c.breakeven_units != null ? `ещё ${c.breakeven_units} шт` : '<span class="neg">не хватит товара</span>'}</span>
      </div>
    </div>

    <div class="section"><div class="row" style="margin-bottom:8px"><h3 style="margin:0">Товары</h3><span class="spacer"></span><button class="primary sm" id="add-item">+ Товар</button></div>
      ${b.items.length ? b.items.map(itemCard).join('') : '<div class="card empty"><b>Пока пусто</b>Добавь вещи из этой посылки</div>'}
    </div>

    <div class="section"><div class="row" style="margin-bottom:8px"><h3 style="margin:0">Прочие расходы партии</h3><span class="spacer"></span><button class="sm" id="add-exp">+ Расход</button></div>
      <div class="card">${b.expenses.length ? b.expenses.map((e) => `<div class="row" style="padding:3px 0"><span>${esc(e.title)}</span><span class="small muted">${fmtDate(e.spent_at)}</span><span class="spacer"></span><b class="num">${rub(e.amount)}</b><button class="icon-btn" data-del-exp="${e.id}" aria-label="Удалить">✕</button></div>`).join('')
        : '<span class="muted small">Упаковка, продвижение на Авито, комиссия посредника — всё, что не карго и не доставка.</span>'}</div>
    </div>`;

  $('#edit-batch').onclick = () => batchForm(b);
  $('#recv')?.addEventListener('click', guard(async () => { await api('saveBatch', id, { status: 'received' }); toast('Партия на складе'); rerender(); }));
  $('#add-item').onclick = () => itemForm(b);
  $('#add-exp').onclick = () => expenseForm(b.id);
  $$('[data-del-exp]').forEach((x) => (x.onclick = guard(async () => { await api('delExpense', x.dataset.delExp); rerender(); })));
  bindItemCards(b);
}

function itemCard(i) {
  const c = i.calc;
  const ph = i.photos[0];
  return `<div class="card item" data-item="${i.id}">
    <button class="thumb" data-photos="${i.id}" aria-label="Фото">${ph ? `<img src="${ph.url}" alt="" loading="lazy">` : 'нет<br>фото'}</button>
    <div>
      <div class="row"><span class="item-title">${esc(itemName(i))}</span>${i.photos.length > 1 ? `<span class="chip">${i.photos.length} фото</span>` : ''}</div>
      <div class="chips" style="margin-top:4px">
        <span class="chip">${esc(i.category || 'без типа')} · ${kg(i.weight_kg)}</span>
        <span class="chip ${c.stock ? 'ok' : ''}">в наличии ${c.stock} из ${i.qty}</span>
        ${c.reserved ? `<span class="chip accent">бронь ${c.reserved}</span>` : ''}
        ${c.sold ? `<span class="chip">продано ${c.sold}</span>` : ''}
      </div>
      <label class="yuan ${i.buy_cny > 0 ? '' : 'missing'}"><span class="small muted">Выкуп за 1 шт, ¥</span>
        <input type="number" inputmode="decimal" step="0.01" min="0" value="${i.buy_cny || ''}" placeholder="0" data-yuan="${i.id}"></label>
      <div class="item-meta">
        <div><span>Выкуп </span>${rub(c.unit_buy_rub)}</div>
        <div><span>Логистика </span>${rub(c.unit_logistics_rub)}</div>
        <div><span>Себестоимость </span><b>${rub(c.unit_cost_rub)}</b></div>
        <div><span>Продажа </span><b>${rub(i.sell_price)}</b></div>
        <div><span>С 1 шт </span>${rubS(c.unit_margin_rub)} <span>(${nf0.format(c.margin_pct)}%)</span></div>
        ${c.sold ? `<div><span>Заработано </span>${rubS(c.profit_rub)}</div>` : ''}
      </div>
      <div class="item-actions">
        <button class="sm primary" data-sell="${i.id}" ${c.stock + c.reserved ? '' : 'disabled'}>Продал</button>
        <button class="sm" data-photos="${i.id}">Фото</button>
        <button class="sm" data-edit="${i.id}">Изменить</button>
      </div>
    </div></div>`;
}

function bindItemCards(b) {
  const byId = Object.fromEntries(b.items.map((i) => [i.id, i]));
  $$('[data-yuan]').forEach((inp) => {
    inp.onchange = guard(async () => {
      await api('saveItem', inp.dataset.yuan, { buy_cny: Number(inp.value || 0) });
      toast('Цена выкупа сохранена'); rerender();
    });
    inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); };
  });
  $$('[data-sell]').forEach((x) => (x.onclick = () => sellForm(byId[x.dataset.sell])));
  $$('[data-photos]').forEach((x) => (x.onclick = () => photosSheet(byId[x.dataset.photos])));
  $$('[data-edit]').forEach((x) => (x.onclick = () => itemForm(b, byId[x.dataset.edit])));
}

async function itemForm(b, it) {
  const cats = await api('categories');
  const v = it || { category_id: cats.find((c) => c.name.startsWith('Худи'))?.id ?? cats[0]?.id, title: '', color: '', size: '', qty: 1, buy_cny: '', sell_price: '', note: '', reserved: 0 };
  const catOpts = cats.map((c) => `<option value="${c.id}" data-w="${c.weight_kg}" data-p="${c.default_price}" ${c.id === v.category_id ? 'selected' : ''}>${esc(c.name)} — ${nf2.format(c.weight_kg)} кг</option>`).join('');
  openSheet(it ? 'Товар' : 'Новый товар', `
    <form id="itf">
      <label class="f"><span>Тип вещи (по нему ставится вес)</span><select name="category_id">${catOpts}</select></label>
      <label class="f"><span>Название / модель</span><input name="title" required value="${esc(v.title)}" placeholder="Chrome Hearts Matty Boy" autofocus></label>
      <div class="f-row">
        <label class="f"><span>Цвет</span><input name="color" value="${esc(v.color)}" placeholder="серый"></label>
        <label class="f"><span>Размер</span><input name="size" value="${esc(v.size)}" placeholder="L"></label>
      </div>
      <div class="f-row three">
        <label class="f"><span>Кол-во, шт</span><input name="qty" type="number" min="1" step="1" required value="${v.qty}"></label>
        <label class="f"><span>Выкуп 1 шт, ¥</span><input name="buy_cny" type="number" inputmode="decimal" min="0" step="0.01" value="${v.buy_cny || ''}" placeholder="0"></label>
        <label class="f"><span>Продажа, ₽</span><input name="sell_price" type="number" min="0" step="1" value="${v.sell_price}"></label>
      </div>
      ${it ? `<div class="f-row">
        <label class="f"><span>Вес 1 шт, кг</span><input name="weight_kg" type="number" min="0.01" step="0.01" value="${it.weight_kg}"></label>
        <label class="f"><span>В брони, шт</span><input name="reserved" type="number" min="0" step="1" value="${it.reserved}"></label></div>` : ''}
      <p class="hint-line" id="w-hint"></p>
      <label class="check"><input type="checkbox" name="listed" ${it?.listed ? 'checked' : ''}> Выставлено на Авито</label>
      <label class="f"><span>Заметка</span><input name="note" value="${esc(v.note)}"></label>
      <button class="primary block">${it ? 'Сохранить' : 'Добавить'}</button>
      ${it ? '<button type="button" class="danger block" id="del-item" style="margin-top:8px">Удалить товар</button>' : ''}
    </form>`, (el) => {
    const sel = $('[name=category_id]', el), price = $('[name=sell_price]', el), hint = $('#w-hint', el);
    const upd = (setPrice) => {
      const o = sel.selectedOptions[0];
      if (!o) return;
      hint.textContent = it ? 'Если сменишь тип — вес поставится от нового типа.' : `Вес поставится автоматически: ${nf2.format(o.dataset.w)} кг за штуку.`;
      if (setPrice && (!price.value || !it)) price.value = o.dataset.p;
    };
    upd(!it);
    sel.onchange = () => {
      upd(true);
      const w = $('[name=weight_kg]', el); if (w) w.value = sel.selectedOptions[0].dataset.w;
    };
    $('#itf', el).onsubmit = guard(async (e) => {
      e.preventDefault();
      const d = formData(e.target);
      d.category_id = d.category_id || null;
      d.buy_cny = d.buy_cny ?? 0;
      if (it) await api('saveItem', it.id, d);
      else await api('createItem', b.id, d);
      closeSheet(); toast(it ? 'Сохранено' : 'Товар добавлен'); rerender();
    });
    if (it) $('#del-item', el).onclick = guard(async () => {
      if (!(await ask(`Удалить «${itemName(it)}» вместе с фото и продажами?`))) return itemForm(b, it);
      await api('delItem', it.id); closeSheet(); rerender();
    });
  });
}

function sellForm(i) {
  const c = i.calc;
  const today = todayIso();
  openSheet('Продажа', `
    <p style="margin-top:0"><b>${esc(itemName(i))}</b><br><span class="small muted">В наличии ${c.stock}${c.reserved ? `, в брони ${c.reserved}` : ''} · себестоимость ${rub(c.unit_cost_rub)}</span></p>
    <form id="sf">
      <div class="f-row">
        <label class="f"><span>Сколько, шт</span><input name="qty" type="number" min="1" max="${c.stock + c.reserved}" step="1" value="1" required></label>
        <label class="f"><span>Цена за 1 шт, ₽</span><input name="price" type="number" min="0" step="1" value="${i.sell_price}" required></label>
      </div>
      <div class="f-row">
        <label class="f"><span>Доп. расходы, ₽</span><input name="extra_cost" type="number" min="0" step="1" value="0"></label>
        <label class="f"><span>Дата</span><input name="sold_at" type="date" value="${today}"></label>
      </div>
      <p class="hint-line">Доп. расходы — например, доставку оплатил ты.</p>
      ${c.reserved ? `<label class="check"><input type="checkbox" name="from_reserved" ${c.stock ? '' : 'checked'}> Это из брони</label>` : ''}
      <p id="sell-profit" class="num" style="font-weight:600"></p>
      <button class="primary block">Записать продажу</button>
    </form>`, (el) => {
    const f = $('#sf', el);
    const calc = () => { const d = formData(f); $('#sell-profit', el).innerHTML = `Прибыль: ${rubS((d.price || 0) * (d.qty || 0) - (d.extra_cost || 0) - c.unit_cost_rub * (d.qty || 0))}`; };
    f.oninput = calc; calc();
    f.onsubmit = guard(async (e) => {
      e.preventDefault();
      const d = formData(f);
      d.sold_at = d.sold_at === today ? null : `${d.sold_at} 12:00:00`;
      await api('createSale', i.id, d);
      closeSheet(); toast('Продажа записана'); rerender();
    });
  });
}

function photosSheet(i) {
  const draw = (photos) => `
    <p class="small muted" style="margin-top:0">${esc(itemName(i))}</p>
    <div class="photos">
      ${photos.map((p) => `<div class="ph"><img src="${p.url}" alt="" data-full="${p.url}"><button data-del-photo="${p.id}" aria-label="Удалить фото">✕</button></div>`).join('')}
      ${ASSETS ? '<label class="add"><b>+</b>Добавить<input type="file" accept="image/*" multiple hidden id="ph-input"></label>' : ''}
    </div>
    <p class="hint-line" style="margin-top:12px">${ASSETS ? 'С телефона можно сразу снять на камеру. Фото сжимаются автоматически.' : 'Добавлять фото может только владелец страницы.'}</p>`;
  const mount = (el) => {
    if ($('#ph-input', el)) $('#ph-input', el).onchange = guard(async (e) => {
      const files = [...e.target.files]; if (!files.length) return;
      toast(`Загружаю ${files.length} фото…`);
      i.photos = await api('uploadPhotos', i.id, files);
      $('#sheet-body').innerHTML = draw(i.photos); mount($('#sheet-body')); toast('Фото добавлены'); rerender();
    });
    $$('[data-full]', el).forEach((img) => (img.onclick = () => showPhoto(img.dataset.full)));
    $$('[data-del-photo]', el).forEach((x) => (x.onclick = guard(async () => {
      const ok = await ask('Удалить это фото?');
      if (ok) { await api('delPhoto', x.dataset.delPhoto); i.photos = i.photos.filter((p) => String(p.id) !== x.dataset.delPhoto); rerender(); }
      photosSheet(i);
    })));
  };
  openSheet('Фото', draw(i.photos), mount);
}

async function expenseForm(batchId) {
  const batches = batchId ? [] : await api('batches');
  openSheet('Расход', `
    <form id="ef">
      <label class="f"><span>На что</span><input name="title" required placeholder="Продвижение на Авито" autofocus></label>
      <label class="f"><span>Сумма, ₽</span><input name="amount" type="number" min="1" step="1" required></label>
      ${batchId ? '' : `<label class="f"><span>Партия</span><select name="batch_id"><option value="">Общий расход (не к партии)</option>${batches.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></label>`}
      <button class="primary block">Добавить</button>
    </form>`, (el) => {
    $('#ef', el).onsubmit = guard(async (e) => {
      e.preventDefault();
      const d = formData(e.target);
      d.batch_id = batchId || d.batch_id || null;
      await api('addExpense', d);
      closeSheet(); toast('Расход добавлен'); rerender();
    });
  });
}

/* ───────────── склад ───────────── */
let stockFilter = 'in';
let stockQuery = '';
async function quickSell(i) {
  const fromReserved = i.calc.stock === 0 && i.calc.reserved > 0;
  const r = await api('createSale', i.id, { qty: 1, price: i.sell_price, extra_cost: 0, from_reserved: fromReserved });
  const reservedBefore = i.calc.reserved;
  toast(`Продано: ${itemName(i)} за ${rub(i.sell_price)}`, {
    label: 'Отменить',
    run: async () => {
      await api('delSale', r.sale_id);
      if (fromReserved) await api('saveItem', i.id, { reserved: reservedBefore });
      toast('Продажа отменена'); rerender();
    },
  });
  rerender();
}

async function viewStock() {
  const all = await api('stock');
  const draw = () => {
    const q = stockQuery.trim().toLowerCase();
    const list = all.filter((i) => (stockFilter === 'all' || (stockFilter === 'in' ? i.calc.stock + i.calc.reserved > 0 : i.stale))
      && (!q || itemName(i).toLowerCase().includes(q)));
    const units = list.reduce((s, i) => s + i.calc.stock, 0);
    const reservedUnits = list.reduce((s, i) => s + i.calc.reserved, 0);
    const value = list.reduce((s, i) => s + i.calc.stock * i.sell_price, 0);
    $('#stock-list').innerHTML = list.length ? `<div class="stock-grid">${list.map((i) => `
      <div class="card tile ${i.calc.stock + i.calc.reserved ? '' : 'soldout'}" data-open="${i.id}" role="button" tabindex="0">
        <div class="ph">${i.photos[0] ? `<img src="${i.photos[0].url}" alt="" loading="lazy">` : 'нет фото'}</div>
        <div class="body"><div class="t">${esc(itemName(i))}</div>
          <div class="p num">${rub(i.sell_price)}</div>
          <div class="chips" style="margin-top:6px"><span class="chip ${i.calc.stock ? 'ok' : ''}">${i.calc.stock ? `${i.calc.stock} шт` : 'нет'}</span>
            ${i.calc.reserved ? `<span class="chip accent">бронь ${i.calc.reserved}</span>` : ''}${i.batch_status === 'transit' ? '<span class="chip">в пути</span>' : ''}
            ${i.stale ? `<span class="chip warn">${i.days_in_stock} дн.</span>` : ''}${i.listed ? '<span class="chip">на Авито</span>' : ''}</div>
          ${i.calc.stock + i.calc.reserved ? `<button class="sm primary block tile-sell" data-qsell="${i.id}">Продал 1 шт</button>` : ''}</div>
      </div>`).join('')}</div>` : '<div class="card empty"><b>Ничего не нашлось</b>Попробуй другой фильтр</div>';
    $('#stock-count').innerHTML = `<b class="num">${units}</b> шт свободно · <b class="num">${reservedUnits}</b> в брони · на <b class="num">${rub(value)}</b>`;
    $$('[data-open]').forEach((x) => {
      const open = () => stockItemSheet(all.find((i) => String(i.id) === x.dataset.open));
      x.onclick = (e) => { if (!e.target.closest('[data-qsell]')) open(); };
      x.onkeydown = (e) => { if (e.key === 'Enter' && e.target === x) open(); };
    });
    $$('[data-qsell]').forEach((x) => (x.onclick = guard(async () => { x.disabled = true; await quickSell(all.find((i) => String(i.id) === x.dataset.qsell)); })));
  };
  view.innerHTML = `
    <div class="page-head"><h1>Склад</h1><span class="small muted stock-count" id="stock-count"></span></div>
    <div class="row" style="margin-bottom:14px">
      <div class="seg" id="seg">${[['in', 'В наличии'], ['stale', 'Залежались'], ['all', 'Все']].map(([k, t]) => `<button data-f="${k}" class="${stockFilter === k ? 'on' : ''}">${t}</button>`).join('')}</div>
      <input class="search" type="search" placeholder="Поиск…" value="${esc(stockQuery)}" id="q">
    </div>
    <div id="stock-list"></div>`;
  $$('#seg button').forEach((x) => (x.onclick = () => { stockFilter = x.dataset.f; $$('#seg button').forEach((y) => y.classList.toggle('on', y === x)); draw(); }));
  $('#q').oninput = (e) => { stockQuery = e.target.value; draw(); };
  draw();
}

function stockItemSheet(i) {
  const c = i.calc;
  openSheet(itemName(i), `
    ${i.photos.length ? `<div class="photos" style="margin-bottom:14px">${i.photos.map((p) => `<div class="ph"><img src="${p.url}" alt="" data-full="${p.url}"></div>`).join('')}</div>` : ''}
    <div class="calc">
      <span class="k">Партия</span><span class="v"><a href="#batch-${i.batch_id}">${esc(i.batch_name)}</a></span>
      <span class="k">В наличии</span><span class="v">${c.stock} из ${i.qty} шт</span>
      <span class="k">В брони</span><span class="v">${c.reserved} шт</span>
      <span class="k">Продано</span><span class="v">${c.sold} шт</span>
      <span class="k">Себестоимость</span><span class="v">${rub(c.unit_cost_rub)}</span>
      <span class="k">Цена продажи</span><span class="v">${rub(i.sell_price)}</span>
      <span class="k">Прибыль с 1 шт</span><span class="v">${rubS(c.unit_margin_rub)}</span>
    </div>
    <div class="row" style="margin-top:16px">
      <button class="primary" id="s-sell" ${c.stock + c.reserved ? '' : 'disabled'}>Продал</button>
      <button id="s-res-plus" ${c.stock ? '' : 'disabled'}>+ Бронь</button>
      <button id="s-res-minus" ${c.reserved ? '' : 'disabled'}>− Бронь</button>
      <button id="s-photos">Фото</button>
    </div>
    <label class="check" style="margin-top:14px"><input type="checkbox" id="s-listed" ${i.listed ? 'checked' : ''}> Выставлено на Авито</label>`, (el) => {
    $$('[data-full]', el).forEach((img) => (img.onclick = () => showPhoto(img.dataset.full)));
    $('#s-sell', el).onclick = () => sellForm(i);
    $('#s-photos', el).onclick = () => photosSheet(i);
    const res = (d) => guard(async () => { await api('saveItem', i.id, { reserved: c.reserved + d }); closeSheet(); toast(d > 0 ? 'Забронировано' : 'Бронь снята'); rerender(); });
    $('#s-res-plus', el).onclick = res(1);
    $('#s-res-minus', el).onclick = res(-1);
    $('#s-listed', el).onchange = guard(async (e) => { await api('saveItem', i.id, { listed: e.target.checked }); rerender(); });
  });
}

/* ───────────── продажи ───────────── */
async function viewSales() {
  const [sales, expenses] = await Promise.all([api('sales'), api('expenses')]);
  const active = sales.filter((s) => !s.returned);
  const sum = (k) => active.reduce((a, s) => a + (k === 'rev' ? s.price * s.qty - s.extra_cost : s.profit_rub), 0);
  view.innerHTML = `
    <div class="page-head"><h1>Продажи</h1></div>
    <div class="grid kpis three" style="margin-bottom:16px">
      <div class="card kpi"><div class="label">Продаж</div><div class="value num">${active.reduce((a, s) => a + s.qty, 0)} шт</div></div>
      <div class="card kpi"><div class="label">Выручка</div><div class="value num">${rub(sum('rev'))}</div></div>
      <div class="card kpi"><div class="label">Прибыль</div><div class="value num">${rubS(sum('profit'))}</div></div>
    </div>
    ${sales.length ? `<div class="card" style="padding:4px 8px; overflow-x:auto"><table class="t">
      <thead><tr><th>Дата</th><th>Товар</th><th>Шт</th><th>Цена</th><th>Прибыль</th><th></th></tr></thead>
      <tbody>${sales.map((s) => `<tr style="${s.returned ? 'opacity:.5' : ''}">
        <td class="small">${fmtDate(s.sold_at)}</td>
        <td>${esc(itemName(s))}<div class="small muted">${esc(s.batch_name)}${s.extra_cost ? ` · доп. ${rub(s.extra_cost)}` : ''}${s.returned ? ' · <b>возврат</b>' : ''}</div></td>
        <td class="num">${s.qty}</td><td class="num">${rub(s.price)}</td><td class="num">${s.returned ? '—' : rubS(s.profit_rub)}</td>
        <td><div class="row" style="flex-wrap:nowrap"><button class="sm" data-ret="${s.id}" data-v="${s.returned ? 0 : 1}">${s.returned ? 'Отменить возврат' : 'Возврат'}</button><button class="icon-btn" data-del-sale="${s.id}" aria-label="Удалить">✕</button></div></td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="card empty"><b>Продаж пока нет</b>Отметь продажу на складе или в партии кнопкой «Продал»</div>'}

    <div class="section"><div class="row" style="margin-bottom:8px"><h3 style="margin:0">Расходы</h3><span class="spacer"></span><button class="sm" id="add-exp">+ Расход</button></div>
      <div class="card">${expenses.length ? expenses.map((e) => `<div class="row" style="padding:3px 0"><span>${esc(e.title)}</span><span class="small muted">${e.batch_name ? esc(e.batch_name) : 'общий'} · ${fmtDate(e.spent_at)}</span><span class="spacer"></span><b class="num">${rub(e.amount)}</b><button class="icon-btn" data-del-exp="${e.id}" aria-label="Удалить">✕</button></div>`).join('')
        : '<span class="muted small">Продвижение, упаковка и прочее. Учитываются в прибыли.</span>'}</div></div>`;
  $$('[data-ret]').forEach((x) => (x.onclick = guard(async () => { await api('saveSale', x.dataset.ret, { returned: x.dataset.v === '1' }); toast(x.dataset.v === '1' ? 'Товар вернулся на склад' : 'Возврат отменён'); rerender(); })));
  $$('[data-del-sale]').forEach((x) => (x.onclick = guard(async () => { if (!(await ask('Удалить запись о продаже?'))) return; await api('delSale', x.dataset.delSale); rerender(); })));
  $('#add-exp').onclick = () => expenseForm(null);
  $$('[data-del-exp]').forEach((x) => (x.onclick = guard(async () => { await api('delExpense', x.dataset.delExp); rerender(); })));
}

/* ───────────── настройки ───────────── */
async function viewSettings() {
  const [s, cats] = await Promise.all([api('settings'), api('categories')]);
  view.innerHTML = `
    <div class="page-head"><h1>Настройки</h1></div>
    <h3>Курсы и доставка</h3>
    <form class="card" id="setf">
      <div class="f-row">
        <label class="f"><span>Юань ЦБ, ₽</span><input name="cny_cbr" type="number" step="0.0001" min="0" value="${s.cny_cbr}"></label>
        <label class="f"><span>Наценка к юаню, ₽</span><input name="cny_markup" type="number" step="0.01" value="${s.cny_markup}"></label>
      </div>
      <p class="hint-line">Курс для выкупа: <b>${nf2.format(s.cny_rate)} ₽</b> за 1 ¥ · ${s.cny_cbr_date ? `обновлён ${esc(s.cny_cbr_date)}` : 'ещё не обновлялся'} · <a href="https://www.cbr.ru/currency_base/daily/" target="_blank" rel="noopener">курс на сайте ЦБ</a></p>
      <div class="f-row">
        <label class="f"><span>Доллар у карго, ₽</span><input name="usd_rate" type="number" step="0.01" min="0" value="${s.usd_rate}"></label>
        <label class="f"><span>Карго, $ за кг</span><input name="cargo_usd_per_kg" type="number" step="0.01" min="0" value="${s.cargo_usd_per_kg}"></label>
      </div>
      <div class="f-row">
        <label class="f"><span>Доставка по РФ на посылку, ₽</span><input name="rf_delivery_rub" type="number" step="1" min="0" value="${s.rf_delivery_rub}"></label>
        <label class="f"><span>Залежался через, дней</span><input name="stale_days" type="number" step="1" min="1" value="${s.stale_days}"></label>
      </div>
      <p class="hint-line">Курс ЦБ обновляется сам каждое утро. Можно поправить вручную. Новые значения применяются к новым партиям. У существующей партии курсы меняются в её «Курсах и настройках».</p>
      <button class="primary">Сохранить</button>
    </form>

    <div class="section"><div class="row" style="margin-bottom:8px"><h3 style="margin:0">Типы вещей и вес</h3><span class="spacer"></span><button class="sm" id="add-cat">+ Тип</button></div>
      <div class="card" style="padding:4px 8px; overflow-x:auto"><table class="t">
        <thead><tr><th>Тип</th><th>Вес 1 шт, кг</th><th>Цена по умолч., ₽</th><th></th></tr></thead>
        <tbody>${cats.length ? '' : '<tr><td colspan="4" class="muted">Типов пока нет. <button class="sm" id="add-default-cats">Добавить стандартные</button></td></tr>'}${cats.map((c) => `<tr data-cat="${c.id}">
          <td><input name="name" value="${esc(c.name)}"></td>
          <td style="width:110px"><input name="weight_kg" type="number" step="0.05" min="0.01" value="${c.weight_kg}"></td>
          <td style="width:130px"><input name="default_price" type="number" step="100" min="0" value="${c.default_price}"></td>
          <td style="width:40px"><button class="icon-btn" data-del-cat="${c.id}" aria-label="Удалить">✕</button></td></tr>`).join('')}</tbody>
      </table></div>
      <p class="hint-line" style="margin-top:8px">Меняется сразу при выходе из поля. Вес у уже добавленных товаров не меняется — его можно поправить в самом товаре.</p>
    </div>

    <div class="section"><h3>Как открыть с телефона</h3><div class="card small">
      <p style="margin:0">Открой эту же страницу в приложении Claude на телефоне: раздел с артефактами или ссылка из чата. Данные общие — что вбил на ПК, сразу видно на телефоне.</p>
    </div></div>`;

  $('#setf').onsubmit = guard(async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    if (d.cny_cbr === s.cny_cbr) delete d.cny_cbr;
    await api('saveSettings', d);
    toast('Сохранено'); rerender();
  });
  $$('[data-cat]').forEach((tr) => {
    tr.onchange = guard(async () => {
      const body = { name: $('[name=name]', tr).value, weight_kg: Number($('[name=weight_kg]', tr).value), default_price: Number($('[name=default_price]', tr).value || 0) };
      await api('saveCategory', tr.dataset.cat, body); toast('Сохранено');
    });
  });
  $$('[data-del-cat]').forEach((x) => (x.onclick = guard(async () => { if (!(await ask('Удалить этот тип вещи? Товары останутся.'))) return; await api('delCategory', x.dataset.delCat); rerender(); })));
  $('#add-cat').onclick = guard(async () => { await api('addCategory', { name: 'Новый тип', weight_kg: 0.5, default_price: 0 }); rerender(); });
  $('#add-default-cats')?.addEventListener('click', guard(async () => { await api('addDefaultCategories'); toast('Типы добавлены'); rerender(); }));
}

/* ───────────── запуск ───────────── */
render();
(async () => {
  const c = window.claude;
  DB = c ? await c.use('db') : null;
  if (!DB) { S.failed = 'Открой эту страницу на claude.ai под своим аккаунтом — там хранятся твои данные.'; render(); return; }
  ASSETS = await c.use('assets');
  c.use('sample').then((s) => { SAMPLE = s; if (location.hash === '#reply') rerender(); });
  connectStore(onStoreChange);
})();
