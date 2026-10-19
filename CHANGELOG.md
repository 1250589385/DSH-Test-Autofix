# 更新日志

本项目的所有重要变更都记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.2] - 2026-10-19

文档与工程性修正，插件行为无变化。

### 修复

- **npm 包内的 CHANGELOG 落后一版**：0.1.1 是在补齐 0.1.1 变更日志之前发布的，
  而 npm 已发布版本不可修改，导致从 npm 安装的人看不到 0.1.1 那一节。
  本版把完整日志带进发布包。

### 新增

- **`test/verify-installed.mjs`**：安装打包后的副本并验证其可加载、导出齐全、
  解析与解码可用。用于防止 `files` 字段漏文件导致的运行时崩溃。

## [0.1.1] - 2026-10-19

内容与 0.1.0 相同，仅版本号递增。

发布 0.1.0 时 npm registry 已把它收进异步处理队列，随后重复发布被拒绝
（`409 Cannot publish over previously staged version "0.1.0"`）。
0.1.1 携带完全相同的代码重新发布，registry 现在以它作为 `latest`。

### 修复

- **pytest 绝对路径行号定位**：回溯帧形如 `D:\work\test_a.py:30: in test_x`
  时，原来的正则把盘符后的冒号当成路径分隔，导致 `line` 为 `undefined`。
  现在允许绝对路径与两种分隔符。

## [0.1.0] - 2026-10-19

首个版本。

### 新增

- **`run_tests` 工具**：运行项目测试并返回结构化失败结果，而不是原始输出。
- **六个框架的自动识别**：pytest / jest / vitest / cargo / go / npm，
  可用 `framework` 参数强制指定。
- **失败结构化**：每条失败带文件路径、行号、断言消息与裁剪后的回溯。
- **参数化测试支持**：`test_x[6]`、`test_x[7]` 这类同名用例按出现顺序
  逐一配对，不会互相错配。
- **中文断言不乱码**：给子进程注入 `PYTHONIOENCODING=utf-8` / `PYTHONUTF8=1`，
  并带 UTF-8 → GBK 的解码回退，Windows 中文环境下的断言消息完整保留。
- **解释器探测**：pytest 按 `.venv` → `DSH_PYTHON` → `python` → `python3` →
  `py -3` 的顺序寻找真正能 `import pytest` 的解释器，避免系统 Python 遮蔽虚拟环境。
- **包管理器探测**：jest/vitest 优先用 `node_modules/.bin` 的本地 shim，
  其次 `npx` → `pnpm exec` → `yarn`，最后回退 `npm test`。
  某些运行环境（例如只带 pnpm 的 DSH 运行时）没有 `npx`。
- **循环防护**：同一失败签名重复出现时返回 `status: "loop"` 并提示停止，
  避免反复修改无果还继续烧 token。签名刻意忽略行号——修复通常移动行号。
- **失败时不污染回合**：参数错误、找不到 runner、找不到解释器都返回
  结构化结果与 `notes`，不抛异常。

### 测试

65 个用例：

- `parsers.test.js`（27）—— 四个框架解析、签名稳定性、框架探测优先级
- `real-output.test.js`（14）—— 本机真实抓取的 pytest 输出回归
- `hard-mode.test.js`（11）—— 中文断言、参数化 id、嵌套类、批量失败
- `e2e.test.js`（13）—— 完整调用链：失败 / 循环 / 通过

### 已知限制

- 解析器依赖各框架的默认输出格式；自定义 reporter 可能让其失效，
  此时回退到 `raw_tail`（原始输出尾部）
- 只处理测试框架，不含 lint / typecheck
- 嵌套类的显示名取决于 pytest 版本
