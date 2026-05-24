import { ToolDefinition, ToolResponse, ToolExecutor, SceneInfo } from '../types';
import * as AssetDB from '../asset-db-wrapper';
import { getPageArgs, paginate } from '../paging';

export interface SceneCreationRequest {
    sceneName: string;
    savePath: string;
    openAfterCreate?: boolean;
    overwrite?: boolean;
}

export interface SceneCreationDeps {
    buildSceneContent?: (sceneName: string) => string;
    assetExists?: (url: string) => boolean;
    normalizeUrl?: (url: string) => string;
    createAsset?: (
        url: string,
        content: string,
        options?: { overwrite?: boolean }
    ) => Promise<{ url: string; uuid: string; metaReady?: boolean }>;
    openSceneByUuid?: (uuid: string) => Promise<void>;
}

export interface SceneSwitchGuardRequest {
    operation: 'open_scene' | 'close_scene';
    dirty: boolean;
    autoSave?: boolean;
}

export interface SceneSwitchGuardPlan {
    allowed: boolean;
    shouldSave: boolean;
    reason: string | null;
}

export function buildSceneAssetUrl(savePath: string, sceneName: string): string {
    const trimmed = savePath.trim().replace(/\/+$/, '');
    return trimmed.endsWith('.scene') ? trimmed : `${trimmed}/${sceneName}.scene`;
}

/**
 * 统一规划切场景前的脏状态处理，避免 Creator 弹保存确认阻塞自动化流程。
 */
export function planSceneSwitchGuard(request: SceneSwitchGuardRequest): SceneSwitchGuardPlan {
    if (!request.dirty) {
        return {
            allowed: true,
            shouldSave: false,
            reason: null,
        };
    }

    if (request.autoSave) {
        return {
            allowed: true,
            shouldSave: true,
            reason: null,
        };
    }

    const actionLabel = request.operation === 'open_scene'
        ? 'switching scenes'
        : 'closing the scene';

    return {
        allowed: false,
        shouldSave: false,
        reason: `Current scene has unsaved changes. Pass autoSave=true to save before ${actionLabel}.`,
    };
}

function buildDefaultSceneContent(sceneName: string): string {
    return JSON.stringify([
        {
            "__type__": "cc.SceneAsset",
            "_name": sceneName,
            "_objFlags": 0,
            "__editorExtras__": {},
            "_native": "",
            "scene": {
                "__id__": 1
            }
        },
        {
            "__type__": "cc.Scene",
            "_name": sceneName,
            "_objFlags": 0,
            "__editorExtras__": {},
            "_parent": null,
            "_children": [],
            "_active": true,
            "_components": [],
            "_prefab": null,
            "_lpos": {
                "__type__": "cc.Vec3",
                "x": 0,
                "y": 0,
                "z": 0
            },
            "_lrot": {
                "__type__": "cc.Quat",
                "x": 0,
                "y": 0,
                "z": 0,
                "w": 1
            },
            "_lscale": {
                "__type__": "cc.Vec3",
                "x": 1,
                "y": 1,
                "z": 1
            },
            "_mobility": 0,
            "_layer": 1073741824,
            "_euler": {
                "__type__": "cc.Vec3",
                "x": 0,
                "y": 0,
                "z": 0
            },
            "autoReleaseAssets": false,
            "_globals": {
                "__id__": 2
            },
            "_id": "scene"
        },
        {
            "__type__": "cc.SceneGlobals",
            "ambient": {
                "__id__": 3
            },
            "skybox": {
                "__id__": 4
            },
            "fog": {
                "__id__": 5
            },
            "octree": {
                "__id__": 6
            }
        },
        {
            "__type__": "cc.AmbientInfo",
            "_skyColorHDR": {
                "__type__": "cc.Vec4",
                "x": 0.2,
                "y": 0.5,
                "z": 0.8,
                "w": 0.520833
            },
            "_skyColor": {
                "__type__": "cc.Vec4",
                "x": 0.2,
                "y": 0.5,
                "z": 0.8,
                "w": 0.520833
            },
            "_skyIllumHDR": 20000,
            "_skyIllum": 20000,
            "_groundAlbedoHDR": {
                "__type__": "cc.Vec4",
                "x": 0.2,
                "y": 0.2,
                "z": 0.2,
                "w": 1
            },
            "_groundAlbedo": {
                "__type__": "cc.Vec4",
                "x": 0.2,
                "y": 0.2,
                "z": 0.2,
                "w": 1
            }
        },
        {
            "__type__": "cc.SkyboxInfo",
            "_envLightingType": 0,
            "_envmapHDR": null,
            "_envmap": null,
            "_envmapLodCount": 0,
            "_diffuseMapHDR": null,
            "_diffuseMap": null,
            "_enabled": false,
            "_useHDR": true,
            "_editableMaterial": null,
            "_reflectionHDR": null,
            "_reflectionMap": null,
            "_rotationAngle": 0
        },
        {
            "__type__": "cc.FogInfo",
            "_type": 0,
            "_fogColor": {
                "__type__": "cc.Color",
                "r": 200,
                "g": 200,
                "b": 200,
                "a": 255
            },
            "_enabled": false,
            "_fogDensity": 0.3,
            "_fogStart": 0.5,
            "_fogEnd": 300,
            "_fogAtten": 5,
            "_fogTop": 1.5,
            "_fogRange": 1.2,
            "_accurate": false
        },
        {
            "__type__": "cc.OctreeInfo",
            "_enabled": false,
            "_minPos": {
                "__type__": "cc.Vec3",
                "x": -1024,
                "y": -1024,
                "z": -1024
            },
            "_maxPos": {
                "__type__": "cc.Vec3",
                "x": 1024,
                "y": 1024,
                "z": 1024
            },
            "_depth": 8
        }
    ], null, 2);
}

export async function createSceneAsset(
    request: SceneCreationRequest,
    deps: SceneCreationDeps = {}
): Promise<{ uuid: string; url: string; name: string; opened: boolean }> {
    const fullPath = buildSceneAssetUrl(request.savePath, request.sceneName);
    const normalizeUrl = deps.normalizeUrl ?? ((url: string) => url);
    const assetExists = deps.assetExists ?? (() => false);
    const createAsset = deps.createAsset ?? (async (url: string, content: string) => {
        const result = await AssetDB.createAsset(url, content, { overwrite: request.overwrite });
        return { ...result, metaReady: true };
    });
    const openSceneByUuid = deps.openSceneByUuid ?? (async (uuid: string) => {
        await Editor.Message.request('scene', 'open-scene', uuid);
    });
    const buildSceneContent = deps.buildSceneContent ?? buildDefaultSceneContent;

    AssetDB.throwIfAssetExists(fullPath, !!request.overwrite, assetExists, normalizeUrl);

    const created = AssetDB.ensureCreatedAssetIsReady(
        await createAsset(fullPath, buildSceneContent(request.sceneName), { overwrite: request.overwrite })
    );

    let opened = false;
    if (request.openAfterCreate) {
        await openSceneByUuid(created.uuid);
        opened = true;
    }

    return {
        uuid: created.uuid,
        url: created.url,
        name: request.sceneName,
        opened
    };
}

export class SceneTools implements ToolExecutor {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'get_current_scene',
                description: 'Get current scene information',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'get_scene_list',
                description: 'Get all scenes in the project (paginated)',
                inputSchema: {
                    type: 'object',
                    properties: {
                        page_size: { type: 'number', default: 50, description: 'Results per page (1-500, default: 50)' },
                        cursor: { type: 'number', default: 0, description: 'Pagination cursor offset (default: 0)' }
                    }
                }
            },
            {
                name: 'open_scene',
                description: 'Open a scene by path',
                inputSchema: {
                    type: 'object',
                    properties: {
                        scenePath: {
                            type: 'string',
                            description: 'The scene file path'
                        },
                        autoSave: {
                            type: 'boolean',
                            description: 'Save the current dirty scene before opening another scene',
                            default: false
                        }
                    },
                    required: ['scenePath']
                }
            },
            {
                name: 'save_scene',
                description: 'Save current scene',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'create_scene',
                description: 'Create a new scene asset',
                inputSchema: {
                    type: 'object',
                    properties: {
                        sceneName: {
                            type: 'string',
                            description: 'Name of the new scene'
                        },
                        savePath: {
                            type: 'string',
                            description: 'Path to save the scene (e.g., db://assets/scenes/NewScene.scene)'
                        }
                    },
                    required: ['sceneName', 'savePath']
                }
            },
            {
                name: 'save_scene_as',
                description: 'Save scene as new file',
                inputSchema: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: 'Path to save the scene'
                        }
                    },
                    required: ['path']
                }
            },
            {
                name: 'close_scene',
                description: 'Close current scene',
                inputSchema: {
                    type: 'object',
                    properties: {
                        autoSave: {
                            type: 'boolean',
                            description: 'Save the current dirty scene before closing it',
                            default: false
                        }
                    }
                }
            },
            {
                name: 'get_scene_hierarchy',
                description: 'Get the complete hierarchy of current scene (paginated)',
                inputSchema: {
                    type: 'object',
                    properties: {
                        includeComponents: {
                            type: 'boolean',
                            description: 'Include component information',
                            default: false
                        },
                        page_size: {
                            type: 'number',
                            default: 50,
                            description: 'Results per page (1-500, default: 50)'
                        },
                        cursor: {
                            type: 'number',
                            default: 0,
                            description: 'Pagination cursor offset (default: 0)'
                        }
                    }
                }
            }
        ];
    }

    async execute(toolName: string, args: any): Promise<ToolResponse> {
        switch (toolName) {
            case 'get_current_scene':
                return await this.getCurrentScene();
            case 'get_scene_list':
                const slResult = await this.getSceneList();
                if (slResult.success && Array.isArray(slResult.data)) {
                    const { pageSize: ps, cursor: c } = getPageArgs(args);
                    slResult.data = paginate(slResult.data, ps, c);
                }
                return slResult;
            case 'open_scene':
                return await this.openScene(args.scenePath, args.autoSave);
            case 'save_scene':
                return await this.saveScene();
            case 'create_scene':
                return await this.createScene(args.sceneName, args.savePath);
            case 'save_scene_as':
                return await this.saveSceneAs(args.path);
            case 'close_scene':
                return await this.closeScene(args.autoSave);
            case 'get_scene_hierarchy':
                const shResult = await this.getSceneHierarchy(args.includeComponents);
                if (shResult.success && Array.isArray(shResult.data)) {
                    const { pageSize: ps, cursor: c } = getPageArgs(args);
                    shResult.data = paginate(shResult.data, ps, c);
                }
                return shResult;
            default:
                throw new Error(`Unknown tool: ${toolName}`);
        }
    }

    private async getCurrentScene(): Promise<ToolResponse> {
        return new Promise((resolve) => {
            // 直接使用 query-node-tree 来获取场景信息（这个方法已经验证可用）
            Editor.Message.request('scene', 'query-node-tree').then((tree: any) => {
                if (tree && tree.uuid) {
                    resolve({
                        success: true,
                        data: {
                            name: tree.name || 'Current Scene',
                            uuid: tree.uuid,
                            type: tree.type || 'cc.Scene',
                            active: tree.active !== undefined ? tree.active : true,
                            nodeCount: tree.children ? tree.children.length : 0
                        }
                    });
                } else {
                    resolve({ success: false, error: 'No scene data available' });
                }
            }).catch((err: Error) => {
                // 备用方案：使用场景脚本
                const options = {
                    name: 'cocos-mcp-server',
                    method: 'getCurrentSceneInfo',
                    args: []
                };
                
                Editor.Message.request('scene', 'execute-scene-script', options).then((result: any) => {
                    resolve(result);
                }).catch((err2: Error) => {
                    resolve({ success: false, error: `Direct API failed: ${err.message}, Scene script failed: ${err2.message}` });
                });
            });
        });
    }

    private async getSceneList(): Promise<ToolResponse> {
        try {
            const results = await AssetDB.queryAssets('db://assets/**/*.scene');
            const scenes: SceneInfo[] = results.map(asset => ({
                name: asset.name,
                path: asset.url,
                uuid: asset.uuid
            }));
            return { success: true, data: scenes };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    /**
     * 查询当前场景是否有未保存修改，供切场景保护逻辑复用。
     */
    private async isSceneDirty(): Promise<boolean> {
        try {
            const dirty = await Editor.Message.request('scene', 'query-dirty');
            return dirty === true;
        } catch {
            return false;
        }
    }

    /**
     * 在切换或关闭场景前先处理 dirty 状态，避免编辑器弹确认框卡住流程。
     */
    private async guardSceneSwitch(operation: 'open_scene' | 'close_scene', autoSave = false): Promise<ToolResponse | null> {
        const guardPlan = planSceneSwitchGuard({
            operation,
            dirty: await this.isSceneDirty(),
            autoSave,
        });

        if (!guardPlan.allowed) {
            return {
                success: false,
                error: guardPlan.reason ?? 'Current scene has unsaved changes',
            };
        }

        if (guardPlan.shouldSave) {
            const saveResult = await this.saveScene();
            if (!saveResult.success) {
                return saveResult;
            }
        }

        return null;
    }

    private async openScene(scenePath: string, autoSave = false): Promise<ToolResponse> {
        try {
            const guardResult = await this.guardSceneSwitch('open_scene', autoSave);
            if (guardResult) {
                return guardResult;
            }

            const uuid = await AssetDB.queryUuid(scenePath);
            if (!uuid) {
                return { success: false, error: 'Scene not found' };
            }
            await Editor.Message.request('scene', 'open-scene', uuid);
            return { success: true, message: `Scene opened: ${scenePath}` };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    private async saveScene(): Promise<ToolResponse> {
        return new Promise((resolve) => {
            Editor.Message.request('scene', 'save-scene').then(() => {
                resolve({ success: true, message: 'Scene saved successfully' });
            }).catch((err: Error) => {
                resolve({ success: false, error: err.message });
            });
        });
    }

    private async createScene(sceneName: string, savePath: string): Promise<ToolResponse> {
        try {
            const result = await createSceneAsset({
                sceneName,
                savePath
            });
            return {
                success: true,
                data: {
                    uuid: result.uuid,
                    url: result.url,
                    name: sceneName,
                    message: `Scene '${sceneName}' created successfully`
                }
            };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    private async getSceneHierarchy(includeComponents: boolean = false): Promise<ToolResponse> {
        return new Promise((resolve) => {
            // 优先尝试使用 Editor API 查询场景节点树
            Editor.Message.request('scene', 'query-node-tree').then((tree: any) => {
                if (tree) {
                    const hierarchy = this.buildHierarchy(tree, includeComponents);
                    resolve({
                        success: true,
                        data: hierarchy
                    });
                } else {
                    resolve({ success: false, error: 'No scene hierarchy available' });
                }
            }).catch((err: Error) => {
                // 备用方案：使用场景脚本
                const options = {
                    name: 'cocos-mcp-server',
                    method: 'getSceneHierarchy',
                    args: [includeComponents]
                };
                
                Editor.Message.request('scene', 'execute-scene-script', options).then((result: any) => {
                    resolve(result);
                }).catch((err2: Error) => {
                    resolve({ success: false, error: `Direct API failed: ${err.message}, Scene script failed: ${err2.message}` });
                });
            });
        });
    }

    private buildHierarchy(node: any, includeComponents: boolean): any {
        const nodeInfo: any = {
            uuid: node.uuid,
            name: node.name,
            type: node.type,
            active: node.active,
            children: []
        };

        if (includeComponents && node.__comps__) {
            nodeInfo.components = node.__comps__.map((comp: any) => ({
                type: comp.__type__ || 'Unknown',
                enabled: comp.enabled !== undefined ? comp.enabled : true
            }));
        }

        if (node.children) {
            nodeInfo.children = node.children.map((child: any) => 
                this.buildHierarchy(child, includeComponents)
            );
        }

        return nodeInfo;
    }

    private async saveSceneAs(path: string): Promise<ToolResponse> {
        return new Promise((resolve) => {
            // save-as-scene API 不接受路径参数，会弹出对话框让用户选择
            (Editor.Message.request as any)('scene', 'save-as-scene').then(() => {
                resolve({
                    success: true,
                    data: {
                        path: path,
                        message: `Scene save-as dialog opened`
                    }
                });
            }).catch((err: Error) => {
                resolve({ success: false, error: err.message });
            });
        });
    }

    private async closeScene(autoSave = false): Promise<ToolResponse> {
        const guardResult = await this.guardSceneSwitch('close_scene', autoSave);
        if (guardResult) {
            return guardResult;
        }

        return new Promise((resolve) => {
            Editor.Message.request('scene', 'close-scene').then(() => {
                resolve({
                    success: true,
                    message: 'Scene closed successfully'
                });
            }).catch((err: Error) => {
                resolve({ success: false, error: err.message });
            });
        });
    }
}
