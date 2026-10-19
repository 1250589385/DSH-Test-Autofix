"""订单处理（多文件场景之二）。"""

from auth import level_of


class Order:
    def __init__(self, order_id, amount, owner_role="viewer"):
        self.order_id = order_id
        self.amount = amount
        self.owner_role = owner_role
        self.status = "new"

    def __repr__(self):
        return "Order({0}, {1})".format(self.order_id, self.amount)


def create_order(order_id, amount, owner_role="viewer"):
    if amount <= 0:
        raise ValueError("订单金额必须大于 0，收到 {0}".format(amount))
    return Order(order_id, amount, owner_role)


def cancel_order(order):
    """只有 editor 及以上能取消。"""
    if level_of(order.owner_role) < 50:
        raise PermissionError("无权取消订单")
    order.status = "cancelled"
    return order


def total_amount(orders):
    """汇总订单金额。"""
    return sum(o.amount for o in orders)
