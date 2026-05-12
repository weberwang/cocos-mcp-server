/* eslint-disable vue/one-component-per-file */

import { readFileSync } from 'fs-extra';
import { join } from 'path';
import { createApp, App, defineComponent, ref, computed, onMounted, watch, nextTick } from 'vue';

const panelDataMap = new WeakMap<any, App>();

interface ToolConfig {
    category: string;
    name: string;
    enabled: boolean;
    description: string;
}

interface ServerSettings {
    port: number;
    autoStart: boolean;
    debugLog: boolean;
    maxConnections: number;
}

type ClientTarget = 'opencode' | 'codex' | 'all';
type ConfigLocation = 'local' | 'global';

const CATEGORY_LABELS: Record<string, string> = {
    scene: 'Scene Tools',
    node: 'Node Tools',
    component: 'Component Tools',
    prefab: 'Prefab Tools',
    project: 'Project Tools',
    debug: 'Debug Tools',
    preferences: 'Preferences Tools',
    server: 'Server Tools',
    broadcast: 'Broadcast Tools',
    sceneAdvanced: 'Advanced Scene Tools',
    sceneView: 'Scene View Tools',
    referenceImage: 'Reference Image Tools',
    assetAdvanced: 'Advanced Asset Tools',
    validation: 'Validation Tools',
};

function readEventValue(event: any): any {
    return event?.target?.value ?? event?.detail?.value ?? event?.value ?? event;
}

function readEventChecked(event: any): boolean {
    return Boolean(event?.target?.checked ?? event?.target?.value ?? event?.detail?.value ?? event?.value ?? event);
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

            app.component('McpServerApp', defineComponent({
                setup() {
                    const activeTab = ref('server');
                    const serverRunning = ref(false);
                    const serverStatus = ref('Stopped');
                    const connectedClients = ref(0);
                    const httpUrl = ref('');
                    const isProcessing = ref(false);

                    const configLoading = ref(false);
                    const configMessage = ref('');
                    const configError = ref(false);
                    const configTarget = ref<ClientTarget>('opencode');
                    const configLocation = ref<ConfigLocation>('local');

                    const settings = ref<ServerSettings>({
                        port: 7788,
                        autoStart: false,
                        debugLog: false,
                        maxConnections: 10,
                    });

                    const availableTools = ref<ToolConfig[]>([]);
                    const toolCategories = ref<string[]>([]);
                    const settingsChanged = ref(false);

                    const statusClass = computed(() => ({
                        'status-running': serverRunning.value,
                        'status-stopped': !serverRunning.value,
                    }));

                    const totalTools = computed(() => availableTools.value.length);
                    const enabledTools = computed(() => availableTools.value.filter((tool) => tool.enabled).length);
                    const disabledTools = computed(() => totalTools.value - enabledTools.value);

                    const switchTab = (tabName: string) => {
                        activeTab.value = tabName;
                        if (tabName === 'tools') {
                            loadToolManagerState();
                        }
                    };

                    const toggleServer = async () => {
                        try {
                            isProcessing.value = true;
                            if (serverRunning.value) {
                                await Editor.Message.request('cocos-mcp-server', 'stopServer');
                            } else {
                                const currentSettings = {
                                    port: Number(settings.value.port),
                                    autoStart: settings.value.autoStart,
                                    enableDebugLog: settings.value.debugLog,
                                    maxConnections: Number(settings.value.maxConnections),
                                };
                                await Editor.Message.request('cocos-mcp-server', 'updateSettings', currentSettings);
                                await Editor.Message.request('cocos-mcp-server', 'startServer');
                            }
                            console.log('[Vue App] Server toggled');
                        } catch (error) {
                            console.error('[Vue App] Failed to toggle server:', error);
                        } finally {
                            isProcessing.value = false;
                        }
                    };

                    const saveSettings = async () => {
                        try {
                            const settingsData = {
                                port: Number(settings.value.port),
                                autoStart: settings.value.autoStart,
                                enableDebugLog: settings.value.debugLog,
                                maxConnections: Number(settings.value.maxConnections),
                                allowedOrigins: ['*'],
                            };

                            const result = await Editor.Message.request('cocos-mcp-server', 'updateSettings', settingsData);
                            console.log('[Vue App] Save result:', result);

                            const status = await Editor.Message.request('cocos-mcp-server', 'getServerStatus');
                            if (status && status.settings) {
                                Object.assign(settings.value, {
                                    port: status.settings.port,
                                    autoStart: status.settings.autoStart,
                                    debugLog: status.settings.enableDebugLog,
                                    maxConnections: status.settings.maxConnections,
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

                    const configureAIClient = async (target: ClientTarget, location: ConfigLocation) => {
                        configLoading.value = true;
                        configMessage.value = '';
                        configError.value = false;
                        try {
                            const result = await Editor.Message.request(
                                'cocos-mcp-server',
                                'configureAIClient',
                                target,
                                location,
                            );

                            if (!result?.success) {
                                throw new Error(result?.error ?? 'Configuration failed');
                            }

                            const lines = Array.isArray(result.paths)
                                ? result.paths.map((item: { client: string; path: string }) => `${item.client}: ${item.path}`)
                                : [result.path];

                            configMessage.value = `Updated configuration files:\n${lines.filter(Boolean).join('\n')}`;
                        } catch (error: any) {
                            configError.value = true;
                            configMessage.value = error?.message ?? 'Configuration failed';
                            console.error('[Vue App] Failed to configure AI client:', error);
                        } finally {
                            configLoading.value = false;
                        }
                    };

                    const configureSelectedAIClient = async () => {
                        await configureAIClient(configTarget.value, configLocation.value);
                    };

                    const configureAllAIClients = async () => {
                        await configureAIClient('all', configLocation.value);
                    };

                    const loadToolManagerState = async () => {
                        try {
                            const result = await Editor.Message.request('cocos-mcp-server', 'getToolManagerState');
                            if (result && result.success) {
                                availableTools.value = result.availableTools || [];
                                const categories = new Set(availableTools.value.map((tool) => tool.category));
                                toolCategories.value = Array.from(categories);
                                console.log('[Vue App] Loaded tools:', availableTools.value.length);
                            }
                        } catch (error) {
                            console.error('[Vue App] Failed to load tool manager state:', error);
                        }
                    };

                    const updateToolStatus = async (category: string, name: string, enabled: boolean) => {
                        const toolIndex = availableTools.value.findIndex(
                            (tool) => tool.category === category && tool.name === name,
                        );

                        try {
                            if (toolIndex !== -1) {
                                availableTools.value[toolIndex].enabled = enabled;
                                availableTools.value = [...availableTools.value];
                            }

                            const result = await Editor.Message.request(
                                'cocos-mcp-server',
                                'updateToolStatus',
                                category,
                                name,
                                enabled,
                            );

                            if (!result || !result.success) {
                                throw new Error('Backend update failed');
                            }
                        } catch (error) {
                            if (toolIndex !== -1) {
                                availableTools.value[toolIndex].enabled = !enabled;
                                availableTools.value = [...availableTools.value];
                            }
                            console.error('[Vue App] Failed to update tool status:', error);
                        }
                    };

                    const saveChanges = async () => {
                        try {
                            const updates = availableTools.value.map((tool) => ({
                                category: String(tool.category),
                                name: String(tool.name),
                                enabled: Boolean(tool.enabled),
                            }));

                            const result = await Editor.Message.request('cocos-mcp-server', 'updateToolStatusBatch', updates);
                            if (result && result.success) {
                                console.log('[Vue App] Tool changes saved successfully');
                            }
                        } catch (error) {
                            console.error('[Vue App] Failed to save tool changes:', error);
                        }
                    };

                    const selectAllTools = async () => {
                        availableTools.value.forEach((tool) => {
                            tool.enabled = true;
                        });
                        await saveChanges();
                    };

                    const deselectAllTools = async () => {
                        availableTools.value.forEach((tool) => {
                            tool.enabled = false;
                        });
                        await saveChanges();
                    };

                    const toggleCategoryTools = async (category: string, enabled: boolean) => {
                        availableTools.value.forEach((tool) => {
                            if (tool.category === category) {
                                tool.enabled = enabled;
                            }
                        });
                        await saveChanges();
                    };

                    const getToolsByCategory = (category: string) => availableTools.value.filter(
                        (tool) => tool.category === category,
                    );

                    const getCategoryDisplayName = (category: string): string => CATEGORY_LABELS[category] || category;

                    const onPortChange = (event: any) => {
                        settings.value.port = Number(readEventValue(event));
                    };

                    const onAutoStartChange = (event: any) => {
                        settings.value.autoStart = readEventChecked(event);
                    };

                    const onDebugLogChange = (event: any) => {
                        settings.value.debugLog = readEventChecked(event);
                    };

                    const onMaxConnectionsChange = (event: any) => {
                        settings.value.maxConnections = Number(readEventValue(event));
                    };

                    const onConfigTargetChange = (event: any) => {
                        configTarget.value = readEventValue(event) as ClientTarget;
                    };

                    const onConfigLocationChange = (event: any) => {
                        configLocation.value = readEventValue(event) as ConfigLocation;
                    };

                    watch(settings, () => {
                        settingsChanged.value = true;
                    }, { deep: true });

                    onMounted(async () => {
                        await loadToolManagerState();

                        try {
                            const serverStatusResult = await Editor.Message.request('cocos-mcp-server', 'getServerStatus');
                            if (serverStatusResult && serverStatusResult.settings) {
                                settings.value = {
                                    port: serverStatusResult.settings.port || 7788,
                                    autoStart: serverStatusResult.settings.autoStart || false,
                                    debugLog: serverStatusResult.settings.enableDebugLog || false,
                                    maxConnections: serverStatusResult.settings.maxConnections || 10,
                                };
                            } else if (serverStatusResult && serverStatusResult.port) {
                                settings.value.port = serverStatusResult.port;
                            }
                        } catch (error) {
                            console.error('[Vue App] Failed to get server status:', error);
                        }

                        setInterval(async () => {
                            try {
                                const result = await Editor.Message.request('cocos-mcp-server', 'getServerStatus');
                                if (result) {
                                    serverRunning.value = result.running;
                                    serverStatus.value = result.running ? 'Running' : 'Stopped';
                                    connectedClients.value = result.clients || 0;
                                    httpUrl.value = result.running ? `http://localhost:${result.port}` : '';
                                }
                            } catch (error) {
                                console.error('[Vue App] Failed to get server status:', error);
                            }
                        }, 2000);
                    });

                    return {
                        activeTab,
                        serverRunning,
                        serverStatus,
                        connectedClients,
                        httpUrl,
                        isProcessing,
                        configLoading,
                        configMessage,
                        configError,
                        configTarget,
                        configLocation,
                        settings,
                        availableTools,
                        toolCategories,
                        settingsChanged,
                        statusClass,
                        totalTools,
                        enabledTools,
                        disabledTools,
                        switchTab,
                        toggleServer,
                        saveSettings,
                        copyUrl,
                        configureSelectedAIClient,
                        configureAllAIClients,
                        loadToolManagerState,
                        updateToolStatus,
                        selectAllTools,
                        deselectAllTools,
                        saveChanges,
                        toggleCategoryTools,
                        getToolsByCategory,
                        getCategoryDisplayName,
                        onPortChange,
                        onAutoStartChange,
                        onDebugLogChange,
                        onMaxConnectionsChange,
                        onConfigTargetChange,
                        onConfigLocationChange,
                        readEventChecked,
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
