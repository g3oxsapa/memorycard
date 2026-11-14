"""Курс юаня ЦБ РФ с кэшем: один запрос к ЦБ на всех пользователей."""
import json
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET

_cache = {"value": None, "at": 0.0}
_lock = threading.Lock()
TTL = 3 * 3600


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Marginly/1.0"})
    with urllib.request.urlopen(req, timeout=8) as r:
        return r.read()


def _fetch() -> dict | None:
    try:
        d = json.loads(_get("https://www.cbr-xml-daily.ru/daily_json.js"))
        v = d["Valute"]["CNY"]
        return {"rate": round(v["Value"] / v["Nominal"], 4), "date": d.get("Date", "")[:10]}
    except Exception:
        pass
    try:
        root = ET.fromstring(_get("https://www.cbr.ru/scripts/XML_daily.asp"))
        for v in root.findall("Valute"):
            if v.findtext("CharCode") == "CNY":
                rate = float(v.findtext("Value", "0").replace(",", ".")) / float(v.findtext("Nominal", "1"))
                dd, mm, yy = (root.get("Date") or "..").split(".")
                return {"rate": round(rate, 4), "date": f"{yy}-{mm}-{dd}"}
    except Exception:
        pass
    return None


def cny() -> dict | None:
    with _lock:
        if _cache["value"] and time.time() - _cache["at"] < TTL:
            return _cache["value"]
        v = _fetch()
        if v:
            _cache.update(value=v, at=time.time())
        return v or _cache["value"]
