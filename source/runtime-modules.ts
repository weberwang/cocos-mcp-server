import { AIClientTarget, ConfigLocation, configureAIClients as configureAIClientsImpl } from './client-config';
import { MCPServer } from './mcp-server';
import { ToolManager } from './tools/tool-manager';

/**
 * 运行时依赖集合。
 * 通过延迟加载配合缓存清理，确保扩展重载后不会继续复用旧模块实现。
 */
export interface RuntimeModules {
    MCPServer: typeof MCPServer;
    ToolManager: typeof ToolManager;
    configureAIClients: (target: AIClientTarget, location: ConfigLocation) => ReturnType<typeof configureAIClientsImpl>;
}

/**
 * 运行时模块加载参数。
 */
export interface LoadRuntimeModulesOptions {
    extensionRoot?: string;
    currentEntryFile?: string;
    moduleCache?: NodeJS.Dict<NodeModule>;
    moduleRequire?: NodeRequire;
}

/**
 * 清理扩展目录下的 require 缓存，但保留当前入口模块本身，避免执行中的模块被意外移除。
 */
export function clearExtensionModuleCache(
    moduleCache: NodeJS.Dict<NodeModule>,
    options: {
        extensionRoot: string;
        currentEntryFile: string;
    }
): string[] {
    const normalizedRoot = normalizeModulePath(options.extensionRoot);
    const normalizedEntryFile = normalizeModulePath(options.currentEntryFile);
    const removedKeys: string[] = [];

    for (const cacheKey of Object.keys(moduleCache)) {
        const normalizedCacheKey = normalizeModulePath(cacheKey);
        if (!normalizedCacheKey.startsWith(normalizedRoot)) {
            continue;
        }
        if (normalizedCacheKey === normalizedEntryFile) {
            continue;
        }

        delete moduleCache[cacheKey];
        removedKeys.push(cacheKey);
    }

    removedKeys.sort();
    return removedKeys;
}

/**
 * 重新加载扩展内部运行时依赖。
 * 设计上显式清缓存，是为了让 Cocos 的扩展“重载”真正拿到最新编译产物。
 */
export function loadRuntimeModules(options: LoadRuntimeModulesOptions = {}): RuntimeModules {
    const moduleCache = options.moduleCache ?? require.cache;
    const moduleRequire = options.moduleRequire ?? require;
    const extensionRoot = normalizeModulePath(
        options.extensionRoot ?? __dirname
    );
    const currentEntryFile = normalizeModulePath(
        options.currentEntryFile ?? __filename
    );

    clearExtensionModuleCache(moduleCache, {
        extensionRoot,
        currentEntryFile,
    });

    const { MCPServer: FreshMCPServer } = moduleRequire('./mcp-server') as typeof import('./mcp-server');
    const { ToolManager: FreshToolManager } = moduleRequire('./tools/tool-manager') as typeof import('./tools/tool-manager');
    const { configureAIClients: freshConfigureAIClients } = moduleRequire('./client-config') as typeof import('./client-config');

    return {
        MCPServer: FreshMCPServer,
        ToolManager: FreshToolManager,
        configureAIClients: freshConfigureAIClients,
    };
}

/**
 * 统一模块路径格式，避免 Windows 盘符和分隔符差异影响缓存匹配。
 */
function normalizeModulePath(filePath: string): string {
    return String(filePath).replace(/\\/g, '/').toLowerCase();
}
