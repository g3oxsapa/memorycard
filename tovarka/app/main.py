"""Товарка — учёт партий, склада и прибыли. Сервер FastAPI + SQLite."""

from __future__ import annotations

import io
import threading
import uuid
from contextlib import asynccontextmanager
from collections import defaultdict
from dataclasses import asdict
from datetime import date, datetime, timedelta
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from pydantic import BaseModel, Field

from . import db
from .calc import BatchParams, ItemIn, SaleIn, calc_batch, cny_with_markup, r2
from .rates import fetch_cny_cbr

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
MAX_PHOTO_SIDE = 1600



@asynccontextmanager
async def lifespan(_app):
    fresh = db.init_db()
    if fresh:
        with db.tx() as c:
            db.seed_first_batch(c)
    threading.Thread(target=_refresh_rate_quietly, daemon=True).start()
    yield


app = FastAPI(title="Товарка", lifespan=lifespan)


# ───────────────────────── модели запросов ─────────────────────────

class SettingsIn(BaseModel):
    cny_markup: float | None = None
    usd_rate: float | None = Field(None, gt=0)
    cargo_usd_per_kg: float | None = Field(None, ge=0)
    rf_delivery_rub: float | None = Field(None, ge=0)
    stale_days: int | None = Field(None, ge=1)
    cny_cbr: float | None = Field(None, gt=0)


class CategoryIn(BaseModel):
    name: str = Field(min_length=1)
    weight_kg: float = Field(gt=0)
    default_price: float = Field(0, ge=0)


class BatchIn(BaseModel):
    name: str | None = None
    status: str | None = Field(None, pattern="^(transit|received)$")
    note: str | None = None
    cny_cbr: float | None = Field(None, gt=0)
    cny_markup: float | None = None
    usd_rate: float | None = Field(None, gt=0)
    cargo_usd_per_kg: float | None = Field(None, ge=0)
    rf_delivery_rub: float | None = Field(None, ge=0)


class ItemCreate(BaseModel):
    category_id: int | None = None
    title: str = Field(min_length=1)
    color: str = ""
    size: str = ""
    qty: int = Field(1, ge=1)
    weight_kg: float | None = Field(None, gt=0)   # если не задан — берётся из категории
    buy_cny: float = Field(0, ge=0)
    sell_price: float | None = Field(None, ge=0)  # если не задана — из категории
    listed: bool = False
    note: str = ""


class ItemUpdate(BaseModel):
    category_id: int | None = None
    title: str | None = Field(None, min_length=1)
    color: str | None = None
    size: str | None = None
    qty: int | None = Field(None, ge=1)
    weight_kg: float | None = Field(None, gt=0)
    buy_cny: float | None = Field(None, ge=0)
    sell_price: float | None = Field(None, ge=0)
    reserved: int | None = Field(None, ge=0)
    listed: bool | None = None
    note: str | None = None


class SaleCreate(BaseModel):
    qty: int = Field(1, ge=1)
    price: float | None = Field(None, ge=0)   # по умолчанию — цена продажи товара
    extra_cost: float = Field(0, ge=0)
    sold_at: str | None = None
    channel: str = "Авито"
    note: str = ""
    from_reserved: bool = False               # снять бронь при продаже


class SaleUpdate(BaseModel):
    returned: bool | None = None
    price: float | None = Field(None, ge=0)
    extra_cost: float | None = Field(None, ge=0)
    note: str | None = None


class ExpenseIn(BaseModel):
    batch_id: int | None = None
    title: str = Field(min_length=1)
    amount: float = Field(gt=0)
    spent_at: str | None = None


# ───────────────────────── курс ЦБ ─────────────────────────

_rate_lock = threading.Lock()


def refresh_rate() -> dict:
    with _rate_lock:
        rate, rate_date = fetch_cny_cbr()
        with db.tx() as c:
            db.set_setting(c, "cny_cbr", rate)
            db.set_setting(c, "cny_cbr_date", rate_date or date.today().isoformat())
        return {"cny_cbr": rate, "date": rate_date}


def _refresh_rate_quietly() -> None:
    try:
        refresh_rate()
    except Exception:  # noqa: BLE001 — нет сети: остаётся последний сохранённый курс
        pass


# ───────────────────────── вспомогательное ─────────────────────────

def _row(r) -> dict:
    return dict(r) if r is not None else None


def _settings_out(c) -> dict:
    s = db.get_settings(c)
    out = {
        "cny_markup": float(s["cny_markup"]),
        "usd_rate": float(s["usd_rate"]),
        "cargo_usd_per_kg": float(s["cargo_usd_per_kg"]),
        "rf_delivery_rub": float(s["rf_delivery_rub"]),
        "stale_days": int(s["stale_days"]),
        "cny_cbr": float(s["cny_cbr"]),
        "cny_cbr_date": s.get("cny_cbr_date", ""),
    }
    out["cny_rate"] = cny_with_markup(out["cny_cbr"], out["cny_markup"])
    return out


def _photos_by_item(c, item_ids: list[int]) -> dict[int, list[dict]]:
    res: dict[int, list[dict]] = defaultdict(list)
    if not item_ids:
        return res
    q = ",".join("?" * len(item_ids))
    for p in c.execute(f"SELECT * FROM photos WHERE item_id IN ({q}) ORDER BY id", item_ids):
        res[p["item_id"]].append({"id": p["id"], "url": f"/photos/{p['filename']}"})
    return res


def _batch_full(c, batch_id: int) -> dict:
    b = c.execute("SELECT * FROM batches WHERE id = ?", (batch_id,)).fetchone()
    if b is None:
        raise HTTPException(404, "Партия не найдена")
    b = dict(b)
    cny_rate = cny_with_markup(b["cny_cbr"], b["cny_markup"])
    items = [dict(r) for r in c.execute(
        "SELECT i.*, cat.name AS category FROM items i "
        "LEFT JOIN categories cat ON cat.id = i.category_id "
        "WHERE i.batch_id = ? ORDER BY i.id", (batch_id,))]
    ids = [i["id"] for i in items]
    sales = []
    if ids:
        q = ",".join("?" * len(ids))
        sales = [dict(r) for r in c.execute(f"SELECT * FROM sales WHERE item_id IN ({q})", ids)]
    expenses = [dict(r) for r in c.execute(
        "SELECT * FROM expenses WHERE batch_id = ? ORDER BY spent_at DESC, id DESC", (batch_id,))]

    result = calc_batch(
        BatchParams(cny_rate, b["usd_rate"], b["cargo_usd_per_kg"], b["rf_delivery_rub"]),
        [ItemIn(i["id"], i["qty"], i["weight_kg"], i["buy_cny"], i["sell_price"], i["reserved"])
         for i in items],
        [SaleIn(s["item_id"], s["qty"], s["price"], s["extra_cost"], bool(s["returned"])) for s in sales],
        sum(e["amount"] for e in expenses),
    )
    photos = _photos_by_item(c, ids)
    calc = asdict(result)
    item_calcs = calc.pop("items")
    for i in items:
        i["listed"] = bool(i["listed"])
        i["calc"] = item_calcs[i["id"]]
        i["photos"] = photos.get(i["id"], [])
        i["batch_name"] = b["name"]
        i["batch_status"] = b["status"]
    b["cny_rate"] = cny_rate
    b["calc"] = calc
    b["items"] = items
    b["expenses"] = expenses
    b["missing_buy_price"] = sum(1 for i in items if i["buy_cny"] <= 0)
    return b


def _all_batches(c) -> list[dict]:
    ids = [r["id"] for r in c.execute("SELECT id FROM batches ORDER BY created_at DESC, id DESC")]
    return [_batch_full(c, i) for i in ids]


def _item_or_404(c, item_id: int) -> dict:
    r = c.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
    if r is None:
        raise HTTPException(404, "Товар не найден")
    return dict(r)


def _days_since(ts: str | None) -> int:
    if not ts:
        return 0
    try:
        return (datetime.now() - datetime.fromisoformat(ts)).days
    except ValueError:
        return 0


# ───────────────────────── настройки и категории ─────────────────────────

@app.get("/api/settings")
def get_settings():
    with db.tx() as c:
        return _settings_out(c)


@app.put("/api/settings")
def put_settings(body: SettingsIn):
    with db.tx() as c:
        for k, v in body.model_dump(exclude_none=True).items():
            db.set_setting(c, k, v)
        if body.cny_cbr is not None:
            db.set_setting(c, "cny_cbr_date", "вручную " + date.today().isoformat())
        return _settings_out(c)


@app.post("/api/rates/refresh")
def post_refresh_rate():
    try:
        refresh_rate()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Не удалось получить курс ЦБ: {e}") from e
    with db.tx() as c:
        return _settings_out(c)


@app.get("/api/categories")
def list_categories():
    with db.tx() as c:
        return [dict(r) for r in c.execute("SELECT * FROM categories ORDER BY sort, id")]


@app.post("/api/categories")
def create_category(body: CategoryIn):
    with db.tx() as c:
        sort = c.execute("SELECT COALESCE(MAX(sort), 0) + 1 FROM categories").fetchone()[0]
        cur = c.execute(
            "INSERT INTO categories(name, weight_kg, default_price, sort) VALUES (?,?,?,?)",
            (body.name.strip(), body.weight_kg, body.default_price, sort))
        return _row(c.execute("SELECT * FROM categories WHERE id = ?", (cur.lastrowid,)).fetchone())


@app.put("/api/categories/{cat_id}")
def update_category(cat_id: int, body: CategoryIn):
    with db.tx() as c:
        cur = c.execute("UPDATE categories SET name=?, weight_kg=?, default_price=? WHERE id=?",
                        (body.name.strip(), body.weight_kg, body.default_price, cat_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "Категория не найдена")
        return _row(c.execute("SELECT * FROM categories WHERE id = ?", (cat_id,)).fetchone())


@app.delete("/api/categories/{cat_id}")
def delete_category(cat_id: int):
    with db.tx() as c:
        c.execute("DELETE FROM categories WHERE id = ?", (cat_id,))
    return {"ok": True}


# ───────────────────────── партии ─────────────────────────

@app.get("/api/batches")
def list_batches():
    with db.tx() as c:
        out = []
        for b in _all_batches(c):
            b.pop("expenses")
            b["items_count"] = len(b.pop("items"))
            out.append(b)
        return out


@app.post("/api/batches")
def create_batch(body: BatchIn):
    with db.tx() as c:
        s = _settings_out(c)
        n = c.execute("SELECT COUNT(*) FROM batches").fetchone()[0] + 1
        status = body.status or "transit"
        cur = c.execute(
            "INSERT INTO batches(name, status, created_at, received_at, cny_cbr, cny_markup, usd_rate,"
            " cargo_usd_per_kg, rf_delivery_rub, note) VALUES (?,?,?,?,?,?,?,?,?,?)",
            ((body.name or "").strip() or f"Партия №{n}", status, db.now_iso(),
             db.now_iso() if status == "received" else None,
             body.cny_cbr or s["cny_cbr"],
             s["cny_markup"] if body.cny_markup is None else body.cny_markup,
             body.usd_rate or s["usd_rate"],
             s["cargo_usd_per_kg"] if body.cargo_usd_per_kg is None else body.cargo_usd_per_kg,
             s["rf_delivery_rub"] if body.rf_delivery_rub is None else body.rf_delivery_rub,
             body.note or ""))
        return _batch_full(c, cur.lastrowid)


@app.get("/api/batches/{batch_id}")
def get_batch(batch_id: int):
    with db.tx() as c:
        return _batch_full(c, batch_id)


@app.put("/api/batches/{batch_id}")
def update_batch(batch_id: int, body: BatchIn):
    with db.tx() as c:
        b = _batch_full(c, batch_id)
        data = body.model_dump(exclude_none=True)
        if "name" in data:
            data["name"] = data["name"].strip() or b["name"]
        if data.get("status") == "received" and not b["received_at"]:
            data["received_at"] = db.now_iso()
        if data:
            cols = ", ".join(f"{k} = ?" for k in data)
            c.execute(f"UPDATE batches SET {cols} WHERE id = ?", (*data.values(), batch_id))
        return _batch_full(c, batch_id)


@app.post("/api/batches/{batch_id}/use-current-rate")
def batch_use_current_rate(batch_id: int):
    """Подставить в партию текущий курс ЦБ (если партию заводили со старым курсом)."""
    with db.tx() as c:
        _batch_full(c, batch_id)
        s = _settings_out(c)
        c.execute("UPDATE batches SET cny_cbr = ? WHERE id = ?", (s["cny_cbr"], batch_id))
        return _batch_full(c, batch_id)


@app.delete("/api/batches/{batch_id}")
def delete_batch(batch_id: int):
    with db.tx() as c:
        files = [r["filename"] for r in c.execute(
            "SELECT p.filename FROM photos p JOIN items i ON i.id = p.item_id WHERE i.batch_id = ?",
            (batch_id,))]
        c.execute("DELETE FROM batches WHERE id = ?", (batch_id,))
    for f in files:
        (db.PHOTOS_DIR / f).unlink(missing_ok=True)
    return {"ok": True}


# ───────────────────────── товары ─────────────────────────

@app.post("/api/batches/{batch_id}/items")
def create_item(batch_id: int, body: ItemCreate):
    with db.tx() as c:
        _batch_full(c, batch_id)
        cat = None
        if body.category_id is not None:
            cat = c.execute("SELECT * FROM categories WHERE id = ?", (body.category_id,)).fetchone()
            if cat is None:
                raise HTTPException(400, "Нет такой категории")
        weight = body.weight_kg or (cat["weight_kg"] if cat else None)
        if not weight:
            raise HTTPException(400, "Выбери тип вещи — по нему ставится вес")
        price = body.sell_price if body.sell_price is not None else (cat["default_price"] if cat else 0)
        c.execute(
            "INSERT INTO items(batch_id, category_id, title, color, size, qty, weight_kg, buy_cny,"
            " sell_price, listed, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (batch_id, body.category_id, body.title.strip(), body.color.strip(), body.size.strip(),
             body.qty, weight, body.buy_cny, price, int(body.listed), body.note, db.now_iso()))
        return _batch_full(c, batch_id)


@app.put("/api/items/{item_id}")
def update_item(item_id: int, body: ItemUpdate):
    with db.tx() as c:
        it = _item_or_404(c, item_id)
        data = body.model_dump(exclude_unset=True)
        if "category_id" in data and data["category_id"] != it["category_id"] and "weight_kg" not in data:
            cat = c.execute("SELECT * FROM categories WHERE id = ?", (data["category_id"],)).fetchone()
            if cat is None:
                raise HTTPException(400, "Нет такой категории")
            data["weight_kg"] = cat["weight_kg"]
        data = {k: v for k, v in data.items() if v is not None}
        if "listed" in data:
            data["listed"] = int(data["listed"])
        qty = data.get("qty", it["qty"])
        sold = c.execute("SELECT COALESCE(SUM(qty),0) FROM sales WHERE item_id=? AND returned=0",
                         (item_id,)).fetchone()[0]
        if qty < sold:
            raise HTTPException(400, f"Уже продано {sold} шт — меньше нельзя")
        if data.get("reserved", it["reserved"]) > qty - sold:
            raise HTTPException(400, "Бронь больше, чем осталось")
        if data:
            cols = ", ".join(f"{k} = ?" for k in data)
            c.execute(f"UPDATE items SET {cols} WHERE id = ?", (*data.values(), item_id))
        return _batch_full(c, it["batch_id"])


@app.delete("/api/items/{item_id}")
def delete_item(item_id: int):
    with db.tx() as c:
        it = _item_or_404(c, item_id)
        files = [r["filename"] for r in c.execute("SELECT filename FROM photos WHERE item_id=?", (item_id,))]
        c.execute("DELETE FROM items WHERE id = ?", (item_id,))
        result = _batch_full(c, it["batch_id"])
    for f in files:
        (db.PHOTOS_DIR / f).unlink(missing_ok=True)
    return result


@app.get("/api/stock")
def stock():
    with db.tx() as c:
        stale_days = _settings_out(c)["stale_days"]
        out = []
        for b in _all_batches(c):
            for i in b["items"]:
                i["days_in_stock"] = _days_since(b["received_at"]) if b["status"] == "received" else 0
                i["stale"] = b["status"] == "received" and i["calc"]["stock"] > 0 \
                    and i["days_in_stock"] >= stale_days
                out.append(i)
        return out


# ───────────────────────── фото ─────────────────────────

@app.post("/api/items/{item_id}/photos")
async def upload_photos(item_id: int, files: list[UploadFile] = File(...)):
    with db.tx() as c:
        _item_or_404(c, item_id)
    saved = []
    for f in files:
        raw = await f.read()
        try:
            img = Image.open(io.BytesIO(raw))
            img = ImageOps.exif_transpose(img).convert("RGB")
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f"«{f.filename}» — не картинка") from e
        img.thumbnail((MAX_PHOTO_SIDE, MAX_PHOTO_SIDE))
        name = f"{uuid.uuid4().hex}.jpg"
        img.save(db.PHOTOS_DIR / name, "JPEG", quality=82, optimize=True)
        saved.append(name)
    with db.tx() as c:
        for name in saved:
            c.execute("INSERT INTO photos(item_id, filename, created_at) VALUES (?,?,?)",
                      (item_id, name, db.now_iso()))
        return _photos_by_item(c, [item_id]).get(item_id, [])


@app.delete("/api/photos/{photo_id}")
def delete_photo(photo_id: int):
    with db.tx() as c:
        p = c.execute("SELECT * FROM photos WHERE id = ?", (photo_id,)).fetchone()
        if p is None:
            raise HTTPException(404, "Фото не найдено")
        c.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
    (db.PHOTOS_DIR / p["filename"]).unlink(missing_ok=True)
    return {"ok": True}


# ───────────────────────── продажи ─────────────────────────

@app.post("/api/items/{item_id}/sales")
def create_sale(item_id: int, body: SaleCreate):
    with db.tx() as c:
        it = _item_or_404(c, item_id)
        sold = c.execute("SELECT COALESCE(SUM(qty),0) FROM sales WHERE item_id=? AND returned=0",
                         (item_id,)).fetchone()[0]
        free = it["qty"] - sold - it["reserved"]
        available = free + (it["reserved"] if body.from_reserved else 0)
        if body.qty > available:
            raise HTTPException(400, f"В наличии только {max(available, 0)} шт")
        if body.from_reserved:
            c.execute("UPDATE items SET reserved = MAX(reserved - ?, 0) WHERE id = ?", (body.qty, item_id))
        c.execute(
            "INSERT INTO sales(item_id, qty, price, extra_cost, sold_at, channel, note) VALUES (?,?,?,?,?,?,?)",
            (item_id, body.qty, it["sell_price"] if body.price is None else body.price, body.extra_cost,
             body.sold_at or db.now_iso(), body.channel, body.note))
        return _batch_full(c, it["batch_id"])


@app.get("/api/sales")
def list_sales():
    with db.tx() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT s.*, i.title, i.color, i.size, i.batch_id, b.name AS batch_name FROM sales s "
            "JOIN items i ON i.id = s.item_id JOIN batches b ON b.id = i.batch_id "
            "ORDER BY s.sold_at DESC, s.id DESC")]
        costs = {}
        for bid in {r["batch_id"] for r in rows}:
            for i in _batch_full(c, bid)["items"]:
                costs[i["id"]] = i["calc"]["unit_cost_rub"]
        for r in rows:
            r["returned"] = bool(r["returned"])
            unit_cost = costs.get(r["item_id"], 0)
            r["unit_cost_rub"] = unit_cost
            r["profit_rub"] = 0 if r["returned"] else r2(r["price"] * r["qty"] - r["extra_cost"] - unit_cost * r["qty"])
        return rows


@app.put("/api/sales/{sale_id}")
def update_sale(sale_id: int, body: SaleUpdate):
    with db.tx() as c:
        s = c.execute("SELECT * FROM sales WHERE id = ?", (sale_id,)).fetchone()
        if s is None:
            raise HTTPException(404, "Продажа не найдена")
        data = body.model_dump(exclude_none=True)
        if data.get("returned") is False and s["returned"]:
            it = _item_or_404(c, s["item_id"])
            sold = c.execute("SELECT COALESCE(SUM(qty),0) FROM sales WHERE item_id=? AND returned=0",
                             (s["item_id"],)).fetchone()[0]
            if sold + s["qty"] + it["reserved"] > it["qty"]:
                raise HTTPException(400, "Этот товар уже продан повторно — отменить возврат нельзя")
        if "returned" in data:
            data["returned"] = int(data["returned"])
        if data:
            cols = ", ".join(f"{k} = ?" for k in data)
            c.execute(f"UPDATE sales SET {cols} WHERE id = ?", (*data.values(), sale_id))
    return {"ok": True}


@app.delete("/api/sales/{sale_id}")
def delete_sale(sale_id: int):
    with db.tx() as c:
        c.execute("DELETE FROM sales WHERE id = ?", (sale_id,))
    return {"ok": True}


# ───────────────────────── расходы ─────────────────────────

@app.get("/api/expenses")
def list_expenses():
    with db.tx() as c:
        return [dict(r) for r in c.execute(
            "SELECT e.*, b.name AS batch_name FROM expenses e LEFT JOIN batches b ON b.id = e.batch_id "
            "ORDER BY e.spent_at DESC, e.id DESC")]


@app.post("/api/expenses")
def create_expense(body: ExpenseIn):
    with db.tx() as c:
        if body.batch_id is not None:
            _batch_full(c, body.batch_id)
        c.execute("INSERT INTO expenses(batch_id, title, amount, spent_at) VALUES (?,?,?,?)",
                  (body.batch_id, body.title.strip(), body.amount, body.spent_at or db.now_iso()))
    return {"ok": True}


@app.delete("/api/expenses/{exp_id}")
def delete_expense(exp_id: int):
    with db.tx() as c:
        c.execute("DELETE FROM expenses WHERE id = ?", (exp_id,))
    return {"ok": True}


# ───────────────────────── дашборд ─────────────────────────

@app.get("/api/dashboard")
def dashboard():
    with db.tx() as c:
        s = _settings_out(c)
        batches = _all_batches(c)
        general_exp = c.execute(
            "SELECT COALESCE(SUM(amount),0) FROM expenses WHERE batch_id IS NULL").fetchone()[0]

        def total(key):
            return sum(b["calc"][key] for b in batches)

        invested = total("total_cost_rub") + general_exp
        revenue = total("revenue_rub")
        profit = total("profit_rub") - general_exp
        planned_profit = total("planned_profit_rub") - general_exp

        # продажи по неделям за последние 8 недель
        today = date.today()
        start = today - timedelta(days=today.weekday()) - timedelta(weeks=7)
        weeks = [{"week": (start + timedelta(weeks=n)).isoformat(), "revenue": 0.0, "profit": 0.0, "units": 0}
                 for n in range(8)]
        unit_cost = {i["id"]: i["calc"]["unit_cost_rub"] for b in batches for i in b["items"]}
        items_by_id = {i["id"]: i for b in batches for i in b["items"]}
        for sale in c.execute("SELECT * FROM sales WHERE returned = 0"):
            try:
                d = datetime.fromisoformat(sale["sold_at"]).date()
            except ValueError:
                continue
            idx = (d - start).days // 7
            if 0 <= idx < 8:
                net = sale["price"] * sale["qty"] - sale["extra_cost"]
                weeks[idx]["revenue"] += net
                weeks[idx]["profit"] += net - unit_cost.get(sale["item_id"], 0) * sale["qty"]
                weeks[idx]["units"] += sale["qty"]
        for w in weeks:
            w["revenue"], w["profit"] = r2(w["revenue"]), r2(w["profit"])

        top = sorted(
            ({"id": i["id"], "title": i["title"], "color": i["color"], "sold": i["calc"]["sold"],
              "profit": i["calc"]["profit_rub"], "photo": (i["photos"][0]["url"] if i["photos"] else None)}
             for i in items_by_id.values() if i["calc"]["sold"] > 0),
            key=lambda x: x["profit"], reverse=True)[:5]

        stale = []
        for b in batches:
            if b["status"] != "received":
                continue
            days = _days_since(b["received_at"])
            if days < s["stale_days"]:
                continue
            for i in b["items"]:
                if i["calc"]["stock"] > 0:
                    stale.append({"id": i["id"], "title": i["title"], "color": i["color"],
                                  "stock": i["calc"]["stock"], "days": days, "batch_id": b["id"]})

        return {
            "settings": s,
            "invested_rub": r2(invested),
            "revenue_rub": r2(revenue),
            "profit_rub": r2(profit),
            "planned_profit_rub": r2(planned_profit),
            "payback_rub": r2(revenue - invested),
            "roi_pct": r2(planned_profit / invested * 100) if invested else 0.0,
            "units_total": total("units_total"),
            "units_sold": total("units_sold"),
            "units_left": total("units_left"),
            "stock_value_rub": r2(sum(i["calc"]["stock"] * i["sell_price"] for i in items_by_id.values())),
            "general_expenses_rub": r2(general_exp),
            "missing_buy_price": sum(b["missing_buy_price"] for b in batches),
            "weeks": weeks,
            "top": top,
            "stale": stale,
            "batches": [{"id": b["id"], "name": b["name"], "status": b["status"],
                         "missing_buy_price": b["missing_buy_price"],
                         **{k: b["calc"][k] for k in ("total_cost_rub", "revenue_rub", "profit_rub",
                                                       "planned_profit_rub", "payback_rub", "units_total",
                                                       "units_sold", "breakeven_units")}}
                        for b in batches],
        }


# ───────────────────────── статика ─────────────────────────

db.DATA_DIR.mkdir(parents=True, exist_ok=True)
db.PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/photos", StaticFiles(directory=db.PHOTOS_DIR), name="photos")
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
