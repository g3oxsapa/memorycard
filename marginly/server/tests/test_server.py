import io
import os
import re
import tempfile

os.environ["MARGINLY_DATA"] = tempfile.mkdtemp()

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from app import db, mailer  # noqa: E402
from app.main import app  # noqa: E402


def last_code(email):
    for m in reversed(mailer.OUTBOX):
        if m["to"] == email:
            return re.search(r"(\d{6})", m["subject"]).group(1)


def signup(cl, email, password="secret123"):
    assert cl.post("/api/auth/register", json={"email": email, "password": password}).status_code == 200
    r = cl.post("/api/auth/verify", json={"email": email, "code": last_code(email)})
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["token"]}


def test_auth_flow():
    with TestClient(app) as cl:
        e = "Anna@Example.com"
        assert cl.post("/api/auth/register", json={"email": e, "password": "short"}).status_code == 400
        assert cl.post("/api/auth/register", json={"email": e, "password": "secret123"}).status_code == 200
        # до подтверждения войти нельзя
        assert cl.post("/api/auth/login", json={"email": e, "password": "secret123"}).status_code == 403
        assert cl.post("/api/auth/verify", json={"email": e, "code": "000000"}).status_code in (400,)
        r = cl.post("/api/auth/verify", json={"email": e, "code": last_code("anna@example.com")})
        assert r.status_code == 200
        assert r.json()["user"]["plan"]["status"] == "trial"
        # повторная регистрация занятой почты
        assert cl.post("/api/auth/register", json={"email": e, "password": "secret123"}).status_code == 409
        assert cl.post("/api/auth/login", json={"email": e, "password": "wrong-pass"}).status_code == 401
        tok = cl.post("/api/auth/login", json={"email": e, "password": "secret123"}).json()["token"]
        h = {"Authorization": "Bearer " + tok}
        assert cl.get("/api/me", headers=h).json()["email"] == "anna@example.com"
        # сброс пароля выкидывает со всех устройств
        cl.post("/api/auth/forgot", json={"email": e})
        r = cl.post("/api/auth/reset", json={"email": e, "code": last_code("anna@example.com"), "password": "newpass123"})
        assert r.status_code == 200
        assert cl.get("/api/me", headers=h).status_code == 401
        assert cl.post("/api/auth/login", json={"email": e, "password": "newpass123"}).status_code == 200
        assert cl.get("/api/me").status_code == 401


def test_code_attempts_limited():
    with TestClient(app) as cl:
        e = "brute@example.com"
        cl.post("/api/auth/register", json={"email": e, "password": "secret123"})
        for _ in range(5):
            cl.post("/api/auth/verify", json={"email": e, "code": "999999" if last_code(e) != "999999" else "111111"})
        r = cl.post("/api/auth/verify", json={"email": e, "code": last_code(e)})
        assert r.status_code == 429


def test_sync_and_isolation():
    with TestClient(app) as cl:
        a = signup(cl, "a@example.com")
        b = signup(cl, "b@example.com")
        r = cl.post("/api/sync", headers=a, json={"cursor": 0, "changes": [
            {"path": "batches/b1", "data": {"name": "Партия 1"}},
            {"path": "items/i1", "data": {"title": "Худи", "qty": 3}},
            {"path": "evil/x", "data": {}},
        ]}).json()
        assert [x["reason"] for x in r["rejected"]] == ["bad_path"]
        assert {c["path"] for c in r["changes"]} == {"batches/b1", "items/i1"}
        cur = r["cursor"]
        # второе устройство того же пользователя видит данные
        r2 = cl.post("/api/sync", headers=a, json={"cursor": 0}).json()
        assert len(r2["changes"]) == 2
        # чужой пользователь не видит
        assert cl.post("/api/sync", headers=b, json={"cursor": 0}).json()["changes"] == []
        # удаление и инкрементальная выдача
        r3 = cl.post("/api/sync", headers=a, json={"cursor": cur, "changes": [{"path": "items/i1", "data": None}]}).json()
        assert r3["changes"] == [{"path": "items/i1", "data": None}]
        assert cl.post("/api/sync", headers=a, json={"cursor": r3["cursor"]}).json()["changes"] == []


def test_trial_limits_and_expiry():
    with TestClient(app) as cl:
        h = signup(cl, "t@example.com")
        ch = [{"path": "batches/b1", "data": {}}, {"path": "batches/b2", "data": {}}]
        ch += [{"path": f"items/i{n}", "data": {"n": n}} for n in range(12)]
        r = cl.post("/api/sync", headers=h, json={"cursor": 0, "changes": ch}).json()
        assert sorted(x["path"] for x in r["rejected"]) == ["batches/b2", "items/i10", "items/i11"]
        # изменение существующего не упирается в лимит, удаление освобождает место
        r = cl.post("/api/sync", headers=h, json={"changes": [{"path": "items/i0", "data": {"n": 100}},
                                                               {"path": "items/i1", "data": None},
                                                               {"path": "items/i10", "data": {}}]}).json()
        assert r["rejected"] == []
        # пробный период закончился — только просмотр
        with db.tx() as c:
            c.execute("UPDATE users SET trial_ends_at = '2000-01-01T00:00:00+00:00' WHERE email = 't@example.com'")
        r = cl.post("/api/sync", headers=h, json={"changes": [{"path": "items/i0", "data": {}}]}).json()
        assert r["plan"]["status"] == "expired" and r["rejected"][0]["reason"] == "subscription_required"
        assert len(cl.post("/api/sync", headers=h, json={"cursor": 0}).json()["changes"]) > 0
        # подписка снимает лимиты
        from app.admin import main as admin
        admin(["grant", "t@example.com", "30"])
        many = [{"path": f"items/x{n}", "data": {}} for n in range(30)]
        r = cl.post("/api/sync", headers=h, json={"changes": many}).json()
        assert r["plan"]["status"] == "active" and r["rejected"] == []


def test_blobs():
    with TestClient(app) as cl:
        h = signup(cl, "p@example.com")
        other = signup(cl, "q@example.com")
        buf = io.BytesIO(); Image.new("RGB", (3000, 2000), "red").save(buf, "PNG")
        r = cl.post("/api/blobs", headers=h, files={"file": ("a.png", buf.getvalue(), "image/png")}).json()
        img = cl.get(r["url"])
        assert img.status_code == 200 and max(Image.open(io.BytesIO(img.content)).size) == 1600
        assert cl.get(f"/api/blobs/{r['id']}?s=bad").status_code == 404
        assert cl.post("/api/blobs", headers=h, files={"file": ("x.txt", b"hi", "text/plain")}).status_code == 400
        assert cl.delete(f"/api/blobs/{r['id']}", headers=other).json()["deleted"] is False
        assert cl.delete(f"/api/blobs/{r['id']}", headers=h).json()["deleted"] is True
        assert cl.get(r["url"]).status_code == 404


def test_delete_account():
    with TestClient(app) as cl:
        h = signup(cl, "del@example.com")
        assert cl.request("DELETE", "/api/me", headers=h, json={"password": "nope"}).status_code == 401
        assert cl.request("DELETE", "/api/me", headers=h, json={"password": "secret123"}).status_code == 200
        assert cl.get("/api/me", headers=h).status_code == 401


def test_login_rate_limit():
    with TestClient(app) as cl:
        signup(cl, "rl@example.com")
        for _ in range(10):
            assert cl.post("/api/auth/login", json={"email": "rl@example.com", "password": "bad-pass1"}).status_code == 401
        assert cl.post("/api/auth/login", json={"email": "rl@example.com", "password": "secret123"}).status_code == 429
