/* eslint-disable vue/one-component-per-file */

import { readFileSync } from 'fs-extra';
import { join } from 'path';
import { createApp, App, defineComponent, ref, computed, onMounted, watch, nextTick } from 'vue';

const panelDataMap = new WeakMap<any, App>();

// 定义工具配置接口
interface ToolConfig {
    category: string;
    name: string;
    enabled: boolean;
    description: string;
}

// 定义配置接口
interface Configuration {
    id: string;
    name: string;
    description: string;
    tools: ToolConfig[];
    createdAt: string;
    updatedAt: string;
}

// 定义服务器设置接口
interface ServerSettings {
    port: number;
    autoStart: boolean;
    debugLog: boolean;
    maxConnections: number;
}

module.exports = Editor.Panel.define({
    listeners: {
        show() { 
            console.log('[MCP Panel] Panel shown'); 
        },
        hide() { 
            console.log('[MCP Panel] Panel hidden'); 
        },
    },
    template: readFileSync(join(__dirname, '../../../static/template/default/index.html'), 'utf-8'),
    style: readFileSync(join(__dirname, '../../../static/style/default/index.css'), 'utf-8'),
    $: {
        app: '#app',
        panelTitle: '#panelTitle',
    },
    ready() {
        if (this.$.app) {
            const app = createApp({});
            app.config.compilerOptions.isCustomElement = (tag) => tag.startsWith('ui-');
            
            // 创建主应用组件
            app.component('McpServerApp', defineComponent({
                setup() {
                    // 响应式数据
                    const activeTab = ref('server');
                    const serverRunning = ref(false);
                    const serverStatus = ref('已停止');
                    const connectedClients = ref(0);
                    const httpUrl = ref('');
                    const isProcessing = ref(false);
                    
                    // 客户端配置相关状态
                    const configLoading = ref(false);
                    const configMessage = ref('');
                    const configError = ref(false);
                    
                    const settings = ref<ServerSettings>({
                        port: 3000,
                        autoStart: false,
                        debugLog: false,
                        maxConnections: 10
                    });
                    
                    const availableTools = ref<ToolConfig[]>([]);
                    const toolCategories = ref<string[]>([]);
                    

                    
                    // 计算属性
                    const statusClass = computed(() => ({
                        'status-running': serverRunning.value,
                        'status-stopped': !serverRunning.value
                    }));
                    
                    const totalTools = computed(() => availableTools.value.length);
                    const enabledTools = computed(() => availableTools.value.filter(t => t.enabled).length);
                    const disabledTools = computed(() => totalTools.value - enabledTools.value);
                    

                    
                    const settingsChanged = ref(false);
                    
                    // 方法
                    const switchTab = (tabName: string) => {
                        activeTab.value = tabName;
                        if (tabName === 'tools') {
                            loadToolManagerState();
                        }
                    };
                    
                    const toggleServer = async () => {
                        try {
                            if (serverRunning.value) {
                                await Editor.Message.request('cocos-mcp-server', 'stopServer');
                            } else {
                                // 启动服务器时使用当前面板设置
                                const currentSettings = {
                                    port: settings.value.port,
                                    autoStart: settings.value.autoStart,
                                    enableDebugLog: settings.value.debugLog,
                                    maxConnections: settings.value.maxConnections
                                };
await Editor.Message.request('cocos-mcp-server', 'updateSettings', currentSettings);
await Editor.Message.request('cocos-mcp-server', 'startServer');
                            }
                            console.log('[Vue App] Server toggled');
                        } catch (error) {
                            console.error('[Vue App] Failed to toggle server:', error);
                        }
                    };
                    
                    const saveSettings = async () => {
                        try {
                            const settingsData = {
                                port: settings.value.port,
                                autoStart: settings.value.autoStart,
                                enableDebugLog: settings.value.debugLog,
                                maxConnections: settings.value.maxConnections,
                                allowedOrigins: ['*']
                            };

                            const result = await Editor.Message.request('cocos-mcp-server', 'updateSettings', settingsData);
                            console.log('[Vue App] Save result:', result);
                            
                            // Immediately re-read settings from server to confirm
                            const status = await Editor.Message.request('cocos-mcp-server', 'getServerStatus');
                            if (status && status.settings) {
                                Object.assign(settings.value, {
                                    port: status.settings.port,
                                    autoStart: status.settings.autoStart,
                                    debugLog: status.settings.enableDebugLog,
                                    maxConnections: status.settings.maxConnections
                                });
                                await nextTick();
                            }
                            
                            settingsChanged.value = false;
                        } catch (error) {
                            console.error('[Vue App] Failed to save settings:', error);
                        }
                    };
                    
                    const copyUrl = async () => {
                        try {
                            await navigator.clipboard.writeText(httpUrl.value);
                        } catch (error) {
                            console.error('[Vue App] Failed to copy URL:', error);
                        }
                    };

                    const configureOpenCode = async (location: string) => {
                        configLoading.value = true;
                        configMessage.value = '';
                        configError.value = false;
                        try {
                            const path = require('path') as typeof import('path');
                            const fs = require('fs') as typeof import('fs');

                            // Resolve stdio adapter path (from dist/panels/default/ up to extension root)
                            const projectPath = Editor.Project.path;
                            const adapterAbs = path.resolve(__dirname, '..', '..', '..', 'stdio-adapter', 'build', 'index.js');
                            // Relative path from project root, with forward slashes
                            const adapterPath = path.relative(projectPath, adapterAbs).replace(/\\/g, '/');

                            // Build the MCP config entry
                            const mcpEntry: Record<string, unknown> = {
                                'cocos-mcp': {
                                    type: 'local',
                                    command: ['node', adapterPath],
                                    enabled: true,
                                    timeout: 30000,
                                },
                            };

                            // Determine target config file
                            let configPath: string;
                            if (location === 'global') {
                                const home = process.env['USERPROFILE'] || process.env['HOME'] || '~';
                                configPath = path.join(home, '.config', 'opencode', 'opencode.json');
                            } else {
                                configPath = path.join(Editor.Project.path, 'opencode.json');
                            }

                            // Ensure parent directory exists
                            const dir = path.dirname(configPath);
                            if (!fs.existsSync(dir)) {
                                fs.mkdirSync(dir, { recursive: true });
                            }

                            // Read existing config or create new
                            let config: any = { $schema: 'https://opencode.ai/config.json' };
                            if (fs.existsSync(configPath)) {
                                const raw = fs.readFileSync(configPath, 'utf8');
                                config = JSON.parse(raw);
                                if (!config.$schema) {
                                    config.$schema = 'https://opencode.ai/config.json';
                                }
                            }

                            // Merge MCP config (preserve other mcp entries)
                            config.mcp = { ...(config.mcp || {}), ...mcpEntry };

                            // Write back
                            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

                            configError.value = false;
                            configMessage.value = `配置成功！已写入: ${configPath}`;
                        } catch (error: any) {
                            configError.value = true;
                            configMessage.value = error?.message ?? '配置失败: 未知错误';
                            console.error('[Vue App] Failed to configure OpenCode:', error);
                        } finally {
                            configLoading.value = false;
                        }
                    };
                    
                    const loadToolManagerState = async () => {
                        try {
                            const result = await Editor.Message.request('cocos-mcp-server', 'getToolManagerState');
                            if (result && result.success) {
                                // 总是加载后端状态，确保数据是最新的
                                availableTools.value = result.availableTools || [];
                                console.log('[Vue App] Loaded tools:', availableTools.value.length);
                                
                                // 更新工具分类
                                const categories = new Set(availableTools.value.map(tool => tool.category));
                                toolCategories.value = Array.from(categories);
                            }
                        } catch (error) {
                            console.error('[Vue App] Failed to load tool manager state:', error);
                        }
                    };
                    
                    const updateToolStatus = async (category: string, name: string, enabled: boolean) => {
                        try {
                            console.log('[Vue App] updateToolStatus called:', category, name, enabled);
                            
                            // 先更新本地状态
                            const toolIndex = availableTools.value.findIndex(t => t.category === category && t.name === name);
                            if (toolIndex !== -1) {
                                availableTools.value[toolIndex].enabled = enabled;
                                // 强制触发响应式更新
                                availableTools.value = [...availableTools.value];
                                console.log('[Vue App] Local state updated, tool enabled:', availableTools.value[toolIndex].enabled);
                            }
                            
                            // 调用后端更新
                            const result = await Editor.Message.request('cocos-mcp-server', 'updateToolStatus', category, name, enabled);
                            if (!result || !result.success) {
                                // 如果后端更新失败，回滚本地状态
                                if (toolIndex !== -1) {
                                    availableTools.value[toolIndex].enabled = !enabled;
                                    availableTools.value = [...availableTools.value];
                                }
                                console.error('[Vue App] Backend update failed, rolled back local state');
                            } else {
                                console.log('[Vue App] Backend update successful');
                            }
                        } catch (error) {
                            // 如果发生错误，回滚本地状态
                            const toolIndex = availableTools.value.findIndex(t => t.category === category && t.name === name);
                            if (toolIndex !== -1) {
                                availableTools.value[toolIndex].enabled = !enabled;
                                availableTools.value = [...availableTools.value];
                            }
                            console.error('[Vue App] Failed to update tool status:', error);
                        }
                    };
                    
                    const selectAllTools = async () => {
                        try {
                            // 直接更新本地状态，然后保存
                            availableTools.value.forEach(tool => tool.enabled = true);
                            await saveChanges();
                        } catch (error) {
                            console.error('[Vue App] Failed to select all tools:', error);
                        }
                    };
                    
                    const deselectAllTools = async () => {
                        try {
                            // 直接更新本地状态，然后保存
                            availableTools.value.forEach(tool => tool.enabled = false);
                            await saveChanges();
                        } catch (error) {
                            console.error('[Vue App] Failed to deselect all tools:', error);
                        }
                    };
                    
                                        const saveChanges = async () => {
                        try {
                            // 创建普通对象，避免Vue3响应式对象克隆错误
                            const updates = availableTools.value.map(tool => ({
                                category: String(tool.category),
                                name: String(tool.name),
                                enabled: Boolean(tool.enabled)
                            }));
                            
                            console.log('[Vue App] Sending updates:', updates.length, 'tools');
                            
                            const result = await Editor.Message.request('cocos-mcp-server', 'updateToolStatusBatch', updates);
                            
                            if (result && result.success) {
                                console.log('[Vue App] Tool changes saved successfully');
                            }
                        } catch (error) {
                            console.error('[Vue App] Failed to save tool changes:', error);
                        }
                    };
                    

                    
                    const toggleCategoryTools = async (category: string, enabled: boolean) => {
                        try {
                            // 直接更新本地状态，然后保存
                            availableTools.value.forEach(tool => {
                                if (tool.category === category) {
                                    tool.enabled = enabled;
                                }
                            });
                            await saveChanges();
                        } catch (error) {
                            console.error('[Vue App] Failed to toggle category tools:', error);
                        }
                    };
                    
                    const getToolsByCategory = (category: string) => {
                        return availableTools.value.filter(tool => tool.category === category);
                    };
                    
                    const getCategoryDisplayName = (category: string): string => {
                        const categoryNames: { [key: string]: string } = {
                            'scene': '场景工具',
                            'node': '节点工具',
                            'component': '组件工具',
                            'prefab': '预制体工具',
                            'project': '项目工具',
                            'debug': '调试工具',
                            'preferences': '偏好设置工具',
                            'server': '服务器工具',
                            'broadcast': '广播工具',
                            'sceneAdvanced': '高级场景工具',
                            'sceneView': '场景视图工具',
                            'referenceImage': '参考图片工具',
                            'assetAdvanced': '高级资源工具',
                            'validation': '验证工具'
                        };
                        return categoryNames[category] || category;
                    };
                    

                    

                    
                    // 监听设置变化
                    watch(settings, () => {
                        settingsChanged.value = true;
                    }, { deep: true });
                    

                    
                    // 组件挂载时加载数据
                    onMounted(async () => {
                        // 加载工具管理器状态
                        await loadToolManagerState();
                        
                        // 从服务器状态获取设置信息
                        try {
                            const serverStatus = await Editor.Message.request('cocos-mcp-server', 'getServerStatus');
                            if (serverStatus && serverStatus.settings) {
                                settings.value = {
                                    port: serverStatus.settings.port || 3000,
                                    autoStart: serverStatus.settings.autoStart || false,
                                    debugLog: serverStatus.settings.enableDebugLog || false,
                                    maxConnections: serverStatus.settings.maxConnections || 10
                                };
                                console.log('[Vue App] Server settings loaded from status:', serverStatus.settings);
                            } else if (serverStatus && serverStatus.port) {
                                // 兼容旧版本，只获取端口信息
                                settings.value.port = serverStatus.port;
                                console.log('[Vue App] Port loaded from server status:', serverStatus.port);
                            }
                        } catch (error) {
                            console.error('[Vue App] Failed to get server status:', error);
                            console.log('[Vue App] Using default server settings');
                        }
                        
                        // 定期更新服务器状态
                        setInterval(async () => {
                            try {
                                const result = await Editor.Message.request('cocos-mcp-server', 'getServerStatus');
                                if (result) {
                                    serverRunning.value = result.running;
                                    serverStatus.value = result.running ? '运行中' : '已停止';
                                    connectedClients.value = result.clients || 0;
                                    httpUrl.value = result.running ? `http://localhost:${result.port}` : '';
                                    isProcessing.value = false;
                                }
                            } catch (error) {
                                console.error('[Vue App] Failed to get server status:', error);
                            }
                        }, 2000);
                    });
                    
                    return {
                        // 数据
                        activeTab,
                        serverRunning,
                        serverStatus,
                        connectedClients,
                        httpUrl,
                        isProcessing,
                        configLoading,
                        configMessage,
                        configError,
                        settings,
                        availableTools,
                        toolCategories,
                        settingsChanged,
                        
                        // 计算属性
                        statusClass,
                        totalTools,
                        enabledTools,
                        disabledTools,
                        
                        // 方法
                        switchTab,
                        toggleServer,
                        saveSettings,
                        copyUrl,
                        configureOpenCode,
                        loadToolManagerState,
                        updateToolStatus,
                        selectAllTools,
                        deselectAllTools,
                        saveChanges,
                        toggleCategoryTools,
                        getToolsByCategory,
                        getCategoryDisplayName
                    };
                },
                template: readFileSync(join(__dirname, '../../../static/template/vue/mcp-server-app.html'), 'utf-8'),
            }));
            
            app.mount(this.$.app);
            panelDataMap.set(this, app);
            
            console.log('[MCP Panel] Vue3 app mounted successfully');
        }
    },
    beforeClose() { },
    close() {
        const app = panelDataMap.get(this);
        if (app) {
            app.unmount();
        }
    },
});