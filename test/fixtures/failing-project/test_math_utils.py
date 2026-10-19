from math_utils import add, divide


def test_add_ok():
    assert add(2, 2) == 4


def test_divide_ok():
    assert divide(10, 2) == 5


def test_divide_by_zero():
    # Intentional failure: the fixture exists to produce a real failing run.
    assert divide(1, 0) == 0


def test_add_failure():
    assert add(2, 3) == 6
