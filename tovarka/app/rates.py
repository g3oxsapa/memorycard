"""Курс юаня ЦБ РФ.

Пробуем два источника по очереди. Если интернета нет — используется
последний сохранённый курс (или тот, что вбит вручную в настройках).
"""

from __future__ import annotations

import json
import urllib.request
import xml.etree.ElementTree as ET

TIMEOUT = 8


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "tovarka/1.0"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read()


def _from_json() -> tuple[float, str]:
    data = json.loads(_get("https://www.cbr-xml-daily.ru/daily_json.js"))
    v = data["Valute"]["CNY"]
    return v["Value"] / v["Nominal"], data.get("Date", "")[:10]


def _from_xml() -> tuple[float, str]:
    root = ET.fromstring(_get("https://www.cbr.ru/scripts/XML_daily.asp"))
    for val in root.findall("Valute"):
        if val.findtext("CharCode") == "CNY":
            value = float(val.findtext("Value", "0").replace(",", "."))
            nominal = float(val.findtext("Nominal", "1"))
            return value / nominal, root.get("Date", "")
    raise ValueError("CNY не найден в ответе ЦБ")


def fetch_cny_cbr() -> tuple[float, str]:
    """Возвращает (курс ₽ за 1 ¥, дата курса). Бросает исключение, если оба источника недоступны."""
    errors = []
    for fn in (_from_json, _from_xml):
        try:
            rate, date = fn()
            if rate > 0:
                return round(rate, 4), date
        except Exception as e:  # noqa: BLE001 — сеть может упасть как угодно
            errors.append(f"{fn.__name__}: {e}")
    raise RuntimeError("; ".join(errors))
