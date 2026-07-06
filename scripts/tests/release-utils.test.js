const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  REQUIRED_OUTPUTS,
  PUBLISH_ITEMS,
  assertRepoRoot,
  resolveExtensionTargetDir,
  resolveProjectRoot,
  resolveRemotePackageDir,
  runCommand,
  sanitizeDistributionPackageJson,
  validateRequiredOutputs,
} = require('../release-utils');

/**
 * 验证项目根目录在未传参时回退到当前工作目录。
 */
test('resolveProjectRoot 默认返回当前执行目录', () => {
  assert.equal(resolveProjectRoot(), process.cwd());
});

/**
 * 验证显式传入的项目目录优先级高于当前工作目录。
 */
test('resolveProjectRoot 参数路径优先于当前执行目录', () => {
  const projectRoot = path.join('workspace', 'demo-project');

  assert.equal(resolveProjectRoot(projectRoot), projectRoot);
});

/**
 * 验证扩展安装目录固定拼接到 Creator extensions 目录下。
 */
test('resolveExtensionTargetDir 拼接 extensions/cocos-mcp-server', () => {
  const projectRoot = path.join('workspace', 'demo-project');

  assert.equal(
    resolveExtensionTargetDir(projectRoot),
    path.join(projectRoot, 'extensions', 'cocos-mcp-server'),
  );
});

/**
 * 验证远端打包目录固定落在仓库内 plugin-package。
 */
test('resolveRemotePackageDir 指向仓库内 plugin-package', () => {
  const projectRoot = path.join('workspace', 'demo-project');

  assert.equal(
    resolveRemotePackageDir(projectRoot),
    path.join(projectRoot, 'plugin-package'),
  );
});

/**
 * 验证发布清单顺序，避免后续脚本复制内容时顺序漂移。
 */
test('PUBLISH_ITEMS 包含约定 source 顺序', () => {
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
    ],
  );
});

/**
 * 验证仓库根目录校验在未传参时回退到当前工作目录，并确认仓库特征匹配。
 */
test('assertRepoRoot 成功时返回当前工作目录', () => {
  const projectRoot = path.join('workspace', 'repo-root');
  const visitedPaths = [];

  assert.equal(
    assertRepoRoot(undefined, {
      cwd() {
        return projectRoot;
      },
      existsSync(targetPath) {
        visitedPaths.push(targetPath);
        return (
          targetPath === path.join(projectRoot, 'package.json') ||
          targetPath === path.join(projectRoot, 'static') ||
          targetPath === path.join(projectRoot, 'stdio-adapter')
        );
      },
      readPackageJson() {
        return { name: 'cocos-mcp-server' };
      },
    }),
    projectRoot,
  );

  assert.deepEqual(visitedPaths, [
    path.join(projectRoot, 'package.json'),
    path.join(projectRoot, 'static'),
    path.join(projectRoot, 'stdio-adapter'),
  ]);
});

/**
 * 验证仓库标识不匹配时立即拒绝，避免误把任意 Node 工程当成本仓库。
 */
test('assertRepoRoot 在 package.json.name 不匹配时抛错', () => {
  const projectRoot = path.join('workspace', 'wrong-project');

  assert.throws(
    () =>
      assertRepoRoot(projectRoot, {
        existsSync() {
          return true;
        },
        readPackageJson() {
          return { name: 'another-project' };
        },
      }),
    /cocos-mcp-server/,
  );
});

/**
 * 验证缺少核心编译产物时立即报错，避免发布残缺包。
 */
test('validateRequiredOutputs 缺少 dist/main.js 时抛错', () => {
  const projectRoot = path.join('workspace', 'demo-project');

  assert.throws(
    () =>
      validateRequiredOutputs(projectRoot, {
        hasPath(targetPath) {
          return targetPath !== path.join(projectRoot, 'dist', 'main.js');
        },
      }),
    /dist[\\/]main\.js/,
  );
});

/**
 * 验证成功分支会完整检查每一个必要产物路径。
 */
test('validateRequiredOutputs 成功时覆盖完整 REQUIRED_OUTPUTS', () => {
  const projectRoot = path.join('workspace', 'demo-project');
  const checkedPaths = [];

  validateRequiredOutputs(projectRoot, {
    hasPath(targetPath) {
      checkedPaths.push(targetPath);
      return true;
    },
  });

  assert.deepEqual(
    checkedPaths,
    REQUIRED_OUTPUTS.map((relativePath) => path.join(projectRoot, relativePath)),
  );
});

/**
 * 验证命令执行透传参数，并默认使用 inherit 输出约定。
 */
test('runCommand 按约定调用 execFileSync', () => {
  const calls = [];

  runCommand('node', ['--version'], {
    cwd: path.join('workspace', 'demo-project'),
    execFileSync(command, args, options) {
      calls.push({ command, args, options });
    },
  });

  assert.deepEqual(calls, [
    {
      command: 'node',
      args: ['--version'],
      options: {
        cwd: path.join('workspace', 'demo-project'),
        stdio: 'inherit',
      },
    },
  ]);
});

/**
 * 验证 Windows 下仅 npm.cmd 会走 cmd.exe 包装，避免把普通命令也强行改走额外分支。
 */
test('runCommand 在 Windows 下仅包装 npm.cmd', () => {
  const calls = [];
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'win32',
  });

  try {
    runCommand('npm.cmd', ['run', 'build'], {
      cwd: path.join('workspace', 'demo-project'),
      execFileSync(command, args, options) {
        calls.push({ command, args, options });
      },
    });
  } finally {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  }

  assert.deepEqual(calls, [
    {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd', 'run', 'build'],
      options: {
        cwd: path.join('workspace', 'demo-project'),
        stdio: 'inherit',
      },
    },
  ]);
});

/**
 * 验证分发版 package.json 会裁掉仓库内脚本，避免发布产物继续暴露不可用命令。
 */
test('sanitizeDistributionPackageJson 会移除 scripts 并保留其他字段', () => {
  const sourceManifest = {
    name: 'cocos-mcp-server',
    version: '1.5.1',
    scripts: {
      build: 'tsc',
      publish: 'node scripts/publish.js',
    },
    dependencies: {
      vue: '^3.5.33',
    },
  };

  assert.deepEqual(sanitizeDistributionPackageJson(sourceManifest), {
    name: 'cocos-mcp-server',
    version: '1.5.1',
    dependencies: {
      vue: '^3.5.33',
    },
  });
});

/**
 * 验证仓库脚本面与旧入口文件都已移除，避免旧发布流程继续对外可见或残留可执行入口。
 */
test('package.json 与旧本地安装入口文件都不再存在', () => {
  const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const installScriptPath = path.join(__dirname, '..', 'install-from-github.js');
  const installScriptTestPath = path.join(__dirname, 'install-from-github.test.js');

  assert.equal(
    Object.prototype.hasOwnProperty.call(packageJson.scripts ?? {}, 'install:github'),
    false,
  );
  assert.equal(fs.existsSync(installScriptPath), false);
  assert.equal(fs.existsSync(installScriptTestPath), false);
});
