"""SQLite-хранилище. Один файл data/tovarka.db, фото — в data/photos."""

from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

DATA_DIR = Path(os.environ.get("TOVARKA_DATA", Path(__file__).resolve().parent.parent / "data"))
PHOTOS_DIR = DATA_DIR / "photos"
DB_PATH = DATA_DIR / "tovarka.db"

DEFAULT_SETTINGS = {
    "cny_markup": "0.5",          # +₽ к курсу ЦБ за 1 юань
    "usd_rate": "89.5",           # курс доллара у карго
    "cargo_usd_per_kg": "2.9",    # ставка карго
    "rf_delivery_rub": "2000",    # доставка по РФ на посылку
    "stale_days": "14",           # через сколько дней вещь считается залежавшейся
    "cny_cbr": "11.0",            # последний известный курс ЦБ (обновляется автоматически)
    "cny_cbr_date": "",
}

# (название, вес 1 шт в кг, цена продажи по умолчанию)
DEFAULT_CATEGORIES = [
    ("Футболка", 0.3, 2000),
    ("Худи / свитшот", 0.8, 3000),
    ("Штаны", 0.6, 2500),
    ("Куртка / ветровка", 1.0, 3500),
    ("Пуховик", 1.5, 4000),
    ("Обувь (с коробкой)", 1.5, 4000),
    ("Аксессуары", 0.2, 1000),
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    weight_kg REAL NOT NULL,
    default_price REAL NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'transit',   -- transit | received
    created_at TEXT NOT NULL,
    received_at TEXT,
    cny_cbr REAL NOT NULL,
    cny_markup REAL NOT NULL,
    usd_rate REAL NOT NULL,
    cargo_usd_per_kg REAL NOT NULL,
    rf_delivery_rub REAL NOT NULL,
    note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '',
    size TEXT NOT NULL DEFAULT '',
    qty INTEGER NOT NULL DEFAULT 1,
    weight_kg REAL NOT NULL,
    buy_cny REAL NOT NULL DEFAULT 0,
    sell_price REAL NOT NULL DEFAULT 0,
    reserved INTEGER NOT NULL DEFAULT 0,
    listed INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    qty INTEGER NOT NULL DEFAULT 1,
    price REAL NOT NULL,
    extra_cost REAL NOT NULL DEFAULT 0,
    sold_at TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'Авито',
    note TEXT NOT NULL DEFAULT '',
    returned INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY,
    batch_id INTEGER REFERENCES batches(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    amount REAL NOT NULL,
    spent_at TEXT NOT NULL
);
"""


def now_iso() -> str:
    return datetime.now().replace(microsecond=0).isoformat(sep=" ")


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def tx():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> bool:
    """Создаёт таблицы и значения по умолчанию. Возвращает True, если база новая."""
    with tx() as c:
        fresh = c.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='settings'"
        ).fetchone() is None
        c.executescript(SCHEMA)
        for k, v in DEFAULT_SETTINGS.items():
            c.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (k, v))
        if c.execute("SELECT COUNT(*) FROM categories").fetchone()[0] == 0:
            for n, (name, w, price) in enumerate(DEFAULT_CATEGORIES):
                c.execute(
                    "INSERT INTO categories(name, weight_kg, default_price, sort) VALUES (?,?,?,?)",
                    (name, w, price, n),
                )
    return fresh


def get_settings(c: sqlite3.Connection) -> dict[str, str]:
    return {r["key"]: r["value"] for r in c.execute("SELECT key, value FROM settings")}


def set_setting(c: sqlite3.Connection, key: str, value) -> None:
    c.execute(
        "INSERT INTO settings(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, str(value)),
    )


def seed_first_batch(c: sqlite3.Connection) -> None:
    """Первая партия пользователя — цены в юанях пустые, их вбивают в приложении."""
    s = get_settings(c)
    cats = {r["name"]: r for r in c.execute("SELECT * FROM categories")}
    cur = c.execute(
        "INSERT INTO batches(name, status, created_at, received_at, cny_cbr, cny_markup, usd_rate,"
        " cargo_usd_per_kg, rf_delivery_rub) VALUES (?,?,?,?,?,?,?,?,?)",
        ("Партия №1", "received", now_iso(), now_iso(), float(s["cny_cbr"]), float(s["cny_markup"]),
         float(s["usd_rate"]), float(s["cargo_usd_per_kg"]), float(s["rf_delivery_rub"])),
    )
    bid = cur.lastrowid
    hoodie, puffer = cats["Худи / свитшот"], cats["Пуховик"]
    rows = [
        (hoodie, "Chrome Hearts Matty Boy", "серый", 3, 3000),
        (hoodie, "Chrome Hearts Matty Boy", "синий", 3, 3000),
        (hoodie, "Stone Island «зебра»", "", 3, 3000),
        (puffer, "C.P. Company пуховик", "", 1, 4000),
    ]
    for cat, title, color, qty, price in rows:
        c.execute(
            "INSERT INTO items(batch_id, category_id, title, color, qty, weight_kg, buy_cny,"
            " sell_price, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (bid, cat["id"], title, color, qty, cat["weight_kg"], 0, price, now_iso()),
        )
