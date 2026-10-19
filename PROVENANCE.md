# 素材来源与许可范围（PROVENANCE）

本仓库的**代码**按 MIT 许可（见 [`LICENSE`](LICENSE)），覆盖
`index.js`、`lib/**`、`cordis.patch.yml`、`package.json`、`locale/**`、
`test/**` 与文档。

## 许可范围

| 范围 | 许可 |
|---|---|
| `index.js`、`lib/**`、`cordis.patch.yml`、`package.json` | **MIT** |
| `test/**`（含 fixtures） | **MIT** |
| `locale/en.json`、`locale/zh.json`（文案） | **MIT** |
| `icon.svg`（插件列表图标） | **原创作品**，按 **MIT** 一并授权 |

## 逐项来源

| 文件 | 来源 / 说明 |
|---|---|
| `icon.svg` | 维护者手写的原创 SVG：圆角矩形 + 终端提示符 + 状态圆点。无第三方素材、无嵌入元数据。 |
| `locale/en.json`、`locale/zh.json` | 维护者撰写，仅含插件标题与描述。 |
| `index.js`、`lib/decode.js`、`cordis.patch.yml` | 维护者原创；仅使用 DeepSeek Harness 公开的插件接口（`ctx.tools.register`、`ctx.get('subprocess')`），未复制宿主组件源码。 |
| `test/**` | 维护者编写。`test/fixtures/**` 的示例项目（购物车、权限、订单、报表）均为原创，仅用于演示与回归测试。 |
| `test/real-output.test.js` 中的 pytest 输出 | 本机实际运行 `pytest` 抓取的输出片段，用于回归测试。 |

## 无第三方素材

本仓库**不包含**任何第三方图片、动图、音频或字体素材；整仓内容统一为 MIT。

## 权利主张 / Takedown

如果你认为本仓库的内容侵犯了你的权利，请在本仓库开一条 issue，
说明**文件名**与**依据**，我们会在核实后**立即替换或移除**，不附加其它条件。
