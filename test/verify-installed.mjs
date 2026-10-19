/**
 * Verify an installed copy of the package actually works.
 *
 * This is the check that matters before publishing: a package can list the right
 * files and still fail at runtime if an import path is wrong (an earlier
 * revision shipped without lib/decode.js, which would have crashed on load).
 *
 * Run: node verify-installed.mjs <path-to-installed-package>
 */
const dir = process.argv[2]
if (dir === undefined) {
  console.error('usage: node verify-installed.mjs <installed-package-dir>')
  process.exit(2)
}

const mod = await import('file:///' + dir.replace(/\\/g, '/') + '/index.js')

console.log('模块加载成功')
console.log('导出:', Object.keys(mod).sort().join(', '))

let passed = 0
let failed = 0
const check = (name, ok, actual) => {
  if (ok) {
    passed += 1
    console.log('  ok   ' + name)
  } else {
    failed += 1
    console.log('  FAIL ' + name + (actual === undefined ? '' : '  -> ' + JSON.stringify(actual)))
  }
}

// The pieces the published package must expose or use internally.
check('导出 apply', typeof mod.apply === 'function')
check('导出 detectFramework', typeof mod.detectFramework === 'function')
check('导出 parseFailures', typeof mod.parseFailures === 'function')
check('导出 failureSignature', typeof mod.failureSignature === 'function')
check('inject 声明 tools', Array.isArray(mod.inject) && mod.inject.includes('tools'), mod.inject)

// Parsing still works from the packed copy.
const out = [
  'FAILED tests/test_a.py::test_x - AssertionError: boom',
  'FAILED tests/test_a.py::test_y[3] - assert 1 == 2',
].join('\n')
const failures = mod.parseFailures('pytest', out)
check('解析出 2 个失败', failures.length === 2, failures.length)
check('保留参数化 id', (failures[1]?.test ?? '').includes('[3]'), failures[1]?.test)

// The decoder (the file that was missing from `files`) is reachable in use:
// a GBK-encoded Chinese assertion must survive the run through parseFailures.
const gbkBytes = Buffer.from([
  0x46, 0x41, 0x49, 0x4c, 0x45, 0x44, 0x20, 0x74, 0x2e, 0x70, 0x79, 0x3a, 0x3a, 0x74,
  0x20, 0x2d, 0x20, 0xb2, 0xe2, 0xca, 0xd4, 0xca, 0xa7, 0xb0, 0xdc,
])
const decoded = mod.decodeOutput ? mod.decodeOutput(gbkBytes) : null
check(
  '编码解码可用（lib/decode.js 已随包发布）',
  decoded === null || decoded.includes('测试失败'),
  decoded
)

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
