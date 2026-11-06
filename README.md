# Cocos Creator MCP 服务器插件

**[📖 English](README.EN.md)**  **[📖 中文](README.md)**

适用于 Cocos Creator `3.8.6+` 的 MCP（Model Context Protocol）插件。它在编辑器内启动一个本地 MCP 服务，把场景、节点、组件、资源、预制体、调试与编辑器操作暴露给 AI 客户端。

当前仓库版本：`v1.5.2`

## 项目定位

这个仓库不是一个“独立桌面应用”，而是一个放在 Cocos Creator 项目 `extensions/` 目录下运行的编辑器扩展。

它由两部分组成：

- **主插件**：运行在 Cocos Creator 扩展环境中，负责启动 HTTP MCP 服务、暴露工具、管理工具开关和面板设置。
- **stdio 适配器**：把标准输入输出的 JSON-RPC 请求转发到本地 HTTP `/mcp` 端点，方便 Codex、OpenCode 等偏好 `stdio` 的客户端接入。

## 当前能力

当前仓库中的实现重点是“把编辑器能力稳定地暴露给 AI”，主要包括：

- **场景与节点操作**：读取当前场景、获取层级、创建节点、移动节点、删除节点、修改名称/变换/属性。
- **组件操作**：添加组件、移除组件、读取组件信息、批量设置组件属性，并补强了颜色和尺寸类参数解析。
- **预制体与资源操作**：创建预制体、实例化预制体、创建场景资源、导入/移动/删除资源、查询依赖与资源信息。
- **编辑器与调试能力**：执行菜单命令、撤销/重做、读取控制台日志、读取项目日志、场景校验、性能信息、截图。
- **截图与视图辅助**：支持编辑器截图、Scene View / Game View 截图，并包含多层兜底逻辑处理空白图或窗口识别失败。
- **工具管理**：支持在面板里按工具维度启用/禁用，并保存为项目内配置。
- **AI 客户端配置**：可直接从插件面板写入 `codex` / `opencode` 的 MCP 配置文件。
- **运行时热重载**：扩展重新加载时会清理内部模块缓存，避免继续复用旧模块实现。

## 仓库结构

```text
cocos-mcp-server/
├── source/                   # 主插件源码
│   ├── main.ts              # 扩展入口
│   ├── mcp-server.ts        # HTTP MCP 服务
│   ├── runtime-modules.ts   # 运行时模块热重载
│   ├── client-config.ts     # Codex / OpenCode 配置写入
│   ├── settings.ts          # 插件与工具配置持久化
│   ├── panels/              # 面板逻辑
│   ├── tools/               # 各类工具实现
│   └── test/                # 本地测试脚本
├── stdio-adapter/           # stdio → HTTP MCP 代理
│   ├── src/
│   └── build/
├── static/                  # 面板模板与样式
├── dist/                    # 主插件编译产物
└── package.json
```

## 安装

无需手动克隆仓库。远程安装脚本会从 GitHub 默认分支下载源码，在临时目录中安装依赖并构建完整的 `plugin-package/`，然后安装到目标 Creator 项目的 `extensions/cocos-mcp-server`。

安装前请准备 **Node.js 和 npm**；PowerShell 使用 **PowerShell 7（`pwsh`）**，macOS / Linux 还需要 `curl`、`unzip`。安装过程中需要访问 GitHub 和 npm registry。

默认情况下，目标项目目录就是你执行命令时的**当前目录**，最终安装位置如下：

```text
<当前目录>/extensions/cocos-mcp-server
```

如果要安装到别的项目目录，可通过环境变量 `COCOS_PROJECT_PATH` 覆盖目标项目根目录。

### PowerShell 7

在目标 Cocos Creator 项目根目录执行：

```powershell
irm https://raw.githubusercontent.com/weberwang/cocos-mcp-server/main/install.ps1 | iex
```

安装到指定项目目录：

```powershell
$env:COCOS_PROJECT_PATH = 'D:\Projects\Cocos\AnotherGame'
irm https://raw.githubusercontent.com/weberwang/cocos-mcp-server/main/install.ps1 | iex
```

### Shell

在目标 Cocos Creator 项目根目录执行：

```bash
curl -fsSL https://raw.githubusercontent.com/weberwang/cocos-mcp-server/main/install.sh | sh
```

安装到指定项目目录：

```bash
curl -fsSL https://raw.githubusercontent.com/weberwang/cocos-mcp-server/main/install.sh | COCOS_PROJECT_PATH="/path/to/AnotherGame" sh
```

### 补充说明

- 远程安装默认会把插件放到目标项目的 `extensions/cocos-mcp-server`
- 已存在同名插件目录时，安装脚本会做目录切换，避免直接覆盖中断后留下半安装状态
- 依赖安装和编译均在临时目录中自动完成，失败时不会替换已有插件
- 普通安装无需手动执行 `npm install`、`npm run build` 或单独构建 `stdio-adapter`

## 源码仓库维护命令

下面这些命令仅适用于**源码仓库维护流程**，不属于普通项目安装步骤：

- `npm run publish`
- `npm run package:remote`

说明：

- 这些维护命令只存在于源码仓库
- `plugin-package/` 分发包和已经安装到 `extensions/cocos-mcp-server` 的插件目录不包含这些维护脚本

### 一键发布到目标项目

在 **源码仓库根目录** 执行，发布到当前项目的 `extensions/cocos-mcp-server`：

```bash
npm run publish
```

如果要发布到别的项目，可在 **源码仓库根目录** 显式传入目标项目根目录：

```bash
npm run publish -- D:/Projects/Cocos/AnotherGame
```

如果你当前就在目标项目根目录，也可以直接调用源码仓库里的脚本：

```bash
node D:/Projects/Cocos/cocos-mcp-server/scripts/publish.js .
```

### 生成远程发布目录

在 **源码仓库根目录** 执行：

```bash
npm run package:remote
```

该命令会刷新仓库内的 `plugin-package/` 目录，用于远程分发或打包发布。

## 在 Cocos Creator 中启用

1. 打开或刷新项目。
2. 在菜单中进入 `Extension > Cocos MCP Server`。
3. 打开面板后配置服务参数并启动服务器。

当前默认设置来自源码：

- 默认端口：`9527`
- `autoStart`：`false`
- `enableDebugLog`：`false`
- `maxConnections`：`10`

配置会保存在项目内：

- `settings/mcp-server.json`
- `settings/tool-manager.json`

## 面板功能

当前默认面板承担了四类工作：

### 1. 服务控制

- 启动 / 停止本地 MCP 服务
- 查看运行状态
- 查看当前 HTTP 地址
- 修改端口、自动启动、调试日志、最大连接数

### 2. 工具开关

- 读取当前工具列表
- 单个工具启用 / 禁用
- 按类别全选 / 全关
- 批量保存工具状态

### 3. 工具配置管理

- 自动创建默认配置
- 新建配置
- 切换当前配置
- 导入 / 导出配置

### 4. AI 客户端配置

支持把 MCP 配置直接写入：

- `codex`
- `opencode`
- 同时写入两个客户端

支持写入位置：

- 项目本地配置
- 全局用户配置

说明：

- 当前面板内置的“自动写入配置”只覆盖 `codex` 和 `opencode`。
- **Claude Code 目前需要手动配置**，推荐直接使用项目级 `.mcp.json` 或 `claude mcp add`。

## MCP 接入方式

当前仓库支持两种接入方式。

### 方式一：HTTP MCP

主插件启动后，会在本地监听 HTTP 服务。

默认地址：

```text
http://127.0.0.1:9527/mcp
```

同时还暴露这些辅助端点：

- `GET /health`
- `GET /status`
- `GET /capabilities`
- `POST /call-tool`
- `GET /api/tools`
- `POST /api/{category}/{tool}`

如果客户端原生支持 HTTP MCP，这是最直接的接法。

### 方式二：stdio 适配器

对于偏好 `stdio` 的客户端，仓库提供了一个最小代理：

- 从 `stdin` 读取 JSON-RPC 行
- 转发到 `http://127.0.0.1:<port>/mcp`
- 把响应写回 `stdout`

默认读取端口环境变量：

```text
COCOS_MCP_PORT
```

未设置时默认使用 `9527`。

## 客户端配置示例

### Claude Code（推荐：项目级 `.mcp.json`）

Claude Code 官方支持通过项目根目录下的 `.mcp.json` 加载 MCP 服务器配置。对于这个插件，推荐直接走 HTTP 方式接入：

```json
{
  "mcpServers": {
    "cocos-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:9527/mcp"
    }
  }
}
```

如果你希望端口跟环境变量联动，也可以写成：

```json
{
  "mcpServers": {
    "cocos-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:${COCOS_MCP_PORT:-9527}/mcp"
    }
  }
}
```

适用场景：

- 团队共享当前项目的 Claude Code MCP 配置
- 希望把配置随仓库一起管理
- 不想依赖本机用户级全局设置

### Claude Code（CLI 添加）

如果你更偏好用 Claude Code 自带命令，也可以直接添加项目级 HTTP MCP：

```bash
claude mcp add --transport http --scope project cocos-mcp http://127.0.0.1:9527/mcp
```

常用配套命令：

```bash
claude mcp list
claude mcp get cocos-mcp
claude mcp remove cocos-mcp
```

在 Claude Code 会话里，可以用：

```text
/mcp
```

查看当前服务器状态、工具数量和连接情况。

### Codex

项目本地 `.codex/config.toml` 最终会写成类似：

```toml
[mcp_servers.cocos-mcp]
type = "stdio"
command = "node"
args = ["extensions/cocos-mcp-server/stdio-adapter/build/index.js"]
```

### OpenCode

项目本地 `opencode.json` 最终会写成类似：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "cocos-mcp": {
      "type": "local",
      "command": ["node", "extensions/cocos-mcp-server/stdio-adapter/build/index.js"],
      "enabled": true,
      "timeout": 30000
    }
  }
}
```

### Claude / 通用 HTTP 客户端

如果客户端支持 HTTP MCP，可直接指向：

```text
http://127.0.0.1:9527/mcp
```

其中 Claude Code 官方当前推荐使用 HTTP 远程 MCP 方式，而不是 SSE。

## 工具域与分组

源码里同时存在“工具类别”和“工具分组”两个概念。

### 主要工具类别

当前实现覆盖这些类别：

- `scene`
- `node`
- `component`
- `prefab`
- `project`
- `assetAdvanced`
- `debug`
- `validation`
- `editor`
- `sceneView`
- `sceneAdvanced`
- `preferences`
- `server`
- `broadcast`
- `referenceImage`
- `batch`
- `material`
- `meta`

### 工具分组

当前分组机制用于降低 AI 上下文污染，不是权限系统。

可用分组：

- `core`
- `component`
- `prefab`
- `asset`
- `debug`
- `editor`
- `preferences`
- `server`
- `reference`
- `batch`

默认启用分组：

- `core`
- `component`
- `prefab`
- `asset`
- `debug`
- `editor`
- `batch`

其中 `core` 不能被关闭。

## 开发

### 主插件开发

```bash
cd extensions/cocos-mcp-server
npm install
npm run build
npm run watch
```

### stdio 适配器开发

```bash
cd extensions/cocos-mcp-server/stdio-adapter
npm install
npm run build
```

### 本地测试脚本

当前仓库里已有一些测试/验证脚本，位于 `source/test/`，例如：

- `manual-test.ts`
- `mcp-tool-tester.ts`
- `prefab-tools-test.ts`
- `editor-tools-save-scene-test.ts`
- `color-parser-test.ts`

这些脚本更接近仓库内部验证工具，不是完整测试框架。

## 已知限制

为了让 README 真实反映仓库状态，下面这些限制需要明确说明：

- 这是 **项目内扩展**，离开 Cocos Creator 编辑器环境不能独立运行。
- 一部分能力本质上是“打开编辑器面板或触发编辑器命令”，并不是完全无 UI 的底层 API。
- 构建相关工具当前更偏“打开构建面板 / 查询状态 / 启动预览”，不是完整替代人工构建流程。
- `stdio` 客户端依赖 `stdio-adapter/build/index.js`，如果没有单独构建适配器，客户端接入会失败。
- GitNexus 索引、功能指南、历史更新日志这类辅助文档可能比源码滞后，应以 `source/` 实现为准。

## 排障

### 服务起不来

优先检查：

1. 主插件是否已经 `npm install && npm run build`
2. 是否已经在 Cocos Creator 中正确加载扩展
3. 端口 `9527` 是否被占用
4. `settings/mcp-server.json` 是否被写入了异常值

### 客户端接不上

优先检查：

1. 面板中的服务是否已启动
2. HTTP 端点 `http://127.0.0.1:9527/health` 是否可访问
3. 如果是 `stdio` 客户端，`stdio-adapter/build/index.js` 是否存在
4. 如果使用了非默认端口，是否同步设置了 `COCOS_MCP_PORT`

### 改了代码但编辑器里还是旧行为

这个仓库已经实现了运行时模块热重载，但前提仍然是：

1. 先重新编译
2. 再在编辑器内刷新或重新启用扩展

如果仍异常，优先检查 `dist/` 是否真的是最新产物。

## 许可证

本插件供 Cocos Creator 项目使用，源码一并提供，可用于学习、交流和二次开发优化。

未经授权，当前项目代码及其衍生代码不得用于商用或转售。如需商用，请联系作者。
