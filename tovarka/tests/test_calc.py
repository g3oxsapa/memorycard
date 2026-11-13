import pytest

from app.calc import BatchParams, ItemIn, SaleIn, calc_batch, cny_with_markup

P = BatchParams(cny_rate=11.5, usd_rate=89.5, cargo_usd_per_kg=2.9, rf_delivery_rub=2000)


def user_batch(buy=0):
    return [
        ItemIn(1, 3, 0.8, buy, 3000),
        ItemIn(2, 3, 0.8, buy, 3000),
        ItemIn(3, 3, 0.8, buy, 3000),
        ItemIn(4, 1, 1.5, buy, 4000),
    ]


def test_markup():
    assert cny_with_markup(11.0, 0.5) == 11.5


def test_logistics_of_user_batch():
    r = calc_batch(P, user_batch(), [])
    assert r.total_weight_kg == 8.7
    assert r.cargo_rub == pytest.approx(8.7 * 2.9 * 89.5, abs=0.01)  # 2258.09
    assert r.logistics_rub == pytest.approx(4258.09, abs=0.01)
    assert r.items[1].unit_logistics_rub == pytest.approx(391.55, abs=0.01)
    assert r.items[4].unit_logistics_rub == pytest.approx(734.15, abs=0.01)
    # логистика разложена полностью
    total = sum(c.unit_logistics_rub * c.qty for c in r.items.values())
    assert total == pytest.approx(r.logistics_rub, abs=0.05)
    assert r.planned_revenue_rub == 31000


def test_unit_cost_with_buy_price():
    r = calc_batch(P, user_batch(buy=100), [])
    assert r.items[1].unit_buy_rub == 1150
    assert r.items[1].unit_cost_rub == pytest.approx(1541.55, abs=0.01)
    assert r.buy_rub == 10 * 1150
    assert r.total_cost_rub == pytest.approx(11500 + 4258.09, abs=0.01)
    assert r.planned_profit_rub == pytest.approx(31000 - 15758.09, abs=0.01)


def test_sales_profit_and_breakeven():
    sales = [SaleIn(1, 2, 3000), SaleIn(4, 1, 4000, extra_cost=300), SaleIn(2, 1, 3000, returned=True)]
    r = calc_batch(P, user_batch(buy=100), sales, expenses_rub=500)
    assert r.units_sold == 3
    assert r.items[2].sold == 0 and r.items[2].stock == 3
    assert r.revenue_rub == 6000 + 3700
    expected_profit = (6000 - 2 * 1541.55) + (3700 - (1150 + 734.15)) - 500
    assert r.profit_rub == pytest.approx(expected_profit, abs=0.05)
    # вложено 16258.09, получено 9700 → не хватает 6558.12 → 3 худи по 3000
    assert r.breakeven_units == 3


def test_reserved_reduces_stock():
    items = [ItemIn(1, 3, 0.8, 0, 3000, reserved=1)]
    r = calc_batch(P, items, [SaleIn(1, 1, 3000)])
    assert r.items[1].stock == 1


def test_empty_batch():
    r = calc_batch(P, [], [])
    assert r.logistics_rub == 0 and r.total_cost_rub == 0 and r.breakeven_units == 0
