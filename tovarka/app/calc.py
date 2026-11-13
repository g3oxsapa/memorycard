"""Расчёты себестоимости и прибыли.

Чистые функции без базы данных — их легко проверять тестами.

Логика:
  * курс юаня для выкупа  = курс ЦБ + наценка (по умолчанию +0,5 ₽)
  * карго                 = общий вес × ставка $/кг × курс доллара карго
  * доставка по РФ        = фиксированная сумма на всю посылку
  * логистика (карго + РФ) раскладывается по вещам пропорционально весу
  * себестоимость 1 шт    = выкуп в ¥ × курс юаня + доля логистики
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class BatchParams:
    cny_rate: float          # итоговый курс юаня (ЦБ + наценка), ₽ за 1 ¥
    usd_rate: float          # курс доллара у карго, ₽ за 1 $
    cargo_usd_per_kg: float  # ставка карго, $ за 1 кг
    rf_delivery_rub: float   # доставка по РФ на всю посылку, ₽


@dataclass
class ItemIn:
    id: int
    qty: int
    weight_kg: float     # вес одной штуки
    buy_cny: float       # цена выкупа одной штуки в юанях
    sell_price: float    # цена продажи одной штуки
    reserved: int = 0


@dataclass
class SaleIn:
    item_id: int
    qty: int
    price: float         # цена за 1 шт
    extra_cost: float = 0.0  # доп. расходы по сделке (доставка за свой счёт и т.п.)
    returned: bool = False


@dataclass
class ItemCalc:
    id: int
    qty: int
    weight_kg: float
    total_weight_kg: float
    unit_buy_rub: float
    unit_logistics_rub: float
    unit_cost_rub: float
    unit_margin_rub: float       # плановая прибыль с 1 шт
    margin_pct: float            # плановая маржа, % от цены продажи
    sold: int
    reserved: int
    stock: int                   # свободный остаток
    revenue_rub: float           # фактическая выручка (за вычетом доп. расходов по сделкам)
    profit_rub: float            # фактическая прибыль по проданным


@dataclass
class BatchCalc:
    total_weight_kg: float
    cargo_rub: float
    rf_delivery_rub: float
    logistics_rub: float
    logistics_per_kg_rub: float
    buy_rub: float               # выкуп всех вещей в рублях
    expenses_rub: float          # прочие расходы партии
    total_cost_rub: float        # всего вложено
    units_total: int
    units_sold: int
    units_left: int
    planned_revenue_rub: float   # если всё продать по своей цене
    planned_profit_rub: float
    revenue_rub: float           # уже получено
    profit_rub: float            # прибыль по проданным (минус прочие расходы)
    payback_rub: float           # получено − вложено (минус = ещё не отбили)
    roi_pct: float               # плановый ROI
    breakeven_units: int | None  # сколько ещё штук продать, чтобы отбить (None — не отбить)
    items: dict[int, ItemCalc] = field(default_factory=dict)


def r2(x: float) -> float:
    return round(x + 0.0, 2)


def calc_batch(params: BatchParams, items: list[ItemIn], sales: list[SaleIn],
               expenses_rub: float = 0.0) -> BatchCalc:
    total_weight = sum(max(i.qty, 0) * max(i.weight_kg, 0) for i in items)
    has_items = total_weight > 0
    cargo = total_weight * params.cargo_usd_per_kg * params.usd_rate
    rf = params.rf_delivery_rub if has_items else 0.0
    logistics = cargo + rf
    per_kg = logistics / total_weight if has_items else 0.0

    active_sales = [s for s in sales if not s.returned]
    by_item: dict[int, list[SaleIn]] = {}
    for s in active_sales:
        by_item.setdefault(s.item_id, []).append(s)

    calcs: dict[int, ItemCalc] = {}
    buy_total = 0.0
    planned_revenue = 0.0
    revenue = 0.0
    sold_cost = 0.0
    remaining_prices: list[float] = []

    for it in items:
        unit_buy = it.buy_cny * params.cny_rate
        unit_log = it.weight_kg * per_kg
        unit_cost = unit_buy + unit_log
        it_sales = by_item.get(it.id, [])
        sold = sum(s.qty for s in it_sales)
        it_revenue = sum(s.price * s.qty - s.extra_cost for s in it_sales)
        stock = max(it.qty - sold - it.reserved, 0)
        unsold = max(it.qty - sold, 0)

        buy_total += unit_buy * it.qty
        planned_revenue += it.sell_price * it.qty
        revenue += it_revenue
        sold_cost += unit_cost * sold
        remaining_prices += [it.sell_price] * unsold

        margin = it.sell_price - unit_cost
        calcs[it.id] = ItemCalc(
            id=it.id,
            qty=it.qty,
            weight_kg=it.weight_kg,
            total_weight_kg=r2(it.weight_kg * it.qty),
            unit_buy_rub=r2(unit_buy),
            unit_logistics_rub=r2(unit_log),
            unit_cost_rub=r2(unit_cost),
            unit_margin_rub=r2(margin),
            margin_pct=r2(margin / it.sell_price * 100) if it.sell_price else 0.0,
            sold=sold,
            reserved=it.reserved,
            stock=stock,
            revenue_rub=r2(it_revenue),
            profit_rub=r2(it_revenue - unit_cost * sold),
        )

    total_cost = buy_total + logistics + expenses_rub
    planned_profit = planned_revenue - total_cost
    payback = revenue - total_cost

    # Точка безубыточности: минимум штук, если продавать самые дорогие первыми.
    breakeven: int | None = 0
    if payback < 0:
        need = -payback
        breakeven = None
        acc = 0.0
        for n, price in enumerate(sorted(remaining_prices, reverse=True), start=1):
            acc += price
            if acc >= need - 1e-9:
                breakeven = n
                break

    units_total = sum(i.qty for i in items)
    units_sold = sum(c.sold for c in calcs.values())

    return BatchCalc(
        total_weight_kg=r2(total_weight),
        cargo_rub=r2(cargo),
        rf_delivery_rub=r2(rf),
        logistics_rub=r2(logistics),
        logistics_per_kg_rub=r2(per_kg),
        buy_rub=r2(buy_total),
        expenses_rub=r2(expenses_rub),
        total_cost_rub=r2(total_cost),
        units_total=units_total,
        units_sold=units_sold,
        units_left=max(units_total - units_sold, 0),
        planned_revenue_rub=r2(planned_revenue),
        planned_profit_rub=r2(planned_profit),
        revenue_rub=r2(revenue),
        profit_rub=r2(revenue - sold_cost - expenses_rub),
        payback_rub=r2(payback),
        roi_pct=r2(planned_profit / total_cost * 100) if total_cost else 0.0,
        breakeven_units=breakeven,
        items=calcs,
    )


def cny_with_markup(cbr_rate: float, markup: float) -> float:
    return r2(cbr_rate + markup)
