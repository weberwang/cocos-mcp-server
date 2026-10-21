const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const powerShellCommand = 'pwsh.exe';

/**
 * 探测系统命令能否按测试所需参数正常启动，用于在缺少平台工具时明确跳过对应集成测试。
 * @param {string} command 命令名称或可执行文件路径。
 * @param {string[]} args 探测命令参数。
 * @returns {boolean}
 */
function isCommandAvailable(command, args) {
  const result = childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
  });

  return !result.error && result.status === 0;
}

/**
 * 通过 Git 执行目录和 where.exe 定位 Git for Windows，避免测试绑定某台机器的安装盘符。
 * @returns {string|null} Git for Windows 的 sh.exe 路径；未找到时返回 null。
 */
function resolveGitBashPath() {
  const candidatePaths = [];
  const gitExecPathResult = childProcess.spawnSync('git', ['--exec-path'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const gitLocationResult = childProcess.spawnSync('where.exe', ['git'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const gitLocations = [];
  if (gitLocationResult.status === 0) {
    for (const location of gitLocationResult.stdout.split(/\r?\n/)) {
      const trimmedLocation = location.trim();
      if (trimmedLocation) {
        gitLocations.push(trimmedLocation);
      }
    }
  }

  if (!gitExecPathResult.error && gitExecPathResult.status === 0) {
    let directory = path.resolve(gitExecPathResult.stdout.trim());
    while (true) {
      candidatePaths.push(path.join(directory, 'bin', 'sh.exe'));
      const parentDirectory = path.dirname(directory);
      if (parentDirectory === directory) {
        break;
      }
      directory = parentDirectory;
    }
  }

  for (const gitLocation of gitLocations) {
    let directory = path.dirname(gitLocation);
    while (true) {
      candidatePaths.push(path.join(directory, 'bin', 'sh.exe'));
      const parentDirectory = path.dirname(directory);
      if (parentDirectory === directory) {
        break;
      }
      directory = parentDirectory;
    }
  }

  for (const installRoot of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (installRoot) {
      candidatePaths.push(path.join(installRoot, 'Git', 'bin', 'sh.exe'));
    }
  }

  for (const candidatePath of candidatePaths) {
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

const powerShellAvailable = isCommandAvailable(powerShellCommand, [
  '-NoLogo',
  '-NoProfile',
  '-Command',
  'exit 0',
]);
const gitBashPath = resolveGitBashPath();
const gitBashAvailable = gitBashPath !== null;

/**
 * 将 Windows 绝对路径转换为 Git Bash 可直接传给内建命令的 POSIX 路径。
 * @param {string} windowsPath Windows 文件系统路径。
 * @returns {string}
 */
function toGitBashPath(windowsPath) {
  const normalizedPath = windowsPath.replace(/\\/g, '/');
  const drivePath = normalizedPath.match(/^([A-Za-z]):(\/.*)?$/);

  if (!drivePath) {
    return normalizedPath;
  }

  return `/${drivePath[1].toLowerCase()}${drivePath[2] || ''}`;
}

/**
 * 创建仅含准备脚本的本地源码压缩包，准备脚本会在安装器解压目录内生成最小插件包。
 * @param {boolean} buildShouldFail 是否让夹具准备脚本以退出码 42 失败。
 * @returns {{root: string, archivePath: string, sourceScriptsPath: string, markerPath: string}}
 */
function createFixture(buildShouldFail) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-install-flow-'));
  const sourceRoot = path.join(root, 'remote-source-main');
  const sourceScriptsPath = path.join(sourceRoot, 'scripts');
  const archivePath = path.join(root, 'source archive.zip');
  const markerPath = path.join(root, 'prepare-script-called.json');
  const archiveCreatorPath = path.join(root, 'create-source-archive.ps1');
  const prepareScript = `
const fs = require('node:fs');
const path = require('node:path');

fs.writeFileSync(process.env.REMOTE_INSTALL_PREPARE_MARKER, JSON.stringify({
  scriptDirectory: __dirname,
  currentDirectory: process.cwd(),
}));

if (process.env.REMOTE_INSTALL_BUILD_FAIL === '1') {
  process.exit(42);
}

const packageRoot = path.resolve(__dirname, '..', 'plugin-package');
fs.mkdirSync(packageRoot, { recursive: true });
fs.writeFileSync(path.join(packageRoot, 'version.txt'), 'fixture-version-2.0.0');
fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
  name: 'cocos-mcp-server-fixture',
  version: '2.0.0',
}, null, 2));
`;

  fs.mkdirSync(sourceScriptsPath, { recursive: true });
  fs.writeFileSync(path.join(sourceScriptsPath, 'prepare-remote-install.js'), prepareScript);
  fs.writeFileSync(
    archiveCreatorPath,
    [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      '[System.IO.Compression.ZipFile]::CreateFromDirectory(',
      '  $env:REMOTE_INSTALL_SOURCE_ROOT,',
      '  $env:REMOTE_INSTALL_ARCHIVE_PATH,',
      '  [System.IO.Compression.CompressionLevel]::Optimal,',
      '  $true',
      ')',
    ].join('\n'),
    'utf8',
  );

  try {
    if (!powerShellAvailable) {
      throw new Error('生成本地源码压缩包需要 pwsh.exe。');
    }

    const env = { ...process.env };
    env.REMOTE_INSTALL_SOURCE_ROOT = sourceRoot;
    env.REMOTE_INSTALL_ARCHIVE_PATH = archivePath;
    const archiveResult = childProcess.spawnSync(
      powerShellCommand,
      ['-NoLogo', '-NoProfile', '-File', archiveCreatorPath],
      { cwd: root, env, encoding: 'utf8', windowsHide: true },
    );

    assert.equal(
      archiveResult.status,
      0,
      `创建测试压缩包失败：${archiveResult.stderr || archiveResult.stdout || archiveResult.error}`,
    );

    return { root, archivePath, sourceScriptsPath, markerPath, buildShouldFail };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/**
 * 按 Windows 环境变量大小写不敏感规则设置或删除指定变量，避免继承宿主机上的同名配置。
 * @param {NodeJS.ProcessEnv} env 子进程环境变量对象。
 * @param {string} name 环境变量名称。
 * @param {string|undefined} value 要设置的值；未定义时删除变量。
 */
function setEnvironmentValue(env, name, value) {
  for (const existingName of Object.keys(env)) {
    if (existingName.toLowerCase() === name.toLowerCase()) {
      delete env[existingName];
    }
  }

  if (value !== undefined) {
    env[name] = value;
  }
}

/**
 * 运行 PowerShell 安装入口，并用本地函数替代 GitHub API 和压缩包下载，避免网络访问。
 * @param {{fixture: object, projectRoot: string, workingDirectory: string, useProjectPathEnvironment: boolean}} options 场景配置。
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runPowerShellInstaller(options) {
  const wrapperPath = path.join(options.fixture.root, 'run-installer.ps1');
  fs.writeFileSync(
    wrapperPath,
    [
      "$ErrorActionPreference = 'Stop'",
      'function Invoke-RestMethod {',
      '  param([string]$Uri, [hashtable]$Headers, [string]$Method)',
      "  return [pscustomobject]@{ default_branch = 'main' }",
      '}',
      'function Invoke-WebRequest {',
      '  param([string]$Uri, [string]$OutFile, [hashtable]$Headers)',
      '  Copy-Item -LiteralPath $env:REMOTE_INSTALL_FIXTURE_ZIP -Destination $OutFile -Force',
      '}',
      '& $env:REMOTE_INSTALL_ENTRY_SCRIPT -RepoOwner fixture-owner -RepoName fixture-repo',
    ].join('\n'),
    'utf8',
  );

  const env = { ...process.env };
  env.REMOTE_INSTALL_FIXTURE_ZIP = options.fixture.archivePath;
  env.REMOTE_INSTALL_PREPARE_MARKER = options.fixture.markerPath;
  env.REMOTE_INSTALL_BUILD_FAIL = options.fixture.buildShouldFail ? '1' : '0';
  env.REMOTE_INSTALL_ENTRY_SCRIPT = path.join(repositoryRoot, 'install.ps1');
  setEnvironmentValue(
    env,
    'COCOS_PROJECT_PATH',
    options.useProjectPathEnvironment ? options.projectRoot : undefined,
  );

  const result = childProcess.spawnSync(
    powerShellCommand,
    ['-NoLogo', '-NoProfile', '-File', wrapperPath],
    { cwd: options.workingDirectory, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 },
  );
  result.commandDescription = `${powerShellCommand} -NoLogo -NoProfile -File "${wrapperPath}"`;
  return result;
}

/**
 * 运行 Shell 安装入口，通过临时 curl 桩返回默认分支并复制本地压缩包。
 * @param {{fixture: object, projectRoot: string, workingDirectory: string, useProjectPathEnvironment: boolean}} options 场景配置。
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runShellInstaller(options) {
  const fakeBinPath = path.join(options.fixture.root, 'fake bin');
  const fakeCurlPath = path.join(fakeBinPath, 'curl');
  fs.mkdirSync(fakeBinPath, { recursive: true });
  fs.writeFileSync(
    fakeCurlPath,
    [
      '#!/usr/bin/env sh',
      'set -eu',
      'output_path=""',
      'previous_argument=""',
      'for argument in "$@"; do',
      '  if [ "$previous_argument" = "-o" ]; then output_path="$argument"; fi',
      '  previous_argument="$argument"',
      'done',
      'if [ -n "$output_path" ]; then',
      '  cp "$REMOTE_INSTALL_FIXTURE_ZIP_POSIX" "$output_path"',
      'else',
      '  printf \'{"default_branch":"main"}\\n\'',
      'fi',
    ].join('\n'),
    'utf8',
  );
  fs.chmodSync(fakeCurlPath, 0o755);

  const env = { ...process.env };
  let pathVariableName = 'PATH';
  for (const name of Object.keys(env)) {
    if (name.toLowerCase() === 'path') {
      pathVariableName = name;
      break;
    }
  }
  env[pathVariableName] = [fakeBinPath, path.dirname(process.execPath), env[pathVariableName] || '']
    .filter(Boolean)
    .join(path.delimiter);
  env.REPO_OWNER = 'fixture-owner';
  env.REPO_NAME = 'fixture-repo';
  env.REMOTE_INSTALL_ENTRY_SCRIPT_POSIX = toGitBashPath(path.join(repositoryRoot, 'install.sh'));
  env.REMOTE_INSTALL_FAKE_BIN_POSIX = toGitBashPath(fakeBinPath);
  env.REMOTE_INSTALL_FIXTURE_ZIP_POSIX = toGitBashPath(options.fixture.archivePath);
  // Node 在 Windows 上读取原生路径；Git Bash 变量只影响安装器自身的目录切换。
  env.REMOTE_INSTALL_PREPARE_MARKER = options.fixture.markerPath;
  env.REMOTE_INSTALL_BUILD_FAIL = options.fixture.buildShouldFail ? '1' : '0';
  setEnvironmentValue(
    env,
    'COCOS_PROJECT_PATH',
    options.useProjectPathEnvironment ? toGitBashPath(options.projectRoot) : undefined,
  );

  const shellCommand = 'set -eu; PATH="$REMOTE_INSTALL_FAKE_BIN_POSIX:$PATH"; export PATH; expected_curl="$REMOTE_INSTALL_FAKE_BIN_POSIX/curl"; actual_curl="$(command -v curl)"; if [ "$actual_curl" != "$expected_curl" ]; then printf "测试 curl 桩未生效: %s\\n" "$actual_curl" >&2; exit 70; fi; . "$REMOTE_INSTALL_ENTRY_SCRIPT_POSIX"';
  const result = childProcess.spawnSync(
    gitBashPath,
    ['-c', shellCommand],
    { cwd: options.workingDirectory, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 },
  );
  result.commandDescription = `${gitBashPath} -c '${shellCommand}'`;
  return result;
}

/**
 * 为升级和失败场景写入旧插件及用户数据，检查安装器是否保留了原目录内容。
 * @param {string} projectRoot Creator 项目目录。
 * @returns {string} 旧插件目录路径。
 */
function seedExistingPlugin(projectRoot) {
  const pluginRoot = path.join(projectRoot, 'extensions', 'cocos-mcp-server');
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, 'version.txt'), 'fixture-version-1.0.0');
  fs.writeFileSync(path.join(pluginRoot, 'user-data.txt'), 'preserve-this-file');
  return pluginRoot;
}

/**
 * 断言远程准备脚本确实来自压缩包解压目录，而不是当前仓库中的脚本。
 * @param {object} fixture 测试夹具。
 * @returns {string} 安装器使用的临时下载目录。
 */
function assertPrepareScriptUsedExtractedSource(fixture) {
  assert.ok(fs.existsSync(fixture.markerPath), '下载源码中的准备脚本应被 Node 执行');
  const record = JSON.parse(fs.readFileSync(fixture.markerPath, 'utf8'));
  const extractedScriptsPath = path.resolve(record.scriptDirectory);

  assert.equal(path.basename(extractedScriptsPath), 'scripts');
  assert.equal(path.basename(path.dirname(extractedScriptsPath)), 'remote-source-main');
  assert.notEqual(extractedScriptsPath, path.resolve(fixture.sourceScriptsPath));

  const installerTempRoot = path.dirname(path.dirname(path.dirname(extractedScriptsPath)));
  const relativeTempPath = path.relative(path.resolve(os.tmpdir()), path.resolve(installerTempRoot));
  assert.ok(
    relativeTempPath === '' || (
      !path.isAbsolute(relativeTempPath) &&
      relativeTempPath !== '..' &&
      !relativeTempPath.startsWith(`..${path.sep}`)
    ),
    '准备脚本应从系统临时目录中的下载源码解压位置运行',
  );
  return installerTempRoot;
}

/**
 * 断言安装入口已清理下载临时目录，并在失败时附带具体命令与 stderr 便于定位。
 * @param {string} installerTempRoot 安装器创建的临时下载目录。
 * @param {{name: string}} installer 当前安装器。
 * @param {'default'|'upgrade'|'failure'} scenario 场景类型。
 * @param {import('node:child_process').SpawnSyncReturns<string> & {commandDescription: string}} result 安装器子进程结果。
 */
function assertInstallerTempRootCleaned(installerTempRoot, installer, scenario, result) {
  assert.equal(
    fs.existsSync(installerTempRoot),
    false,
    [
      `安装结束后应清理解压目录: ${installerTempRoot}`,
      `场景: ${installer.name} / ${scenario}`,
      `子进程命令: ${result.commandDescription}`,
      `标准输出:\n${result.stdout}`,
      `标准错误:\n${result.stderr}`,
    ].join('\n'),
  );
}

/**
 * 断言安装结果来自夹具构建出的 plugin-package，并且原子切换没有残留中间目录。
 * @param {string} projectRoot Creator 项目目录。
 */
function assertBuiltPluginInstalled(projectRoot) {
  const extensionsPath = path.join(projectRoot, 'extensions');
  const pluginRoot = path.join(extensionsPath, 'cocos-mcp-server');

  assert.equal(fs.readFileSync(path.join(pluginRoot, 'version.txt'), 'utf8'), 'fixture-version-2.0.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8')).version, '2.0.0');
  assert.equal(fs.existsSync(path.join(extensionsPath, 'cocos-mcp-server.__new__')), false);
  assert.equal(fs.existsSync(path.join(extensionsPath, 'cocos-mcp-server.__backup__')), false);
}

/**
 * 断言失败构建没有覆盖旧插件，也没有留下安装切换目录。
 * @param {string} projectRoot Creator 项目目录。
 */
function assertOldPluginPreserved(projectRoot) {
  const extensionsPath = path.join(projectRoot, 'extensions');
  const pluginRoot = path.join(extensionsPath, 'cocos-mcp-server');

  assert.equal(fs.readFileSync(path.join(pluginRoot, 'version.txt'), 'utf8'), 'fixture-version-1.0.0');
  assert.equal(fs.readFileSync(path.join(pluginRoot, 'user-data.txt'), 'utf8'), 'preserve-this-file');
  assert.equal(fs.existsSync(path.join(extensionsPath, 'cocos-mcp-server.__new__')), false);
  assert.equal(fs.existsSync(path.join(extensionsPath, 'cocos-mcp-server.__backup__')), false);
}

/**
 * 清理失败用例中安装器可能遗留的临时下载目录，避免集成测试在系统临时目录留下夹具。
 * @param {object} fixture 测试夹具。
 */
function cleanupInstallerTempRoot(fixture) {
  if (!fs.existsSync(fixture.markerPath)) {
    return;
  }

  try {
    const record = JSON.parse(fs.readFileSync(fixture.markerPath, 'utf8'));
    const scriptsPath = path.resolve(record.scriptDirectory);
    if (
      path.basename(scriptsPath) !== 'scripts' ||
      path.basename(path.dirname(scriptsPath)) !== 'remote-source-main'
    ) {
      return;
    }

    const installerTempRoot = path.dirname(path.dirname(path.dirname(scriptsPath)));
    const relativeTempPath = path.relative(path.resolve(os.tmpdir()), installerTempRoot);
    const isWithinSystemTemp = relativeTempPath !== '' &&
      !path.isAbsolute(relativeTempPath) &&
      relativeTempPath !== '..' &&
      !relativeTempPath.startsWith(`..${path.sep}`);
    if (isWithinSystemTemp) {
      fs.rmSync(installerTempRoot, { recursive: true, force: true });
    }
  } catch {
    // 清理失败时交由系统临时目录回收，不覆盖场景本身的断言结果。
  }
}

/**
 * 为一个安装器执行成功默认路径、空格环境路径升级和构建失败回滚三个独立临时场景。
 * @param {{name: string, run: Function}} installer 安装器执行适配器。
 * @param {'default'|'upgrade'|'failure'} scenario 场景类型。
 */
function runInstallerScenario(installer, scenario) {
  const buildShouldFail = scenario === 'failure';
  const fixture = createFixture(buildShouldFail);
  const projectRoot = path.join(
    fixture.root,
    scenario === 'default' ? 'default project with spaces' : 'creator project path with spaces',
  );
  const workingDirectory = scenario === 'default'
    ? projectRoot
    : path.join(fixture.root, 'unrelated caller cwd with spaces');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(workingDirectory, { recursive: true });

  try {
    if (scenario !== 'default') {
      seedExistingPlugin(projectRoot);
    }

    const result = installer.run({
      fixture,
      projectRoot,
      workingDirectory,
      useProjectPathEnvironment: scenario !== 'default',
    });

    assert.ifError(result.error);
    if (scenario === 'failure') {
      assert.notEqual(
        result.status,
        0,
        `${installer.name} 应在 Node 源码构建退出码 42 时失败\n${result.stdout}\n${result.stderr}`,
      );
      const installerTempRoot = assertPrepareScriptUsedExtractedSource(fixture);
      assertOldPluginPreserved(projectRoot);
      assertInstallerTempRootCleaned(installerTempRoot, installer, scenario, result);
      if (scenario !== 'default') {
        assert.equal(
          fs.existsSync(path.join(workingDirectory, 'extensions')),
          false,
          '设置 COCOS_PROJECT_PATH 时不应把插件写入启动工作目录',
        );
      }
      return;
    }

    assert.equal(
      result.status,
      0,
      `${installer.name} 安装应成功\n${result.stdout}\n${result.stderr}`,
    );
    const installerTempRoot = assertPrepareScriptUsedExtractedSource(fixture);
    assertBuiltPluginInstalled(projectRoot);
    assertInstallerTempRootCleaned(installerTempRoot, installer, scenario, result);

    if (scenario === 'upgrade') {
      assert.equal(
        fs.existsSync(path.join(projectRoot, 'extensions', 'cocos-mcp-server', 'user-data.txt')),
        false,
        '升级后应完整替换为下载包生成的插件目录',
      );
    }

    if (scenario !== 'default') {
      assert.equal(
        fs.existsSync(path.join(workingDirectory, 'extensions')),
        false,
        '设置 COCOS_PROJECT_PATH 时不应把插件写入启动工作目录',
      );
    }
  } finally {
    cleanupInstallerTempRoot(fixture);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

const powerShellInstaller = {
  name: 'install.ps1',
  run: runPowerShellInstaller,
};
const shellInstaller = {
  name: 'install.sh',
  run: runShellInstaller,
};

/**
 * 注册默认路径、带空格路径升级和构建失败保护三项集成测试，覆盖两个远程安装入口。
 * @param {{name: string, run: Function}} installer 安装器执行适配器。
 * @param {string|false} skipReason 缺少运行平台工具时显示的跳过原因。
 */
function registerInstallerScenarios(installer, skipReason) {
  const options = { skip: skipReason };

  test(`${installer.name} 默认安装到当前目录并构建下载源码`, options, function defaultPathScenario() {
    runInstallerScenario(installer, 'default');
  });

  test(`${installer.name} 支持带空格的环境路径并升级已有插件`, options, function pathWithSpacesUpgradeScenario() {
    runInstallerScenario(installer, 'upgrade');
  });

  test(`${installer.name} 构建失败时返回非零并保留旧插件`, options, function buildFailurePreservesPluginScenario() {
    runInstallerScenario(installer, 'failure');
  });
}

const powerShellSkipReason = powerShellAvailable ? false : 'pwsh.exe 不可用，跳过 PowerShell 安装集成测试';
const shellSkipReason = !gitBashAvailable
  ? '未找到 Git for Windows 的 sh.exe，跳过 Shell 安装集成测试'
  : !powerShellAvailable
    ? '需要 pwsh.exe 生成本地源码 zip，跳过 Shell 安装集成测试'
    : false;

registerInstallerScenarios(powerShellInstaller, powerShellSkipReason);
registerInstallerScenarios(shellInstaller, shellSkipReason);
