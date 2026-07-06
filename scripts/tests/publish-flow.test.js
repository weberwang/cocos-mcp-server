const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { publishToProject, resolvePublishOptions } = require('../publish');
const { packageRemoteRelease } = require('../package-remote');

/**
 * 创建测试所需的最小仓库结构，覆盖本地发布白名单依赖的核心目录。
 * @param {string} repoRoot
 */
function createRepoFixture(repoRoot) {
  fs.mkdirSync(path.join(repoRoot, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'static'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '@types', 'schema', 'package'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'stdio-adapter', 'build'), { recursive: true });

  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ name: 'cocos-mcp-server' }, null, 2),
  );
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# test');
  fs.writeFileSync(path.join(repoRoot, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(repoRoot, 'dist', 'main.js'), 'module.exports = {};');
  fs.writeFileSync(path.join(repoRoot, 'static', 'template.html'), '<html></html>');
  fs.writeFileSync(
    path.join(repoRoot, 'stdio-adapter', 'build', 'index.js'),
    'module.exports = {};',
  );
  fs.writeFileSync(path.join(repoRoot, '@types', 'schema', 'package', 'index.json'), '{}');
}

/**
 * 验证本地发布默认安装到 Creator 项目的 extensions 目录，并复制核心产物。
 */
test('publishToProject 发布到项目 extensions 目录并复制核心产物', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-flow-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const projectRoot = path.join(tempRoot, 'project');

  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  createRepoFixture(repoRoot);

  const targetDir = publishToProject({
    repoRoot,
    projectRoot,
    skipBuild: true,
  });

  assert.equal(targetDir, path.join(projectRoot, 'extensions', 'cocos-mcp-server'));
  assert.equal(fs.existsSync(path.join(targetDir, 'dist', 'main.js')), true);
  assert.equal(fs.existsSync(path.join(targetDir, 'stdio-adapter', 'build', 'index.js')), true);
  assert.equal(fs.existsSync(path.join(targetDir, 'static', 'template.html')), true);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf8')).scripts,
    undefined,
  );
});

/**
 * 验证 CLI 位置参数只取首个项目路径，并解析为本地发布目标目录。
 */
test('publishToProject 使用 args 的首个位置参数作为项目根目录', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-flow-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const workspaceRoot = path.join(tempRoot, 'workspace');
  const projectRoot = path.join(workspaceRoot, 'creator-project');

  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  createRepoFixture(repoRoot);

  const originalCwd = process.cwd();
  process.chdir(workspaceRoot);

  try {
    const targetDir = publishToProject({
      repoRoot,
      args: ['creator-project', 'ignored-project'],
      skipBuild: true,
    });

    assert.equal(targetDir, path.join(projectRoot, 'extensions', 'cocos-mcp-server'));
    assert.equal(fs.existsSync(path.join(targetDir, 'dist', 'main.js')), true);
  } finally {
    process.chdir(originalCwd);
  }
});

/**
 * 验证从目标项目根目录直接调用脚本时，会默认使用脚本所在源码仓库作为 repoRoot。
 */
test('resolvePublishOptions 在目标项目目录调用时默认指向脚本仓库根目录', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-flow-'));
  const cwd = path.join(tempRoot, 'creator-project');
  const scriptRepoRoot = path.join(tempRoot, 'repo');

  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(scriptRepoRoot, { recursive: true });
  createRepoFixture(scriptRepoRoot);

  try {
    const options = resolvePublishOptions(['.'], {
      cwd,
      scriptRepoRoot,
    });

    assert.deepEqual(options, {
      repoRoot: scriptRepoRoot,
      projectRoot: path.resolve(cwd, '.'),
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

/**
 * 验证发布前会清空已有插件目录，避免旧版本残留文件继续留在目标目录中。
 */
test('publishToProject 会清空目标插件目录中的旧文件', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-flow-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const projectRoot = path.join(tempRoot, 'project');
  const targetDir = path.join(projectRoot, 'extensions', 'cocos-mcp-server');

  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });
  createRepoFixture(repoRoot);
  fs.writeFileSync(path.join(targetDir, 'legacy.txt'), 'old');

  publishToProject({
    repoRoot,
    projectRoot,
    skipBuild: true,
  });

  assert.equal(fs.existsSync(path.join(targetDir, 'legacy.txt')), false);
  assert.equal(fs.existsSync(path.join(targetDir, 'dist', 'main.js')), true);
});

/**
 * 验证项目根路径如果指向普通文件而不是目录，会抛出明确错误。
 */
test('publishToProject 在项目根路径是文件时抛出明确错误', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-flow-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const projectFile = path.join(tempRoot, 'not-a-directory.txt');

  fs.mkdirSync(repoRoot, { recursive: true });
  createRepoFixture(repoRoot);
  fs.writeFileSync(projectFile, 'file');

  assert.throws(
    () =>
      publishToProject({
        repoRoot,
        projectRoot: projectFile,
        skipBuild: true,
      }),
    /目标项目目录不是目录/,
  );
});

/**
 * 验证白名单项缺失时会在清空目标目录前给出明确错误，避免底层复制异常泄漏。
 */
test('publishToProject 在缺少白名单项时抛出明确错误', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-flow-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const projectRoot = path.join(tempRoot, 'project');
  const targetDir = path.join(projectRoot, 'extensions', 'cocos-mcp-server');

  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  createRepoFixture(repoRoot);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'legacy.txt'), 'old');
  fs.rmSync(path.join(repoRoot, 'README.md'));

  assert.throws(
    () =>
      publishToProject({
        repoRoot,
        projectRoot,
        skipBuild: true,
      }),
    /缺少发布白名单项/,
  );

  assert.equal(fs.existsSync(path.join(targetDir, 'legacy.txt')), true);
});

/**
 * 验证远程发布会刷新仓库内 plugin-package 目录，并复制远程安装所需的核心产物。
 */
test('packageRemoteRelease 刷新 plugin-package 并复制核心产物', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-flow-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const remoteDir = path.join(repoRoot, 'plugin-package');

  fs.mkdirSync(repoRoot, { recursive: true });
  createRepoFixture(repoRoot);
  fs.mkdirSync(remoteDir, { recursive: true });
  fs.writeFileSync(path.join(remoteDir, 'legacy.txt'), 'old');

  const resultDir = packageRemoteRelease({
    repoRoot,
    skipBuild: true,
  });

  assert.equal(resultDir, path.join(repoRoot, 'plugin-package'));
  assert.equal(fs.existsSync(path.join(remoteDir, 'legacy.txt')), false);
  assert.equal(fs.existsSync(path.join(remoteDir, 'dist', 'main.js')), true);
  assert.equal(fs.existsSync(path.join(remoteDir, 'stdio-adapter', 'build', 'index.js')), true);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(remoteDir, 'package.json'), 'utf8')).scripts,
    undefined,
  );
});

/**
 * 验证远程发布在白名单校验失败时不会先清空已有 plugin-package，避免旧包被误删。
 */
test('packageRemoteRelease 在缺少白名单项时保留已有 plugin-package 内容', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-flow-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const remoteDir = path.join(repoRoot, 'plugin-package');

  fs.mkdirSync(repoRoot, { recursive: true });
  createRepoFixture(repoRoot);
  fs.mkdirSync(remoteDir, { recursive: true });
  fs.writeFileSync(path.join(remoteDir, 'legacy.txt'), 'old');
  fs.rmSync(path.join(repoRoot, 'README.md'));

  assert.throws(
    () =>
      packageRemoteRelease({
        repoRoot,
        skipBuild: true,
      }),
    /缺少发布白名单项/,
  );

  assert.equal(fs.existsSync(path.join(remoteDir, 'legacy.txt')), true);
});
