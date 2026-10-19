# DSH 测试自动修复（DSH Test AutoFix）

> 给 agent 一个 `run_tests` 工具：跑测试 → 结构化提取失败 → 精准告诉它「哪个文件、哪一行、什么断言挂了」→ 它直接进修复循环。

其他 AI 编码工具早就有这个能力，DSH 生态此前没有：

| 工具 | 能力 |
| --- | --- |
| Aider | `--test-cmd` / `--auto-test`，改完自动跑测试并修复 |
| Cline | 「Run tests, have the agent fix failures, and set a timeout」 |
| Cursor | Automations：「detect and fix bugs, and generate tests」 |
| **DSH（本插件之前）** | ❌ 790 个第三方插件中，测试修复类命中 **0** |

---

## 和其他插件的关系

生态里有一个名字相近的包，这里说明区别，避免装重复：

| | `dsh-test-autofix`（本插件） | `@mkaliezz/dsh-test-runner` |
| --- | --- | --- |
| 暴露形式 | **工具** `run_tests`（agent 自主调用） | **斜杠命令** `/test` |
| 是否真的跑测试 | ✅ 内置执行，自动探测框架与解释器 | ❌ 需要使用者通过插件 config 注入 `run` 适配器，默认不可用 |
| 输出 | 结构化失败 + 文件/行号 + 注入对话的修复上下文 | 规范化后的摘要 JSON |
| 循环防护 | ✅ 同一失败重复出现时停止 | 无 |

两者**不冲突**（工具 vs 命令，命名空间不同），可以共存。若只想要「解析自己跑出的测试输出」，
用那个；若想让 agent 自己跑、自己看、自己修，用本插件。

---

## 它解决什么

让 agent「跑测试、自己修」听起来很简单,但直接 `bash npm test` 有两个致命问题:

1. **输出太长** —— 一个失败测试的完整 traceback 可能几百行,全塞给模型是在烧 token
2. **模型要自己找重点** —— 从几千行输出里定位「哪个断言失败了」,容易看漏

本插件把这一步做成**结构化**的:

```json
{
  "status": "failed",
  "framework": "pytest",
  "passed": 2,
  "failed": 1,
  "failures": [
    {
      "file": "tests/test_math.py",
      "test": "test_divide",
      "line": 12,
      "message": "ZeroDivisionError: division by zero",
      "detail": "def test_divide():\n>       assert divide(1, 0) == 0\nE       ZeroDivisionError: division by zero"
    }
  ]
}
```

模型拿到的是**精准的失败点**,不是几千行日志。

---

## 特性

### 自动识别测试框架

| 项目特征 | 使用 |
| --- | --- |
| `pyproject.toml` / `pytest.ini` / `setup.cfg` / `tox.ini` | pytest（自动挑选解释器） |
| `Cargo.toml` | `cargo test` |
| `go.mod` | `go test ./...` |
| `package.json` + vitest 依赖 | vitest（见下方启动器探测） |
| `package.json` + jest 依赖 | jest（见下方启动器探测） |
| `package.json` + test 脚本 | `npm test` |

也可以用 `framework` 参数强制指定。

#### Node 项目的启动器探测

`npx` 不是必然存在的——有的机器只装了 pnpm（DSH 自带运行时就是这样），
直接调用会报 `npx: not found`。因此按可用性依次选择：

1. `node_modules/.bin/<runner>` —— 项目自己的 runner shim，不需要包管理器
2. `npx <runner>`
3. `pnpm exec <runner>`
4. `yarn <runner>`
5. `npm test` —— 项目自己的脚本

解析到降级方案时会在结果的 `notes` 里说明。

#### pytest 的解释器探测

裸 `python` / `pytest` 经常**不是**项目实际使用的解释器 —— Windows 上系统 Python 可能遮蔽虚拟环境，而 DSH 自带运行时又不在 PATH 上。用错解释器会报 `No module named pytest`，看起来像测试失败。

因此插件会按优先级探测，**第一个能 `import pytest` 的胜出**：

1. 项目虚拟环境（`.venv` / `venv` / `env`）
2. 环境变量 `DSH_PYTHON` 指定的解释器
3. PATH 上的 `python`
4. PATH 上的 `python3`
5. Windows 的 `py -3` 启动器

全部失败时会明确报出「试过哪些解释器」，而不是把它当成测试失败。

#### 中文断言不乱码

Windows 下 Python 子进程默认输出系统代码页（中文系统是 GBK）。按 UTF-8 解码会把
中文断言变成乱码，正好毁掉这个工具要呈现的信息。插件做两件事：

1. 给子进程注入 `PYTHONIOENCODING=utf-8` / `PYTHONUTF8=1`，**强制输出 UTF-8**
2. 解码时先严格按 UTF-8，失败再回退 GBK / 系统编码（`lib/decode.js`）



### 结构化解析

已支持并经过测试的解析器：

- **pytest** —— `FAILED path::test` + 回溯定位断言上下文
- **jest / vitest** —— `● suite › test` 块，提取 `Expected` / `Received`
- **cargo** —— `---- test stdout ----` 块，提取 panic 位置
- **go** —— `--- FAIL: TestX` + 缩进断言行

每个失败都带**文件路径 + 行号 + 断言信息**,而不是一整坨输出。

### 死循环防护

如果**同一个失败反复出现**,说明模型在打转。插件会给失败算一个签名(文件 + 测试名 + 错误信息,**刻意忽略行号** —— 因为修复通常会移动行号,算作新失败就失去防护意义),同一个签名超过阈值就返回 `status: "loop"` 并明确告知:

> This identical failure has now happened 3 times. Stop editing and report the blocker to the user instead of retrying.

这样避免「改一下、还是错、再改一下」无限烧钱。

### 省 token

- 失败详情每个最多 14 行
- 最多返回 20 个失败
- 通过时不返回原始输出
- 失败时只给最后 40 行原始输出作兜底

---

## 安装

```bash
dsh plugin --profile <你的profile> add DSH-Test-Autofix
```

或从源码目录安装：

```bash
dsh plugin --profile <你的profile> add /绝对路径/DSH-Test-Autofix
```

装完重启 DSH，agent 就能看到 `run_tests` 工具。

---

## 使用

模型可以直接调用：

```
run_tests()                          # 自动识别并跑全部测试
run_tests(framework="pytest")        # 强制用 pytest
run_tests(path_filter="test_math")   # 只跑匹配的测试
run_tests(timeout_ms=60000)          # 60 秒超时
```

也可以直接对模型说：「跑一下测试，把失败的修好」——它就会用这个工具。

---

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: test-autofix
  name: DSH-Test-Autofix
  config:
    repeatLimit: 2      # 同一失败重复几次算循环（默认 2）
    timeoutMs: 300000   # 默认超时 5 分钟
```

---

## 实现说明（给开发者）

- **零依赖**：通过调用方自己的 `ctx.tools.register` 注册普通对象定义，不 import 任何 `@deepseek-ai/*` 值，因此无需 peerDependencies
- **Host 服务通过 `ctx.get(...)` 获取**：用 `subprocess` 执行命令（复用官方的凭据擦除、输出溢出处理、进程树终止）
- **循环状态按 session 隔离**：存在插件闭包里，卸载插件即清除，多会话互不干扰
- **失败不会污染回合**：参数错误、找不到 runner 都返回结构化结果和 `notes`，不抛异常

### 边界与已知限制

完整清单见文末 [已知限制](#已知限制)。

---

## 测试

```bash
node test/parsers.test.js        # 27 个：四个框架的解析、签名、探测
node test/real-output.test.js    # 14 个：真实 pytest 输出回归
node test/hard-mode.test.js      # 11 个：中文/参数化/嵌套类/批量失败
node test/e2e.test.js <python>   # 13 个：完整调用链（失败/循环/通过）
node test/verify-installed.mjs <安装目录>  # 8 个：验证发布包能加载
```

共 **65 + 8 个用例**。

`real-output.test.js` 和 `hard-mode.test.js` 用的是本机真实抓取的输出，
它们存在的原因很实际——初版有两个 bug 只有真实输出才能暴露：

1. **区块错配**：两个测试失败时，每个失败都拿到了对方的 traceback
2. **中文乱码**：Windows 下 GBK 输出按 UTF-8 解码，中文断言全变成问号

合成的单失败样例永远发现不了这两个问题。

`verify-installed.mjs` 验证的是**打包后的副本**能否运行。它存在的理由同样具体：
曾有版本的 `files` 字段漏掉了 `lib/decode.js`，装出来的包会在加载时崩溃。


---

## 已知限制

- 解析器依赖各框架的**默认输出格式**；自定义 reporter / 格式化插件可能让解析失效，此时回退到 `raw_tail`
- 只处理**测试框架**，不含 lint / typecheck（可用 `path_filter` 或另建工具）
- 循环签名**忽略行号**是有意取舍：修复通常移动行号，算作新失败就失去防护意义
- pytest 解释器探测与 Node 启动器探测都是**启发式的**；特殊部署可用 `DSH_PYTHON` 显式指定解释器
- 嵌套测试类的显示名取决于 pytest 版本
- 单个失败的详情最多 16 行，最多返回 20 条失败；超出部分需要缩小 `path_filter` 再跑

---

## 许可

MIT
