import pytest

from orders import Order
from reports import group_by_status, summarize, top_orders


# ---------------------------------------------------------------- 汇总

def test_summarize_empty():
    assert summarize([]) == {"count": 0, "total": 0.0, "average": 0.0}


def test_summarize_basic():
    orders = [Order("R1", 10.0), Order("R2", 30.0)]
    result = summarize(orders)
    assert result["count"] == 2
    assert result["total"] == 40.0
    assert result["average"] == 20.0


def test_summarize_average_rounding():
    orders = [Order("R3", 10.0), Order("R4", 10.0), Order("R5", 10.0)]
    result = summarize(orders)
    assert result["average"] == pytest.approx(10.0)


# ---------------------------------------------------------------- TOP N

def test_top_orders():
    orders = [
        Order("T1", 5.0),
        Order("T2", 100.0),
        Order("T3", 50.0),
        Order("T4", 75.0),
    ]
    top = top_orders(orders, n=2)
    assert [o.order_id for o in top] == ["T2", "T4"]


def test_top_orders_more_than_available():
    orders = [Order("T5", 1.0)]
    assert len(top_orders(orders, n=10)) == 1


# ---------------------------------------------------------------- 分组

def test_group_by_status():
    a = Order("G1", 10.0)
    b = Order("G2", 20.0)
    c = Order("G3", 30.0)
    b.status = "cancelled"
    grouped = group_by_status([a, b, c])
    assert len(grouped["new"]) == 2
    assert len(grouped["cancelled"]) == 1


def test_group_by_status_empty():
    assert group_by_status([]) == {}


# ---------------------------------------------------------------- 大量失败（压力测试）

@pytest.mark.parametrize("index", list(range(12)))
def test_many_failures(index):
    # 12 个参数化失败：考验解析器能否逐一正确配对
    assert index < 6, "索引 {0} 超过阈值 6".format(index)
