const path = require('node:path');

const { assertRepoRoot, runCommand } = require('./release-utils');
const { packageRemoteRelease } = require('./package-remote');

/**
 * 安装仓库依赖并生成可供远程安装脚本使用的完整分发目录。
 * @param {{
 *   repoRoot?: string,
 *   runCommand?: typeof runCommand,
 *   packageRemoteRelease?: typeof packageRemoteRelease,
 * }} [options]
 * @returns {string}
 */
function prepareRemoteInstall(options = {}) {
  // 远程安装脚本通常从 Cocos 项目目录启动，因此默认仓库位置必须由脚本自身确定。
  const repoRoot = assertRepoRoot(options.repoRoot || path.resolve(__dirname, '..'));
  const runCommandImpl = options.runCommand || runCommand;
  const packageRemoteReleaseImpl = options.packageRemoteRelease || packageRemoteRelease;
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  // 构建依赖必须安装；显式包含 devDependencies 可避免生产环境配置省略 TypeScript 编译器。
  runCommandImpl(npmCommand, ['ci', '--ignore-scripts', '--include=dev'], { cwd: repoRoot });

  return packageRemoteReleaseImpl({ repoRoot });
}

/**
 * 提供中文命令行反馈，并将任何准备失败转换为非零退出码。
 * @param {Parameters<typeof prepareRemoteInstall>[0]} [options]
 */
function main(options = {}) {
  try {
    const remoteDir = prepareRemoteInstall(options);
    console.log(`远程安装包准备完成: ${remoteDir}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`远程安装包准备失败: ${message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  prepareRemoteInstall,
  main,
};
