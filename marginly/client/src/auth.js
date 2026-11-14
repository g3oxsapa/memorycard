'use strict';
/* Экраны входа и регистрации. После успеха — startApp(session). */

function authShell(title, inner) {
  document.body.classList.add('auth-mode');
  view.innerHTML = `
    <div class="auth">
      <div class="auth-brand">${BRAND_SVG}<span>Marginly</span></div>
      <p class="auth-tag">Учёт партий из Китая: карго, себестоимость, склад и прибыль</p>
      <div class="card auth-card">
        <h1>${esc(title)}</h1>
        ${inner}
      </div>
    </div>`;
}

const authState = { email: '' };

function authError(el, e) { el.textContent = e.message || String(e); el.hidden = false; }

function bindForm(handler) {
  const f = $('#auth-form'), err = $('#auth-err'), btn = $('#auth-form button[type=submit]');
  f.onsubmit = async (e) => {
    e.preventDefault();
    err.hidden = true; btn.disabled = true;
    try { await handler(formData(f)); } catch (x) { authError(err, x); } finally { btn.disabled = false; }
  };
}

function finishAuth(res, email) {
  const session = { token: res.token, email: res.user.email || email };
  saveSession(session);
  document.body.classList.remove('auth-mode');
  startApp(session, res.user.plan);
}

function showLogin(msg) {
  authShell('Вход', `
    ${msg ? `<p class="auth-note">${esc(msg)}</p>` : ''}
    <form id="auth-form" novalidate>
      <label class="f"><span>Почта</span><input id="a-email" name="email" type="email" autocomplete="email" required value="${esc(authState.email)}"></label>
      <label class="f"><span>Пароль</span><input id="a-pass" name="password" type="password" autocomplete="current-password" required></label>
      <p class="neg small" id="auth-err" hidden></p>
      <button type="submit" class="primary block">Войти</button>
    </form>
    <div class="auth-links"><a href="#" id="go-register">Регистрация</a><a href="#" id="go-forgot">Забыли пароль?</a></div>
    <div class="auth-demo"><button class="block" id="go-demo">Попробовать без регистрации</button>
      <p class="hint-line">Данные будут только на этом устройстве. Ограничения как в пробной неделе: 1 партия и до 10 товаров.</p></div>
    ${window.__APP_ANDROID ? `<p class="auth-server small muted">Сервер: ${API_BASE ? esc(API_BASE) : 'не задан'} · <a href="#" id="go-server">изменить</a></p>` : ''}`);
  bindForm(async (d) => {
    authState.email = d.email;
    try {
      finishAuth(await http('/api/auth/login', { method: 'POST', body: d }), d.email);
    } catch (e) {
      if (e.status === 403) return showVerify(d.email, e.message);
      throw e;
    }
  });
  $('#go-register').onclick = (e) => { e.preventDefault(); showRegister(); };
  $('#go-forgot').onclick = (e) => { e.preventDefault(); showForgot(); };
  $('#go-demo').onclick = () => { const s = { demo: true, email: 'demo' }; saveSession(s); startApp(s); };
  $('#go-server')?.addEventListener('click', (e) => { e.preventDefault(); showServer(); });
}

function showServer() {
  authShell('Адрес сервера', `
    <p class="auth-note">Обычно менять не нужно. Адрес сервера Marginly появится, когда сервис запустится.</p>
    <form id="auth-form" novalidate>
      <label class="f"><span>Адрес</span><input name="url" type="url" placeholder="https://api.marginly.ru" value="${esc(API_BASE)}"></label>
      <p class="neg small" id="auth-err" hidden></p>
      <button type="submit" class="primary block">Сохранить</button>
    </form>
    <div class="auth-links"><a href="#" id="go-login">Назад</a></div>`);
  bindForm(async (d) => {
    const url = (d.url || '').trim().replace(/\/+$/, '');
    if (url && !/^https:\/\/[^\s/]+/.test(url)) throw new Error('Адрес должен начинаться с https://');
    try { url ? localStorage.setItem('mg:api', url) : localStorage.removeItem('mg:api'); } catch { /* */ }
    API_BASE = url;
    showLogin(url ? 'Адрес сохранён' : 'Адрес сброшен');
  });
  $('#go-login').onclick = (e) => { e.preventDefault(); showLogin(); };
}

function showRegister() {
  authShell('Регистрация', `
    <p class="auth-note">Первая неделя бесплатно: 1 партия и до 10 товаров. Дальше — ${PRICE_RUB} ₽ в месяц.</p>
    <form id="auth-form" novalidate>
      <label class="f"><span>Почта</span><input id="r-email" name="email" type="email" autocomplete="email" required value="${esc(authState.email)}"></label>
      <label class="f"><span>Пароль, от 8 символов</span><input id="r-pass" name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      <label class="check"><input type="checkbox" id="r-agree" name="agree"> <span>Принимаю <a href="${LEGAL.terms}" target="_blank" rel="noopener">условия</a> и <a href="${LEGAL.privacy}" target="_blank" rel="noopener">политику конфиденциальности</a>, даю согласие на обработку персональных данных</span></label>
      <p class="neg small" id="auth-err" hidden></p>
      <button type="submit" class="primary block">Зарегистрироваться</button>
    </form>
    <div class="auth-links"><a href="#" id="go-login">У меня уже есть аккаунт</a></div>`);
  bindForm(async (d) => {
    if (!d.agree) throw new Error('Нужно принять условия и дать согласие на обработку данных');
    if ((d.password || '').length < 8) throw new Error('Пароль должен быть не короче 8 символов');
    authState.email = d.email;
    await http('/api/auth/register', { method: 'POST', body: { email: d.email, password: d.password } });
    showVerify(d.email);
  });
  $('#go-login').onclick = (e) => { e.preventDefault(); showLogin(); };
}

function showVerify(email, msg) {
  authShell('Подтверди почту', `
    <p class="auth-note">${esc(msg || 'Мы отправили 6-значный код на')} <b>${esc(email)}</b>. Если письма нет, проверь «Спам».</p>
    <form id="auth-form" novalidate>
      <label class="f"><span>Код из письма</span><input id="v-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required class="code-input"></label>
      <p class="neg small" id="auth-err" hidden></p>
      <button type="submit" class="primary block">Подтвердить</button>
    </form>
    <div class="auth-links"><a href="#" id="resend">Отправить код ещё раз</a><a href="#" id="go-login">Назад</a></div>`);
  bindForm(async (d) => finishAuth(await http('/api/auth/verify', { method: 'POST', body: { email, code: d.code } }), email));
  $('#resend').onclick = async (e) => {
    e.preventDefault();
    try { await http('/api/auth/resend', { method: 'POST', body: { email } }); toast('Код отправлен ещё раз'); } catch (x) { toast(x.message); }
  };
  $('#go-login').onclick = (e) => { e.preventDefault(); showLogin(); };
}

function showForgot() {
  authShell('Сброс пароля', `
    <p class="auth-note">Пришлём код на почту, и ты задашь новый пароль.</p>
    <form id="auth-form" novalidate>
      <label class="f"><span>Почта</span><input id="f-email" name="email" type="email" autocomplete="email" required value="${esc(authState.email)}"></label>
      <p class="neg small" id="auth-err" hidden></p>
      <button type="submit" class="primary block">Прислать код</button>
    </form>
    <div class="auth-links"><a href="#" id="go-login">Назад ко входу</a></div>`);
  bindForm(async (d) => {
    authState.email = d.email;
    await http('/api/auth/forgot', { method: 'POST', body: { email: d.email } });
    showReset(d.email);
  });
  $('#go-login').onclick = (e) => { e.preventDefault(); showLogin(); };
}

function showReset(email) {
  authShell('Новый пароль', `
    <p class="auth-note">Если почта <b>${esc(email)}</b> зарегистрирована, на неё пришёл код.</p>
    <form id="auth-form" novalidate>
      <label class="f"><span>Код из письма</span><input id="p-code" name="code" inputmode="numeric" maxlength="6" required class="code-input"></label>
      <label class="f"><span>Новый пароль, от 8 символов</span><input id="p-pass" name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      <p class="neg small" id="auth-err" hidden></p>
      <button type="submit" class="primary block">Сохранить и войти</button>
    </form>
    <div class="auth-links"><a href="#" id="go-login">Назад ко входу</a></div>`);
  bindForm(async (d) => finishAuth(await http('/api/auth/reset', { method: 'POST', body: { email, code: d.code, password: d.password } }), email));
  $('#go-login').onclick = (e) => { e.preventDefault(); showLogin(); };
}
