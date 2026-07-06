const path = require('node:path');

const {
  assertRepoRoot,
  buildArtifacts,
  copyPublishItems,
  ensureProjectRoot,
  resetDirectory,
  resolveExtensionTargetDir,
  resolveProjectRootFromArgs,
  validatePublishItems,
  validateRequiredOutputs,
} = require('./release-utils');

/**
 * 解析发布脚本的仓库根目录与目标项目根目录，保证从目标项目目录直调脚本时也能定位源码仓库。
 * @param {string[]} [args]
 * @param {{
 *   repoRoot?: string,
 *   projectRoot?: string,
 *   cwd?: string,
 *   scriptRepoRoot?: string,
 * }} [options]
 * @returns {{ repoRoot: string, projectRoot: string }}
 */
function resolvePublishOptions(args = [], options = {}) {
  const cwd = options.cwd || process.cwd();
  const scriptRepoRoot = options.scriptRepoRoot || path.resolve(__dirname, '..');

  return {
    repoRoot: assertRepoRoot(options.repoRoot || scriptRepoRoot),
    projectRoot: ensureProjectRoot(
      options.projectRoot || resolveProjectRootFromArgs(args, { cwd }),
    ),
  };
}

/**
 * 执行本地一键发布：校验仓库、可选构建、清理目标目录并复制发布白名单。
 * @param {{
 *   repoRoot?: string,
  *   projectRoot?: string,
  *   args?: string[],
  *   skipBuild?: boolean,
 * }} [options]
 * @returns {string}
 */
function publishToProject(options = {}) {
  const { repoRoot, projectRoot } = resolvePublishOptions(options.args || [], options);

  if (!options.skipBuild) {
    buildArtifacts(repoRoot);
  }

  validateRequiredOutputs(repoRoot);
  validatePublishItems(repoRoot);

  const targetDir = resolveExtensionTargetDir(projectRoot);
  resetDirectory(targetDir);
  copyPublishItems(repoRoot, targetDir);

  return targetDir;
}

/**
 * 作为 CLI 执行时复用同一套发布逻辑，避免脚本入口和模块导出行为分叉。
 */
function main() {
  try {
    const targetDir = publishToProject({
      args: process.argv.slice(2),
    });

    console.log(`发布完成: ${targetDir}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  publishToProject,
  resolvePublishOptions,
};
