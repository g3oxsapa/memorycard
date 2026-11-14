"""Тарифы: пробная неделя с лимитами, подписка 499 ₽/мес, после окончания — только просмотр."""
from datetime import timedelta

from . import config, db


def plan_of(user) -> dict:
    now = db.now()
    paid_until = db.parse(user["paid_until"])
    trial_ends = db.parse(user["trial_ends_at"])
    if paid_until and paid_until > now:
        status = "active"
    elif trial_ends and trial_ends > now:
        status = "trial"
    else:
        status = "expired"
    limits = {"batches": config.TRIAL_MAX_BATCHES, "items": config.TRIAL_MAX_ITEMS} if status == "trial" else None
    return {
        "status": status,                     # trial | active | expired
        "trial_ends_at": user["trial_ends_at"],
        "paid_until": user["paid_until"],
        "limits": limits,
        "can_write": status != "expired",
        "price_rub": config.PRICE_RUB,
    }


def trial_end_from_now() -> str:
    return db.iso(db.now() + timedelta(days=config.TRIAL_DAYS))
