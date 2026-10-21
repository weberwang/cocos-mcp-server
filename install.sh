#!/usr/bin/env sh

set -eu

REPO_OWNER="${REPO_OWNER:-weberwang}"
REPO_NAME="${REPO_NAME:-cocos-mcp-server}"
PROJECT_PATH="${COCOS_PROJECT_PATH:-.}"
TARGET_PLUGIN_SUBPATH="extensions/cocos-mcp-server"

TEMP_ROOT=""
INSTALL_TARGET_DIR=""
INSTALL_NEW_DIR=""
INSTALL_BACKUP_DIR=""
INSTALL_SWITCH_ACTIVE=0
INSTALL_PROMOTED=0
INSTALL_HAS_BACKUP=0

# 函数：输出统一错误并退出，确保远程安装失败时有明确原因。
fail() {
  printf '%s\n' "安装 cocos-mcp-server 失败: $*" >&2
  exit 1
}

# 函数：统一检查依赖命令，缺失时提前失败，避免安装中途才暴露环境问题。
require_command() {
  command_name="$1"

  if ! command -v "${command_name}" >/dev/null 2>&1; then
    fail "缺少依赖命令: ${command_name}"
  fi
}

# 函数：统一做环境预检，保持报错前缀和依赖集合一致。
check_dependencies() {
  require_command "node"
  require_command "npm"
  require_command "curl"
  require_command "unzip"
  require_command "find"
  require_command "sed"
  require_command "mktemp"
}

# 函数：恢复安装切换阶段的中间态，尽量避免中断后正式目录丢失。
restore_install_state() {
  if [ "${INSTALL_SWITCH_ACTIVE}" -ne 1 ]; then
    # EXIT 陷阱中显式返回成功，避免继承失败状态后被 set -e 中断，跳过下载目录清理。
    return 0
  fi

  if [ -n "${INSTALL_NEW_DIR}" ] && [ -d "${INSTALL_NEW_DIR}" ]; then
    rm -rf "${INSTALL_NEW_DIR}" || true
  fi

  if [ -n "${INSTALL_BACKUP_DIR}" ] && [ -d "${INSTALL_BACKUP_DIR}" ]; then
    if [ -n "${INSTALL_TARGET_DIR}" ] && [ ! -e "${INSTALL_TARGET_DIR}" ]; then
      mv "${INSTALL_BACKUP_DIR}" "${INSTALL_TARGET_DIR}" || true
    elif [ "${INSTALL_PROMOTED}" -eq 1 ] && [ -d "${INSTALL_TARGET_DIR}" ]; then
      rm -rf "${INSTALL_BACKUP_DIR}" || true
    fi
  fi
}

# 函数：统一清理临时目录和安装中间态，确保 EXIT/信号退出都走相同收尾逻辑。
cleanup() {
  restore_install_state

  if [ -n "${TEMP_ROOT}" ] && [ -d "${TEMP_ROOT}" ]; then
    rm -rf "${TEMP_ROOT}" || true
  fi
}

# 函数：信号退出时先做清理，再返回非零状态，避免脚本在中断后继续执行。
handle_signal() {
  cleanup
  exit 1
}

trap cleanup EXIT
trap handle_signal INT TERM HUP

# 函数：解析目标项目目录；未设置 COCOS_PROJECT_PATH 时默认当前目录。
resolve_target_project_path() {
  input_path="$1"

  if [ ! -e "${input_path}" ]; then
    fail "目标项目目录不存在: ${input_path}"
  fi

  if [ ! -d "${input_path}" ]; then
    fail "目标项目路径不是目录: ${input_path}"
  fi

  (
    cd "${input_path}" || exit 1
    pwd
  ) || fail "无法解析目标项目目录: ${input_path}"
}

# 函数：读取 GitHub 仓库默认分支，避免脚本绑死固定分支名。
get_default_branch() {
  api_url="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}"

  response="$(
    curl -fsSL \
      -H "Accept: application/vnd.github+json" \
      -H "User-Agent: cocos-mcp-installer" \
      "${api_url}"
  )" || fail "请求 GitHub API 失败: ${api_url}"

  branch="$(printf '%s' "${response}" | sed -n 's/.*"default_branch"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "${branch}" ] || fail "GitHub API 未返回默认分支 default_branch: ${api_url}"

  printf '%s\n' "${branch}"
}

# 函数：校验压缩包顶层目录唯一，避免解压结果结构异常时误装。
resolve_archive_root() {
  extract_root="$1"

  archive_dir_count="$(find "${extract_root}" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
  [ "${archive_dir_count}" = "1" ] || fail "压缩包解压后顶层目录数量异常: ${archive_dir_count}"

  archive_dir="$(find "${extract_root}" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [ -n "${archive_dir}" ] || fail "压缩包解压后没有找到仓库目录"

  printf '%s\n' "${archive_dir}"
}

# 函数：用新目录和备份目录切换安装结果，避免覆盖中断破坏旧安装。
replace_plugin_directory_atomically() {
  source_dir="$1"
  target_extensions_dir="$2"
  target_dir="${target_extensions_dir}/cocos-mcp-server"
  new_dir="${target_extensions_dir}/cocos-mcp-server.__new__"
  backup_dir="${target_extensions_dir}/cocos-mcp-server.__backup__"

  INSTALL_TARGET_DIR="${target_dir}"
  INSTALL_NEW_DIR="${new_dir}"
  INSTALL_BACKUP_DIR="${backup_dir}"
  INSTALL_SWITCH_ACTIVE=1
  INSTALL_PROMOTED=0
  INSTALL_HAS_BACKUP=0

  rm -rf "${new_dir}" "${backup_dir}"
  mkdir -p "${target_extensions_dir}"
  cp -R "${source_dir}" "${new_dir}" || fail "复制插件目录失败: ${source_dir}"

  if [ -d "${target_dir}" ]; then
    mv "${target_dir}" "${backup_dir}" || fail "备份旧插件目录失败: ${target_dir}"
    INSTALL_HAS_BACKUP=1
  fi

  if mv "${new_dir}" "${target_dir}"; then
    INSTALL_PROMOTED=1

    if [ "${INSTALL_HAS_BACKUP}" -eq 1 ]; then
      rm -rf "${backup_dir}" || fail "清理旧插件备份目录失败: ${backup_dir}"
    fi

    INSTALL_SWITCH_ACTIVE=0
    return
  fi

  fail "切换插件目录失败: ${target_dir}"
}

# 函数：在临时源码目录构建完整分发包，构建失败时保持已有插件不变。
prepare_remote_package() {
  archive_root="$1"
  prepare_script="${archive_root}/scripts/prepare-remote-install.js"
  [ -f "${prepare_script}" ] || fail "远程压缩包缺少安装准备脚本: ${prepare_script}"

  node "${prepare_script}" || fail "构建远程安装包失败"
}

# 函数：从默认分支 zip 构建 plugin-package 并安装到 Creator 项目 extensions 目录。
install_plugin_package() {
  target_project_path="$1"
  branch="$(get_default_branch)"
  zip_url="https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/heads/${branch}.zip"

  TEMP_ROOT="$(mktemp -d 2>/dev/null || mktemp -d -t cocos-mcp)"
  [ -n "${TEMP_ROOT}" ] || fail "无法创建临时目录"

  zip_path="${TEMP_ROOT}/archive.zip"
  extract_root="${TEMP_ROOT}/extract"
  mkdir -p "${extract_root}"

  curl -fL \
    -H "User-Agent: cocos-mcp-installer" \
    -o "${zip_path}" \
    "${zip_url}" || fail "下载默认分支压缩包失败: ${zip_url}"

  unzip -q "${zip_path}" -d "${extract_root}" || fail "解压默认分支压缩包失败: ${zip_path}"

  archive_dir="$(resolve_archive_root "${extract_root}")"
  prepare_remote_package "${archive_dir}"
  source_dir="${archive_dir}/plugin-package"
  [ -d "${source_dir}" ] || fail "远程压缩包缺少 plugin-package 目录: ${source_dir}"

  target_extensions_dir="${target_project_path}/extensions"
  target_dir="${target_project_path}/${TARGET_PLUGIN_SUBPATH}"
  replace_plugin_directory_atomically "${source_dir}" "${target_extensions_dir}"

  printf '%s\n' "安装完成: ${target_dir}"
}

check_dependencies
target_project_path="$(resolve_target_project_path "${PROJECT_PATH}")"
install_plugin_package "${target_project_path}"
