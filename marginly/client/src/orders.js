'use strict';
/* Заказы: новый заказ, переходы статусов, раздел «Заказы». */

const STATUS_CHIP = {
  ordered: '<span class="chip accent">заказан</span>',
  shipped: '<span class="chip warn">отправлен</span>',
  sold: '<span class="chip ok">продан</span>',
  cancelled: '<span class="chip">отменён</span>',
  returned: '<span class="chip bad">возврат</span>',
};

function orderForm(i) {
  const c = i.calc;
  const today = todayIso();
  openSheet('Новый заказ', `
    <p style="margin-top:0"><b>${esc(itemName(i))}</b><br><span class="small muted">Свободно ${c.stock} шт · себестоимость ${rub(c.unit_cost_rub)}</span></p>
    <form id="of">
      <div class="f-row">
        <label class="f"><span>Сколько, шт</span><input name="qty" type="number" min="1" max="${c.stock}" step="1" value="1" required></label>
        <label class="f"><span>Цена за 1 шт, ₽</span><input name="price" type="number" min="0" step="1" value="${i.sell_price}" required></label>
      </div>
      <div class="f-row">
        <label class="f"><span>Доставка за твой счёт, ₽</span><input name="extra_cost" type="number" min="0" step="1" value="0"></label>
        <label class="f"><span>Дата</span><input name="date" type="date" value="${today}"></label>
      </div>
      <label class="f"><span>Покупатель или заметка</span><input name="buyer" placeholder="Например: Иван, Авито"></label>
      <label class="check"><input type="checkbox" name="sold_now"> Сразу продано (встреча, деньги получены)</label>
      <p id="of-profit" class="num" style="font-weight:600"></p>
      <button class="primary block" id="of-go">Оформить заказ</button>
    </form>`, (el) => {
    const f = $('#of', el);
    const upd = () => {
      const d = formData(f);
      $('#of-profit', el).innerHTML = `Прибыль, когда продашь: ${rubS((d.price || 0) * (d.qty || 0) - (d.extra_cost || 0) - c.unit_cost_rub * (d.qty || 0))}`;
      $('#of-go', el).textContent = d.sold_now ? 'Записать продажу' : 'Оформить заказ';
    };
    f.oninput = upd; upd();
    f.onsubmit = guard(async (e) => {
      e.preventDefault();
      const d = formData(f);
      const r = await api('createOrder', i.id, {
        qty: d.qty, price: d.price, extra_cost: d.extra_cost, buyer: d.buyer,
        status: d.sold_now ? 'sold' : 'ordered', date: d.date === today ? null : `${d.date} 12:00:00`,
      });
      closeSheet();
      toast(d.sold_now ? 'Продажа записана' : 'Заказ оформлен — он в разделе «Заказы»', {
        label: 'Отменить', run: async () => { await api('delOrder', r.id); toast('Отменено'); rerender(); },
      });
      rerender();
    });
  });
}

async function changeStatus(o, status, extra) {
  const prev = { ...S.orders.get(o.id) };
  await api('setOrderStatus', o.id, status, extra);
  const msg = { shipped: 'Отмечено: отправлен', sold: `Продано за ${rub(o.price * o.qty)}`, cancelled: 'Заказ отменён, вещь вернулась на склад',
    returned: extra?.return_action === 'restock' ? 'Возврат: вещь снова на складе' : 'Возврат: вещь списана' }[status];
  toast(msg, { label: 'Отменить', run: async () => { await api('undoOrderStatus', o.id, prev); toast('Вернул как было'); rerender(); } });
  rerender();
}

function shipForm(o) {
  openSheet('Отправлен', `
    <p style="margin-top:0"><b>${esc(itemName(o))}</b></p>
    <form id="sf">
      <label class="f"><span>Трек-номер (необязательно)</span><input name="track" value="${esc(o.track || '')}" placeholder="Например: 80085012345678" autofocus></label>
      <button class="primary block">Отметить отправленным</button>
    </form>`, (el) => {
    $('#sf', el).onsubmit = guard(async (e) => { e.preventDefault(); closeSheet(); await changeStatus(o, 'shipped', { track: formData(e.target).track }); });
  });
}

function returnForm(o) {
  openSheet('Возврат от покупателя', `
    <p style="margin-top:0"><b>${esc(itemName(o))}</b> · ${o.qty} шт</p>
    <p class="hint-line">Деньги за этот заказ уберутся из выручки. Доставка ${o.extra_cost ? `(${rub(o.extra_cost)})` : ''} останется в расходах.</p>
    <div class="ret-choice">
      <button class="primary" id="r-restock"><b>Вернуть на склад</b><span>Вещь в порядке, продам снова</span></button>
      <button id="r-writeoff"><b>Списать</b><span>Брак, потеря или испорчена — себестоимость уйдёт в убыток</span></button>
    </div>`, (el) => {
    $('#r-restock', el).onclick = guard(async () => { closeSheet(); await changeStatus(o, 'returned', { return_action: 'restock' }); });
    $('#r-writeoff', el).onclick = guard(async () => { closeSheet(); await changeStatus(o, 'returned', { return_action: 'writeoff' }); });
  });
}

function orderSheet(o) {
  const can = { ordered: ['shipped', 'sold', 'cancelled'], shipped: ['sold', 'returned', 'cancelled'], sold: ['returned'] }[o.status] || [];
  const ts = (k, label) => (o[k] ? `<span class="k">${label}</span><span class="v">${fmtDate(o[k])}</span>` : '');
  openSheet('Заказ', `
    <div class="row" style="margin-bottom:10px"><b>${esc(itemName(o))}</b>${STATUS_CHIP[o.status]}</div>
    <div class="calc">
      <span class="k">Количество</span><span class="v">${o.qty} шт × ${rub(o.price)}</span>
      <span class="k">Сумма</span><span class="v">${rub(o.price * o.qty)}</span>
      ${o.extra_cost ? `<span class="k">Доставка за твой счёт</span><span class="v">${rub(o.extra_cost)}</span>` : ''}
      ${o.profit_rub != null ? `<span class="k">Прибыль</span><span class="v">${rubS(o.profit_rub)}</span>` : ''}
      ${ts('created_at', 'Оформлен')}${ts('shipped_at', 'Отправлен')}${ts('sold_at', 'Продан')}
      ${o.status === 'returned' ? `<span class="k">Возврат</span><span class="v">${o.return_action === 'writeoff' ? 'списан' : 'на склад'}</span>` : ''}
      <span class="k">Партия</span><span class="v"><a href="#batch-${o.batch_id}">${esc(o.batch_name || '—')}</a></span>
    </div>
    <form id="oe" style="margin-top:14px">
      <div class="f-row">
        <label class="f"><span>Трек-номер</span><input name="track" value="${esc(o.track || '')}"></label>
        <label class="f"><span>Покупатель / заметка</span><input name="buyer" value="${esc(o.buyer || '')}"></label>
      </div>
      <div class="f-row">
        <label class="f"><span>Цена за 1 шт, ₽</span><input name="price" type="number" min="0" step="1" value="${o.price}"></label>
        <label class="f"><span>Доставка за твой счёт, ₽</span><input name="extra_cost" type="number" min="0" step="1" value="${o.extra_cost || 0}"></label>
      </div>
      <button class="sm">Сохранить изменения</button>
    </form>
    ${can.length ? `<div class="row" style="margin-top:16px">
      ${can.includes('shipped') ? '<button class="primary" data-st="shipped">Отправил</button>' : ''}
      ${can.includes('sold') ? `<button class="${o.status === 'shipped' ? 'primary' : ''}" data-st="sold">Продано</button>` : ''}
      ${can.includes('returned') ? '<button data-st="returned">Возврат</button>' : ''}
      ${can.includes('cancelled') ? '<button class="danger" data-st="cancelled">Отменить заказ</button>' : ''}
    </div>` : ''}
    <button class="ghost sm" id="o-del" style="margin-top:14px">Удалить запись</button>`, (el) => {
    $('#oe', el).onsubmit = guard(async (e) => { e.preventDefault(); await api('saveOrder', o.id, formData(e.target)); closeSheet(); toast('Сохранено'); rerender(); });
    $$('[data-st]', el).forEach((b) => (b.onclick = guard(async () => {
      const st = b.dataset.st;
      if (st === 'shipped') return shipForm(o);
      if (st === 'returned') return returnForm(o);
      if (st === 'cancelled' && !(await ask('Отменить заказ? Вещь вернётся на склад.', 'Отменить заказ'))) return orderSheet(o);
      closeSheet(); await changeStatus(o, st);
    })));
    $('#o-del', el).onclick = guard(async () => {
      if (!(await ask('Удалить запись о заказе совсем? Лучше отменить заказ — так сохранится история.'))) return orderSheet(o);
      await api('delOrder', o.id); rerender();
    });
  });
}

let ordersTab = 'open';
async function viewOrders() {
  const [orders, expenses] = await Promise.all([api('orders'), api('expenses')]);
  const tabs = [
    ['open', 'В работе', (o) => o.status === 'ordered' || o.status === 'shipped'],
    ['sold', 'Проданы', (o) => o.status === 'sold'],
    ['returned', 'Возвраты', (o) => o.status === 'returned'],
    ['cancelled', 'Отменены', (o) => o.status === 'cancelled'],
  ];
  const count = Object.fromEntries(tabs.map(([k, , f]) => [k, orders.filter(f).length]));
  const list = orders.filter(tabs.find((t) => t[0] === ordersTab)[2]);
  const sold = orders.filter((o) => o.status === 'sold');
  const open = orders.filter((o) => o.status === 'ordered' || o.status === 'shipped');
  view.innerHTML = `
    <div class="page-head"><h1>Заказы</h1></div>
    <div class="grid kpis three" style="margin-bottom:16px">
      <div class="card kpi"><div class="label">В работе</div><div class="value num">${open.length}</div><div class="hint">на ${rub(open.reduce((a, o) => a + o.price * o.qty, 0))}</div></div>
      <div class="card kpi"><div class="label">Продано</div><div class="value num">${sold.reduce((a, o) => a + o.qty, 0)} шт</div><div class="hint">${rub(sold.reduce((a, o) => a + o.price * o.qty - (o.extra_cost || 0), 0))}</div></div>
      <div class="card kpi"><div class="label">Прибыль</div><div class="value num">${rubS(orders.reduce((a, o) => a + (o.profit_rub || 0), 0))}</div></div>
    </div>
    <div class="seg" id="otabs" style="margin-bottom:12px">${tabs.map(([k, t]) => `<button data-t="${k}" class="${ordersTab === k ? 'on' : ''}">${t}${count[k] ? ` · ${count[k]}` : ''}</button>`).join('')}</div>
    ${list.length ? list.map((o) => `
      <div class="card order" data-oid="${o.id}" role="button" tabindex="0">
        <div class="thumb sm">${o.photo ? `<img src="${o.photo}" alt="" loading="lazy">` : 'нет<br>фото'}</div>
        <div class="order-main">
          <div class="row"><b>${esc(itemName(o))}</b>${STATUS_CHIP[o.status]}</div>
          <div class="small muted">${o.qty} шт × ${rub(o.price)} · ${fmtDate(o.created_at)}${o.track ? ` · трек ${esc(o.track)}` : ''}${o.buyer ? ` · ${esc(o.buyer)}` : ''}</div>
          ${o.profit_rub != null ? `<div class="small">Прибыль ${rubS(o.profit_rub)}</div>` : ''}
        </div>
        <div class="order-act">
          ${o.status === 'ordered' ? `<button class="sm primary" data-next="shipped" data-id="${o.id}">Отправил</button>` : ''}
          ${o.status === 'shipped' ? `<button class="sm primary" data-next="sold" data-id="${o.id}">Продано</button>` : ''}
        </div>
      </div>`).join('') : `<div class="card empty"><b>${ordersTab === 'open' ? 'Заказов в работе нет' : 'Пока пусто'}</b>${ordersTab === 'open' ? 'Новый заказ оформляется на складе кнопкой «Новый заказ»' : ''}</div>`}

    <div class="section"><div class="row" style="margin-bottom:8px"><h3 style="margin:0">Расходы</h3><span class="spacer"></span><button class="sm" id="add-exp">+ Расход</button></div>
      <div class="card">${expenses.length ? expenses.map((e) => `<div class="row" style="padding:3px 0"><span>${esc(e.title)}</span><span class="small muted">${e.batch_name ? esc(e.batch_name) : 'общий'} · ${fmtDate(e.spent_at)}</span><span class="spacer"></span><b class="num">${rub(e.amount)}</b><button class="icon-btn" data-del-exp="${e.id}" aria-label="Удалить">✕</button></div>`).join('')
        : '<span class="muted small">Продвижение, упаковка и прочее. Учитываются в прибыли.</span>'}</div></div>`;
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
  $$('#otabs button').forEach((b) => (b.onclick = () => { ordersTab = b.dataset.t; viewOrders(); }));
  $$('[data-oid]').forEach((card) => {
    card.onclick = (e) => { if (!e.target.closest('[data-next]')) orderSheet(byId[card.dataset.oid]); };
    card.onkeydown = (e) => { if (e.key === 'Enter' && e.target === card) orderSheet(byId[card.dataset.oid]); };
  });
  $$('[data-next]').forEach((b) => (b.onclick = guard(async () => {
    const o = byId[b.dataset.id];
    if (b.dataset.next === 'shipped') return shipForm(o);
    await changeStatus(o, 'sold');
  })));
  $('#add-exp').onclick = () => expenseForm(null);
  $$('[data-del-exp]').forEach((x) => (x.onclick = guard(async () => { await api('delExpense', x.dataset.delExp); rerender(); })));
}
