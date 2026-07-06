const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 读取仓库根目录下的 README 文件，统一 README 契约测试入口，避免中英文测试各自散落路径逻辑。
 * @param {string} relativePath README 相对仓库根目录的路径。
 * @returns {string}
 */
function readRepositoryDoc(relativePath) {
  const readmePath = path.join(__dirname, '..', '..', relativePath);
  return fs.readFileSync(readmePath, 'utf8');
}

/**
 * 统一校验 README 的远程安装核心语义，确保不同语言版本对安装入口、默认路径和源码仓库边界描述一致。
 * @param {string} readme README 内容。
 * @param {{defaultInstallPath: RegExp, runFromProjectRoot: RegExp, sourceRepoBoundary: RegExp}} expectations 多语言语义断言集合。
 */
function assertRemoteInstallReadmeContract(readme, expectations) {
  assert.match(readme, /install\.ps1/);
  assert.match(readme, /install\.sh/);
  assert.match(readme, /COCOS_PROJECT_PATH/);
  assert.match(readme, expectations.defaultInstallPath);
  assert.match(readme, expectations.runFromProjectRoot);
  assert.match(readme, expectations.sourceRepoBoundary);
  assert.doesNotMatch(readme, /scripts\/install-from-github\.js/);
}

/**
 * 验证 PowerShell 远程安装入口保留关键契约，避免后续重构破坏发布流程。
 */
test('install.ps1 包含远程安装入口关键契约', () => {
  const installScriptPath = path.join(__dirname, '..', '..', 'install.ps1');
  const installScript = fs.readFileSync(installScriptPath, 'utf8');

  assert.match(installScript, /\[string\]\$RepoOwner\s*=\s*'weberwang'/);
  assert.match(installScript, /\[string\]\$RepoName\s*=\s*'cocos-mcp-server'/);
  assert.match(installScript, /\[string\]\$ProjectPath\s*=\s*\$env:COCOS_PROJECT_PATH/);
  assert.match(installScript, /Get-DefaultBranch/);
  assert.match(installScript, /default_branch/);
  assert.match(installScript, /Expand-Archive/);
  assert.match(installScript, /Join-Path\s+\$TargetProjectPath\s+'extensions'/);
  assert.match(installScript, /Join-Path\s+\$targetExtensionsDir\s+'cocos-mcp-server'/);
  assert.match(installScript, /plugin-package/);
  assert.match(installScript, /finally/);
  assert.match(installScript, /cocos-mcp-server\.__new__/);
  assert.match(installScript, /cocos-mcp-server\.__backup__/);
  assert.match(installScript, /Move-Item/);
  assert.doesNotMatch(
    installScript,
    /if\s*\(Test-Path\s*-LiteralPath\s*\$targetDir\)\s*\{\s*Remove-Item\s*-LiteralPath\s*\$targetDir\s*-Recurse\s*-Force\s*\}\s*Copy-Item\s*-LiteralPath\s*\$sourceDir\s*-Destination\s*\$targetDir\s*-Recurse/s,
  );
});

/**
 * 验证 Shell 远程安装入口保留关键契约，避免发布地址或安装路径被意外改坏。
 */
test('install.sh 包含远程安装入口关键契约', () => {
  const installScriptPath = path.join(__dirname, '..', '..', 'install.sh');
  const installScript = fs.readFileSync(installScriptPath, 'utf8');

  assert.match(installScript, /REPO_OWNER="\$\{REPO_OWNER:-weberwang\}"/);
  assert.match(installScript, /REPO_NAME="\$\{REPO_NAME:-cocos-mcp-server\}"/);
  assert.match(installScript, /default_branch/);
  assert.match(installScript, /plugin-package/);
  assert.match(installScript, /COCOS_PROJECT_PATH/);
  assert.match(installScript, /unzip/);
  assert.match(installScript, /extensions\/cocos-mcp-server/);
  assert.match(installScript, /cocos-mcp-server\.__new__/);
  assert.match(installScript, /cocos-mcp-server\.__backup__/);
  assert.match(installScript, /require_command "curl"/);
  assert.match(installScript, /require_command "unzip"/);
  assert.match(installScript, /require_command "find"/);
  assert.match(installScript, /require_command "sed"/);
  assert.match(installScript, /require_command "mktemp"/);
  assert.match(installScript, /缺少依赖命令:/);
  assert.match(installScript, /trap .*EXIT/);
  assert.match(installScript, /sed -n 's\/\.\*"default_branch"/);
  assert.doesNotMatch(
    installScript,
    /rm -rf "\$\{target_dir\}".*cp -R "\$\{source_dir\}" "\$\{target_dir\}"/s,
  );
});

/**
 * 验证中文 README 仅保留远程安装口径，避免重新引入本地仓库安装脚本说明。
 */
test('README.md 保持纯远程安装文案契约', () => {
  const readme = readRepositoryDoc('README.md');

  assertRemoteInstallReadmeContract(readme, {
    // 默认安装目录必须明确落到当前目录下的扩展路径，避免 README 只说远程安装却不说最终落点。
    defaultInstallPath: /<当前目录>\/extensions\/cocos-mcp-server/,
    runFromProjectRoot: /在目标\s*Cocos Creator\s*项目根目录执行/,
    sourceRepoBoundary: /源码仓库维护命令|只存在于源码仓库/,
  });
});

/**
 * 验证英文 README 与中文 README 保持一致的远程安装口径。
 */
test('README.EN.md 保持纯远程安装文案契约', () => {
  const readme = readRepositoryDoc('README.EN.md');

  assertRemoteInstallReadmeContract(readme, {
    // 英文 README 也必须明确默认落点和源码仓库边界，防止只保留命令而丢失迁移语义。
    defaultInstallPath: /<current-directory>\/extensions\/cocos-mcp-server/,
    runFromProjectRoot: /Run this from the target Cocos Creator project root/i,
    sourceRepoBoundary: /Source Repository Maintenance Commands|only exist in the source repository/i,
  });
});
