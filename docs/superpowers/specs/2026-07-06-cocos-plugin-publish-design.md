# Cocos 插件一键发布与 GitHub 安装设计

## 背景

当前仓库已经是一个 Cocos Creator 扩展插件仓库，具备以下特征：

- 根目录 `package.json` 已声明 `editor`、`main`、`panels`、`contributions`
- 主插件运行产物位于 `dist/`
- 面板模板与样式位于 `static/`
- `stdio-adapter/build/index.js` 用于 stdio 转 HTTP MCP 代理

当前缺口不是“改造成插件”，而是补齐两类交付能力：

1. 在本地把插件一键发布到某个 Cocos 项目的 `extensions/` 目录
2. 支持从 GitHub 仓库默认分支远程安装这个插件自身，并且安装后可直接使用

## 目标

### 目标 1：本地一键发布

提供一个发布命令，默认把当前仓库的可运行插件内容发布到：

```text
<执行目录>/extensions/cocos-mcp-server/
```

同时支持通过命令参数覆盖目标项目根目录。

### 目标 2：开箱即用

发布结果必须能直接被 Cocos Creator 识别和加载，不依赖目标项目再次执行：

- `npm install`
- `npm run build`

### 目标 3：GitHub 远程安装

提供一个安装命令，从 GitHub 默认分支下载本仓库压缩包，提取预先准备好的插件发布目录，并安装到目标项目的 `extensions/` 下。

## 非目标

- 不改现有插件运行逻辑
- 不引入 bundler、打包器或额外构建系统
- 不做 GitHub Release 分发
- 不做“任意 GitHub 仓库插件安装器”
- 不做增量同步、热发布、多项目配置中心
- 不重构当前源码目录结构

## 核心判断

当前插件不能只发布 `dist/`，原因如下：

- `source/mcp-server.ts` 运行时依赖 `uuid`
- `source/panels/default/index.ts`、`source/panels/tool-manager/index.ts` 运行时依赖 `fs-extra`
- 面板代码运行时依赖 `vue`

因此“可直接使用”的发布包必须包含运行所需的 `node_modules/`，否则目标项目中插件无法正常加载。

## 方案对比

### 方案 A：纯复制发布

直接把现有仓库中的可运行目录复制到目标项目。

优点：

- 实现简单
- 与当前仓库结构一致

缺点：

- 容易把无关文件一起带过去
- 发布边界不清晰

### 方案 B：清单式发布

维护明确的发布白名单，仅复制运行必需项。

优点：

- 发布内容可控
- 更适合长期维护
- 更适合“开箱即用”目标

缺点：

- 需要先定义清单

### 方案 C：先打包再安装

先输出一个本地发布包，再额外执行安装。

优点：

- 适合未来扩展为更正式分发

缺点：

- 对当前“直接发到某个项目”的目标来说，多一层流程

## 选定方案

采用 **方案 B：清单式发布**。

原因：

- 最符合“一键发布到项目 `extensions/`”的需求
- 能明确控制最终插件目录内容
- 不需要顺手引入更复杂的构建或打包体系

## 本地发布设计

### 命令接口

在仓库根目录提供：

```bash
npm run publish
npm run publish -- D:/Projects/Cocos/AnotherGame
```

### 路径规则

#### 默认行为

执行：

```bash
npm run publish
```

发布目标为：

```text
<当前执行目录>/extensions/cocos-mcp-server/
```

#### 参数覆盖

执行：

```bash
npm run publish -- D:/Projects/Cocos/AnotherGame
```

发布目标为：

```text
D:/Projects/Cocos/AnotherGame/extensions/cocos-mcp-server/
```

### 执行流程

1. 校验当前命令是否在本仓库根目录执行
2. 解析目标项目根目录
3. 计算目标插件目录 `<project>/extensions/cocos-mcp-server`
4. 执行主插件构建
5. 执行 `stdio-adapter` 构建
6. 校验关键构建产物存在
7. 删除旧的目标插件目录
8. 重建目标插件目录
9. 按发布白名单复制文件和目录
10. 输出最终发布路径与完成提示

### 发布白名单

发布目录只包含以下内容：

- `dist/`
- `static/`
- `package.json`
- `node_modules/`
- `@types/`
- `stdio-adapter/build/`
- `README.md`

### 发布后的目录结构

```text
<project>/
└─ extensions/
   └─ cocos-mcp-server/
      ├─ dist/
      ├─ static/
      ├─ package.json
      ├─ node_modules/
      ├─ @types/
      ├─ README.md
      └─ stdio-adapter/
         └─ build/
```

### 明确不发布的内容

- `source/`
- `scripts/`
- `dist/test/`
- `stdio-adapter/src/`
- `.git/`
- `package-lock.json`
- 根目录功能说明与开发文档

## GitHub 远程安装设计

### 设计约束

远程安装选择“从 GitHub 默认分支最新版本安装”，且要求安装后可直接使用。

这意味着仓库默认分支必须长期保留一份可运行发布目录，不能依赖目标项目本地构建。

### 固定远程发布目录

仓库根目录新增：

```text
plugin-package/
```

该目录内容与最终发布到项目 `extensions/cocos-mcp-server/` 的内容一致。

### 远程安装命令

提供安装脚本，例如：

```bash
npm run install:github -- owner/repo
```

或等价的 Node 脚本调用形式。

本次设计只要求支持安装**这个插件自身**，即使保留 `owner/repo` 参数，也只针对固定目录结构生效。

### 远程安装流程

1. 解析目标 GitHub 仓库
2. 下载该仓库默认分支 zip 压缩包
3. 解压到临时目录
4. 定位压缩包中的 `plugin-package/`
5. 校验 `plugin-package/` 下关键文件存在
6. 解析目标项目根目录
7. 删除目标项目中的旧插件目录
8. 将 `plugin-package/` 内容复制到 `<project>/extensions/cocos-mcp-server/`
9. 输出安装结果

### 为什么不选 GitHub Release

本次已明确不走 Release 分发，因此远程安装不能依赖 tag 或附件，而是直接消费默认分支中的固定发布目录。

### 代价

- 默认分支会提交发布产物
- 仓库体积会变大
- 每次插件更新后，需要同步刷新并提交 `plugin-package/`

这是在“不走 Release”且“必须开箱即用”的前提下，最简单且稳定的实现方式。

## 计划新增命令

`package.json` 预期新增：

```json
{
  "scripts": {
    "publish": "node scripts/publish.js",
    "package:remote": "node scripts/package-remote.js",
    "install:github": "node scripts/install-from-github.js"
  }
}
```

说明：

- `publish`：发布到某个本地 Cocos 项目 `extensions/`
- `package:remote`：刷新仓库内 `plugin-package/`
- `install:github`：从 GitHub 默认分支安装插件

## 计划新增或修改文件

### 新增

- `scripts/publish.js`
- `scripts/package-remote.js`
- `scripts/install-from-github.js`
- `plugin-package/`（由脚本生成与刷新）

### 修改

- `package.json`
- `README.md`

## 错误处理

以下情况直接失败并退出：

1. 目标项目根目录不存在
2. 主插件构建失败
3. `stdio-adapter` 构建失败
4. 关键发布项缺失：
   - `dist/main.js`
   - `static/`
   - `package.json`
   - `stdio-adapter/build/index.js`
5. 远程安装时找不到 `plugin-package/`
6. 删除旧插件目录失败
7. 复制文件失败
8. 当前执行位置不在仓库根目录，导致源文件无法定位

## 验证方案

### 本地发布验证

1. 在仓库根目录执行 `npm run publish`
2. 检查目标项目 `extensions/cocos-mcp-server/` 目录结构
3. 确认以下文件存在：
   - `package.json`
   - `dist/main.js`
   - `static/...`
   - `stdio-adapter/build/index.js`
4. 抽查 `node_modules/` 中运行时依赖是否已复制

### 远程安装验证

1. 先执行 `npm run package:remote`
2. 确认仓库内 `plugin-package/` 已刷新
3. 模拟从默认分支 zip 安装
4. 检查目标项目 `extensions/cocos-mcp-server/` 目录结构
5. 确认安装后无需再执行 `npm install` 或 `npm run build`

### 编辑器验证

如果本机存在可用 Cocos 项目环境，则进一步验证：

1. 打开目标项目
2. 确认扩展可被识别
3. 确认面板可打开
4. 确认主入口未因缺少依赖而报错

如果无法实际启动 Cocos Creator，则在实现完成时明确说明该验证未执行。

## 风险与边界

### 风险 1：发布体积较大

由于包含 `node_modules/`，发布目录和 `plugin-package/` 体积都会变大。这是当前不引入 bundling 的直接代价。

### 风险 2：远程安装依赖发布目录同步

如果开发者修改了插件代码但没有刷新并提交 `plugin-package/`，远程安装拿到的会是旧版本。

### 风险 3：仓库目录必须保持稳定

远程安装依赖固定目录 `plugin-package/`，后续如果调整目录结构，需要同步更新安装脚本。

## 最终实现边界

本次实现只解决以下能力：

1. 一键发布到本地项目 `extensions/`
2. 一键刷新仓库内远程安装目录
3. 从 GitHub 默认分支远程安装这个插件自身

不扩展到以下能力：

- 通用插件市场
- 多仓库插件安装
- 版本管理与回滚
- 自动发布 Release
- 自动推送 GitHub
