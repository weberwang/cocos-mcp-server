import { readSettings, saveSettings } from './settings';
import { MCPServerSettings } from './types';
import { AIClientTarget, ConfigLocation } from './client-config';
import { loadRuntimeModules, RuntimeModules } from './runtime-modules';

let runtimeModules: RuntimeModules | null = null;
let mcpServer: InstanceType<RuntimeModules['MCPServer']> | null = null;
let toolManager: InstanceType<RuntimeModules['ToolManager']>;

/**
 * 获取当前可用的运行时依赖。
 * 扩展被重新启用时会先刷新模块缓存，再重新拉起服务和工具实例。
 */
function getRuntimeModules(): RuntimeModules {
    if (!runtimeModules) {
        runtimeModules = loadRuntimeModules();
    }
    return runtimeModules;
}

export const methods: { [key: string]: (...any: any) => any } = {
    openPanel() {
        Editor.Panel.open('cocos-mcp-server');
    },

    async startServer() {
        if (mcpServer) {
            const enabledTools = toolManager.getEnabledTools();
            mcpServer.updateEnabledTools(enabledTools);
            await mcpServer.start();
        } else {
            console.warn('[MCP] mcpServer is not initialized');
        }
    },

    async stopServer() {
        if (mcpServer) {
            mcpServer.stop();
        } else {
            console.warn('[MCP] mcpServer is not initialized');
        }
    },

    getServerStatus() {
        const status = mcpServer ? mcpServer.getStatus() : { running: false, port: 0, clients: 0 };
        const settings = mcpServer ? mcpServer.getSettings() : readSettings();
        return {
            ...status,
            settings,
        };
    },

    async updateSettings(settings: MCPServerSettings) {
        const { MCPServer } = getRuntimeModules();
        saveSettings(settings);
        if (mcpServer) {
            mcpServer.stop();
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        mcpServer = new MCPServer(settings);
        await mcpServer.start();
        return { success: true, port: settings.port, running: true };
    },

    getToolsList() {
        return mcpServer ? mcpServer.getAvailableTools() : [];
    },

    getFilteredToolsList() {
        if (!mcpServer) {
            return [];
        }

        const enabledTools = toolManager.getEnabledTools();
        mcpServer.updateEnabledTools(enabledTools);

        return mcpServer.getFilteredTools(enabledTools);
    },

    async getServerSettings() {
        return mcpServer ? mcpServer.getSettings() : readSettings();
    },

    async getSettings() {
        return mcpServer ? mcpServer.getSettings() : readSettings();
    },

    async getToolManagerState() {
        return toolManager.getToolManagerState();
    },

    async createToolConfiguration(name: string, description?: string) {
        try {
            const config = toolManager.createConfiguration(name, description);
            return { success: true, id: config.id, config };
        } catch (error: any) {
            throw new Error(`Create configuration failed: ${error.message}`);
        }
    },

    async updateToolConfiguration(configId: string, updates: any) {
        try {
            return toolManager.updateConfiguration(configId, updates);
        } catch (error: any) {
            throw new Error(`Update configuration failed: ${error.message}`);
        }
    },

    async deleteToolConfiguration(configId: string) {
        try {
            toolManager.deleteConfiguration(configId);
            return { success: true };
        } catch (error: any) {
            throw new Error(`Delete configuration failed: ${error.message}`);
        }
    },

    async setCurrentToolConfiguration(configId: string) {
        try {
            toolManager.setCurrentConfiguration(configId);
            return { success: true };
        } catch (error: any) {
            throw new Error(`Set current configuration failed: ${error.message}`);
        }
    },

    async updateToolStatus(category: string, toolName: string, enabled: boolean) {
        try {
            const currentConfig = toolManager.getCurrentConfiguration();
            if (!currentConfig) {
                throw new Error('No current configuration');
            }

            toolManager.updateToolStatus(currentConfig.id, category, toolName, enabled);

            if (mcpServer) {
                const enabledTools = toolManager.getEnabledTools();
                mcpServer.updateEnabledTools(enabledTools);
            }

            return { success: true };
        } catch (error: any) {
            throw new Error(`Update tool status failed: ${error.message}`);
        }
    },

    async updateToolStatusBatch(updates: any[]) {
        try {
            console.log('[Main] updateToolStatusBatch called with updates count:', updates ? updates.length : 0);

            const currentConfig = toolManager.getCurrentConfiguration();
            if (!currentConfig) {
                throw new Error('No current configuration');
            }

            toolManager.updateToolStatusBatch(currentConfig.id, updates);

            if (mcpServer) {
                const enabledTools = toolManager.getEnabledTools();
                mcpServer.updateEnabledTools(enabledTools);
            }

            return { success: true };
        } catch (error: any) {
            throw new Error(`Batch update tool status failed: ${error.message}`);
        }
    },

    async exportToolConfiguration(configId: string) {
        try {
            return { configJson: toolManager.exportConfiguration(configId) };
        } catch (error: any) {
            throw new Error(`Export configuration failed: ${error.message}`);
        }
    },

    async importToolConfiguration(configJson: string) {
        try {
            return toolManager.importConfiguration(configJson);
        } catch (error: any) {
            throw new Error(`Import configuration failed: ${error.message}`);
        }
    },

    async getEnabledTools() {
        return toolManager.getEnabledTools();
    },

    async configureAIClient(target: AIClientTarget, location: ConfigLocation) {
        const { configureAIClients } = getRuntimeModules();
        const result = configureAIClients(target, location);

        if (result.success) {
            console.log(`[MCP] AI client configuration updated: ${result.message}`);
        } else {
            console.warn(`[MCP] AI client configuration failed: ${result.error}`);
        }

        return result;
    },
};

export function load() {
    console.log('Cocos MCP Server extension loaded');

    runtimeModules = loadRuntimeModules();
    const { MCPServer, ToolManager } = runtimeModules;

    toolManager = new ToolManager();

    const settings = readSettings();
    mcpServer = new MCPServer(settings);

    const enabledTools = toolManager.getEnabledTools();
    mcpServer.updateEnabledTools(enabledTools);

    mcpServer.start().catch((err) => {
        console.error('Failed to auto-start MCP server:', err);
    });
}

export function unload() {
    if (mcpServer) {
        mcpServer.stop();
        mcpServer = null;
    }
    runtimeModules = null;
}
