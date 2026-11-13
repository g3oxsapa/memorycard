import io
import os
import tempfile

os.environ["TOVARKA_DATA"] = tempfile.mkdtemp()

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from app.main import app  # noqa: E402


def test_full_flow():
    with TestClient(app) as cl:
        s = cl.put("/api/settings", json={"cny_cbr": 11.0}).json()
        assert s["cny_rate"] == 11.5 and s["usd_rate"] == 89.5

        batches = cl.get("/api/batches").json()
        assert len(batches) == 1 and batches[0]["items_count"] == 4
        b = cl.get(f"/api/batches/{batches[0]['id']}").json()
        assert b["calc"]["total_weight_kg"] == 8.7
        assert b["missing_buy_price"] == 4

        # новая партия берёт курс из настроек
        nb = cl.post("/api/batches", json={"name": "Тест"}).json()
        assert nb["cny_cbr"] == 11.0 and nb["status"] == "transit"
        cats = cl.get("/api/categories").json()
        hoodie = next(c for c in cats if c["name"].startswith("Худи"))
        nb = cl.post(f"/api/batches/{nb['id']}/items",
                     json={"category_id": hoodie["id"], "title": "Худи", "qty": 2, "buy_cny": 100}).json()
        item = nb["items"][0]
        assert item["weight_kg"] == 0.8 and item["sell_price"] == 3000
        assert item["calc"]["unit_buy_rub"] == 1150

        # фото
        buf = io.BytesIO()
        Image.new("RGB", (3000, 2000), "red").save(buf, "PNG")
        ph = cl.post(f"/api/items/{item['id']}/photos",
                     files=[("files", ("a.png", buf.getvalue(), "image/png"))]).json()
        assert len(ph) == 1
        img = cl.get(ph[0]["url"])
        assert img.status_code == 200
        assert max(Image.open(io.BytesIO(img.content)).size) == 1600
        assert cl.post(f"/api/items/{item['id']}/photos",
                       files=[("files", ("x.txt", b"hello", "text/plain"))]).status_code == 400

        # продажа и лимит остатка
        r = cl.post(f"/api/items/{item['id']}/sales", json={"qty": 2}).json()
        assert r["items"][0]["calc"]["sold"] == 2
        assert cl.post(f"/api/items/{item['id']}/sales", json={"qty": 1}).status_code == 400
        sales = cl.get("/api/sales").json()
        assert sales[0]["price"] == 3000 and sales[0]["profit_rub"] > 0

        # возврат возвращает на склад
        cl.put(f"/api/sales/{sales[0]['id']}", json={"returned": True})
        assert cl.get(f"/api/batches/{nb['id']}").json()["items"][0]["calc"]["stock"] == 2

        d = cl.get("/api/dashboard").json()
        assert d["units_total"] == 12 and len(d["weeks"]) == 8

        assert cl.get("/").status_code == 200
        cl.delete(f"/api/batches/{nb['id']}")
        assert len(cl.get("/api/batches").json()) == 1
