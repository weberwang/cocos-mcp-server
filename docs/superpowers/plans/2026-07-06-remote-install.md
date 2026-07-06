# Remote Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让这个 Cocos 插件在推送到 GitHub 后可通过纯远程命令安装，不依赖本地源码仓库，并同时支持 PowerShell 与 Shell。

**Architecture:** 保留 `plugin-package/` 作为唯一分发内容源，移除本地 `install-from-github.js` 安装路径，改为仓库根目录的 `install.ps1` 和 `install.sh` 直接负责“读取默认分支、下载 zip、提取 `plugin-package/`、安装到目标项目”。README 和 `package.json` 同步切换到纯远程安装口径，避免双入口混淆。

**Tech Stack:** PowerShell、POSIX shell、Node.js、GitHub REST API、`node:test`

---

## 文件结构

### 计划新增

- `D:\Projects\Cocos\cocos-mcp-server\install.ps1`
  - Windows 远程安装入口，默认安装到当前目录，可通过 `COCOS_PROJECT_PATH` 覆盖。
- `D:\Projects\Cocos\cocos-mcp-server\install.sh`
  - macOS / Linux 远程安装入口，默认安装到当前目录，可通过 `COCOS_PROJECT_PATH` 覆盖。
- `D:\Projects\Cocos\cocos-mcp-server\scripts\tests\remote-install-entry.test.js`
  - 锁定纯远程安装入口所依赖的 URL、默认分支与文档契约。

### 计划修改

- `D:\Projects\Cocos\cocos-mcp-server\README.md`
- `D:\Projects\Cocos\cocos-mcp-server\README.EN.md`
- `D:\Projects\Cocos\cocos-mcp-server\package.json`
- `D:\Projects\Cocos\cocos-mcp-server\scripts\tests\release-utils.test.js`

### 计划删除

- `D:\Projects\Cocos\cocos-mcp-server\scripts\install-from-github.js`
- `D:\Projects\Cocos\cocos-mcp-server\scripts\tests\install-from-github.test.js`

### 说明

- `plugin-package/` 继续保留，不做职责迁移。
- 本计划不改 `source\**`、`mcp-server`、面板逻辑。

## Task 1: 移除本地安装入口并收紧 package 命令面

**Files:**
- Modify: `D:\Projects\Cocos\cocos-mcp-server\package.json`
- Delete: `D:\Projects\Cocos\cocos-mcp-server\scripts\install-from-github.js`
- Delete: `D:\Projects\Cocos\cocos-mcp-server\scripts\tests\install-from-github.test.js`
- Test: `D:\Projects\Cocos\cocos-mcp-server\scripts\tests\release-utils.test.js`

- [ ] **Step 1: 先写一个失败测试，锁定 package scripts 不再暴露本地安装入口**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('package.json 不再暴露 install:github 本地安装脚本入口', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
  );

  assert.equal(Object.prototype.hasOwnProperty.call(packageJson.scripts, 'install:github'), false);
});
```

- [ ] **Step 2: 运行测试，确认当前实现是红灯**

Run: `node --test scripts/tests/release-utils.test.js`

Expected: FAIL，`install:github` 仍存在。

- [ ] **Step 3: 删除本地安装入口并收紧 package scripts**

```json
{
  "scripts": {
    "build": "tsc",
    "watch": "tsc -w",
    "test:release": "node --test scripts/tests/*.test.js",
    "publish": "node scripts/publish.js",
    "package:remote": "node scripts/package-remote.js"
  }
}
```

- [ ] **Step 4: 删除旧的本地安装脚本与测试**

```bash
git rm scripts/install-from-github.js scripts/tests/install-from-github.test.js
```

- [ ] **Step 5: 重新运行测试，确认变绿**

Run: `node --test scripts/tests/release-utils.test.js`

Expected: PASS，`install:github` 断言通过。

- [ ] **Step 6: 提交这一小步**

```bash
git add package.json scripts/tests/release-utils.test.js
git commit -m "refactor: remove local github install entry"
```

## Task 2: PowerShell 远程安装脚本

**Files:**
- Create: `D:\Projects\Cocos\cocos-mcp-server\install.ps1`
- Create: `D:\Projects\Cocos\cocos-mcp-server\scripts\tests\remote-install-entry.test.js`

- [ ] **Step 1: 先写 PowerShell 入口契约测试**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('install.ps1 存在并包含 plugin-package 安装逻辑', () => {
  const content = fs.readFileSync(path.join(process.cwd(), 'install.ps1'), 'utf8');

  assert.match(content, /default_branch/);
  assert.match(content, /plugin-package/);
  assert.match(content, /COCOS_PROJECT_PATH/);
  assert.match(content, /Expand-Archive/);
});
```

- [ ] **Step 2: 运行测试，确认当前实现是红灯**

Run: `node --test scripts/tests/remote-install-entry.test.js`

Expected: FAIL，缺少 `install.ps1`。

- [ ] **Step 3: 实现 `install.ps1`**

```powershell
param(
    [string]$ProjectPath = $env:COCOS_PROJECT_PATH
)

$ErrorActionPreference = "Stop"

function Resolve-TargetProjectPath {
    param([string]$InputPath)

    if ([string]::IsNullOrWhiteSpace($InputPath)) {
        return (Get-Location).Path
    }

    return (Resolve-Path -LiteralPath $InputPath).Path
}

function Get-DefaultBranch {
    param([string]$Owner, [string]$Repo)

    $apiUrl = "https://api.github.com/repos/$Owner/$Repo"
    $headers = @{ "User-Agent" = "cocos-mcp-installer" }
    $response = Invoke-RestMethod -Uri $apiUrl -Headers $headers -Method Get

    if (-not $response.default_branch) {
        throw "GitHub API 未返回默认分支: $apiUrl"
    }

    return [string]$response.default_branch
}

function Install-PluginPackage {
    param(
        [string]$Owner,
        [string]$Repo,
        [string]$TargetProjectPath
    )

    $branch = Get-DefaultBranch -Owner $Owner -Repo $Repo
    $zipUrl = "https://github.com/$Owner/$Repo/archive/refs/heads/$branch.zip"
    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cocos-mcp-" + [guid]::NewGuid().ToString("N"))
    $zipPath = Join-Path $tempRoot "archive.zip"
    $extractRoot = Join-Path $tempRoot "extract"
    $targetDir = Join-Path $TargetProjectPath "extensions/cocos-mcp-server"

    New-Item -ItemType Directory -Path $tempRoot | Out-Null
    New-Item -ItemType Directory -Path $extractRoot | Out-Null

    try {
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -Headers @{ "User-Agent" = "cocos-mcp-installer" }
        Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force

        $archiveDir = Get-ChildItem -Path $extractRoot -Directory | Select-Object -First 1
        if (-not $archiveDir) {
            throw "压缩包解压后没有找到仓库目录"
        }

        $sourceDir = Join-Path $archiveDir.FullName "plugin-package"
        if (-not (Test-Path -LiteralPath $sourceDir)) {
            throw "远程压缩包缺少 plugin-package: $sourceDir"
        }

        New-Item -ItemType Directory -Path (Join-Path $TargetProjectPath "extensions") -Force | Out-Null
        if (Test-Path -LiteralPath $targetDir) {
            Remove-Item -LiteralPath $targetDir -Recurse -Force
        }

        Copy-Item -LiteralPath $sourceDir -Destination $targetDir -Recurse
        Write-Host "安装完成: $targetDir"
    } finally {
        if (Test-Path -LiteralPath $tempRoot) {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force
        }
    }
}
```

- [ ] **Step 4: 运行入口契约测试**

Run: `node --test scripts/tests/remote-install-entry.test.js`

Expected: PASS，脚本存在且包含默认分支、环境变量、`plugin-package`、`Expand-Archive`。

- [ ] **Step 5: 提交这一小步**

```bash
git add install.ps1 scripts/tests/remote-install-entry.test.js
git commit -m "feat: add powershell remote installer"
```

## Task 3: Shell 远程安装脚本

**Files:**
- Create: `D:\Projects\Cocos\cocos-mcp-server\install.sh`
- Modify: `D:\Projects\Cocos\cocos-mcp-server\scripts\tests\remote-install-entry.test.js`

- [ ] **Step 1: 先补 Shell 入口契约测试**

```js
test('install.sh 存在并包含 plugin-package 安装逻辑', () => {
  const content = fs.readFileSync(path.join(process.cwd(), 'install.sh'), 'utf8');

  assert.match(content, /default_branch/);
  assert.match(content, /plugin-package/);
  assert.match(content, /COCOS_PROJECT_PATH/);
  assert.match(content, /unzip/);
});
```

- [ ] **Step 2: 运行测试，确认当前实现是红灯**

Run: `node --test scripts/tests/remote-install-entry.test.js`

Expected: FAIL，缺少 `install.sh`。

- [ ] **Step 3: 实现 `install.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

PROJECT_PATH="${COCOS_PROJECT_PATH:-$(pwd)}"
SCRIPT_REPO="${GITHUB_REPOSITORY:-}"

if [[ -z "${SCRIPT_REPO}" ]]; then
  echo "Missing GITHUB_REPOSITORY" >&2
  exit 1
fi

owner="${SCRIPT_REPO%%/*}"
repo="${SCRIPT_REPO##*/}"

api_url="https://api.github.com/repos/${owner}/${repo}"
default_branch="$(curl -fsSL -H 'User-Agent: cocos-mcp-installer' "${api_url}" | sed -n 's/.*\"default_branch\": *\"\\([^\"]*\\)\".*/\\1/p' | head -n 1)"

if [[ -z "${default_branch}" ]]; then
  echo "GitHub API 未返回默认分支: ${api_url}" >&2
  exit 1
fi

zip_url="https://github.com/${owner}/${repo}/archive/refs/heads/${default_branch}.zip"
temp_root="$(mktemp -d)"
zip_path="${temp_root}/archive.zip"
extract_root="${temp_root}/extract"
target_dir="${PROJECT_PATH}/extensions/cocos-mcp-server"

mkdir -p "${extract_root}" "${PROJECT_PATH}/extensions"

cleanup() {
  rm -rf "${temp_root}"
}
trap cleanup EXIT

curl -fsSL -H 'User-Agent: cocos-mcp-installer' "${zip_url}" -o "${zip_path}"
unzip -q "${zip_path}" -d "${extract_root}"

archive_dir="$(find "${extract_root}" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [[ -z "${archive_dir}" ]]; then
  echo "压缩包解压后没有找到仓库目录" >&2
  exit 1
fi

source_dir="${archive_dir}/plugin-package"
if [[ ! -d "${source_dir}" ]]; then
  echo "远程压缩包缺少 plugin-package: ${source_dir}" >&2
  exit 1
fi

rm -rf "${target_dir}"
cp -R "${source_dir}" "${target_dir}"
echo "安装完成: ${target_dir}"
```

- [ ] **Step 4: 运行入口契约测试**

Run: `node --test scripts/tests/remote-install-entry.test.js`

Expected: PASS，PowerShell 与 Shell 入口契约都通过。

- [ ] **Step 5: 提交这一小步**

```bash
git add install.sh scripts/tests/remote-install-entry.test.js
git commit -m "feat: add shell remote installer"
```

## Task 4: README 与 README.EN 迁移到纯远程安装口径

**Files:**
- Modify: `D:\Projects\Cocos\cocos-mcp-server\README.md`
- Modify: `D:\Projects\Cocos\cocos-mcp-server\README.EN.md`

- [ ] **Step 1: 先补 README 验证测试，锁定远程安装文案**

```js
test('README 说明纯远程安装命令并移除本地 install-from-github 路径', () => {
  const content = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');

  assert.match(content, /install\.ps1/);
  assert.match(content, /install\.sh/);
  assert.match(content, /COCOS_PROJECT_PATH/);
  assert.doesNotMatch(content, /scripts\/install-from-github\.js/);
});
```

- [ ] **Step 2: 运行测试，确认当前 README 仍是红灯**

Run: `node --test scripts/tests/remote-install-entry.test.js`

Expected: FAIL，README 还在描述本地 `install-from-github.js`。

- [ ] **Step 3: 修改中文 README**

```md
## 纯远程安装

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -Command "& { iwr https://raw.githubusercontent.com/<owner>/<repo>/main/install.ps1 -UseBasicParsing | iex }"
```

指定目标项目：

```powershell
$env:COCOS_PROJECT_PATH='D:/Projects/Cocos/MyGame'
powershell -ExecutionPolicy Bypass -Command "& { iwr https://raw.githubusercontent.com/<owner>/<repo>/main/install.ps1 -UseBasicParsing | iex }"
```

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | bash
```

指定目标项目：

```bash
COCOS_PROJECT_PATH="/path/to/MyGame" curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | bash
```
```

- [ ] **Step 4: 修改英文 README**

```md
## Remote Install

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -Command "& { iwr https://raw.githubusercontent.com/<owner>/<repo>/main/install.ps1 -UseBasicParsing | iex }"
```

Override target project:

```powershell
$env:COCOS_PROJECT_PATH='D:/Projects/Cocos/MyGame'
powershell -ExecutionPolicy Bypass -Command "& { iwr https://raw.githubusercontent.com/<owner>/<repo>/main/install.ps1 -UseBasicParsing | iex }"
```

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | bash
```

Override target project:

```bash
COCOS_PROJECT_PATH="/path/to/MyGame" curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | bash
```
```

- [ ] **Step 5: 重新运行入口契约测试**

Run: `node --test scripts/tests/remote-install-entry.test.js`

Expected: PASS，README 说明与新入口一致。

- [ ] **Step 6: 提交这一小步**

```bash
git add README.md README.EN.md scripts/tests/remote-install-entry.test.js
git commit -m "docs: switch install docs to remote scripts"
```

## Task 5: 真实验证与分发包同步

**Files:**
- Modify: `D:\Projects\Cocos\cocos-mcp-server\package.json`
- Modify: `D:\Projects\Cocos\cocos-mcp-server\plugin-package\**` (generated)

- [ ] **Step 1: 运行已有自动化测试**

Run: `npm run test:release`

Expected: PASS，全部远程安装与发布测试通过。

- [ ] **Step 2: 运行主插件构建**

Run: `npm run build`

Expected: PASS。

- [ ] **Step 3: 运行 stdio 适配器构建（仅在当前仓库仍保留该目录时）**

Run: `npm --prefix stdio-adapter run build`

Expected: PASS。

- [ ] **Step 4: 刷新分发包**

Run: `npm run package:remote`

Expected: PASS，并更新 `D:\Projects\Cocos\cocos-mcp-server\plugin-package\`

- [ ] **Step 5: 本地发布到测试项目**

Run: `npm run publish -- D:/tmp/cocos-demo-project`

Expected: PASS，并更新 `D:/tmp/cocos-demo-project/extensions/cocos-mcp-server/`

- [ ] **Step 6: 验证分发包包含最新 README 与远程入口脚本**

Run: `powershell -NoProfile -Command "(Test-Path plugin-package/README.md), (Test-Path plugin-package/package.json)"`

Expected: `True True`

- [ ] **Step 7: 提交最终同步改动**

```bash
git add package.json install.ps1 install.sh plugin-package README.md README.EN.md scripts/tests/remote-install-entry.test.js
git commit -m "feat: add pure remote install workflow"
```

## 自检

### Spec coverage

- 纯远程安装：Task 2、Task 3
- PowerShell + Shell：Task 2、Task 3
- 默认当前目录安装 + 环境变量覆盖：Task 2、Task 3、Task 4
- 默认分支 zip 安装：Task 2、Task 3
- 弃用本地安装脚本：Task 1

### Placeholder scan

- 已避免 `TODO`、`TBD`、`后续实现` 等占位词
- 每个任务都给出实际文件路径、命令和代码框架

### Type consistency

- PowerShell 入口：`install.ps1`
- Shell 入口：`install.sh`
- 分发目录：`plugin-package`
- 环境变量：`COCOS_PROJECT_PATH`
