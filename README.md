# Bambu Lab Promptfoo 评估模板

这是一个基于 [promptfoo](https://promptfoo.dev/) 的本地评估模板，用于测试 Bambu Lab 客服对话接口的单轮和多轮行为。项目包含一个自定义 provider、一个本地 Web 控制台，以及若干 YAML 测试集。

> 请仅在你有权测试的服务、账号和数据上运行测试。测试集中的提示词可能会触发敏感行为检查，不要将真实凭证或个人数据提交到仓库。

## 快速开始

### 环境要求

- Node.js `22.22` 或更高版本
- promptfoo
- 可访问目标服务的网络环境

安装项目依赖：

```bash
npm install
```

安装 promptfoo。推荐安装到当前项目，这样控制台可以直接找到它：

```bash
npm install --save-dev promptfoo
```

也可以使用全局安装的 promptfoo。控制台会依次查找项目本地、`PATH` 和 nvm Node.js 目录中的 `promptfoo`。

### 启动控制台

```bash
npm start
```

然后打开 <http://127.0.0.1:4310>。

macOS 也可以双击根目录中的 `启动评估控制台.command`。如需更换端口：

```bash
PORT=4320 npm start
```

控制台默认只监听 `127.0.0.1`。它会读取 YAML、确认目标配置、启动 promptfoo 评估，并把结果保存到指定路径。

## 使用流程

1. 在控制台选择 `test_set/` 或其他目录中的 YAML 文件。
2. 确认目标配置。默认 provider 通常是 `file://../bambuProvider.js`，路径以 YAML 文件所在目录为基准。
3. 输入结果文件路径，例如 `results/my-run.json`。
4. 设置重复次数、并发数和请求延迟。
5. 点击开始评估，在日志和“本次测试输出”中查看结果。

控制台不会修改原始 YAML。确认目标后，它会创建临时配置来替换顶层 `targets` 或 `providers`，同时保留提示词和测试文件的相对路径。

## 直接使用 promptfoo

不需要控制台时，可以直接运行 YAML：

```bash
npx promptfoo eval -c test_set/roleplay.yaml \\
  --no-cache \\
  --max-concurrency 1 \\
  --delay 1000 \\
  --no-share \\
  -o results/roleplay.json
```

直接运行时，YAML 中的 provider 路径和配置会原样生效，不会使用网页中的目标配置草稿。

## Provider 配置

`bambuProvider.js` 是自定义 promptfoo provider，负责：

- 连接 Bambu Lab SSE 接口；
- 发送 `/gw/robot/sse/chat` 请求；
- 为多轮测试复用同一个 `sessionId` 和 `uuid`；
- 读取流式响应并返回文本结果；
- 支持 `HTTPS_PROXY` 或 `HTTP_PROXY` 代理环境变量。

YAML 中的最小配置示例：

```yaml
providers:
  - id: file://../bambuProvider.js
    label: bambu
    config:
      baseUrl: https://support.bambulab.com
      origin: https://support.bambulab.com
      userAgent: Mozilla/5.0
```

`baseUrl` 和 `origin` 应与实际测试站点一致。也可以通过 `config.headers` 增加请求头。provider 使用启动进程的环境变量，不会自动读取或配置外部服务凭证。

## 测试集

- `test_set/roleplay.yaml`：角色扮演和多轮上下文测试。
- `test_set/extraction.yaml`：提示词提取相关测试。
- `test_set/danger.yaml`：危险行为相关测试。
- `test_set/tools.yaml`：工具使用相关测试。
- `test_set/tool_copy.yaml`：工具内容复制相关测试。
- `no_upload/`：不通过网页上传、按原始路径使用的配置示例。

sequence provider 的 `inputs` 会按顺序发送多轮消息。自定义 provider 会在同一测试用例的多轮之间保留会话；“断言通过”通常只表示收到了非空响应，具体内容仍应人工复核。

## 结果文件

推荐把结果保存到 `results/`：

```text
results/
├── input-tests.json
├── order-com.json
└── ...
```

控制台的结果保存规则：

- JSON 首次保存为 promptfoo 的原始对象；再次保存会追加到历史数组。
- JSONL 直接追加记录。
- CSV、HTML、XML、YAML、TXT 等格式会先备份旧文件，再保存新报告。
- 评估失败且没有新结果时，原结果文件不会被覆盖。
- `--repeat N` 会在一次评估进程中重复每个测试用例，重复记录会保存在同一份结果中。

不要把包含敏感请求、响应或凭证的结果文件上传到公共仓库。

## 配置环境变量

| 变量 | 作用 |
| --- | --- |
| `PORT` | 控制台端口，默认 `4310` |
| `RUNNER_ORIGIN` | 使用反向代理时指定允许的浏览器来源，例如 `https://runner.example.com` |
| `PROMPTFOO_NODE` | 指定运行 promptfoo 的 Node.js 可执行文件 |
| `PROMPTFOO_BIN` | 指定 promptfoo JavaScript 入口文件 |
| `HTTPS_PROXY` / `HTTP_PROXY` | 为 provider 请求设置代理 |

示例：

```bash
PROMPTFOO_NODE="$HOME/.nvm/versions/node/v22.22.0/bin/node" npm start
```

## 目录结构

```text
.
├── bambuProvider.js       # Bambu Lab 自定义 provider
├── test_set/               # 可上传或载入的测试 YAML
├── no_upload/              # 按原始路径载入的 YAML
├── results/                # 评估结果
├── runner/                # 本地 Web 控制台服务和前端
├── package.json
└── 启动评估控制台.command  # macOS 启动脚本
```

## 开发与测试

运行控制台相关的自动化测试：

```bash
npm run test:runner
```

测试使用临时文件和本地进程，不会调用真实模型或目标服务。

## 远程部署

服务默认只监听本机。部署到远程机器后，推荐使用 SSH 端口转发：

```bash
ssh -L 4310:127.0.0.1:4310 user@server
```

然后在本机打开 <http://127.0.0.1:4310>。如果通过反向代理提供访问，请设置 `RUNNER_ORIGIN`，并在代理层配置身份验证；项目本身不提供登录功能。
