/* ───────────── ответ покупателю (ИИ) ───────────── */
const DEFAULT_RULES = 'Отправляю Авито Доставкой. Фото в живую могу скинуть по запросу.';
const R = { message: '', image: null, imageUrl: '', result: null, busy: false, ctl: null };

const sampleErrorText = (code) => ({
  not_granted: 'ИИ не разрешён. Нажми «Написать ответ» ещё раз и разреши в окне запроса, или обнови страницу.',
  rate_limited: 'Слишком много запросов подряд. Подожди минуту и попробуй снова.',
  prompt_too_large: 'Слишком длинная переписка. Оставь только последние сообщения.',
  image_rejected: 'Скриншот не подошёл. Попробуй другой или вставь текст.',
  images_unavailable: 'Скриншоты здесь не поддерживаются — вставь текст сообщения.',
  invalid_json: 'ИИ ответил не по формату. Нажми «Другой вариант».',
  refused: 'ИИ отказался отвечать на это сообщение. Ответь сам.',
  cancelled: 'Остановлено.',
}[code] || 'Не получилось написать ответ. Попробуй ещё раз.');

function stockForPrompt(items) {
  return items.map((i) => ({
    id: i.id, model: i.title, color: i.color || null, size: i.size || null, type: i.category || null,
    free: i.calc.stock, reserved: i.calc.reserved, price_rub: i.sell_price, in_transit: i.batch_status === 'transit',
  }));
}

function buildPrompt(stock, rules, message, hasImage) {
  return `Ты помогаешь продавцу одежды на Авито отвечать покупателям. Напиши, что продавец ответит на последнее сообщение покупателя.

Правила:
- Пиши по-русски, коротко (1–3 предложения), вежливо и просто, на «вы». Без смайликов, без канцелярита, без восклицаний через слово.
- Цена фиксированная, торга нет. На просьбы скинуть, уступить или «за сколько отдадите» вежливо и твёрдо откажи. Никаких скидок, подарков и обещаний.
- Опирайся только на данные склада ниже. Если нужного цвета или размера нет (free = 0), так и скажи и предложи то, что есть. Не выдумывай размеры, замеры, состав, сроки и наличие.
- Если товар в брони (reserved > 0, free = 0), скажи, что он забронирован.
- Если спрашивают, оригинал ли это, честно ответь, что это реплика, не оригинал.
- Если покупатель готов купить или просит отложить вещь, подтверди и укажи этот товар в item_id, action = "reserve".
- Если это претензия, возврат, угроза, что-то странное или ты не уверен, action = "handoff" и коротко объясни продавцу в note.
- Особые правила продавца: ${rules || 'нет'}

Склад (JSON, цены в рублях за штуку):
${JSON.stringify(stock)}

${hasImage ? 'Скриншот переписки приложен: прочитай последнее сообщение покупателя.' : ''}${message ? `Сообщение покупателя (или переписка):\n"""\n${message}\n"""` : ''}

Ответь только JSON без пояснений:
{"reply": "текст ответа покупателю", "item_id": "id товара из склада или null", "action": "none" | "reserve" | "handoff", "note": "короткая подсказка продавцу или пустая строка"}`;
}

async function viewReply() {
  const [stock, rulesSnap] = await Promise.all([api('stock'), DB.doc('app/replies').get().catch(() => null)]);
  const rules = rulesSnap?.exists ? rulesSnap.data().rules ?? DEFAULT_RULES : DEFAULT_RULES;
  const canImages = !!(SAMPLE && (await SAMPLE.limits().catch(() => ({})))?.images);
  const byId = Object.fromEntries(stock.map((i) => [i.id, i]));

  view.innerHTML = `
    <div class="page-head"><h1>Ответ покупателю</h1></div>
    ${SAMPLE ? '' : '<div class="alert" style="margin-bottom:12px">ИИ здесь недоступен. Открой страницу на claude.ai под своим аккаунтом.</div>'}
    <div class="reply-grid">
      <div class="card">
        <label class="f"><span>Сообщение покупателя</span>
          <textarea id="r-msg" rows="5" placeholder="Вставь сюда, что написал покупатель. Можно всю переписку.">${esc(R.message)}</textarea></label>
        ${canImages ? `<div class="row" style="margin:-4px 0 12px">
          <label class="btn sm" for="r-img">${R.image ? 'Другой скриншот' : 'Или скриншот переписки'}</label>
          <input type="file" id="r-img" accept="image/*" hidden>
          ${R.image ? `<img class="r-shot" src="${R.imageUrl}" alt="Скриншот"><button class="icon-btn" id="r-img-x" aria-label="Убрать скриншот">✕</button>` : ''}
        </div>` : ''}
        <div class="row">
          <button class="primary" id="r-go" ${SAMPLE ? '' : 'disabled'}>${R.busy ? 'Пишу…' : 'Написать ответ'}</button>
          ${R.busy ? '<button id="r-stop">Стоп</button>' : ''}
          <span class="spacer"></span>
          <button class="ghost sm" id="r-clear">Очистить</button>
        </div>
        <div id="r-out"></div>
      </div>
      <details class="card rules">
        <summary>Правила для ИИ</summary>
        <p class="hint-line" style="margin-top:10px">Всегда: цена без торга, только то, что есть на складе, честно про реплику, если спросят. Здесь — твоё: доставка, встреча, примерка.</p>
        <textarea id="r-rules" rows="3">${esc(rules)}</textarea>
        <button class="sm" id="r-rules-save" style="margin-top:8px">Сохранить правила</button>
      </details>
    </div>`;

  const out = $('#r-out');
  const drawResult = () => {
    const r = R.result;
    if (!r) { out.innerHTML = ''; return; }
    if (r.error) { out.innerHTML = `<p class="neg small" style="margin:14px 0 0">${esc(r.error)}</p>`; return; }
    const it = r.item_id && byId[r.item_id];
    out.innerHTML = `
      <div class="reply-out">
        <label class="f"><span>Ответ — можно поправить</span><textarea id="r-text" rows="4">${esc(r.reply || '')}</textarea></label>
        ${r.action === 'handoff' ? `<div class="alert" style="margin-bottom:10px">Лучше ответить самому${r.note ? `: ${esc(r.note)}` : ''}</div>` : r.note ? `<p class="hint-line">${esc(r.note)}</p>` : ''}
        <div class="row">
          <button class="primary" id="r-copy">Скопировать</button>
          <button id="r-again">Другой вариант</button>
          ${r.action === 'reserve' && it && it.calc.stock > 0 ? `<button id="r-res">Забронировать: ${esc(itemName(it))}</button>` : ''}
        </div>
      </div>`;
    $('#r-copy').onclick = async () => {
      const t = $('#r-text');
      try { await navigator.clipboard.writeText(t.value); toast('Скопировано — вставь в чат Авито'); } catch { t.focus(); t.select(); toast('Текст выделен — скопируй его'); }
    };
    $('#r-again').onclick = () => run(false);
    $('#r-res')?.addEventListener('click', guard(async () => {
      await api('saveItem', it.id, { reserved: it.calc.reserved + 1 });
      toast(`Забронировано: ${itemName(it)}`);
      R.result = { ...r, action: 'none' }; drawResult();
    }));
  };

  async function run(useCache) {
    R.message = $('#r-msg').value.trim();
    if (!R.message && !R.image) { toast('Вставь сообщение покупателя или скриншот'); return; }
    R.busy = true; R.result = null;
    $('#r-go').textContent = 'Пишу…'; $('#r-go').disabled = true;
    out.innerHTML = '<p class="muted small" style="margin:14px 0 0">ИИ читает сообщение и смотрит склад…</p>';
    R.ctl = new AbortController();
    try {
      const prompt = buildPrompt(stockForPrompt(stock), $('#r-rules').value.trim(), R.message, !!R.image);
      const opts = { modelTier: 'quick', signal: R.ctl.signal, cache: useCache };
      if (R.image) opts.images = [R.image];
      const res = await SAMPLE.json(prompt, opts);
      R.result = res && typeof res.reply === 'string' ? res : { error: sampleErrorText('invalid_json') };
    } catch (e) {
      R.result = { error: sampleErrorText(e?.code) };
    } finally {
      R.busy = false;
      $('#r-go').textContent = 'Написать ответ'; $('#r-go').disabled = false;
      drawResult();
    }
  }

  $('#r-go').onclick = () => run(true);
  $('#r-msg').oninput = (e) => { R.message = e.target.value; };
  $('#r-clear').onclick = () => { R.message = ''; R.image = null; R.imageUrl = ''; R.result = null; viewReply(); };
  $('#r-img')?.addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    R.image = await compress(f, 1600); R.imageUrl = URL.createObjectURL(R.image); viewReply();
  });
  $('#r-img-x')?.addEventListener('click', () => { R.image = null; R.imageUrl = ''; viewReply(); });
  $('#r-rules-save').onclick = guard(async () => {
    try { await DB.doc('app/replies').set({ rules: $('#r-rules').value.trim() }); } catch { throw new Error('Не получилось сохранить правила'); }
    toast('Правила сохранены');
  });
  drawResult();
}

