import pytest

from orders import Order, cancel_order, create_order, total_amount


# ---------------------------------------------------------------- 构造

def test_create_order_ok():
    order = create_order("A1", 100.0)
    assert order.order_id == "A1"
    assert order.amount == 100.0
    assert order.status == "new"


def test_create_order_rejects_zero():
    with pytest.raises(ValueError):
        create_order("A2", 0)


def test_create_order_negative_message():
    with pytest.raises(ValueError) as excinfo:
        create_order("A3", -5)
    assert "订单金额必须大于 0" in str(excinfo.value)


# ---------------------------------------------------------------- 取消（跨文件权限）

class TestCancelOrder:
    """嵌套类：解析器需要处理 class 内的测试。"""

    def test_cancel_as_editor(self):
        order = create_order("B1", 50.0, owner_role="editor")
        result = cancel_order(order)
        assert result.status == "cancelled"

    def test_cancel_as_viewer_raises(self):
        order = create_order("B2", 50.0, owner_role="viewer")
        with pytest.raises(Exception):
            cancel_order(order)

    def test_cancel_as_admin(self):
        order = create_order("B3", 50.0, owner_role="admin")
        assert cancel_order(order).status == "cancelled"


# ---------------------------------------------------------------- 汇总

def test_total_amount():
    orders = [Order("C1", 10.0), Order("C2", 20.5)]
    assert total_amount(orders) == 30.5


def test_total_amount_empty():
    assert total_amount([]) == 0


def test_total_amount_float_precision():
    orders = [Order("C3", 0.1), Order("C4", 0.2)]
    assert total_amount(orders) == 0.3
