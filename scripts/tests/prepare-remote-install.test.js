const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { main, prepareRemoteInstall } = require('../prepare-remote-install');

/**
 * 使用调用顺序和参数桩验证依赖准备流程，不执行真实 npm 或构建命令。
 */
test('prepareRemoteInstall 使用脚本仓库路径并先安装依赖再打包', () => {
  const originalCwd = process.cwd();
  const userProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-install-project-'));
  const expectedRepoRoot = path.resolve(__dirname, '..', '..');
  const expectedDistributionDir = path.join(expectedRepoRoot, 'plugin-package');
  const calls = [];

  process.chdir(userProjectRoot);

  try {
    const result = prepareRemoteInstall({
      runCommand(command, args, options) {
        calls.push({ type: 'install', command, args, options });
      },
      packageRemoteRelease(options) {
        calls.push({ type: 'package', options });
        return expectedDistributionDir;
      },
    });

    assert.equal(result, expectedDistributionDir);
    assert.deepEqual(calls, [
      {
        type: 'install',
        command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
        args: ['ci', '--ignore-scripts', '--include=dev'],
        options: { cwd: expectedRepoRoot },
      },
      {
        type: 'package',
        options: { repoRoot: expectedRepoRoot },
      },
    ]);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(userProjectRoot, { recursive: true, force: true });
  }
});

/**
 * 验证依赖安装失败会原样向上抛出，且不会进入构建打包阶段。
 */
test('prepareRemoteInstall 在依赖安装失败时不调用打包逻辑', () => {
  const installError = new Error('npm ci failed');
  let packageWasCalled = false;

  assert.throws(
    () =>
      prepareRemoteInstall({
        runCommand() {
          throw installError;
        },
        packageRemoteRelease() {
          packageWasCalled = true;
        },
      }),
    (error) => error === installError,
  );
  assert.equal(packageWasCalled, false);
});

/**
 * 验证命令行入口成功时用中文报告最终分发目录。
 */
test('main 为准备成功输出分发目录', () => {
  const originalConsoleLog = console.log;
  const output = [];
  console.log = (message) => output.push(message);

  try {
    main({
      runCommand() {},
      packageRemoteRelease() {
        return path.join('repo', 'plugin-package');
      },
    });

    assert.match(output[0], /远程安装包准备完成/);
    assert.match(output[0], /plugin-package/);
  } finally {
    console.log = originalConsoleLog;
  }
});

/**
 * 验证命令行入口用中文说明失败原因，并设置非零退出状态。
 */
test('main 为准备失败输出清晰中文错误并设置非零退出码', () => {
  const originalExitCode = process.exitCode;
  const originalConsoleError = console.error;
  const output = [];

  process.exitCode = 0;
  console.error = (message) => output.push(message);

  try {
    main({
      runCommand() {
        throw new Error('npm ci failed');
      },
    });

    assert.equal(process.exitCode, 1);
    assert.match(output[0], /远程安装包准备失败/);
    assert.match(output[0], /npm ci failed/);
  } finally {
    process.exitCode = originalExitCode;
    console.error = originalConsoleError;
  }
});
