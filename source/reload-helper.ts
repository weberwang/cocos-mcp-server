import path from 'node:path';

export const CURRENT_EXTENSION_NAME = 'cocos-mcp-server';
export const RELOAD_HELPER_EXTENSION_NAME = 'cocos-mcp-server-helper';
export const DEFAULT_EXTENSION_SELF_RELOAD_DELAY_MS = 150;

/**
 * 确保辅助扩展可注册、可启用时所需的最小宿主接口。
 * 这里拆成纯依赖，方便单元测试而不依赖真实 Creator 运行时。
 */
export interface EnsureReloadHelperExtensionDeps {
    getExtensionPath: (extensionName: string) => string | undefined;
    registerExtension: (extensionPath: string) => void;
    enableExtension: (extensionPath: string) => void;
}

/**
 * 当前扩展通过辅助扩展发起自重载时所需的请求接口。
 */
export interface RequestCurrentExtensionReloadDeps {
    requestReload: (helperExtensionName: string, extensionName: string, delayMs: number) => Promise<any>;
}

/**
 * 计算内置辅助扩展目录。
 * 辅助扩展跟随主扩展一起发布，放在 support-packages 下便于统一复制与注册。
 */
export function resolveBundledReloadHelperPath(currentExtensionPath: string): string {
    return path.join(currentExtensionPath, 'support-packages', RELOAD_HELPER_EXTENSION_NAME);
}

/**
 * 确保辅助扩展已经被注册并启用。
 * 已注册时直接复用既有路径；未注册时从主扩展内置目录注册并启用。
 */
export function ensureReloadHelperExtension(
    currentExtensionPath: string,
    deps: EnsureReloadHelperExtensionDeps,
): { helperPath: string; registered: boolean } {
    const existingHelperPath = deps.getExtensionPath(RELOAD_HELPER_EXTENSION_NAME);
    if (existingHelperPath) {
        deps.enableExtension(existingHelperPath);
        return {
            helperPath: existingHelperPath,
            registered: false,
        };
    }

    const helperPath = resolveBundledReloadHelperPath(currentExtensionPath);
    deps.registerExtension(helperPath);
    deps.enableExtension(helperPath);
    return {
        helperPath,
        registered: true,
    };
}

/**
 * 通过辅助扩展发起当前插件的延迟自重载。
 * 这里必须先让 helper 返回成功，再由 helper 自己在稍后执行 disable/enable。
 */
export async function requestCurrentExtensionReload(
    extensionName: string,
    extensionPath: string,
    deps: RequestCurrentExtensionReloadDeps,
    delayMs: number = DEFAULT_EXTENSION_SELF_RELOAD_DELAY_MS,
): Promise<{ extensionName: string; extensionPath: string; scheduled: true }> {
    const result = await deps.requestReload(
        RELOAD_HELPER_EXTENSION_NAME,
        extensionName,
        delayMs,
    );

    if (!result?.success) {
        throw new Error(result?.error || 'Helper extension failed to schedule reload');
    }

    return {
        extensionName,
        extensionPath: result?.data?.extensionPath || extensionPath,
        scheduled: true,
    };
}
