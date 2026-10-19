"""用户与权限模块（多文件场景之一）。"""

ROLES = {
    "admin": 100,
    "editor": 50,
    "viewer": 10,
}


class PermissionError_(Exception):
    pass


def level_of(role):
    """返回角色等级，未知角色返回 0。"""
    return ROLES.get(role, 0)


def can_edit(role):
    """能编辑需要 editor 及以上。"""
    return level_of(role) >= 50


def can_admin(role):
    """能管理需要 admin。"""
    return level_of(role) > 100


def require_admin(role):
    """非 admin 抛异常。"""
    if not can_admin(role):
        raise PermissionError_("需要管理员权限：当前角色是 " + str(role))
    return True
