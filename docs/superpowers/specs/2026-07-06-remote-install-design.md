# Cocos 插件纯远程安装设计

## 背景

当前仓库已经具备以下能力：

- 本地一键发布到目标项目 `extensions/`
- 生成仓库内 `plugin-package/` 作为远程分发目录
- 通过本地源码仓库脚本，从 GitHub 下载并安装插件

但这还不满足新的目标。新的要求是：

1. 用户机器上**不需要本地存在这个插件源码仓库**
2. 插件代码推到 GitHub 后，可以**完全依赖远程命令**完成安装
3. 同时支持：
   - Windows PowerShell
   - macOS / Linux Shell
4. 远程安装通过**下载整个仓库 zip** 后提取 `plugin-package/` 完成

## 目标

### 目标 1：纯远程安装

用户无需先 clone 本仓库，也无需本地存在 `scripts/install-from-github.js`，只通过远程命令即可安装。

### 目标 2：双脚本支持

仓库提供两个远程安装入口：

- `install.ps1`
- `install.sh`

### 目标 3：默认安装到当前目录

安装命令默认把当前目录视为目标 Cocos 项目根目录，并安装到：

```text
<当前目录>/extensions/cocos-mcp-server
```

同时允许显式覆盖目标目录。

### 目标 4：下载默认分支实际内容

远程入口脚本本身可以固定挂在稳定分支 URL 上，但安装内容必须通过 GitHub API 获取仓库**真实默认分支**，再下载该默认分支 zip。

## 非目标

- 不做 GitHub Release 方案
- 不做 npm / npx 安装器
- 不做通用插件市场
- 不做通用任意仓库插件安装器
- 不重写 MCP 主服务
- 不调整 `plugin-package/` 的职责

## 方案对比

### 方案 A：仓库内双脚本直装

在仓库根目录提供：

- `install.ps1`
- `install.sh`

脚本自身读取默认分支、下载 zip、提取 `plugin-package/` 并安装。

优点：

- 完全符合“只依赖远程”的要求
- 不依赖 npm
- 用户入口最直接

缺点：

- 需要维护两份脚本

### 方案 B：单一 Node 安装器

提供远程 `install.js`，用户本地通过 Node 拉起安装。

优点：

- 逻辑复用更高

缺点：

- 依赖用户机器安装 Node
- 不符合“PowerShell + Shell 远程入口”目标

### 方案 C：远程薄启动器 + 二次下载安装器

`install.ps1` / `install.sh` 只做引导，再下载另一个安装器。

优点：

- 可复用安装核心

缺点：

- 结构更复杂
- 对当前目标是过度设计

## 选定方案

采用 **方案 A：仓库内双脚本直装**。

原因：

- 最贴合“提交到 GitHub 后，完全依赖远程安装”的诉求
- 不引入额外依赖面
- 用户侧命令最直接

## 安装行为设计

### 默认行为

如果没有显式传入目标项目路径，则默认把当前目录视为 Cocos 项目根目录。

最终安装目标为：

```text
<当前目录>/extensions/cocos-mcp-server
```

### 路径覆盖

如果显式传入项目路径，则安装到：

```text
<指定目录>/extensions/cocos-mcp-server
```

### 安装流程

两个脚本都执行同一套流程：

1. 解析目标项目根目录
2. 调 GitHub API 获取仓库默认分支
3. 下载该默认分支 zip
4. 解压到临时目录
5. 找到其中的 `plugin-package/`
6. 删除旧的 `extensions/cocos-mcp-server`
7. 复制 `plugin-package/` 到目标目录
8. 输出安装完成信息

## 命令形式设计

### Windows PowerShell

默认安装到当前目录：

```powershell
powershell -ExecutionPolicy Bypass -Command "& { iwr https://raw.githubusercontent.com/<owner>/<repo>/main/install.ps1 -UseBasicParsing | iex }"
```

指定目标项目路径：

```powershell
powershell -ExecutionPolicy Bypass -Command "& { $env:COCOS_PROJECT_PATH='D:/Projects/Cocos/MyGame'; iwr https://raw.githubusercontent.com/<owner>/<repo>/main/install.ps1 -UseBasicParsing | iex }"
```

### macOS / Linux Shell

默认安装到当前目录：

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | bash
```

指定目标项目路径：

```bash
COCOS_PROJECT_PATH="/path/to/MyGame" curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | bash
```

### 说明

远程入口脚本的 raw URL 固定指向稳定分支，例如 `main`。  
但脚本内部安装的实际插件内容，仍然通过 GitHub API 获取仓库真实默认分支，再下载对应 zip。

## 仓库结构调整

### 新增

- `install.ps1`
- `install.sh`

### 保留

- `plugin-package/`

### 删除或弃用

- `scripts/install-from-github.js`
- `scripts/tests/install-from-github.test.js`
- `package.json` 中本地 `install:github` 入口

### 说明

`plugin-package/` 继续作为唯一远程分发内容源。  
远程安装脚本只认 `plugin-package/`，不依赖本地源码仓库脚本。

## 脚本职责

### `install.ps1`

负责：

- 读取 `COCOS_PROJECT_PATH`
- 默认为当前目录
- 调 GitHub API 获取默认分支
- 下载默认分支 zip
- 解压
- 提取 `plugin-package/`
- 安装到目标项目 `extensions/cocos-mcp-server`

### `install.sh`

负责：

- 读取 `COCOS_PROJECT_PATH`
- 默认为当前目录
- 调 GitHub API 获取默认分支
- 下载默认分支 zip
- 解压
- 提取 `plugin-package/`
- 安装到目标项目 `extensions/cocos-mcp-server`

Shell 侧预期使用：

- `curl`
- `mktemp`
- `unzip`
- `cp`
- `rm`

## README 调整

README 和 README.EN 需要改成“远程安装”口径：

1. 本地源码仓库脚本安装说明要删除或降级
2. 新增 PowerShell 安装命令
3. 新增 Shell 安装命令
4. 明确默认安装到当前目录的 `extensions/cocos-mcp-server`
5. 明确可通过 `COCOS_PROJECT_PATH` 覆盖目标目录

## 错误处理

远程安装脚本需明确处理以下失败场景：

1. `COCOS_PROJECT_PATH` 指向目录不存在
2. GitHub API 请求失败
3. GitHub API 未返回默认分支
4. 默认分支 zip 下载失败
5. 缺少解压工具
   - PowerShell：`Expand-Archive`
   - Shell：`unzip`
6. 解压后找不到 `plugin-package/`
7. 删除旧插件目录失败
8. 复制安装失败

要求：

- 输出明确可读错误
- 失败时不要留下误导性的“安装完成”状态

## 验证方案

### 功能验证

1. 先刷新最新 `plugin-package/`
2. 本地执行 `install.ps1`
   - 默认当前目录安装
   - 显式 `COCOS_PROJECT_PATH` 安装
3. 本地执行 `install.sh`
   - 默认当前目录安装
   - 显式 `COCOS_PROJECT_PATH` 安装

### 结果验证

检查目标目录至少包含：

- `extensions/cocos-mcp-server/package.json`
- `extensions/cocos-mcp-server/dist/main.js`
- `extensions/cocos-mcp-server/static/`

如当前仓库之后仍保留 `stdio-adapter`，则还要检查：

- `extensions/cocos-mcp-server/stdio-adapter/build/index.js`

### 文档验证

README 中远程安装命令必须与脚本真实行为一致。

## 计划修改文件

### 新增

- `D:\Projects\Cocos\cocos-mcp-server\install.ps1`
- `D:\Projects\Cocos\cocos-mcp-server\install.sh`

### 修改

- `D:\Projects\Cocos\cocos-mcp-server\README.md`
- `D:\Projects\Cocos\cocos-mcp-server\README.EN.md`
- `D:\Projects\Cocos\cocos-mcp-server\package.json`

### 删除或弃用

- `D:\Projects\Cocos\cocos-mcp-server\scripts\install-from-github.js`
- `D:\Projects\Cocos\cocos-mcp-server\scripts\tests\install-from-github.test.js`

## 风险与边界

### 风险 1：双脚本重复实现

PowerShell 和 Shell 需要维护两份实现。  
这是为了换取用户侧零前置依赖。

### 风险 2：入口脚本 raw URL 仍固定到稳定分支

即使安装内容实际基于仓库默认分支，入口脚本本身仍需要稳定 raw 地址。  
因此维护者需要保证入口脚本所在分支稳定可用。

### 风险 3：Shell 环境依赖系统工具

Shell 安装依赖 `curl` 与 `unzip`。  
如果系统缺失这些工具，需要明确报错。

## 最终实现边界

本次实现只解决：

1. 推到 GitHub 后，通过纯远程命令安装
2. 同时支持 PowerShell 与 Shell
3. 默认安装到当前目录，可通过环境变量覆盖

不扩展到：

- Release 安装
- npm 安装
- 通用仓库市场
- 复杂跨平台安装器抽象
