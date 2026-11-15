#!/usr/bin/env bash
# Установка и обновление сервера Marginly на чистый Ubuntu 22.04/24.04.
# Запуск (от root):  curl -fsSL https://raw.githubusercontent.com/g3oxsapa/memorycard/claude/avito-inventory-app-16ub7w/marginly/deploy/install.sh | bash
# Повторный запуск обновляет код и перезапускает сервер, настройки сохраняются.
set -euo pipefail

REPO="https://github.com/g3oxsapa/memorycard.git"
BRANCH="claude/avito-inventory-app-16ub7w"
APP_DIR="/opt/marginly"
DATA_DIR="/var/lib/marginly"
ENV_FILE="/etc/marginly.env"

[ "$(id -u)" = 0 ] || { echo "Запусти от root"; exit 1; }
say() { printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }

say "Ставлю нужные программы"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip git curl debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

say "Скачиваю Marginly"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin "$BRANCH" && git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
else
  git clone -q --depth 1 -b "$BRANCH" "$REPO" "$APP_DIR"
fi
python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install -q -r "$APP_DIR/marginly/server/requirements.txt"

id marginly >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin marginly
mkdir -p "$DATA_DIR" && chown marginly:marginly "$DATA_DIR" && chmod 700 "$DATA_DIR"

if [ ! -f "$ENV_FILE" ]; then
  say "Настройка (один раз)"
  IP=$(curl -fsS4 https://ifconfig.me || curl -fsS4 https://api.ipify.org)
  DEFAULT_DOMAIN="$(echo "$IP" | tr . -).sslip.io"
  read -rp "Домен сервера [Enter — $DEFAULT_DOMAIN]: " DOMAIN </dev/tty || true
  DOMAIN=${DOMAIN:-$DEFAULT_DOMAIN}
  read -rp "Почта для писем с кодами [marginly.app@gmail.com]: " MAIL </dev/tty || true
  MAIL=${MAIL:-marginly.app@gmail.com}
  read -rsp "Пароль приложения Google для $MAIL (ввод не виден): " PASS </dev/tty; echo
  umask 077
  cat > "$ENV_FILE" <<CONF
MARGINLY_DOMAIN=$DOMAIN
MARGINLY_DATA=$DATA_DIR
MARGINLY_SECRET=$(python3 -c 'import secrets;print(secrets.token_hex(32))')
MARGINLY_CORS=https://$DOMAIN,https://appassets.androidplatform.net
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=$MAIL
SMTP_PASSWORD=${PASS// /}
MAIL_FROM=Marginly <$MAIL>
CONF
  chown root:marginly "$ENV_FILE" && chmod 640 "$ENV_FILE"
fi
DOMAIN=$(grep '^MARGINLY_DOMAIN=' "$ENV_FILE" | cut -d= -f2)

say "Запускаю сервер"
cat > /etc/systemd/system/marginly.service <<UNIT
[Unit]
Description=Marginly
After=network.target

[Service]
User=marginly
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_DIR/marginly/server
ExecStart=$APP_DIR/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8080 --proxy-headers
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
    encode gzip
    reverse_proxy 127.0.0.1:8080
}
CADDY
systemctl daemon-reload
systemctl enable -q --now marginly
systemctl restart marginly caddy
command -v ufw >/dev/null && ufw status | grep -q active && { ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; }

say "Проверяю"
for i in $(seq 1 20); do curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:8080/api/health >/dev/null && echo "Сервер работает" || { echo "Сервер не запустился:"; journalctl -u marginly -n 30 --no-pager; exit 1; }
"$APP_DIR/.venv/bin/python" - <<'PY' && echo "Почта: вход в Gmail успешен" || echo "Почта: не удалось войти — проверь пароль приложения (sudo nano /etc/marginly.env)"
import os, smtplib, ssl
env = dict(l.strip().split("=", 1) for l in open("/etc/marginly.env") if "=" in l)
with smtplib.SMTP_SSL(env["SMTP_HOST"], int(env["SMTP_PORT"]), context=ssl.create_default_context(), timeout=15) as s:
    s.login(env["SMTP_USER"], env["SMTP_PASSWORD"])
PY

echo
echo "Готово. Marginly: https://$DOMAIN"
echo "Первый запуск HTTPS может занять до минуты."
