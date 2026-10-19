import pytest

from auth import ROLES, can_admin, can_edit, level_of, require_admin


# ---------------------------------------------------------------- 基础

@pytest.mark.parametrize("role,expected", [
    ("admin", 100),
    ("editor", 50),
    ("viewer", 10),
    ("guest", 0),      # 未知角色
])
def test_level_of(role, expected):
    assert level_of(role) == expected


@pytest.mark.parametrize("role,expected", [
    ("admin", True),
    ("editor", True),
    ("viewer", False),
])
def test_can_edit(role, expected):
    assert can_edit(role) is expected


# ---------------------------------------------------------------- 边界（含失败）

def test_can_admin_for_admin():
    assert can_admin("admin") is True


def test_can_admin_for_editor():
    assert can_admin("editor") is False


def test_require_admin_raises_for_viewer():
    with pytest.raises(Exception):
        require_admin("viewer")


def test_require_admin_allows_admin():
    assert require_admin("admin") is True


# ---------------------------------------------------------------- 中文断言（解析器考验）

def test_chinese_assertion_message():
    actual = level_of("editor")
    assert actual == 999, "编辑器等级应该是 999（故意写错的中文断言）"


def test_chinese_failure_multiline():
    value = 42
    expected = 100
    assert value == expected, (
        "多行断言消息：\n"
        "  实际值 {0}\n"
        "  期望值 {1}".format(value, expected)
    )
