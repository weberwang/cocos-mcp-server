const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * 共享发布工具的扩展目录名，后续安装和打包脚本都依赖这个固定名称。
 */
const EXTENSION_NAME = 'cocos-mcp-server';

/**
 * 远端安装包输出目录固定在仓库内，避免脚本各自散落不同目录。
 */
const REMOTE_PACKAGE_DIRNAME = 'plugin-package';

/**
 * 发布前必须存在的核心产物，缺一项都说明构建结果不完整。
 */
const REQUIRED_OUTPUTS = [
  'dist/main.js',
  'static',
  'package.json',
  'stdio-adapter/build/index.js',
];

/**
 * 统一维护发布内容顺序，避免多个脚本各自维护白名单产生漂移。
 */
const PUBLISH_ITEMS = [
  { source: 'dist' },
  { source: 'static' },
  { source: 'package.json' },
  { source: 'node_modules' },
  { source: '@types' },
  { source: 'stdio-adapter/build' },
  { source: 'support-packages' },
  { source: 'README.md' },
];

/**
 * 生成分发版 package.json，移除仓库内才可用的脚本声明，避免发布产物误导调用方式。
 * @param {Record<string, unknown>} packageJson
 * @returns {Record<string, unknown>}
 */
function sanitizeDistributionPackageJson(packageJson) {
  const sanitizedPackageJson = { ...packageJson };
  delete sanitizedPackageJson.scripts;
  return sanitizedPackageJson;
}

/**
 * 校验仓库根目录最基本的标识文件，尽早阻止脚本在错误目录执行。
 * @param {string | undefined} projectRoot
 * @param {{
 *   cwd?: () => string,
 *   existsSync?: (targetPath: string) => boolean,
 *   readPackageJson?: (packageJsonPath: string) => { name?: string },
 * }} [options]
 * @returns {string}
 */
function assertRepoRoot(projectRoot, options = {}) {
  const root = resolveProjectRoot(projectRoot || (options.cwd ? options.cwd() : undefined));
  const existsSync = options.existsSync || fs.existsSync;
  const readPackageJson =
    options.readPackageJson ||
    ((packageJsonPath) => JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')));
  const packageJsonPath = path.join(root, 'package.json');
  const staticDirPath = path.join(root, 'static');
  const stdioAdapterDirPath = path.join(root, 'stdio-adapter');

  if (!existsSync(packageJsonPath)) {
    throw new Error(`仓库根目录无效，缺少 package.json: ${packageJsonPath}`);
  }

  const packageJson = readPackageJson(packageJsonPath);

  if (packageJson.name !== EXTENSION_NAME) {
    throw new Error(`仓库根目录无效，package.json.name 必须为 ${EXTENSION_NAME}: ${packageJsonPath}`);
  }

  // 同时校验静态资源目录和适配器目录，避免误把普通 Node 工程识别为当前仓库。
  if (!existsSync(staticDirPath) || !existsSync(stdioAdapterDirPath)) {
    throw new Error(`仓库根目录无效，缺少 Cocos 扩展目录结构: ${root}`);
  }

  return root;
}

/**
 * 解析项目根目录；显式路径优先，未传时回退到当前工作目录。
 * @param {string | undefined} projectRoot
 * @param {{ cwd?: string }} [options]
 * @returns {string}
 */
function resolveProjectRoot(projectRoot, options = {}) {
  return projectRoot || options.cwd || process.cwd();
}

/**
 * 从 CLI 位置参数解析项目根目录，只消费第一个参数，避免把命令选项解析职责混入通用路径函数。
 * @param {string[] | undefined} args
 * @param {{ cwd?: string }} [options]
 * @returns {string}
 */
function resolveProjectRootFromArgs(args, options = {}) {
  const firstArg = Array.isArray(args) ? args[0] : undefined;
  const cwd = options.cwd || process.cwd();
  return firstArg ? path.resolve(cwd, firstArg) : cwd;
}

/**
 * 解析 Creator 项目中的扩展安装目标目录。
 * @param {string} projectRoot
 * @returns {string}
 */
function resolveExtensionTargetDir(projectRoot) {
  return path.join(resolveProjectRoot(projectRoot), 'extensions', EXTENSION_NAME);
}

/**
 * 解析仓库内远端安装包输出目录。
 * @param {string} projectRoot
 * @returns {string}
 */
function resolveRemotePackageDir(projectRoot) {
  return path.join(resolveProjectRoot(projectRoot), REMOTE_PACKAGE_DIRNAME);
}

/**
 * 校验发布所需产物是否齐全；允许注入 hasPath 以便测试直接覆盖缺失场景。
 * @param {string} projectRoot
 * @param {{ hasPath?: (targetPath: string) => boolean }} [options]
 */
function validateRequiredOutputs(projectRoot, options = {}) {
  const root = resolveProjectRoot(projectRoot);
  const hasPath = options.hasPath || fs.existsSync;

  for (const relativePath of REQUIRED_OUTPUTS) {
    const targetPath = path.join(root, relativePath);

    if (!hasPath(targetPath)) {
      throw new Error(`缺少必要发布产物: ${targetPath}`);
    }
  }
}

/**
 * 统一执行外部命令，保持子进程输出直通，便于发布脚本复用。
 * @param {string} command
 * @param {string[]} [args]
 * @param {import('node:child_process').ExecFileSyncOptions & {
 *   execFileSync?: typeof execFileSync,
 * }} [options]
 */
function runCommand(command, args = [], options = {}) {
  const { execFileSync: execFileSyncImpl = execFileSync, ...execOptions } = options;
  const shouldUseCmdWrapper = process.platform === 'win32' && /^npm\.cmd$/i.test(command);
  const finalOptions = {
    stdio: 'inherit',
    ...execOptions,
  };
  const finalCommand = shouldUseCmdWrapper ? process.env.ComSpec || 'cmd.exe' : command;
  const finalArgs = shouldUseCmdWrapper ? ['/d', '/s', '/c', command, ...args] : args;

  // Windows 下直接 spawn npm.cmd 在当前 Node 运行环境里会报 EINVAL，这里改走 cmd 包装且不引入 shell=true 告警。
  execFileSyncImpl(finalCommand, finalArgs, finalOptions);
}

/**
 * 写入分发版 package.json，确保发布目录内只保留真实可用的 manifest 字段。
 * @param {string} sourcePath
 * @param {string} destinationPath
 */
function copyDistributionPackageJson(sourcePath, destinationPath) {
  const packageJson = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const sanitizedPackageJson = sanitizeDistributionPackageJson(packageJson);
  fs.writeFileSync(destinationPath, `${JSON.stringify(sanitizedPackageJson, null, 2)}\n`);
}

/**
 * 校验 Creator 项目根目录存在，并确保 extensions 目录可用于本地安装。
 * @param {string} projectRoot
 * @returns {string}
 */
function ensureProjectRoot(projectRoot) {
  const root = resolveProjectRoot(projectRoot);

  if (!fs.existsSync(root)) {
    throw new Error(`目标项目目录不存在: ${root}`);
  }

  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`目标项目目录不是目录: ${root}`);
  }

  fs.mkdirSync(path.join(root, 'extensions'), { recursive: true });
  return root;
}

/**
 * 执行本地发布前的构建流程，保证主扩展与 stdio 适配器产物都已更新。
 * @param {string} repoRoot
 */
function buildArtifacts(repoRoot) {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  runCommand(npmCommand, ['run', 'build'], { cwd: repoRoot });
  runCommand(npmCommand, ['run', 'build'], {
    cwd: path.join(repoRoot, 'stdio-adapter'),
  });
}

/**
 * 清空并重建目标目录，避免旧文件残留影响本地安装结果。
 * @param {string} targetDir
 */
function resetDirectory(targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
}

/**
 * 按发布白名单复制文件和目录，避免把仓库中的无关内容带入安装目录。
 * @param {string} repoRoot
 * @param {string} targetDir
 */
function copyPublishItems(repoRoot, targetDir) {
  for (const item of PUBLISH_ITEMS) {
    const sourcePath = path.join(repoRoot, item.source);
    const relativeTarget = item.target || item.source;
    const destinationPath = path.join(targetDir, relativeTarget);

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

    if (item.source === 'package.json') {
      copyDistributionPackageJson(sourcePath, destinationPath);
      continue;
    }

    fs.cpSync(sourcePath, destinationPath, { recursive: true });
  }
}

/**
 * 发布前完整校验白名单源路径，避免清空目标目录后才在复制阶段失败。
 * @param {string} repoRoot
 */
function validatePublishItems(repoRoot) {
  for (const item of PUBLISH_ITEMS) {
    const sourcePath = path.join(repoRoot, item.source);

    if (!fs.existsSync(sourcePath)) {
      throw new Error(`缺少发布白名单项: ${sourcePath}`);
    }
  }
}

module.exports = {
  EXTENSION_NAME,
  REMOTE_PACKAGE_DIRNAME,
  REQUIRED_OUTPUTS,
  PUBLISH_ITEMS,
  assertRepoRoot,
  resolveProjectRoot,
  resolveProjectRootFromArgs,
  resolveExtensionTargetDir,
  resolveRemotePackageDir,
  validateRequiredOutputs,
  validatePublishItems,
  runCommand,
  sanitizeDistributionPackageJson,
  ensureProjectRoot,
  buildArtifacts,
  resetDirectory,
  copyDistributionPackageJson,
  copyPublishItems,
};
