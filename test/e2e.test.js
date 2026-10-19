/**
 * End-to-end check of the `run_tests` tool against a real failing project.
 *
 * Registers the tool against a minimal stand-in host (tools.register + a
 * subprocess service backed by node:child_process) and executes it exactly as
 * the harness would: one call on a failing project, one on a clean project.
 *
 * This is the closest thing to a true integration test that runs without
 * booting a whole DSH profile, and it exercises the code path the model uses:
 * detection -> spawn -> collect -> parse -> loop guard -> render.
 *
 * Run: node test/e2e.test.js <pythonExe>
 */
import { execFileSync, spawn } from 'node:child_process'
import { apply } from '../index.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const demoFailing = path.join(here, 'fixtures', 'failing-project')
const demoClean = path.join(here, 'fixtures', 'clean-project')
const python = process.argv[2]

if (python === undefined) {
  console.error('usage: node test/e2e.test.js <pythonExe>')
  process.exit(2)
}

/**
 * Minimal subprocess service: spawns with node:child_process and exposes the
 * collect-mode reader shape the tool consumes (`handle.done`, `handle.collected`).
 */
function createFakeSubprocess() {
  return {
    spawn(spec) {
      const chunks = { stdout: [], stderr: [] }
      const proc = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, PYTHONPATH: spec.cwd },
      })
      let exited = false
      const done = new Promise((resolve) => {
        proc.on('close', (code) => {
          exited = true
          resolve({ exitCode: code, signal: null })
        })
      })
      proc.stdout.on('data', (d) => chunks.stdout.push(d))
      proc.stderr.on('data', (d) => chunks.stderr.push(d))
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: Buffer.concat(chunks.stdout).toString('utf8'), nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: Buffer.concat(chunks.stderr).toString('utf8'), nextOffset: 0, lossy: false }) },
        },
        terminate() {
          if (!exited) proc.kill()
        },
        waitForExit: async () => exited,
      }
    },
  }
}

const subprocess = createFakeSubprocess()

// Minimal context: `tools.register` captures the definition, `get` serves the
// fake subprocess so the tool's ctx.get('subprocess') lookup succeeds.
let captured = null
const ctx = {
  tools: {
    register(definition) {
      captured = definition
      return () => {}
    },
  },
  get(name) {
    return name === 'subprocess' ? subprocess : undefined
  },
}

apply(ctx, { repeatLimit: 2, timeoutMs: 60000 })

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

const exec = { agent: { id: 'session-e2e' }, signal: new AbortController().signal }

console.log('=== 失败项目 ===')
const bad = await captured.execute({ cwd: demoFailing }, exec)
check('状态为 failed', bad.status === 'failed', bad.status)
check('框架识别为 pytest', bad.framework === 'pytest', bad.framework)
check('退出码非 0', bad.exit_code !== 0, bad.exit_code)
check('解析出 2 个失败', bad.failures.length === 2, bad.failures.length)
check('第一个失败有文件', typeof bad.failures[0]?.file === 'string', bad.failures?.[0]?.file)
check('第一个失败有行号', typeof bad.failures[0]?.line === 'number', bad.failures?.[0]?.line)
check('第一个失败是除零', (bad.failures[0]?.test ?? '').includes('divide'), bad.failures?.[0]?.test)

console.log('\n=== 渲染输出（模型实际看到的）===')
const rendered = captured.output.render({}, bad)
console.log(rendered[0].text)

console.log('\n=== 循环防护 ===')
// Same failures a second and third time: the third must trip the guard.
await captured.execute({ cwd: demoFailing }, exec)
const third = await captured.execute({ cwd: demoFailing }, exec)
check('第三次运行被判定为循环', third.status === 'loop', third.status)
check('循环信息带签名', third.loop !== null && typeof third.loop.signature === 'string', third.loop)
check('循环信息带次数', third.loop !== null && third.loop.count > 2, third.loop?.count)

console.log('\n=== 通过的项目 ===')
const good = await captured.execute({ cwd: demoClean }, exec)
check('状态为 passed', good.status === 'passed', good.status)
check('无失败项', good.failures.length === 0, good.failures.length)
check('通过时 raw_tail 为 null', good.raw_tail === null, good.raw_tail)

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
