/**
 * DSH-Test-Autofix — a `run_tests` tool that closes the agent's test/fix loop.
 *
 * Why this exists
 * ---------------
 * Other AI coding tools ship a test loop (Aider's --test-cmd/--auto-test, Cline's
 * "run tests, have the agent fix failures"). DSH has the primitives — the
 * subprocess service and the tool pipeline — but no plugin that turns a failing
 * test run into precise, actionable context for the model.
 *
 * A naive "run tests, paste the output" tool adds nothing: the model can already
 * paste its own output. The value is in:
 *   1. Structured failure extraction (file, line, assertion, expected/actual),
 *      so the model gets ~40 relevant lines instead of a 2000-line dump.
 *   2. Framework detection across pytest / jest / vitest / cargo / go / npm.
 *   3. Loop protection: the same failure signature repeating is a loop, and a
 *      loop burns tokens without progress, so the tool stops and says why.
 *
 * Design notes
 * ------------
 * The tool is registered as a plain definition through the caller's own
 * `ctx.tools.register` (mailbox pattern from dsh-ops): no `@deepseek-ai/*` value
 * import, so the plugin stays a simple bundle with no peer dependencies.
 * Host services are reached with `ctx.get(...)` and an explicit undefined check.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { decodeOutput, utf8Env } from './lib/decode.js'

// Re-exported so consumers and tests can verify the encoding path is shipped.
export { decodeOutput }

const TOOL_NAME = 'run_tests'

/** Failures with an identical signature this many times stop the loop. */
const DEFAULT_REPEAT_LIMIT = 2
/** Per-run wall clock budget. */
const DEFAULT_TIMEOUT_MS = 300000
/** Bytes of raw output kept per stream. */
const MAX_OUTPUT_BYTES = 256 * 1024

/* -------------------------------------------------------------------------- */
/* framework detection                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Build the argv for a package.json project.
 *
 * `npx` is not guaranteed to exist: a machine can have node and pnpm but no npx
 * on PATH (the DSH runtime ships pnpm only). Rather than emitting a command that
 * fails with "npx: not found", this tries the local binaries a package manager
 * installs, then falls back to the package manager itself:
 *
 *   node_modules/.bin/<runner>   the runner's own shim, no package manager needed
 *   npx / pnpm exec / yarn        exec a package that is not linked
 *   npm test                     the project's own script
 *
 * @param {string} cwd
 * @param {'jest'|'vitest'|'npm'} kind
 * @param {Record<string, unknown>} [scripts]
 * @returns {{argv: string[], note?: string}}
 */
function buildNodeRunner(cwd, kind, scripts) {
  const localShim = path.join(cwd, 'node_modules', '.bin', kind === 'npm' ? '' : kind)
  if (kind !== 'npm' && existsSync(localShim)) {
    return { argv: [localShim, kind === 'jest' ? '--ci' : 'run'] }
  }

  // `npm test` runs the project's own script, which is what the maintainer intends.
  if (kind === 'npm') {
    if (scripts !== undefined && scripts.test !== undefined) {
      return { argv: ['npm', 'test'] }
    }
    return { argv: ['npm', 'test'], note: 'no test script declared in package.json' }
  }

  const argSuffix = kind === 'jest' ? ['--ci'] : ['run']
  for (const launcher of [['npx'], ['pnpm', 'exec'], ['yarn']]) {
    if (commandExists(launcher[0])) {
      return {
        argv: launcher.concat([kind]).concat(kind === 'jest' ? ['--ci'] : ['run']),
        ...(launcher[0] === 'npx' ? {} : { note: 'using ' + launcher.join(' ') + ' (npx unavailable)' }),
      }
    }
  }
  return { argv: ['npx', kind].concat(argSuffix), note: 'no package-manager launcher found on PATH' }
}

/** True when a bare command name resolves on PATH. */
function commandExists(name) {
  const extensions = process.platform === 'win32'
    ? ['.cmd', '.exe', '.bat', '']
    : ['']
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter((entry) => entry !== '')
  for (const dir of dirs) {
    for (const extension of extensions) {
      if (existsSync(path.join(dir, name + extension))) return true
    }
  }
  return false
}

/**
 * Pick the interpreter that owns the project's test dependency.
 *
 * A bare `python`/`pytest` resolves against PATH, which is frequently NOT the
 * interpreter the project uses: on Windows a system Python can shadow a venv,
 * and the DSH-bundled runtime sits outside PATH entirely. Running the tests with
 * the wrong interpreter reports "No module named pytest" and looks like a test
 * failure, so this probes candidates in priority order:
 *
 *   1. the project virtualenv (`.venv`, `venv`, `env`)
 *   2. `python` / `python3` on PATH
 *   3. `py -3` (the Windows launcher)
 *
 * The first candidate that reports a usable pytest wins; when none do, the
 * plain command is returned so the caller still gets the runner's own error
 * message rather than a silent skip.
 *
 * @param {string} cwd - project directory.
 * @param {{spawn: Function}} subprocess - host subprocess service.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{argv: string[], note?: string}>}
 */
async function resolvePytestInvocation(cwd, subprocess, signal, extra = []) {
  const venvPython = findVenvPython(cwd)
  const candidates = []
  if (venvPython !== null) candidates.push({ argv: [venvPython, '-m', 'pytest'], label: 'venv' })
  // Caller-supplied interpreters come first among non-venv candidates: the host
  // knows its own bundled runtime, which is never on PATH.
  for (const interpreter of extra) {
    candidates.push({ argv: [interpreter, '-m', 'pytest'], label: interpreter })
  }
  candidates.push({ argv: ['python', '-m', 'pytest'], label: 'python' })
  candidates.push({ argv: ['python3', '-m', 'pytest'], label: 'python3' })
  candidates.push({ argv: ['py', '-3', '-m', 'pytest'], label: 'py -3' })

  const tried = []
  for (const candidate of candidates) {
    if (await probePytest(subprocess, candidate.argv, cwd, signal)) {
      return {
        argv: candidate.argv.concat(['-q', '--tb=short']),
        found: true,
        label: candidate.label,
        tried,
      }
    }
    tried.push(candidate.label)
  }
  return { argv: ['python', '-m', 'pytest', '-q', '--tb=short'], found: false, label: null, tried }
}

/** Locate a virtualenv interpreter inside the project, if one exists. */
function findVenvPython(cwd) {
  const suffixes = process.platform === 'win32'
    ? [['Scripts', 'python.exe']]
    : [['bin', 'python']]
  for (const dir of ['.venv', 'venv', 'env']) {
    for (const suffix of suffixes) {
      const candidate = path.join(cwd, dir, ...suffix)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** True when the candidate interpreter can import pytest. */
async function probePytest(subprocess, baseArgv, cwd, signal) {
  try {
    const handle = subprocess.spawn({
      argv: baseArgv.concat(['--version']),
      cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
      graceMs: 2000,
      signal,
      env: utf8Env(),
    })
    const outcome = await handle.done
    return outcome.exitCode === 0
  } catch (error) {
    return false
  }
}
/**
 * Pick the test command for a project directory.
 *
 * Order matters: a monorepo often has both package.json and pyproject.toml, so
 * an explicit request from the model always wins over detection. pytest's argv
 * from here is a placeholder — `resolvePytestInvocation` replaces it at run time
 * with whichever interpreter actually owns pytest.
 *
 * @param {string} cwd - absolute project directory.
 * @param {string|undefined} requested - framework forced by the caller.
 * @returns {{framework: string, argv: string[], cwd: string} | null}
 */
export function detectFramework(cwd, requested) {
  const has = (name) => existsSync(path.join(cwd, name))
  const script = has('package.json') ? readPackageJson(cwd) : null

  const runners = {
    // `python -m pytest` instead of bare `pytest`: on Windows the console script
    // installs into a Scripts directory that is often absent from PATH, and a
    // project virtualenv is then never used. `-m` binds to the interpreter that
    // resolves, which is the runner the project actually has.
    pytest: () => ({ framework: 'pytest', argv: ['python', '-m', 'pytest', '-q', '--tb=short'] }),
    jest: () => ({ framework: 'jest', ...buildNodeRunner(cwd, 'jest') }),
    vitest: () => ({ framework: 'vitest', ...buildNodeRunner(cwd, 'vitest') }),
    cargo: () => ({ framework: 'cargo', argv: ['cargo', 'test'] }),
    go: () => ({ framework: 'go', argv: ['go', 'test', './...'] }),
    npm: () => ({ framework: 'npm', ...buildNodeRunner(cwd, 'npm', script?.scripts) }),
  }

  if (requested !== undefined) {
    const pick = runners[requested]
    if (pick === undefined) return null
    const built = pick()
    return { framework: built.framework, argv: built.argv, cwd, ...(built.note === undefined ? {} : { note: built.note }) }
  }

  if (has('pyproject.toml') || has('pytest.ini') || has('setup.cfg') || has('tox.ini')) {
    return { ...runners.pytest(), cwd }
  }
  if (has('Cargo.toml')) return { ...runners.cargo(), cwd }
  if (has('go.mod')) return { ...runners.go(), cwd }
  if (has('package.json')) {
    // Prefer a real runner over `npm test` when the project depends on one.
    const devDeps = { ...(script?.dependencies ?? {}), ...(script?.devDependencies ?? {}) }
    if (devDeps.vitest !== undefined) return { ...runners.vitest(), cwd }
    if (devDeps.jest !== undefined) return { ...runners.jest(), cwd }
    if (script?.scripts?.test !== undefined) return { ...runners.npm(), cwd }
    return null
  }
  return null
}

/** Read package.json, tolerating a partially written or malformed file. */
function readPackageJson(cwd) {
  try {
    const file = path.join(cwd, 'package.json')
    if (!existsSync(file)) return null
    const raw = readFileSync(file, 'utf8')
    return raw === '' ? null : JSON.parse(raw)
  } catch (error) {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* failure parsing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Extract structured failures from a runner's combined output.
 *
 * Each parser returns the same shape so the model sees one consistent format
 * regardless of framework. Unknown output yields zero failures, which the
 * caller reports honestly instead of pretending the run passed.
 *
 * @param {string} framework
 * @param {string} output - combined stdout+stderr.
 * @returns {{file?: string, test: string, line?: number, message?: string,
 *            detail?: string}[]}
 */
export function parseFailures(framework, output) {
  switch (framework) {
    case 'pytest':
      return parsePytest(output)
    case 'jest':
    case 'vitest':
      return parseJest(output)
    case 'cargo':
      return parseCargo(output)
    case 'go':
      return parseGo(output)
    default:
      return []
  }
}

/**
 * pytest: `FAILED path::test - AssertionError`.
 *
 * The `FAILED` line lives in the "short test summary info" section, which sits
 * *after* the traceback body. The assertion context the model needs is above
 * it, under the `____ test_name ____` header, so the detail is collected by
 * walking backwards and stopping at the previous header.
 */
function parsePytest(output) {
  const failures = [];
  const lines = output.split(/\r?\n/);
  // One counter per run: a parametrized name repeats, and the Nth FAILED line
  // with that name must take the Nth section rather than the same one twice.
  const consumed = new Map();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const header = /^FAILED\s+(\S+?)(?:::(\S+))?(?:\s+-\s+(.*))?$/.exec(line);
    if (header === null) continue;

    const file = header[1];
    const test = header[2] ?? '(unknown)';
    const message = header[3] ?? '';

    const detail = collectPytestTraceback(lines, i, test, consumed);
    // The outermost traceback frame, which pytest prints first as
    // `path:line: in func`. The path may be relative (`test_a.py`) or absolute
    // (`D:\work\test_a.py`, `/home/x/test_a.py`), so the filename part must
    // allow both separators and a drive letter rather than excluding ':'.
    const detailText = detail.join('\n');
    const frame = /^\s*(.+?\.py):(\d+):\s+in\s+/m.exec(detailText);
    const lineNo = frame !== null
      ? Number(frame[2])
      : (() => {
          const m = /\bline (\d+)/.exec(detailText);
          return m === null ? undefined : Number(m[1]);
        })();

    failures.push({
      file,
      test,
      ...(lineNo === undefined ? {} : { line: lineNo }),
      ...(message === '' ? {} : { message }),
      ...(detail.length === 0 ? {} : { detail: detail.join('\n') }),
    });
    if (failures.length >= 50) break;
  }
  return failures;
}

/**
 * Find the traceback body that belongs to one test.
 *
 * Real pytest output puts every body above the "short test summary info"
 * banner, one section per test, and the FAILED lines below it:
 *
 *   ____ test_a ____          <- section header
 *   ...body a...
 *   ____ test_b ____          <- section header
 *   ...body b...
 *   === short test summary info ===
 *   FAILED path::test_a - ...
 *   FAILED path::test_b - ...
 *
 * Section order and FAILED order both follow definition order, but they are
 * matched here by NAME rather than position: parametrized ids and duplicate
 * basenames make positional pairing unreliable, and a mis-paired body is worse
 * than no body at all because it points the model at the wrong assertion.
 *
 * @param {string[]} lines
 * @param {number} failedAt - index of the FAILED line.
 * @param {string} test - the test name from the FAILED line.
 * @returns {string[]} trimmed traceback lines, in reading order.
 */
/**
 * Find the traceback body that belongs to one test.
 *
 * pytest prints every body above "short test summary info", one section per
 * test, and the FAILED lines below it:
 *
 *   ____ test_a ____
 *   ...body a...
 *   ____ test_b[x] ____
 *   ...body b...
 *   ____ test_b[y] ____
 *   ...body c...
 *   === short test summary info ===
 *   FAILED path::test_a - ...
 *   FAILED path::test_b[x] - ...
 *   FAILED path::test_b[y] - ...
 *
 * Names are the primary key because parametrized ids (`test_b[x]`) and nested
 * classes (`TestX.test_y`) appear in the header exactly as in the FAILED line.
 * A name can repeat, so matches are consumed in order: the Nth FAILED line with
 * a given name takes the Nth section with that name. Falling back to "the
 * nearest section" would hand a failure another test's traceback, which points
 * the model at the wrong assertion — worse than returning no body.
 *
 * @param {string[]} lines
 * @param {number} failedAt - index of the FAILED line.
 * @param {string} test - the test name from the FAILED line.
 * @param {Map<string, number>} consumed - per-run counter of sections already taken.
 * @returns {string[]} trimmed traceback lines, in reading order.
 */
function collectPytestTraceback(lines, failedAt, test, consumed) {
  const isHeader = (text) => /^_{3,}\s+\S.*\s+_{3,}$/.test(text.trim())
  const isBanner = (text) => /^={3,}\s/.test(text.trim())
  // pytest renders a dotted node id with spaces and underscores turned into
  // separation, so compare on a normalized key.
  const normalize = (text) =>
    text.trim().replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()

  const headers = []
  const scanFloor = Math.max(0, failedAt - 1200)
  for (let i = scanFloor; i < failedAt; i += 1) {
    if (isHeader(lines[i])) headers.push(i)
  }
  if (headers.length === 0) return []

  const wanted = normalize(test)
  // A parametrized id contains brackets; match on the full normalized text.
  const sameName = headers.filter((index) => {
    const name = normalize(lines[index])
    return name === wanted || name.endsWith(' ' + wanted) || name.includes(wanted)
  })

  let chosen
  if (sameName.length > 0) {
    const ordinal = consumed.get(wanted) ?? 0
    chosen = sameName[Math.min(ordinal, sameName.length - 1)]
    consumed.set(wanted, ordinal + 1)
  } else {
    // No section names this test (a collection error, for example). Use the
    // last section only when there is exactly one, otherwise return nothing
    // rather than risk attaching the wrong traceback.
    if (headers.length !== 1) return []
    chosen = headers[0]
  }

  const body = []
  for (let i = chosen + 1; i < lines.length; i += 1) {
    if (isHeader(lines[i]) || isBanner(lines[i])) break
    const text = lines[i].trimEnd()
    if (text !== '') body.push(text)
    if (body.length >= 16) break
  }
  return body
}

/** jest / vitest: `● suite › test` blocks, plus `Expected/Received`. */
function parseJest(output) {
  const failures = [];
  const blocks = output.split(/^\s*●\s+/m);

  for (const block of blocks.slice(1)) {
    const lines = block.split(/\r?\n/);
    const title = (lines[0] ?? '').trim();
    if (title === '' || /Console|deprecated/i.test(title)) continue;

    const body = lines.slice(1).join('\n');
    const location = /at\s+(?:Object\.)?\S*\s*\(?([^()\s:]+):(\d+):\d+\)?/.exec(body);
    const expected = /Expected:\s*(.+)/.exec(body);
    const received = /Received:\s*(.+)/.exec(body);
    const errorLine = /(?:^|\n)\s*(?:AssertionError|Error|TypeError|expect\([^)]*\)\.\w+)[^\n]*/.exec(body);

    // Keep the assertion lines; trim the stack for token economy.
    const detailLines = [];
    if (expected !== null) detailLines.push('Expected: ' + expected[1].trim());
    if (received !== null) detailLines.push('Received: ' + received[1].trim());
    if (errorLine !== null) detailLines.unshift(errorLine[0].trim());

    failures.push({
      ...(location === null ? {} : { file: location[1], line: Number(location[2]) }),
      test: title,
      ...(errorLine === null ? {} : { message: errorLine[0].trim() }),
      ...(detailLines.length === 0 ? {} : { detail: detailLines.join('\n') }),
    });
    if (failures.length >= 50) break;
  }
  return failures;
}

/** cargo: `failures:` section then `---- name stdout ----` bodies. */
function parseCargo(output) {
  const failures = [];
  const blocks = output.split(/^----\s+(.+?)\s+stdout\s+----$/m);

  for (let i = 1; i < blocks.length; i += 2) {
    const test = blocks[i].trim();
    const body = (blocks[i + 1] ?? '').split(/^failures:$/m)[0].trim();
    const location = /panicked at (.+?):(\d+):\d+/.exec(body);
    const message = /(?:assertion|panicked)[^\n]*/.exec(body);

    failures.push({
      ...(location === null ? {} : { file: location[1], line: Number(location[2]) }),
      test,
      ...(message === null ? {} : { message: message[0].trim() }),
      ...(body === '' ? {} : { detail: body.slice(0, 800) }),
    });
    if (failures.length >= 50) break;
  }
  return failures;
}

/** go: `--- FAIL: TestX (0.00s)` then indented assertion lines. */
function parseGo(output) {
  const failures = [];
  const lines = output.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const header = /^---\s+FAIL:\s+(\S+)\s+\(/.exec(lines[i]);
    if (header === null) continue;

    const detail = [];
    for (let j = i + 1; j < lines.length && /^\s+/.test(lines[j]); j += 1) {
      detail.push(lines[j].trim());
      if (detail.length >= 10) break;
    }
    const location = /(\S+\.go):(\d+)/.exec(detail.join('\n'));

    failures.push({
      ...(location === null ? {} : { file: location[1], line: Number(location[2]) }),
      test: header[1],
      ...(detail.length === 0 ? {} : { detail: detail.join('\n') }),
    });
    if (failures.length >= 50) break;
  }
  return failures;
}

/* -------------------------------------------------------------------------- */
/* loop protection                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Stable identity for "the same failure happening again".
 *
 * Deliberately excludes line numbers: a fix usually shifts lines, and treating
 * that as a new failure would defeat the loop guard. File + test + message is
 * the thing that is actually failing.
 */
export function failureSignature(failure) {
  return [failure.file ?? '?', failure.test, failure.message ?? ''].join('|');
}

/* -------------------------------------------------------------------------- */
/* tool definition                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Build the `run_tests` tool definition.
 *
 * Loop state is per-session and lives in the closure passed in by `apply`, so
 * concurrent sessions never share counters and unloading the plugin drops them.
 *
 * @param {{repeatLimit: number, defaultTimeoutMs: number}} config
 * @param {Map<string, Map<string, number>>} loopState - sessionId → signature → count
 * @returns {object} a plain ToolDefinition for ctx.tools.register.
 */
export function createRunTestsTool(config, loopState) {
  return {
    name: TOOL_NAME,
    description:
      'Run the project test suite and return structured failures. ' +
      'Detects pytest / jest / vitest / cargo / go / npm automatically. ' +
      'On failure, returns each failing test with file, line, assertion message, and a ' +
      'trimmed traceback so you can fix it directly instead of reading raw output. ' +
      'Stops and reports a loop when the same failure repeats, to avoid burning tokens.',
    parameters: {
      type: 'object',
      properties: {
        framework: {
          type: 'string',
          description:
            'Force one runner instead of auto-detecting: pytest | jest | vitest | cargo | go | npm.',
          enum: ['pytest', 'jest', 'vitest', 'cargo', 'go', 'npm'],
        },
        path_filter: {
          type: 'string',
          description:
            'Only run tests whose path contains this substring (passed to the runner when supported).',
        },
        cwd: {
          type: 'string',
          description: 'Project directory to run in. Defaults to the current working directory.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Wall clock budget in milliseconds. Defaults to 300000.',
        },
      },
      additionalProperties: false,
    },
    output: {
      // The harness validates this with a restricted JSON Schema: `type` must be
      // a single string, so nullable fields use a two-branch `oneOf` instead of
      // a type array.
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          framework: { type: 'string' },
          command: { type: 'string' },
          exit_code: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          duration_ms: { type: 'number' },
          passed: { type: 'number' },
          failed: { type: 'number' },
          failures: { type: 'array', items: { type: 'object' } },
          loop: { oneOf: [{ type: 'object' }, { type: 'null' }] },
          notes: { type: 'array', items: { type: 'string' } },
          raw_tail: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['status', 'framework', 'command', 'failed', 'failures'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    async execute(args, exec) {
      const ctx = this;
      return runTests(args, exec, ctx, config, loopState);
    },
  };
}

/** Human/model readable projection of the structured result. */
function renderResult(value) {
  const lines = [];
  const icon = value.status === 'passed' ? 'PASS' : value.status === 'loop' ? 'LOOP' : 'FAIL';
  lines.push(
    `[${icon}] ${value.framework} — ${value.passed} passed, ${value.failed} failed` +
      ` (exit ${value.exit_code}, ${value.duration_ms}ms)`
  );
  lines.push('command: ' + value.command);

  if (value.loop !== null) {
    lines.push('');
    lines.push('LOOP DETECTED: ' + value.loop.signature);
    lines.push(
      `This identical failure has now happened ${value.loop.count} times. ` +
        'Stop editing and report the blocker to the user instead of retrying.'
    );
  }

  if (value.failures.length > 0) {
    lines.push('');
    lines.push('FAILURES:');
    for (const failure of value.failures) {
      const where =
        failure.file === undefined
          ? ''
          : ` @ ${failure.file}${failure.line === undefined ? '' : ':' + failure.line}`;
      lines.push(`- ${failure.test}${where}`);
      if (failure.message !== undefined) lines.push(`    ${failure.message}`);
      if (failure.detail !== undefined) {
        for (const detailLine of String(failure.detail).split('\n').slice(0, 8)) {
          lines.push('    | ' + detailLine);
        }
      }
    }
  }

  if (value.notes.length > 0) {
    lines.push('');
    for (const note of value.notes) lines.push('note: ' + note);
  }

  if (value.raw_tail !== null && value.raw_tail !== '') {
    lines.push('');
    lines.push('--- raw output tail ---');
    lines.push(value.raw_tail);
  }
  return lines.join('\n');
}

/**
 * Execute one test run.
 *
 * @param {Record<string, unknown>} args - model arguments.
 * @param {{agent?: {id: string}, signal?: AbortSignal}} exec - host execution context.
 * @param {{get: (name: string) => unknown}} ctx - plugin context (for service lookup).
 * @param {{repeatLimit: number, defaultTimeoutMs: number}} config
 * @param {Map<string, Map<string, number>>} loopState
 */
async function runTests(args, exec, ctx, config, loopState) {
  const notes = [];
  const cwd = typeof args?.cwd === 'string' && args.cwd !== ''
    ? path.resolve(args.cwd)
    : process.cwd();

  if (!existsSync(cwd)) {
    return failure('bad-cwd', 'unknown', '', notes.concat('cwd does not exist: ' + cwd));
  }

  const detected = detectFramework(cwd, typeof args?.framework === 'string' ? args.framework : undefined);
  if (detected === null) {
    return failure(
      'no-runner',
      'unknown',
      '',
      notes.concat(
        'Could not detect a test runner in ' + cwd +
          '. Pass `framework` explicitly (pytest | jest | vitest | cargo | go | npm).'
      )
    );
  }
  // Detection can report how it resolved an ambiguous launcher (no npx, no test
  // script). Surface that instead of letting the model wonder why a command ran.
  if (detected.note !== undefined) notes.push(detected.note);

  const subprocess = ctx.get('subprocess');
  if (subprocess === undefined) {
    return failure('no-subprocess', detected.framework, '', notes.concat('the subprocess service is unavailable'));
  }

  // pytest needs the interpreter that owns it, not whatever `python` resolves to.
  let argv = detected.argv;
  let pytestMissing = false;
  let triedLabel = '';
  if (detected.framework === 'pytest') {
    const extra = process.env.DSH_PYTHON !== undefined ? [process.env.DSH_PYTHON] : [];
    const resolved = await resolvePytestInvocation(cwd, subprocess, exec?.signal, extra);
    argv = withPathFilter(resolved.argv, 'pytest', args?.path_filter);
    triedLabel = resolved.tried.join(', ');
    if (resolved.label === 'venv') notes.push('using the project virtualenv');
    // No candidate could import pytest. Report it instead of letting a bare
    // "No module named pytest" masquerade as a test failure.
    if (!resolved.found) pytestMissing = true;
  } else {
    argv = withPathFilter(detected.argv, detected.framework, args?.path_filter);
  }

  const timeoutMs =
    typeof args?.timeout_ms === 'number' && Number.isFinite(args.timeout_ms) && args.timeout_ms > 0
      ? Math.min(args.timeout_ms, 30 * 60 * 1000)
      : config.defaultTimeoutMs;

  const argvResolved = argv;
  const command = argvResolved.join(' ');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  exec?.signal?.addEventListener?.('abort', onAbort, { once: true });

  const startedAt = Date.now();
  let output = '';
  let exitCode = null;
  let timedOut = false;

  try {
    const handle = subprocess.spawn({
      argv,
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_OUTPUT_BYTES },
        stderr: { maxBytes: MAX_OUTPUT_BYTES },
      },
      graceMs: 3000,
      signal: controller.signal,
      env: utf8Env(),
    });

    const outcome = await handle.done;
    exitCode = outcome.exitCode;

    // Collect-mode readers are offset-based; read each stream once from 0.
    // The bytes are decoded through the encoding-aware helper: a Windows Python
    // writes GBK, and decoding that as UTF-8 would garble Chinese assertions.
    const out = handle.collected.stdout?.readFrom(0);
    const err = handle.collected.stderr?.readFrom(0);
    output = [decodeOutput(out?.text ?? ''), decodeOutput(err?.text ?? '')]
      .filter((part) => part !== '')
      .join('\n');
    if (out?.lossy === true || err?.lossy === true) {
      notes.push('test output was truncated; only the retained window was parsed');
    }
  } catch (error) {
    if (controller.signal.aborted) {
      timedOut = exec?.signal?.aborted !== true;
      notes.push('test run was cancelled after ' + timeoutMs + 'ms');
    } else {
      notes.push('failed to run tests: ' + (error instanceof Error ? error.message : String(error)));
    }
  } finally {
    clearTimeout(timer);
    exec?.signal?.removeEventListener?.('abort', onAbort);
  }

  const durationMs = Date.now() - startedAt;
  const failures = parseFailures(detected.framework, output);
  const passed = countPassed(detected.framework, output);

  // Loop detection: identical signatures repeating means the model is stuck.
  const sessionId = String(exec?.agent?.id ?? 'anonymous');
  const seen = loopState.get(sessionId) ?? new Map();
  loopState.set(sessionId, seen);

  let loop = null;
  for (const fail of failures) {
    const signature = failureSignature(fail);
    const count = (seen.get(signature) ?? 0) + 1;
    seen.set(signature, count);
    if (count > config.repeatLimit && loop === null) {
      loop = { signature, count };
    }
  }
  // A clean run clears the history so a later regression starts fresh.
  if (failures.length === 0 && exitCode === 0) seen.clear();

  const ok = exitCode === 0 && failures.length === 0 && !timedOut;
  const status = ok ? 'passed' : loop !== null ? 'loop' : 'failed';

  if (pytestMissing) {
    notes.push(
      'no interpreter with pytest was found (tried: ' + triedLabel + '). ' +
        'Create a project virtualenv or install pytest where `python` can see it.'
    );
  }

  return {
    status,
    framework: detected.framework,
    command,
    exit_code: exitCode,
    duration_ms: durationMs,
    passed,
    failed: failures.length,
    failures: failures.slice(0, 20),
    loop,
    notes,
    raw_tail: ok ? null : tail(output, 40),
  };
}

/** Add a path filter to a runner's argv when the runner supports one. */
function withPathFilter(argv, framework, filter) {
  if (typeof filter !== 'string' || filter.trim() === '') return argv;
  switch (framework) {
    case 'pytest':
      return argv.concat(['-k', filter]);
    case 'jest':
    case 'vitest':
      return argv.concat([filter]);
    case 'cargo':
      return argv.concat([filter]);
    case 'go':
      return argv.concat(['-run', filter]);
    default:
      return argv;
  }
}

/** Count passing tests when the runner reports it; 0 when unknown. */
function countPassed(framework, output) {
  if (framework === 'pytest') {
    const match = /(\d+) passed/.exec(output);
    return match === null ? 0 : Number(match[1]);
  }
  if (framework === 'jest' || framework === 'vitest') {
    const match = /Tests:\s+.*?(\d+) passed/.exec(output);
    return match === null ? 0 : Number(match[1]);
  }
  if (framework === 'cargo') {
    const matches = output.match(/test result: ok\. (\d+) passed/g);
    if (matches === null) return 0;
    return matches.reduce((sum, text) => {
      const n = /(\d+) passed/.exec(text);
      return sum + (n === null ? 0 : Number(n[1]));
    }, 0);
  }
  if (framework === 'go') {
    const match = /^ok\s+\S+/gm;
    return match === null ? 0 : match.length;
  }
  return 0;
}

/** Last N lines of output, for the case where parsing found nothing. */
function tail(text, lines) {
  if (text === '') return null;
  const all = text.split(/\r?\n/);
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

/** Uniform result for the pre-run refusal paths. */
function failure(status, framework, command, notes) {
  return {
    status,
    framework,
    command,
    exit_code: null,
    duration_ms: 0,
    passed: 0,
    failed: 0,
    failures: [],
    loop: null,
    notes,
    raw_tail: null,
  };
}

/* -------------------------------------------------------------------------- */
/* plugin entry                                                               */
/* -------------------------------------------------------------------------- */

/** Required services for registration. */
export const inject = ['tools'];

/**
 * Register `run_tests`.
 *
 * Returns nothing: the registration rides this plugin's fiber, so unloading the
 * plugin unregisters the tool and drops the loop counters with it.
 *
 * @param {object} ctx - plugin context.
 * @param {object} config - plugin config from cordis.patch.yml.
 */
export function apply(ctx, config) {
  const repeatLimit =
    typeof config?.repeatLimit === 'number' && config.repeatLimit >= 0
      ? config.repeatLimit
      : DEFAULT_REPEAT_LIMIT;
  const defaultTimeoutMs =
    typeof config?.timeoutMs === 'number' && config.timeoutMs > 0
      ? config.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  const loopState = new Map();
  const tool = createRunTestsTool({ repeatLimit, defaultTimeoutMs }, loopState);

  // Bind the plugin context so `execute` can reach host services with ctx.get.
  const bound = Object.assign({}, tool, { execute: tool.execute.bind(ctx) });
  ctx.tools.register(bound);
}
