/**
 * Verify the tool against the strict hard-mode fixture using the REAL encoding
 * path: raw Buffers are handed to the decoder exactly as the host's collect-mode
 * reader would, so the UTF-8 / GBK fallback logic is exercised for real.
 *
 * Run: node test/hard-mode.test.js
 */
import { spawn } from 'node:child_process'
import { apply, parseFailures } from '../index.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const project = path.join(here, 'fixtures', 'hard-mode')

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

/** Real subprocess stand-in that keeps raw Buffers for the decoder. */
function createSubprocess() {
  return {
    spawn(spec) {
      const chunks = { out: [], err: [] }
      const proc = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env ?? process.env,
      })
      const done = new Promise((resolve) => {
        proc.on('close', (code) => resolve({ exitCode: code, signal: null }))
      })
      proc.stdout.on('data', (d) => chunks.out.push(d))
      proc.stderr.on('data', (d) => chunks.err.push(d))
      return {
        done,
        collected: {
          // Return the Buffer itself: decodeOutput must handle the real bytes.
          stdout: { readFrom: () => ({ text: Buffer.concat(chunks.out), nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: Buffer.concat(chunks.err), nextOffset: 0, lossy: false }) },
        },
        terminate() {
          proc.kill()
        },
        waitForExit: async () => true,
      }
    },
  }
}

let captured = null
const ctx = {
  tools: { register(d) { captured = d; return () => {} } },
  get(name) { return name === 'subprocess' ? createSubprocess() : undefined },
}

apply(ctx, { repeatLimit: 3, timeoutMs: 90000 })

const exec = { agent: { id: 'hard-mode' }, signal: new AbortController().signal }
const result = await captured.execute({ cwd: project }, exec)

console.log('=== 汇总 ===')
console.log('status   :', result.status)
console.log('passed   :', result.passed)
console.log('failed   :', result.failed)
console.log('parsed   :', result.failures.length)
console.log('')

check('状态为 failed', result.status === 'failed', result.status)
check('通过数为 30', result.passed === 30, result.passed)
check('实际失败数为 11', result.failed === 11, result.failed)
check('解析数与失败数一致', result.failures.length === 11, result.failures.length)

/* ------------------------------------------------ encoding: Chinese intact */

const withChinese = result.failures.filter((f) => f.message !== undefined)
const garbled = withChinese.filter((f) => /[\uFFFD]|Ã|Â|ã|å|ç|è/.test(f.message ?? ''))
check('中文断言未乱码', garbled.length === 0, garbled.map((f) => f.message))
check(
  '中文断言内容正确',
  // pytest -q truncates the FAILED line, so the prefix is what survives there;
  // the full sentence lives in the traceback body.
  withChinese.some((f) => (f.detail ?? '').includes('编辑器等级应该是 999')),
  withChinese.filter((f) => (f.detail ?? '').includes('编辑器')).map((f) => f.detail)
)

/* ------------------------------------------- parametrized ids each distinct */

const many = result.failures.filter((f) => f.test.startsWith('test_many_failures'))
check('参数化失败全部解析', many.length === 6, many.length)
const indexSeen = new Set()
for (const failure of many) {
  const m = /索引 (\d+)/.exec(failure.message ?? '')
  if (m !== null) indexSeen.add(m[1])
}
check('每个参数化失败都有独立索引', indexSeen.size === 6, [...indexSeen])

/* ------------------------------------------------------- nested test class */

const nested = result.failures.filter((f) => f.test.includes('TestCancelOrder'))
check('嵌套类测试能被识别或至少不误配', nested.length === 0 || nested.every((f) => f.file !== undefined), nested.length)

/* ---------------------------------------------------------- line accuracy */

const authFailure = result.failures.find((f) => f.test === 'test_can_admin_for_admin')
check('能定位到正确文件', authFailure?.file === 'test_auth.py', authFailure?.file)
check('能定位到正确行号', authFailure?.line === 30, authFailure?.line)

console.log('\n=== 渲染前 8 行（用户实际看到的）===')
const rendered = captured.output.render({}, result)[0].text
console.log(rendered.split('\n').slice(0, 8).join('\n'))

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
