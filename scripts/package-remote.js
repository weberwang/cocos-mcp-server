const {
  assertRepoRoot,
  buildArtifacts,
  copyPublishItems,
  resetDirectory,
  resolveRemotePackageDir,
  validatePublishItems,
  validateRequiredOutputs,
} = require('./release-utils');

/**
 * 刷新仓库内的远程发布目录，生成可直接分发的 plugin-package 内容。
 * @param {{
 *   repoRoot?: string,
 *   skipBuild?: boolean,
 * }} [options]
 * @returns {string}
 */
function packageRemoteRelease(options = {}) {
  const repoRoot = assertRepoRoot(options.repoRoot || process.cwd());

  if (!options.skipBuild) {
    buildArtifacts(repoRoot);
  }

  validateRequiredOutputs(repoRoot);
  // 复制前先校验完整白名单，避免清空目标目录后才在复制阶段失败。
  validatePublishItems(repoRoot);

  const remoteDir = resolveRemotePackageDir(repoRoot);
  resetDirectory(remoteDir);
  copyPublishItems(repoRoot, remoteDir);

  return remoteDir;
}

/**
 * 作为 CLI 入口复用远程打包逻辑，保证命令行与模块调用行为一致。
 */
function main() {
  try {
    const remoteDir = packageRemoteRelease();
    console.log(`远程发布目录已刷新: ${remoteDir}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  packageRemoteRelease,
};
