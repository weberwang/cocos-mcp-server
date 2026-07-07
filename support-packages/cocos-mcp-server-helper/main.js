'use strict';

const DEFAULT_RELOAD_DELAY_MS = 150;
const HELPER_EXTENSION_NAME = 'cocos-mcp-server-helper';

/**
 * 解析需要被重载的目标扩展路径。
 * 辅助扩展必须在停用目标扩展前先拿到路径，避免停用后再查找失败。
 * @param {string} extensionName
 * @returns {string}
 */
function resolveExtensionPath(extensionName) {
  const normalizedExtensionName = String(extensionName || '').trim();
  if (!normalizedExtensionName) {
    throw new Error('extensionName is required');
  }

  const extensionPath = Editor.Package.getPath(normalizedExtensionName);
  if (!extensionPath) {
    throw new Error(`Extension not found: ${normalizedExtensionName}`);
  }

  if (normalizedExtensionName === HELPER_EXTENSION_NAME) {
    throw new Error('Helper extension cannot reload itself');
  }

  return extensionPath;
}

/**
 * 把目标扩展的 disable/enable 切换延迟到当前消息返回后执行。
 * 这样主扩展的 MCP 请求可以先完成响应，再由 helper 真正触发自重载。
 * @param {string} extensionName
 * @param {number} delayMs
 * @returns {{ extensionName: string, extensionPath: string, scheduled: true, delayMs: number }}
 */
function scheduleExtensionReload(extensionName, delayMs) {
  const normalizedExtensionName = String(extensionName || '').trim();
  const extensionPath = resolveExtensionPath(normalizedExtensionName);
  const normalizedDelayMs = Number.isFinite(Number(delayMs))
    ? Math.max(0, Math.round(Number(delayMs)))
    : DEFAULT_RELOAD_DELAY_MS;

  setTimeout(() => {
    try {
      Editor.Package.disable(extensionPath);
      Editor.Package.enable(extensionPath);
    } catch (error) {
      console.error(`[ReloadHelper] Failed to reload extension '${normalizedExtensionName}':`, error);
    }
  }, normalizedDelayMs);

  return {
    extensionName: normalizedExtensionName,
    extensionPath,
    scheduled: true,
    delayMs: normalizedDelayMs,
  };
}

exports.methods = {
  /**
   * 为目标扩展安排一次延迟重载。
   * @param {string} extensionName
   * @param {number} [delayMs]
   * @returns {{ success: boolean, data?: any, error?: string }}
   */
  reloadExtension(extensionName, delayMs) {
    try {
      return {
        success: true,
        data: scheduleExtensionReload(extensionName, delayMs),
      };
    } catch (error) {
      return {
        success: false,
        error: error && error.message ? error.message : String(error),
      };
    }
  },
};

exports.load = function load() {
  console.log('[ReloadHelper] extension loaded');
};

exports.unload = function unload() {
  console.log('[ReloadHelper] extension unloaded');
};
