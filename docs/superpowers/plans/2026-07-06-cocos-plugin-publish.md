# Cocos Plugin Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为当前 Cocos Creator 插件仓库补齐三条可执行链路：本地一键发布到项目 `extensions/`、生成仓库内 `plugin-package/` 远程发布目录、以及从 GitHub 默认分支安装该插件自身。

**Architecture:** 保持当前仓库构建方式不变，新增一组基于 Node.js CommonJS 的脚本放在 `scripts/` 下。把路径解析、白名单复制、目标目录清理、产物校验等公共逻辑集中到一个共享工具模块，三条脚本链路只组合这些稳定原语，避免重复拷贝文件逻辑。

**Tech Stack:** Node.js、`fs-extra`、`child_process`、`https`、内置 `node:test`、PowerShell/`npm`

---

## 文件结构

### 计划新增

- `D:\Projects\Cocos\cocos-mcp-server\scripts\release-utils.js`
  - 发布脚本共享工具，负责仓库根目录校验、目标路径解析、构建、发布清单、关键产物校验、目录复制与清理。
- `D:\Projects\Cocos\cocos-mcp-server\scripts\publish.js`
  - 本地发布入口，默认发到当前执行目录下的 `extensions/cocos-mcp-server/`，支持参数覆盖目标项目根目录。
- `D:\Projects\Cocos\cocos-mcp-server\scripts\package-remote.js`
  - 生成并刷新仓库内 `plugin-package/` 目录。
- `D:\Projects\Cocos\cocos-mcp-server\scripts\install-from-github.js`
  - 从 GitHub 默认分支 zip 下载并安装 `plugin-package/` 到目标项目。
- `D:\Projects\Cocos\cocos-mcp-server\scripts\tests\release-utils.test.js`
  - 校验公共发布逻辑的路径解析、发布清单和关键产物规则。
- `D:\Projects\Cocos\cocos-mcp-server\scripts\tests\publish-flow.test.js`
  - 使用临时目录验证本地发布和远程打包输出结构。
- `D:\Projects\Cocos\cocos-mcp-server\scripts\tests\install-from-github.test.js`
  - 使用本地 zip fixture 或 mock 下载函数验证远程安装目录提取与落盘。

### 计划修改

- `D:\Projects\Cocos\cocos-mcp-server\package.json`
  - 增加 `publish`、`package:remote`、`install:github`、测试脚本。
- `D:\Projects\Cocos\cocos-mcp-server\README.md`
  - 增加一键发布、远程打包、GitHub 安装说明。

### 已知不改

- `D:\Projects\Cocos\cocos-mcp-server\source\**`
- `D:\Projects\Cocos\cocos-mcp-server\stdio-adapter\src\**`

## Task 1: 共享发布工具与基础测试

**Files:**
- Create: `D:\Projects\Cocos\cocos-mcp-server\scripts\release-utils.js`
- Create: `D:\Projects\Cocos\cocos-mcp-server\scripts\tests\release-utils.test.js`
- Modify: `D:\Projects\Cocos\cocos-mcp-server\package.json`

- [ ] **Step 1: 先写共享工具测试，锁定路径和白名单规则**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  EXTENSION_NAME,
  REMOTE_PACKAGE_DIRNAME,
  PUBLISH_ITEMS,
  resolveProjectRoot,
  resolveExtensionTargetDir,
  resolveRemotePackageDir,
  validateRequiredOutputs,
} = require('../release-utils');

test('resolveProjectRoot 默认返回当前执行目录', () => {
  const cwd = path.resolve('D:/tmp/demo-project');
  assert.equal(resolveProjectRoot([], { cwd }), cwd);
});

test('resolveProjectRoot 参数优先于当前执行目录', () => {
  const explicit = path.resolve('D:/tmp/another-project');
  assert.equal(resolveProjectRoot([explicit], { cwd: 'D:/tmp/ignored' }), explicit);
});

test('resolveExtensionTargetDir 拼接 extensions 与插件目录', () => {
  const projectRoot = path.resolve('D:/tmp/demo-project');
  const target = resolveExtensionTargetDir(projectRoot);
  assert.equal(target, path.join(projectRoot, 'extensions', EXTENSION_NAME));
});

test('resolveRemotePackageDir 指向仓库内 plugin-package', () => {
  const repoRoot = path.resolve('D:/repo/cocos-mcp-server');
  assert.equal(resolveRemotePackageDir(repoRoot), path.join(repoRoot, REMOTE_PACKAGE_DIRNAME));
});

test('PUBLISH_ITEMS 包含运行时必需目录', () => {
  assert.deepEqual(
    PUBLISH_ITEMS.map((item) => item.source),
    [
      'dist',
      'static',
      'package.json',
      'node_modules',
      '@types',
      'stdio-adapter/build',
      'README.md',
    ]
  );
});

test('validateRequiredOutputs 缺少关键产物时抛错', () => {
  assert.throws(
    () => validateRequiredOutputs({
      hasPath: (target) => target !== 'dist/main.js',
    }),
    /dist\/main\.js/
  );
});
```

- [ ] **Step 2: 运行测试，确认当前实现确实是红灯**

Run: `node --test scripts/tests/release-utils.test.js`

Expected: FAIL，报错 `Cannot find module '../release-utils'` 或缺少导出函数。

- [ ] **Step 3: 在 `package.json` 里增加脚本入口，先让测试命令固定下来**

```json
{
  "scripts": {
    "build": "tsc",
    "watch": "tsc -w",
    "test:release": "node --test scripts/tests/*.test.js",
    "publish": "node scripts/publish.js",
    "package:remote": "node scripts/package-remote.js",
    "install:github": "node scripts/install-from-github.js"
  }
}
```

- [ ] **Step 4: 用最小实现补齐共享工具模块**

```js
const path = require('node:path');
const fs = require('fs-extra');
const childProcess = require('node:child_process');

/** 发布脚本共享常量，避免三条脚本链路各自硬编码目录名。 */
const EXTENSION_NAME = 'cocos-mcp-server';
const REMOTE_PACKAGE_DIRNAME = 'plugin-package';
const REQUIRED_OUTPUTS = [
  'dist/main.js',
  'static',
  'package.json',
  'stdio-adapter/build/index.js',
];
const PUBLISH_ITEMS = [
  { source: 'dist', target: 'dist' },
  { source: 'static', target: 'static' },
  { source: 'package.json', target: 'package.json' },
  { source: 'node_modules', target: 'node_modules' },
  { source: '@types', target: '@types' },
  { source: 'stdio-adapter/build', target: 'stdio-adapter/build' },
  { source: 'README.md', target: 'README.md' },
];

function resolveProjectRoot(args, options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const explicit = args[0] ? path.resolve(args[0]) : null;
  return explicit || cwd;
}

function resolveExtensionTargetDir(projectRoot) {
  return path.join(projectRoot, 'extensions', EXTENSION_NAME);
}

function resolveRemotePackageDir(repoRoot) {
  return path.join(repoRoot, REMOTE_PACKAGE_DIRNAME);
}

function assertRepoRoot(repoRoot) {
  const manifestPath = path.join(repoRoot, 'package.json');
  const tsconfigPath = path.join(repoRoot, 'tsconfig.json');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(tsconfigPath)) {
    throw new Error(`当前目录不是插件仓库根目录: ${repoRoot}`);
  }
}

function validateRequiredOutputs({ repoRoot, hasPath = fs.existsSync }) {
  for (const relativePath of REQUIRED_OUTPUTS) {
    const candidate = repoRoot ? path.join(repoRoot, relativePath) : relativePath;
    if (!hasPath(candidate)) {
      throw new Error(`缺少关键发布产物: ${relativePath}`);
    }
  }
}

function runCommand(command, args, options) {
  childProcess.execFileSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
}

module.exports = {
  EXTENSION_NAME,
  REMOTE_PACKAGE_DIRNAME,
  REQUIRED_OUTPUTS,
  PUBLISH_ITEMS,
  assertRepoRoot,
  resolveProjectRoot,
  resolveExtensionTargetDir,
  resolveRemotePackageDir,
  validateRequiredOutputs,
  runCommand,
};
```

- [ ] **Step 5: 重新运行共享工具测试，确认变绿**

Run: `node --test scripts/tests/release-utils.test.js`

Expected: PASS，所有断言通过。

- [ ] **Step 6: 提交这一小步**

```bash
git add package.json scripts/release-utils.js scripts/tests/release-utils.test.js
git commit -m "feat: add release utility module"
```

## Task 2: 本地一键发布脚本

**Files:**
- Modify: `D:\Projects\Cocos\cocos-mcp-server\scripts\release-utils.js`
- Create: `D:\Projects\Cocos\cocos-mcp-server\scripts\publish.js`
- Create: `D:\Projects\Cocos\cocos-mcp-server\scripts\tests\publish-flow.test.js`

- [ ] **Step 1: 先写本地发布流程测试，约束默认路径和复制结果**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
const {
  publishToProject,
} = require('../publish');

test('publishToProject 默认发布到项目 extensions/cocos-mcp-server', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cocos-publish-'));
  const repoRoot = path.join(root, 'repo');
  const projectRoot = path.join(root, 'project');

  await fs.ensureDir(path.join(repoRoot, 'dist'));
  await fs.ensureDir(path.join(repoRoot, 'static'));
  await fs.ensureDir(path.join(repoRoot, 'node_modules'));
  await fs.ensureDir(path.join(repoRoot, '@types/schema/package'));
  await fs.ensureDir(path.join(repoRoot, 'stdio-adapter/build'));
  await fs.outputFile(path.join(repoRoot, 'package.json'), '{"name":"cocos-mcp-server"}');
  await fs.outputFile(path.join(repoRoot, 'README.md'), '# readme');
  await fs.outputFile(path.join(repoRoot, 'dist/main.js'), 'module.exports = {};');
  await fs.outputFile(path.join(repoRoot, 'static/template.html'), '<div></div>');
  await fs.outputFile(path.join(repoRoot, 'stdio-adapter/build/index.js'), 'console.log("ok")');
  await fs.outputFile(path.join(repoRoot, 'tsconfig.json'), '{}');

  const targetDir = await publishToProject({
    repoRoot,
    projectRoot,
    skipBuild: true,
  });

  assert.equal(targetDir, path.join(projectRoot, 'extensions', 'cocos-mcp-server'));
  assert.equal(await fs.pathExists(path.join(targetDir, 'dist/main.js')), true);
  assert.equal(await fs.pathExists(path.join(targetDir, 'stdio-adapter/build/index.js')), true);
  assert.equal(await fs.pathExists(path.join(targetDir, 'static/template.html')), true);
});
```

- [ ] **Step 2: 运行测试，确认当前缺少 `publish.js` 导致失败**

Run: `node --test scripts/tests/publish-flow.test.js`

Expected: FAIL，报错 `Cannot find module '../publish'`。

- [ ] **Step 3: 在共享工具里补齐构建、清理和复制原语**

```js
async function ensureProjectRoot(projectRoot) {
  if (!await fs.pathExists(projectRoot)) {
    throw new Error(`目标项目根目录不存在: ${projectRoot}`);
  }
  await fs.ensureDir(path.join(projectRoot, 'extensions'));
}

function buildArtifacts(repoRoot) {
  // 先构建主插件和 stdio 适配器，保证复制的是最新产物。
  runCommand('npm', ['run', 'build'], { cwd: repoRoot, shell: true });
  runCommand('npm', ['run', 'build'], { cwd: path.join(repoRoot, 'stdio-adapter'), shell: true });
}

async function resetDirectory(targetDir) {
  await fs.remove(targetDir);
  await fs.ensureDir(targetDir);
}

async function copyPublishItems(repoRoot, targetDir) {
  for (const item of PUBLISH_ITEMS) {
    await fs.copy(
      path.join(repoRoot, item.source),
      path.join(targetDir, item.target)
    );
  }
}
```

- [ ] **Step 4: 实现 `scripts/publish.js`，导出可测函数并保留 CLI 入口**

```js
const path = require('node:path');
const {
  assertRepoRoot,
  buildArtifacts,
  copyPublishItems,
  ensureProjectRoot,
  resetDirectory,
  resolveExtensionTargetDir,
  resolveProjectRoot,
  validateRequiredOutputs,
} = require('./release-utils');

async function publishToProject(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  assertRepoRoot(repoRoot);

  const projectRoot = path.resolve(
    options.projectRoot || resolveProjectRoot(options.args || [], { cwd: process.cwd() })
  );

  await ensureProjectRoot(projectRoot);

  if (!options.skipBuild) {
    buildArtifacts(repoRoot);
  }

  validateRequiredOutputs({ repoRoot });

  const targetDir = resolveExtensionTargetDir(projectRoot);
  await resetDirectory(targetDir);
  await copyPublishItems(repoRoot, targetDir);
  return targetDir;
}

async function main() {
  const targetDir = await publishToProject({ args: process.argv.slice(2) });
  console.log(`发布完成: ${targetDir}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { publishToProject };
```

- [ ] **Step 5: 运行本地发布测试，确认变绿**

Run: `node --test scripts/tests/publish-flow.test.js`

Expected: PASS，临时项目生成 `extensions/cocos-mcp-server` 且结构完整。

- [ ] **Step 6: 再跑共享测试，确认没有回归**

Run: `npm run test:release`

Expected: PASS，当前仅 `release-utils.test.js` 与 `publish-flow.test.js` 通过。

- [ ] **Step 7: 提交这一小步**

```bash
git add scripts/release-utils.js scripts/publish.js scripts/tests/publish-flow.test.js
git commit -m "feat: add local publish command"
```

## Task 3: 远程发布目录生成脚本

**Files:**
- Create: `D:\Projects\Cocos\cocos-mcp-server\scripts\package-remote.js`
- Modify: `D:\Projects\Cocos\cocos-mcp-server\scripts\tests\publish-flow.test.js`

- [ ] **Step 1: 先补远程打包测试，锁定 `plugin-package` 结构**

```js
const {
  packageRemoteRelease,
} = require('../package-remote');

test('packageRemoteRelease 刷新仓库内 plugin-package', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cocos-remote-package-'));
  const repoRoot = path.join(root, 'repo');

  await fs.ensureDir(path.join(repoRoot, 'dist'));
  await fs.ensureDir(path.join(repoRoot, 'static'));
  await fs.ensureDir(path.join(repoRoot, 'node_modules'));
  await fs.ensureDir(path.join(repoRoot, '@types/schema/package'));
  await fs.ensureDir(path.join(repoRoot, 'stdio-adapter/build'));
  await fs.outputFile(path.join(repoRoot, 'package.json'), '{"name":"cocos-mcp-server"}');
  await fs.outputFile(path.join(repoRoot, 'README.md'), '# readme');
  await fs.outputFile(path.join(repoRoot, 'dist/main.js'), 'module.exports = {};');
  await fs.outputFile(path.join(repoRoot, 'stdio-adapter/build/index.js'), 'console.log("ok")');
  await fs.outputFile(path.join(repoRoot, 'tsconfig.json'), '{}');

  const remoteDir = await packageRemoteRelease({
    repoRoot,
    skipBuild: true,
  });

  assert.equal(path.basename(remoteDir), 'plugin-package');
  assert.equal(await fs.pathExists(path.join(remoteDir, 'dist/main.js')), true);
  assert.equal(await fs.pathExists(path.join(remoteDir, 'stdio-adapter/build/index.js')), true);
});
```

- [ ] **Step 2: 运行测试，确认当前缺少 `package-remote.js` 导致失败**

Run: `node --test scripts/tests/publish-flow.test.js`

Expected: FAIL，报错 `Cannot find module '../package-remote'`。

- [ ] **Step 3: 实现远程打包脚本，复用共享发布逻辑**

```js
const path = require('node:path');
const {
  assertRepoRoot,
  buildArtifacts,
  copyPublishItems,
  resetDirectory,
  resolveRemotePackageDir,
  validateRequiredOutputs,
} = require('./release-utils');

async function packageRemoteRelease(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  assertRepoRoot(repoRoot);

  if (!options.skipBuild) {
    buildArtifacts(repoRoot);
  }

  validateRequiredOutputs({ repoRoot });

  const remoteDir = resolveRemotePackageDir(repoRoot);
  await resetDirectory(remoteDir);
  await copyPublishItems(repoRoot, remoteDir);
  return remoteDir;
}

async function main() {
  const remoteDir = await packageRemoteRelease();
  console.log(`远程发布目录已刷新: ${remoteDir}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { packageRemoteRelease };
```

- [ ] **Step 4: 重新运行发布流程测试**

Run: `node --test scripts/tests/publish-flow.test.js`

Expected: PASS，本地发布与 `plugin-package` 刷新测试都通过。

- [ ] **Step 5: 提交这一小步**

```bash
git add scripts/package-remote.js scripts/tests/publish-flow.test.js
git commit -m "feat: add remote package refresh command"
```

## Task 4: GitHub 默认分支安装脚本

**Files:**
- Create: `D:\Projects\Cocos\cocos-mcp-server\scripts\install-from-github.js`
- Create: `D:\Projects\Cocos\cocos-mcp-server\scripts\tests\install-from-github.test.js`

- [ ] **Step 1: 先写安装测试，约束 zip 内 `plugin-package` 提取到 `extensions/`**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
const {
  installFromGithubArchive,
} = require('../install-from-github');

test('installFromGithubArchive 把 plugin-package 安装到项目 extensions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cocos-github-install-'));
  const archiveRoot = path.join(root, 'archive-root');
  const projectRoot = path.join(root, 'project');

  await fs.ensureDir(path.join(archiveRoot, 'plugin-package/dist'));
  await fs.ensureDir(path.join(archiveRoot, 'plugin-package/static'));
  await fs.ensureDir(path.join(archiveRoot, 'plugin-package/node_modules'));
  await fs.ensureDir(path.join(archiveRoot, 'plugin-package/@types'));
  await fs.ensureDir(path.join(archiveRoot, 'plugin-package/stdio-adapter/build'));
  await fs.outputFile(path.join(archiveRoot, 'plugin-package/package.json'), '{"name":"cocos-mcp-server"}');
  await fs.outputFile(path.join(archiveRoot, 'plugin-package/README.md'), '# readme');
  await fs.outputFile(path.join(archiveRoot, 'plugin-package/dist/main.js'), 'module.exports = {};');
  await fs.outputFile(path.join(archiveRoot, 'plugin-package/stdio-adapter/build/index.js'), 'console.log("ok")');
  await fs.ensureDir(projectRoot);

  const targetDir = await installFromGithubArchive({
    projectRoot,
    extractedRoot: archiveRoot,
  });

  assert.equal(targetDir, path.join(projectRoot, 'extensions', 'cocos-mcp-server'));
  assert.equal(await fs.pathExists(path.join(targetDir, 'dist/main.js')), true);
  assert.equal(await fs.pathExists(path.join(targetDir, 'stdio-adapter/build/index.js')), true);
});
```

- [ ] **Step 2: 运行测试，确认当前缺少安装脚本导致失败**

Run: `node --test scripts/tests/install-from-github.test.js`

Expected: FAIL，报错 `Cannot find module '../install-from-github'`。

- [ ] **Step 3: 先实现可测试的安装核心与下载、解压原语**

```js
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const fs = require('fs-extra');
const {
  EXTENSION_NAME,
  ensureProjectRoot,
  resetDirectory,
  resolveExtensionTargetDir,
} = require('./release-utils');

function buildArchiveUrl(repo) {
  return `https://github.com/${repo}/archive/refs/heads/main.zip`;
}

async function installFromGithubArchive(options) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  await ensureProjectRoot(projectRoot);

  const pluginPackageRoot = path.join(options.extractedRoot, 'plugin-package');
  if (!await fs.pathExists(pluginPackageRoot)) {
    throw new Error(`远程压缩包缺少 plugin-package: ${pluginPackageRoot}`);
  }

  const targetDir = resolveExtensionTargetDir(projectRoot);
  await resetDirectory(targetDir);
  await fs.copy(pluginPackageRoot, targetDir);
  return targetDir;
}

async function main() {
  const repo = process.argv[2];
  if (!repo) {
    throw new Error('请提供 GitHub 仓库，例如: npm run install:github -- owner/repo');
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildArchiveUrl,
  installFromGithubArchive,
};
```

- [ ] **Step 4: 补齐真实可执行的下载与解压流程**

```js
async function downloadZip(url, destination) {
  await new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return downloadZip(response.headers.location, destination).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        reject(new Error(`下载失败: HTTP ${response.statusCode}`));
        return;
      }
      const stream = fs.createWriteStream(destination);
      response.pipe(stream);
      stream.on('finish', () => stream.close(resolve));
      stream.on('error', reject);
    }).on('error', reject);
  });
}

function expandArchive(zipPath, destination) {
  const { runCommand } = require('./release-utils');
  runCommand(
    'powershell',
    ['-NoProfile', '-Command', 'Expand-Archive', '-LiteralPath', zipPath, '-DestinationPath', destination, '-Force'],
    { shell: true }
  );
}
```

- [ ] **Step 5: 完成 CLI 主流程并处理 GitHub 默认分支目录层级**

```js
async function installFromGithub(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const repo = options.repo;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cocos-github-install-'));
  const zipPath = path.join(tempRoot, 'repo.zip');
  const extractRoot = path.join(tempRoot, 'extract');

  await downloadZip(buildArchiveUrl(repo), zipPath);
  expandArchive(zipPath, extractRoot);

  const [archiveDir] = await fs.readdir(extractRoot);
  return installFromGithubArchive({
    projectRoot,
    extractedRoot: path.join(extractRoot, archiveDir),
  });
}

async function main() {
  const repo = process.argv[2];
  if (!repo) {
    throw new Error('请提供 GitHub 仓库，例如: npm run install:github -- owner/repo');
  }

  const targetDir = await installFromGithub({ repo });
  console.log(`安装完成: ${targetDir}`);
}
```

- [ ] **Step 6: 运行安装测试，确认基础落盘逻辑变绿**

Run: `node --test scripts/tests/install-from-github.test.js`

Expected: PASS，`installFromGithubArchive` 成功把 `plugin-package` 安装到目标项目。

- [ ] **Step 7: 运行全部发布测试**

Run: `npm run test:release`

Expected: PASS，三组测试全部通过。

- [ ] **Step 8: 提交这一小步**

```bash
git add scripts/install-from-github.js scripts/tests/install-from-github.test.js
git commit -m "feat: add github install command"
```

## Task 5: README 与最终验证

**Files:**
- Modify: `D:\Projects\Cocos\cocos-mcp-server\README.md`

- [ ] **Step 1: 先补 README 使用说明**

```md
## 一键发布

在目标 Cocos 项目根目录执行：

```bash
npm run publish
```

如果要发布到别的项目：

```bash
npm run publish -- D:/Projects/Cocos/AnotherGame
```

## 生成远程发布目录

```bash
npm run package:remote
```

命令会刷新仓库内的 `plugin-package/`，用于 GitHub 默认分支安装。

## 从 GitHub 安装

在目标 Cocos 项目根目录执行：

```bash
npm run install:github -- owner/repo
```
```

- [ ] **Step 2: 运行完整验证命令**

Run: `npm run test:release`

Expected: PASS，所有脚本级测试通过。

- [ ] **Step 3: 运行一次真实构建验证**

Run: `npm run build`

Expected: PASS，主插件 TypeScript 构建成功。

- [ ] **Step 4: 运行一次 stdio 适配器构建验证**

Run: `npm --prefix stdio-adapter run build`

Expected: PASS，生成 `stdio-adapter/build/index.js`。

- [ ] **Step 5: 在仓库根目录执行一次真实远程打包**

Run: `npm run package:remote`

Expected: PASS，生成或刷新 `D:\Projects\Cocos\cocos-mcp-server\plugin-package\`

- [ ] **Step 6: 在临时项目目录执行一次真实本地发布**

Run: `npm run publish -- D:/tmp/cocos-demo-project`

Expected: PASS，生成 `D:/tmp/cocos-demo-project/extensions/cocos-mcp-server/`

- [ ] **Step 7: 提交最终文档与验证改动**

```bash
git add README.md package.json plugin-package scripts
git commit -m "feat: add cocos plugin publish workflow"
```

## 自检

### Spec coverage

- 本地一键发布：Task 2、Task 5
- 默认发到执行目录下的 `extensions/`，支持参数覆盖：Task 1、Task 2
- `plugin-package/` 远程发布目录：Task 3
- GitHub 默认分支安装：Task 4
- README 补充：Task 5

### Placeholder scan

- 已删除常见未完成标记与模糊指令
- 计划中的“最小实现”均附带具体代码或命令

### Type consistency

- 共享常量：`EXTENSION_NAME`、`REMOTE_PACKAGE_DIRNAME`
- 发布函数：`publishToProject`
- 远程打包函数：`packageRemoteRelease`
- 安装函数：`installFromGithubArchive`、`installFromGithub`
