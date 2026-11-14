"""Сервер Marginly: аккаунты по почте, синхронизация данных, фото, тарифы."""
import io
import json
import re
import uuid
from contextlib import asynccontextmanager
from datetime import timedelta

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from pydantic import BaseModel, Field

from . import config, db, mailer, plans, rates, security

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PATH_RE = re.compile(r"^([A-Za-z0-9_\-.~:@+]{1,100})/([A-Za-z0-9_\-.~:@+]{1,200})$")


@asynccontextmanager
async def lifespan(_app):
    db.init()
    yield


app = FastAPI(title="Marginly", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=config.CORS_ORIGINS, allow_methods=["*"],
                   allow_headers=["Authorization", "Content-Type"])


# ───────── модели ─────────

class Credentials(BaseModel):
    email: str = Field(max_length=200)
    password: str = Field(max_length=200)


class EmailIn(BaseModel):
    email: str = Field(max_length=200)


class CodeIn(BaseModel):
    email: str = Field(max_length=200)
    code: str = Field(max_length=10)


class ResetIn(BaseModel):
    email: str = Field(max_length=200)
    code: str = Field(max_length=10)
    password: str = Field(max_length=200)


class PasswordIn(BaseModel):
    password: str = Field(max_length=200)


class Change(BaseModel):
    path: str = Field(max_length=310)
    data: dict | None = None        # None — удалить


class SyncIn(BaseModel):
    cursor: int = 0
    changes: list[Change] = []


# ───────── помощники ─────────

def norm_email(e: str) -> str:
    e = e.strip().lower()
    if not EMAIL_RE.match(e):
        raise HTTPException(400, "Проверь адрес почты")
    return e


def check_new_password(p: str) -> None:
    if len(p) < 8:
        raise HTTPException(400, "Пароль должен быть не короче 8 символов")


def issue_code(c, email: str, purpose: str) -> None:
    row = c.execute("SELECT sent_at FROM codes WHERE email=? AND purpose=?", (email, purpose)).fetchone()
    if row and (db.now() - db.parse(row["sent_at"])).total_seconds() < config.RESEND_COOLDOWN_SEC:
        raise HTTPException(429, "Код уже отправлен. Повторить можно через минуту")
    code = security.new_code()
    c.execute("INSERT OR REPLACE INTO codes(email, purpose, code_hash, expires_at, attempts, sent_at) VALUES (?,?,?,?,0,?)",
              (email, purpose, security.sha(code), db.iso(db.now() + timedelta(minutes=config.CODE_TTL_MIN)), db.iso(db.now())))
    mailer.send_code(email, purpose, code)


def use_code(c, email: str, purpose: str, code: str) -> None:
    row = c.execute("SELECT * FROM codes WHERE email=? AND purpose=?", (email, purpose)).fetchone()
    if not row or db.parse(row["expires_at"]) < db.now():
        raise HTTPException(400, "Код устарел. Запроси новый")
    if row["attempts"] >= config.CODE_MAX_ATTEMPTS:
        raise HTTPException(429, "Слишком много попыток. Запроси новый код")
    if security.sha(code.strip()) != row["code_hash"]:
        c.execute("UPDATE codes SET attempts = attempts + 1 WHERE email=? AND purpose=?", (email, purpose))
        c.commit()   # попытка должна засчитаться, даже если запрос завершится ошибкой
        raise HTTPException(400, "Неверный код")
    c.execute("DELETE FROM codes WHERE email=? AND purpose=?", (email, purpose))


def new_session(c, user_id: int) -> str:
    token = security.new_token()
    c.execute("INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)",
              (security.sha(token), user_id, db.iso(db.now()), db.iso(db.now() + timedelta(days=config.SESSION_DAYS))))
    return token


def user_out(user) -> dict:
    return {"email": user["email"], "plan": plans.plan_of(user)}


def current_user(authorization: str = Header(default="")):
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(401, "Нужно войти")
    c = db.connect()
    try:
        row = c.execute("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
                        "WHERE s.token_hash = ? AND s.expires_at > ?", (security.sha(token), db.iso(db.now()))).fetchone()
    finally:
        c.close()
    if not row:
        raise HTTPException(401, "Сессия закончилась. Войди заново")
    return row


# ───────── аккаунт ─────────

@app.post("/api/auth/register")
def register(body: Credentials):
    email = norm_email(body.email)
    check_new_password(body.password)
    with db.tx() as c:
        row = c.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if row and row["verified"]:
            raise HTTPException(409, "Эта почта уже зарегистрирована. Войди или сбрось пароль")
        if row:   # не подтвердил раньше — обновляем пароль и шлём новый код
            c.execute("UPDATE users SET password_hash = ? WHERE id = ?", (security.hash_password(body.password), row["id"]))
        else:
            c.execute("INSERT INTO users(email, password_hash, created_at) VALUES (?,?,?)",
                      (email, security.hash_password(body.password), db.iso(db.now())))
        issue_code(c, email, "verify")
    return {"ok": True, "message": "Мы отправили код на почту"}


@app.post("/api/auth/verify")
def verify(body: CodeIn):
    email = norm_email(body.email)
    with db.tx() as c:
        user = c.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if not user:
            raise HTTPException(400, "Неверный код")
        use_code(c, email, "verify", body.code)
        if not user["verified"]:
            c.execute("UPDATE users SET verified = 1, trial_ends_at = ? WHERE id = ?", (plans.trial_end_from_now(), user["id"]))
        token = new_session(c, user["id"])
        user = c.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
        return {"token": token, "user": user_out(user)}


@app.post("/api/auth/resend")
def resend(body: EmailIn):
    email = norm_email(body.email)
    with db.tx() as c:
        user = c.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if user and not user["verified"]:
            issue_code(c, email, "verify")
    return {"ok": True}


_failed_logins: dict[str, list[float]] = {}


@app.post("/api/auth/login")
def login(body: Credentials):
    email = norm_email(body.email)
    now_ts = db.now().timestamp()
    recent = [t for t in _failed_logins.get(email, []) if now_ts - t < 900]
    if len(recent) >= 10:
        raise HTTPException(429, "Слишком много попыток входа. Подожди 15 минут или сбрось пароль")
    with db.tx() as c:
        user = c.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if not user or not security.check_password(body.password, user["password_hash"]):
            _failed_logins[email] = recent + [now_ts]
            raise HTTPException(401, "Неверная почта или пароль")
        _failed_logins.pop(email, None)
        if not user["verified"]:
            try:
                issue_code(c, email, "verify")
            except HTTPException:
                pass
            raise HTTPException(403, "Почта не подтверждена. Мы отправили код ещё раз")
        return {"token": new_session(c, user["id"]), "user": user_out(user)}


@app.post("/api/auth/forgot")
def forgot(body: EmailIn):
    email = norm_email(body.email)
    with db.tx() as c:
        user = c.execute("SELECT * FROM users WHERE email = ? AND verified = 1", (email,)).fetchone()
        if user:
            issue_code(c, email, "reset")
    return {"ok": True, "message": "Если такая почта есть, мы отправили на неё код"}


@app.post("/api/auth/reset")
def reset(body: ResetIn):
    email = norm_email(body.email)
    check_new_password(body.password)
    with db.tx() as c:
        user = c.execute("SELECT * FROM users WHERE email = ? AND verified = 1", (email,)).fetchone()
        if not user:
            raise HTTPException(400, "Неверный код")
        use_code(c, email, "reset", body.code)
        c.execute("UPDATE users SET password_hash = ? WHERE id = ?", (security.hash_password(body.password), user["id"]))
        c.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))   # выйти на всех устройствах
        return {"token": new_session(c, user["id"]), "user": user_out(user)}


@app.post("/api/auth/logout")
def logout(authorization: str = Header(default="")):
    token = authorization.removeprefix("Bearer ").strip()
    with db.tx() as c:
        c.execute("DELETE FROM sessions WHERE token_hash = ?", (security.sha(token),))
    return {"ok": True}


@app.get("/api/me")
def me(user=Depends(current_user)):
    return user_out(user)


@app.delete("/api/me")
def delete_account(body: PasswordIn, user=Depends(current_user)):
    if not security.check_password(body.password, user["password_hash"]):
        raise HTTPException(401, "Неверный пароль")
    with db.tx() as c:
        blobs = [r["id"] for r in c.execute("SELECT id FROM blobs WHERE user_id = ?", (user["id"],))]
        c.execute("DELETE FROM users WHERE id = ?", (user["id"],))
    for b in blobs:
        (config.BLOBS_DIR / f"{b}.jpg").unlink(missing_ok=True)
    return {"ok": True}


# ───────── синхронизация ─────────

@app.post("/api/sync")
def sync(body: SyncIn, user=Depends(current_user)):
    if len(body.changes) > config.MAX_SYNC_CHANGES:
        raise HTTPException(413, "Слишком много изменений за раз")
    plan = plans.plan_of(user)
    rejected = []
    with db.tx() as c:
        alive = lambda coll: c.execute(  # noqa: E731
            "SELECT COUNT(*) FROM docs WHERE user_id = ? AND path LIKE ? AND data IS NOT NULL",
            (user["id"], coll + "/%")).fetchone()[0]
        counts = {"batches": alive("batches"), "items": alive("items")} if plan["limits"] else {}
        for ch in body.changes:
            m = PATH_RE.match(ch.path)
            if not m or m.group(1) not in config.COLLECTIONS:
                rejected.append({"path": ch.path, "reason": "bad_path"})
                continue
            if not plan["can_write"]:
                rejected.append({"path": ch.path, "reason": "subscription_required"})
                continue
            payload = None if ch.data is None else json.dumps(ch.data, ensure_ascii=False, separators=(",", ":"))
            if payload and len(payload.encode()) > config.MAX_DOC_BYTES:
                rejected.append({"path": ch.path, "reason": "too_large"})
                continue
            coll = m.group(1)
            if plan["limits"] and coll in counts:
                exists = c.execute("SELECT data IS NOT NULL FROM docs WHERE user_id = ? AND path = ?",
                                   (user["id"], ch.path)).fetchone()
                was_alive = bool(exists and exists[0])
                if payload is not None and not was_alive:
                    if counts[coll] + 1 > plan["limits"][coll]:
                        rejected.append({"path": ch.path, "reason": "trial_limit"})
                        continue
                    counts[coll] += 1
                elif payload is None and was_alive:
                    counts[coll] -= 1
            c.execute("INSERT INTO docs(user_id, path, data, seq, updated_at) VALUES (?,?,?,?,?) "
                      "ON CONFLICT(user_id, path) DO UPDATE SET data = excluded.data, seq = excluded.seq, "
                      "updated_at = excluded.updated_at",
                      (user["id"], ch.path, payload, db.next_seq(c), db.iso(db.now())))
        rows = c.execute("SELECT path, data, seq FROM docs WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT 5000",
                         (user["id"], body.cursor)).fetchall()
    cursor = rows[-1]["seq"] if rows else body.cursor
    return {
        "cursor": cursor,
        "more": len(rows) == 5000,
        "changes": [{"path": r["path"], "data": json.loads(r["data"]) if r["data"] else None} for r in rows],
        "rejected": rejected,
        "plan": plan,
    }


# ───────── фото ─────────

@app.post("/api/blobs")
async def upload_blob(file: UploadFile = File(...), user=Depends(current_user)):
    if not plans.plan_of(user)["can_write"]:
        raise HTTPException(402, "Пробный период закончился. Оформи подписку, чтобы добавлять фото")
    raw = await file.read(config.MAX_PHOTO_BYTES + 1)
    if len(raw) > config.MAX_PHOTO_BYTES:
        raise HTTPException(413, "Фото слишком большое")
    try:
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
    except Exception as e:
        raise HTTPException(400, "Это не картинка") from e
    img.thumbnail((1600, 1600))
    blob_id = uuid.uuid4().hex
    out = config.BLOBS_DIR / f"{blob_id}.jpg"
    img.save(out, "JPEG", quality=82, optimize=True)
    with db.tx() as c:
        c.execute("INSERT INTO blobs(id, user_id, size, created_at) VALUES (?,?,?,?)",
                  (blob_id, user["id"], out.stat().st_size, db.iso(db.now())))
    sig = security.blob_sig(blob_id)
    return {"id": blob_id, "sig": sig, "url": f"/api/blobs/{blob_id}?s={sig}"}


@app.get("/api/blobs/{blob_id}")
def get_blob(blob_id: str, s: str = ""):
    if not re.fullmatch(r"[0-9a-f]{32}", blob_id) or s != security.blob_sig(blob_id):
        raise HTTPException(404, "Фото не найдено")
    f = config.BLOBS_DIR / f"{blob_id}.jpg"
    if not f.exists():
        raise HTTPException(404, "Фото не найдено")
    return FileResponse(f, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=31536000, immutable"})


@app.delete("/api/blobs/{blob_id}")
def delete_blob(blob_id: str, user=Depends(current_user)):
    with db.tx() as c:
        cur = c.execute("DELETE FROM blobs WHERE id = ? AND user_id = ?", (blob_id, user["id"]))
    if cur.rowcount:
        (config.BLOBS_DIR / f"{blob_id}.jpg").unlink(missing_ok=True)
    return {"ok": True, "deleted": bool(cur.rowcount)}


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/rate")
def rate():
    """Курс юаня ЦБ, общий для всех. Кэшируется на сервере на 3 часа."""
    r = rates.cny()
    if not r:
        raise HTTPException(503, "Курс ЦБ сейчас недоступен")
    return r


# веб-версия приложения (собирается из client/ скриптом build.py)
if config.WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=config.WEB_DIR, html=True), name="web")
