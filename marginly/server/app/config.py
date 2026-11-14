"""Настройки сервера Marginly. Всё задаётся переменными окружения."""
import os
import secrets
from pathlib import Path

DATA_DIR = Path(os.environ.get("MARGINLY_DATA", Path(__file__).resolve().parent.parent / "data"))
DB_PATH = DATA_DIR / "marginly.db"
BLOBS_DIR = DATA_DIR / "blobs"

# Секрет для подписи ссылок на фото. В бою задаётся переменной, иначе создаётся и хранится в data/.
def _secret() -> bytes:
    env = os.environ.get("MARGINLY_SECRET")
    if env:
        return env.encode()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    f = DATA_DIR / "secret.key"
    if not f.exists():
        f.write_text(secrets.token_hex(32))
    return f.read_text().strip().encode()

SECRET = _secret()

TRIAL_DAYS = int(os.environ.get("MARGINLY_TRIAL_DAYS", "7"))
TRIAL_MAX_BATCHES = 1
TRIAL_MAX_ITEMS = 10
PRICE_RUB = 499

CODE_TTL_MIN = 15
CODE_MAX_ATTEMPTS = 5
RESEND_COOLDOWN_SEC = 60
SESSION_DAYS = 90

MAX_DOC_BYTES = 64 * 1024
MAX_PHOTO_BYTES = 8 * 1024 * 1024
MAX_SYNC_CHANGES = 500

# Почта. Без SMTP_HOST письма не отправляются, а пишутся в журнал (тестовый режим).
SMTP_HOST = os.environ.get("SMTP_HOST", "")  # Gmail: smtp.gmail.com, порт 465, пароль приложения
SMTP_PORT = int(os.environ.get("SMTP_PORT", "465"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
MAIL_FROM = os.environ.get("MAIL_FROM", "Marginly <marginly.app@gmail.com>")

CORS_ORIGINS = [o for o in os.environ.get(
    "MARGINLY_CORS", "https://appassets.androidplatform.net,http://localhost:8000").split(",") if o]

COLLECTIONS = {"app", "categories", "batches", "items", "orders", "expenses", "photos"}
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
