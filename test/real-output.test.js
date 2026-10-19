/**
 * Regression tests built from REAL captured runner output.
 *
 * The synthetic samples in parsers.test.js describe what the formats look like;
 * these fixtures are what the tools actually printed, captured from this machine.
 * They exist because the first implementation shipped a body-mismatch bug that
 * only real output revealed: with two failures, each failure received the other
 * test's traceback. Synthetic single-failure samples never caught it.
 *
 * Run: node test/real-output.test.js
 */
import { parseFailures } from '../index.js'

let passed = 0
let failed = 0

function check(name, condition, actual) {
  if (condition) {
    passed += 1
    console.log('  ok   ' + name)
  } else {
    failed += 1
    console.log('  FAIL ' + name + (actual === undefined ? '' : '  -> ' + JSON.stringify(actual)))
  }
}

/* ------------------------------------------- real pytest, 2 failures ------ */

const realPytest = `
..FF                                                                     [100%]
================================== FAILURES ===================================
_____________________________ test_divide_by_zero _____________________________
test_math_utils.py:16: in test_divide_by_zero
    assert divide(1, 0) == 0
           ^^^^^^^^^^^^
math_utils.py:2: in divide
    return a / b
           ^^^^^
E   ZeroDivisionError: division by zero
______________________________ test_add_failure _______________________________
test_math_utils.py:20: in test_add_failure
    assert add(2, 3) == 6
E   assert 5 == 6
E    +  where 5 = add(2, 3)
=========================== short test summary info ===========================
FAILED test_math_utils.py::test_divide_by_zero - ZeroDivisionError: division ...
FAILED test_math_utils.py::test_add_failure - assert 5 == 6
2 failed, 2 passed in 0.12s
`

const failures = parseFailures('pytest', realPytest)

check('真实 pytest: 解析出 2 个失败', failures.length === 2, failures.length)
check('真实 pytest: 第一个测试名', failures[0]?.test === 'test_divide_by_zero', failures[0]?.test)
check('真实 pytest: 第二个测试名', failures[1]?.test === 'test_add_failure', failures[1]?.test)
check('真实 pytest: 第一个行号 16', failures[0]?.line === 16, failures[0]?.line)
check('真实 pytest: 第二个行号 20', failures[1]?.line === 20, failures[1]?.line)

// The regression: each failure must own its own traceback section.
const firstBody = (failures[0]?.detail ?? '').split('\n')[0]
const secondBody = (failures[1]?.detail ?? '').split('\n')[0]
check('真实 pytest: 第一块指向 test_divide_by_zero', firstBody.includes('test_divide_by_zero'), firstBody)
check('真实 pytest: 第二块指向 test_add_failure', secondBody.includes('test_add_failure'), secondBody)
check(
  '真实 pytest: 第一块未混入第二个测试',
  !(failures[0]?.detail ?? '').includes('test_add_failure'),
  failures[0]?.detail
)
check(
  '真实 pytest: 第二块未混入第一个测试',
  !(failures[1]?.detail ?? '').includes('test_divide_by_zero'),
  failures[1]?.detail
)
check('真实 pytest: 捕获异常类型', (failures[0]?.message ?? '').includes('ZeroDivisionError'), failures[0]?.message)
check('真实 pytest: 捕获断言对比', (failures[1]?.message ?? '').includes('assert 5 == 6'), failures[1]?.message)

/* --------------------------------------- parametrized ids still parse ---- */

const parametrized = `
=================================== FAILURES ===================================
________________________ test_convert[input0-value] _________________________
tests/test_conv.py:7: in test_convert
    assert convert(1) == 2
E   assert 1 == 2
=========================== short test summary info ===========================
FAILED tests/test_conv.py::test_convert[input0-value] - assert 1 == 2
1 failed in 0.01s
`

const paramFailures = parseFailures('pytest', parametrized)
check('参数化: 解析出 1 个失败', paramFailures.length === 1, paramFailures.length)
check(
  '参数化: 保留了方括号 id',
  (paramFailures[0]?.test ?? '').includes('['),
  paramFailures[0]?.test
)
check('参数化: 行号正确', paramFailures[0]?.line === 7, paramFailures[0]?.line)

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
