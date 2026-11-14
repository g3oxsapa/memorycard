'use strict';
/* Запуск Marginly: вход → синхронизация → интерфейс. Аккаунт, тариф, плашки состояния. */

const PRICE_RUB = 499;
const LEGAL = { terms: '/legal/terms.html', privacy: '/legal/privacy.html' };
const BRAND_SVG = '<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="12" fill="#15171a"/><path d="M13 46V20l13 15 12-15v26" fill="none" stroke="#fff" stroke-width="6" stroke-linejoin="miter" stroke-linecap="square"/><path d="M42 33l9-11" stroke="#ffd21f" stroke-width="6" stroke-linecap="square"/><path d="M44 21h8v8" fill="none" stroke="#ffd21f" stroke-width="6" stroke-linecap="square"/></svg>';

let SESSION = null;

/* ── тема: по умолчанию как в системе, выбор хранится на устройстве ── */
const THEMES = [['system', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']];
function getTheme() { try { const t = localStorage.getItem('mg:theme'); return t === 'light' || t === 'dark' ? t : 'system'; } catch { return 'system'; } }
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
}
function setTheme(t) {
  try { if (t === 'system') localStorage.removeItem('mg:theme'); else localStorage.setItem('mg:theme', t); } catch { /* приватный режим */ }
  applyTheme(t);
}
applyTheme(getTheme());

function themeSection() {
  const cur = getTheme();
  return `
    <div class="section"><h3>Оформление</h3><div class="card">
      <div class="seg" id="theme-seg">${THEMES.map(([k, t]) => `<button data-theme-set="${k}" class="${cur === k ? 'on' : ''}">${t}</button>`).join('')}</div>
      <p class="hint-line" style="margin:10px 0 0">«Как в системе» — тема меняется вместе с телефоном или компьютером. Выбор сохраняется на этом устройстве.</p>
    </div></div>`;
}
let SYNC_STATE = 'online';

const REJECT_TEXT = {
  trial_limit: 'В пробный период — 1 партия и до 10 товаров. Лишнее не сохранилось',
  subscription_required: 'Пробный период закончился — изменения не сохранились. Оформи подписку',
  too_large: 'Запись слишком большая и не сохранилась',
  bad_path: 'Часть данных не сохранилась',
};

const DEMO_PLAN = { status: 'demo', limits: { batches: 1, items: 10 }, can_write: true };

function planText(p) {
  if (!p) return 'Загружаю тариф…';
  if (p.status === 'demo') return 'Демо-режим: данные только на этом устройстве · 1 партия и до 10 товаров';
  if (p.status === 'active') return `Подписка активна до ${fmtDate(p.paid_until.slice(0, 10))}`;
  if (p.status === 'trial') {
    const left = Math.max(0, Math.ceil((new Date(p.trial_ends_at) - Date.now()) / 86400000));
    return `Пробный период: осталось ${left} ${plural(left, 'день', 'дня', 'дней')} · 1 партия и до 10 товаров`;
  }
  return 'Пробный период закончился — данные только для просмотра';
}

function renderBanner() {
  const el = $('#banner');
  if (!el) return;
  const p = S.plan;
  let html = '';
  if (p?.status === 'expired') {
    html = `<div class="banner bad">Пробный период закончился — можно только смотреть. <a href="#options">Оформить подписку — ${PRICE_RUB} ₽/мес</a></div>`;
  } else if (p?.status === 'trial') {
    const left = Math.ceil((new Date(p.trial_ends_at) - Date.now()) / 86400000);
    if (left <= 2) html = `<div class="banner">Пробный период закончится через ${left} ${plural(left, 'день', 'дня', 'дней')}. <a href="#options">Оформить подписку</a></div>`;
  }
  if (SYNC_STATE === 'offline') html += '<div class="banner muted">Нет связи с сервером — изменения сохранены на устройстве и отправятся позже</div>';
  el.innerHTML = html;
  el.hidden = !html;
}

function accountSection() {
  const p = S.plan;
  const pending = DB?.pendingCount?.() || 0;
  return `
    <div class="section"><h3>Аккаунт и тариф</h3><div class="card">
      <div class="calc">
        <span class="k">Почта</span><span class="v">${esc(S.email)}</span>
        <span class="k">Тариф</span><span class="v">${{ active: 'Подписка', trial: 'Пробный', demo: 'Демо' }[p?.status] || 'Закончился'}</span>
        ${p?.status === 'demo' ? '' : `<span class="k">Синхронизация</span><span class="v">${SYNC_STATE === 'offline' ? `<span class="neg">нет связи${pending ? `, ждут отправки: ${pending}` : ''}</span>` : '<span class="pos">всё сохранено</span>'}</span>`}
      </div>
      <p class="hint-line" style="margin:12px 0">${esc(planText(p))}</p>
      ${p?.status === 'demo' ? `<button class="primary" id="demo-exit">Зарегистрироваться</button>
        <p class="hint-line" style="margin-top:10px">После регистрации данные демо-режима не переносятся.</p>`
        : `${p?.status !== 'active' ? `<button class="primary" id="subscribe">Оформить подписку — ${PRICE_RUB} ₽/мес</button>` : ''}
      <div class="row" style="margin-top:14px">
        <button id="logout">Выйти</button>
        <span class="spacer"></span>
        <button class="ghost sm" id="del-acc">Удалить аккаунт</button>
      </div>`}
    </div></div>`;
}

function bindAccountSection() {
  $$('[data-theme-set]').forEach((b) => (b.onclick = () => {
    setTheme(b.dataset.themeSet);
    $$('[data-theme-set]').forEach((x) => x.classList.toggle('on', x === b));
  }));
  $('#demo-exit')?.addEventListener('click', () => { saveSession(null); sessionStorage.setItem('mg:msg', 'Зарегистрируйся, чтобы данные сохранялись на сервере'); location.reload(); });
  $('#subscribe')?.addEventListener('click', () => toast('Оплата подключается на следующем этапе'));
  $('#logout')?.addEventListener('click', guard(async () => {
    if (DB?.pendingCount?.() && !(await ask('Часть изменений ещё не отправлена на сервер. Если выйти сейчас, они пропадут.', 'Всё равно выйти'))) return;
    await logout();
  }));
  $('#del-acc')?.addEventListener('click', () => openSheet('Удалить аккаунт', `
    <p style="margin-top:0">Аккаунт, все партии, заказы и фото удалятся навсегда. Восстановить их будет нельзя.</p>
    <form id="da">
      <label class="f"><span>Пароль для подтверждения</span><input name="password" type="password" autocomplete="current-password" required></label>
      <button class="danger block">Удалить навсегда</button>
    </form>`, (el) => {
    $('#da', el).onsubmit = guard(async (e) => {
      e.preventDefault();
      await http('/api/me', { method: 'DELETE', token: SESSION.token, body: { password: formData(e.target).password } });
      DB?.wipe?.();
      closeSheet();
      await logout('Аккаунт удалён');
    });
  }));
}

async function logout(msg) {
  if (SESSION) { try { await http('/api/auth/logout', { method: 'POST', token: SESSION.token }); } catch { /* офлайн — не страшно */ } }
  saveSession(null);
  if (msg) sessionStorage.setItem('mg:msg', msg);
  location.reload();
}

async function ensureDefaults() {
  if (!canWrite()) return;
  if (!S.categories.size) await ops.addDefaultCategories();
  if (!Object.keys(S.settings).length) await DB.doc('app/settings').set({ ...DEFAULTS });
}

async function refreshRate() {
  try {
    const r = await http('/api/rate');
    if (r?.rate > 0 && canWrite()) { if (await ops.setCbrRate(r.rate, r.date)) onStoreChange(); }
  } catch { /* без сети курс подтянется позже */ }
}

async function startApp(session, plan) {
  SESSION = session;
  S.email = session.demo ? 'демо-режим' : session.email;
  if (session.demo) {
    S.plan = DEMO_PLAN;
    document.body.classList.remove('auth-mode');
    DB = makeSyncDb({ email: 'demo', offline: true });
    ASSETS = null;
    connectStore(onStoreChange);
    await ensureDefaults();
    renderBanner();
    render();
    return;
  }
  try { S.plan = plan || JSON.parse(localStorage.getItem('mg:plan:' + session.email)) || null; } catch { S.plan = plan || null; }
  document.body.classList.remove('auth-mode');
  view.innerHTML = '<div class="empty"><b>Загружаю данные…</b></div>';
  DB = makeSyncDb({
    token: session.token,
    email: session.email,
    onPlan: (p) => { S.plan = p; try { localStorage.setItem('mg:plan:' + session.email, JSON.stringify(p)); } catch { /* */ } renderBanner(); },
    onRejected: (reasons) => toast(REJECT_TEXT[reasons[0]] || 'Часть изменений не сохранилась'),
    onStatus: (st) => { if (st !== SYNC_STATE) { SYNC_STATE = st; renderBanner(); } },
    onAuthLost: () => { saveSession(null); sessionStorage.setItem('mg:msg', 'Сессия закончилась. Войди заново'); location.reload(); },
  });
  ASSETS = makeRemoteAssets(session.token);
  connectStore(onStoreChange);
  if (DB.isEmpty()) await DB.syncNow(); else DB.syncNow();
  await ensureDefaults();
  renderBanner();
  render();
  refreshRate();
}

// Кнопка «Назад» на Android: сначала закрывает фото и окна, потом листает назад.
window.__onBack = () => {
  if (!$('#lightbox').hidden) { $('#lightbox').hidden = true; return true; }
  if (!$('#sheet').hidden) { closeSheet(); return true; }
  return false;
};

(function boot() {
  const s = loadSession();
  const msg = sessionStorage.getItem('mg:msg');
  sessionStorage.removeItem('mg:msg');
  try { const api = localStorage.getItem('mg:api'); if (api) API_BASE = api; } catch { /* */ }
  if (s?.token || s?.demo) startApp(s);
  else showLogin(msg);
})();
