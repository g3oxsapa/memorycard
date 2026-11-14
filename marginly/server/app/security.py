"""Пароли, токены сессий, коды из писем, подписи ссылок на фото."""
import hashlib
import hmac
import secrets

from . import config


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    key = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${key.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        _, salt, key = stored.split("$")
        got = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=2**14, r=8, p=1, dklen=32)
        return hmac.compare_digest(got.hex(), key)
    except Exception:
        return False


def new_token() -> str:
    return secrets.token_urlsafe(32)


def sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def new_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def blob_sig(blob_id: str) -> str:
    return hmac.new(config.SECRET, blob_id.encode(), hashlib.sha256).hexdigest()[:32]
