"""报表生成（多文件场景之三）。"""

from orders import total_amount


def summarize(orders):
    """生成简单汇总。"""
    if not orders:
        return {"count": 0, "total": 0.0, "average": 0.0}
    total = total_amount(orders)
    return {
        "count": len(orders),
        "total": total,
        "average": total / len(orders),
    }


def top_orders(orders, n=3):
    """按金额取前 N 个订单。"""
    return sorted(orders, key=lambda o: o.amount, reverse=True)[:n]


def group_by_status(orders):
    """按状态分组。"""
    result = {}
    for order in orders:
        result.setdefault(order.status, []).append(order)
    return result
