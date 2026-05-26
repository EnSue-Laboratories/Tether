# Tether

[English README](README.md)

Tether 是给 AI Agent 使用的浏览器 Console / Network 日志桥接工具。它让 agent 直接读取页面运行时的控制台日志、网络请求、请求/响应体和 WebSocket 事件，不需要人手动打开 DevTools、复制报错或导出抓包文件。

```
Chrome 扩展  ──Native Messaging──▶  tetherd 本地守护进程  ──本地 socket──▶  tether CLI  ◀── Agent Skill
 Console / Network / HAR              按 tab/session 缓存             任意能跑 shell 的 agent
```

设计决策：**CLI + Skill，不做 MCP**。CLI 对所有能运行 shell 的 agent 都可用；Skill 负责告诉 agent 什么时候该调用 Tether、怎么查日志、怎么保护敏感信息。

## 当前状态

- MV3 浏览器扩展、Rust daemon/CLI、Native Messaging host 安装、Codex / Claude Code 两套 Skill 已完成。
- 扩展 UI 使用英文，便于作为通用开发工具；本文档提供中文安装和使用说明。
- 已支持 console、network、请求/响应体、WebSocket 事件和 HAR 导出。
- 真实浏览器路径已经做过基础验收；后续主要是补 `watch`、配置修改等增强功能。

## 功能

- **Console 捕获**：页面 `console.*`、异常、网络错误，以及来自 Chrome `Log.entryAdded` 的浏览器级警告，例如 CORS、CSP、mixed content、deprecation 等。
- **Network 捕获**：请求、响应、失败、完成、请求头、响应头、状态码、耗时、发起者、优先级、server IP、connection id 等。
- **请求/响应体捕获**：默认开启，单个 body 默认按 64 KiB 截断，便于接近 DevTools / HAR 的调试信息完整度。
- **WebSocket 捕获**：连接、握手、发送帧、接收帧、错误和关闭事件。
- **本地优先**：扩展把事件发给本机 `tetherd`，CLI 通过本地 socket 查询；Tether 自身不把日志上传到外部服务。
- **Agent Skill**：提供统一安装入口，让 Codex / Claude Code 这类 agent 知道如何使用 `tether` 调试网页。

## 项目结构

- `docs/DESIGN.md`：协议、事件 schema、CLI 语义、缓冲限制和安全模型。
- `docs/RUNBOOK.md`：端到端安装和验收步骤。
- `extension/`：Chrome MV3 扩展，TypeScript，英文 UI。
- `src/`：Rust daemon + CLI，同一个二进制提供 `tether` / `tetherd`。
- `skills/codex/tether/`：Codex Skill。
- `skills/claude-code/tether/`：Claude Code Skill。
- `skills/install.sh`：统一 Skill 安装器。

## 环境要求

- Rust 1.95+。仓库里的 `Cargo.lock` 是 v4，老版本 Cargo 可能无法解析。
- Node.js / npm，用于构建扩展。
- Chrome 或 Chromium。
- 一个可交互的浏览器环境。扩展 popup 的启用流程需要真实 GUI；纯 headless 环境只能跑 daemon/CLI 层测试。

如果机器上同时有系统 Cargo 和 rustup Cargo，优先使用 rustup：

```sh
export PATH="$HOME/.cargo/bin:$PATH"
```

## 构建与安装

从仓库根目录开始：

```sh
cargo build --release

cd extension
npm install
npm run build
cd ..
```

安装 Chrome / Chromium Native Messaging host：

```sh
target/release/tether install-host
```

这个命令会写入 `com.ensue.tether.json`，并在二进制旁创建 `tetherd` 符号链接。Chrome 会通过这个 native host 拉起本地 daemon。

然后手动加载扩展：

1. 打开 `chrome://extensions`。
2. 开启 **Developer mode**。
3. 点击 **Load unpacked**。
4. 选择仓库里的 `extension/` 目录。
5. 确认扩展 id 是 `lcbgiapgidfgdaohjbofohaokokcpefd`。

目前不要写成 Chrome Web Store 安装流程；Tether 现在按手动加载扩展使用。

## 基本使用

1. 打开需要调试的网页。
2. 点击浏览器工具栏里的 Tether 图标。
3. 点击 **Start capturing this tab**。
4. 复现问题。
5. 在终端用 `tether` 查询日志。

常用命令：

```sh
tether status
tether sessions

tether console --level error,warn --since 2m
tether console --grep "checkout" -n 50 --json

tether net --status 5xx --since 5m
tether net --status 4xx --type xhr,fetch --json
tether net --url "/api/" --since 2m

tether get <requestId> --headers --body --json
tether export --format json -o tether-session.json
tether export --format har -o tether-session.har

tether clear
```

多 tab 同时捕获时，先用 `tether sessions` 找到 session id，再给查询命令加 `--session <id>`。需要让 agent 解析时，加 `--json`；流式命令会输出 JSONL。

## 推荐调试流程

1. `tether status`，确认 daemon 已启动且 extension 已连接。
2. `tether clear`，清掉旧日志，准备干净复现。
3. 让用户或自动化脚本执行失败操作。
4. `tether console --level error,warn --since 2m` 查 console 报错。
5. `tether net --status 4xx,5xx --since 2m` 查失败请求。
6. 对关键请求执行 `tether get <requestId> --headers --body --json`。
7. 总结 URL、状态码、耗时、console 错误和可能原因，不要直接把原始日志整段贴到公共频道。

## 安装 Agent Skill

从本仓库 checkout 安装：

```sh
skills/install.sh --target codex
skills/install.sh --target claude-code
```

Codex 也可以直接从 GitHub 安装：

```sh
python /path/to/skill-installer/scripts/install-skill-from-github.py \
  --repo EnSue-Laboratories/Tether \
  --path skills/codex/tether
```

安装后重启对应 agent runtime，让 `$tether` Skill 被重新发现。

## 退出码

这些退出码方便 agent 自动判断下一步：

- `0`：成功。
- `3`：daemon / socket 不可用。通常需要安装 native host、重载扩展，或本地测试时启动 `tether daemon --no-native`。
- `4`：没有 extension 连接，或当前没有开启 capture。
- `5`：没有匹配的 session。先跑 `tether sessions`，或让用户在目标 tab 上重新开启 capture 并复现。

## 安全与隐私

Tether 是本地优先工具，但浏览器日志本身经常包含敏感信息。

- Tether 不主动把数据上传到外部服务。
- 常见敏感请求头会在扩展侧脱敏：`authorization`、`cookie`、`set-cookie`、`proxy-authorization`。
- 请求体和响应体默认捕获，且内容通常不会自动脱敏。它们可能包含 token、密码、个人信息、业务数据。
- HAR / JSON 导出文件应视为敏感本地产物。除非用户明确要求，不要把原始导出内容贴到公共频道；优先给出最小化、已脱敏的摘要。
- 调试结束后，如果不再需要保留数据，可以用 `tether clear` 清理当前缓冲。

## 已知限制与后续

- `watch` 实时 tail 和 `config set` 配置修改还属于后续功能。
- 浏览器扩展 popup 的完整路径需要真实 GUI；headless 环境只能覆盖部分 daemon/CLI 测试。
- 当前 CLI socket 主要面向 Linux / macOS；Windows named pipe 是后续方向。

## 许可证

MIT
