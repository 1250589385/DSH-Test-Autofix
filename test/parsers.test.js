/**
 * Parser tests for DSH-Test-Autofix.
 *
 * These cover the part that carries the plugin's value: turning raw runner
 * output into structured failures. A regression here silently degrades the
 * tool into "paste the output", so the samples below are realistic excerpts,
 * not invented shapes.
 *
 * Run: node test/parsers.test.js
 */
import { parseFailures, failureSignature, detectFramework } from '../index.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

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

/* -------------------------------------------------------------- pytest ----- */

const pytestOut = `
============================= test session starts ==============================
collected 3 items

tests/test_math.py ..F                                                     [100%]

=================================== FAILURES ===================================
________________________________ test_divide _________________________________

    def test_divide():
>       assert divide(1, 0) == 0
E       ZeroDivisionError: division by zero

tests/test_math.py:12: ZeroDivisionError
=========================== short test summary info ============================
FAILED tests/test_math.py::test_divide - ZeroDivisionError: division by zero
========================= 2 passed, 1 failed in 0.12s ==========================
`

const pytestFailures = parseFailures('pytest', pytestOut)
check('pytest: 解析出 1 个失败', pytestFailures.length === 1, pytestFailures.length)
check('pytest: 文件正确', pytestFailures[0]?.file === 'tests/test_math.py', pytestFailures[0]?.file)
check('pytest: 测试名正确', pytestFailures[0]?.test === 'test_divide', pytestFailures[0]?.test)
check(
  'pytest: 捕获异常信息',
  (pytestFailures[0]?.message ?? '').includes('ZeroDivisionError'),
  pytestFailures[0]?.message
)
check(
  'pytest: 捕获断言上下文',
  (pytestFailures[0]?.detail ?? '').includes('assert divide'),
  pytestFailures[0]?.detail
)

/* ---------------------------------------------------------------- jest ----- */

const jestOut = `
FAIL src/sum.test.js
  ● sum › adds two numbers

    expect(received).toBe(expected) // Object.is equality

    Expected: 5
    Received: 4

      3 | test('adds two numbers', () => {
    > 4 |   expect(sum(2, 2)).toBe(5)
        |                     ^
      5 | })

      at Object.<anonymous> (src/sum.test.js:4:21)

Tests:       1 failed, 1 total
`

const jestFailures = parseFailures('jest', jestOut)
check('jest: 解析出 1 个失败', jestFailures.length === 1, jestFailures.length)
check('jest: 测试名含套件', (jestFailures[0]?.test ?? '').includes('sum'), jestFailures[0]?.test)
check('jest: 捕获 Expected', (jestFailures[0]?.detail ?? '').includes('Expected: 5'), jestFailures[0]?.detail)
check('jest: 捕获 Received', (jestFailures[0]?.detail ?? '').includes('Received: 4'))
check('jest: 定位到文件行', jestFailures[0]?.line === 4, jestFailures[0]?.line)

/* --------------------------------------------------------------- cargo ----- */

const cargoOut = `
running 2 tests
test math::tests::adds ... ok
test math::tests::divides ... FAILED

failures:

---- math::tests::divides stdout ----
thread 'math::tests::divides' panicked at src/math.rs:21:9:
assertion \`left == right\` failed
note: run with RUST_BACKTRACE=1
`

const cargoFailures = parseFailures('cargo', cargoOut)
check('cargo: 解析出 1 个失败', cargoFailures.length === 1, cargoFailures.length)
check('cargo: 测试名正确', cargoFailures[0]?.test === 'math::tests::divides', cargoFailures[0]?.test)
check('cargo: 定位文件', (cargoFailures[0]?.file ?? '').includes('math.rs'), cargoFailures[0]?.file)
check('cargo: 定位行号', cargoFailures[0]?.line === 21, cargoFailures[0]?.line)

/* ------------------------------------------------------------------ go ----- */

const goOut = `
--- FAIL: TestAdd (0.00s)
    calc_test.go:14: got 4, want 5
FAIL
exit status 1
`

const goFailures = parseFailures('go', goOut)
check('go: 解析出 1 个失败', goFailures.length === 1, goFailures.length)
check('go: 测试名正确', goFailures[0]?.test === 'TestAdd', goFailures[0]?.test)
check('go: 定位文件', goFailures[0]?.file === 'calc_test.go', goFailures[0]?.file)
check('go: 定位行号', goFailures[0]?.line === 14, goFailures[0]?.line)

/* --------------------------------------------------------------- edge ----- */

check('未知输出返回空数组', parseFailures('pytest', 'all good').length === 0)
check('空输出返回空数组', parseFailures('jest', '').length === 0)

/* ---------------------------------------------------------- signature ----- */

const sig1 = failureSignature({ file: 'a.py', test: 'test_x', message: 'boom' })
const sig2 = failureSignature({ file: 'a.py', test: 'test_x', message: 'boom', line: 99 })
const sig3 = failureSignature({ file: 'a.py', test: 'test_x', message: 'other' })
check('相同失败签名一致（忽略行号）', sig1 === sig2, [sig1, sig2])
check('不同失败签名不同', sig1 !== sig3)

/* ----------------------------------------------------------- detection ---- */

const dir = mkdtempSync(path.join(tmpdir(), 'testloop-'))
try {
  writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname="x"\n')
  const pytestDetect = detectFramework(dir, undefined)
  check('探测 pytest', pytestDetect?.framework === 'pytest', pytestDetect?.framework)

  writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname="x"\n')
  check('pytest 优先于 cargo', detectFramework(dir, undefined)?.framework === 'pytest')

  check('显式指定生效', detectFramework(dir, 'cargo')?.framework === 'cargo')
  check('未知框架返回 null', detectFramework(dir, 'nosuch') === null)

  const empty = mkdtempSync(path.join(tmpdir(), 'testloop-empty-'))
  check('空目录返回 null', detectFramework(empty, undefined) === null)
  rmSync(empty, { recursive: true, force: true })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
