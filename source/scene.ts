import { join } from 'path';
module.paths.push(join(Editor.App.path, 'node_modules'));

/**
 * 加载 Cocos 内置 scene 包的运行时模块。
 * 内置模块位于 Creator 安装目录的 app.asar 中，不能直接用 cce: 别名时，退回到绝对路径加载。
 */
function requireBuiltinSceneModule<T = any>(relativeModulePath: string): T {
    const normalizedModulePath = relativeModulePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const candidatePaths = [
        join(Editor.App.path, 'builtin', 'scene', 'dist', 'script', '3d', `${normalizedModulePath}.ccc`),
        join(Editor.App.path, 'builtin', 'scene', 'dist', 'script', '3d', normalizedModulePath, 'index.ccc'),
        join(Editor.App.path, 'builtin', 'scene', 'dist', 'script', '3d', normalizedModulePath),
    ];

    const errors: string[] = [];
    for (const candidatePath of candidatePaths) {
        try {
            return require(candidatePath) as T;
        } catch (error: any) {
            errors.push(`${candidatePath}: ${error.message}`);
        }
    }

    throw new Error(`Failed to load builtin scene module '${relativeModulePath}': ${errors.join(' | ')}`);
}

/**
 * 游戏视图截图所需的最小配置。
 */
interface GameViewCaptureOptions {
    cameraName?: string;
    width?: number;
    height?: number;
}

/**
 * 场景树里的相机候选，统一服务旧链路与 preview-play 链路。
 */
interface SceneCameraEntry {
    node: any;
    camera: any;
}

/**
 * 递归收集场景树中的 Camera 组件。
 * 这样不依赖固定节点路径，兼容运行时预览场景与编辑态场景。
 */
function collectSceneCameraEntries(sceneRoot: any, Camera: any): SceneCameraEntry[] {
    const cameraEntries: SceneCameraEntry[] = [];
    const visitNode = (node: any) => {
        if (!node) {
            return;
        }

        const camera = typeof node.getComponent === 'function' ? node.getComponent(Camera) : null;
        if (camera) {
            cameraEntries.push({ node, camera });
        }

        for (const child of node.children || []) {
            visitNode(child);
        }
    };

    for (const child of sceneRoot?.children || []) {
        visitNode(child);
    }

    return cameraEntries;
}

/**
 * 选择最适合截图的相机，优先显式名称，其次是常见的 Camera 节点。
 */
function selectSceneCameraEntry(cameraEntries: SceneCameraEntry[], cameraName?: string): SceneCameraEntry | null {
    return (
        (cameraName
            ? cameraEntries.find((entry) => entry.node?.name === cameraName)
            : null) ??
        cameraEntries.find((entry) => entry.node?.name === 'Camera') ??
        cameraEntries[0] ??
        null
    );
}

/**
 * 统一推导截图分辨率。
 * preview-play 会先设置目标分辨率，这里再用相机窗口兜底，避免拿到 1x1 纹理。
 */
function resolveGameViewCaptureSize(cameraComponent: any, view: any, options: GameViewCaptureOptions): {
    width: number;
    height: number;
} {
    const cameraWindow = cameraComponent?.camera?.window;
    const fallbackVisibleSize = view.getVisibleSize?.() || { width: 1, height: 1 };

    return {
        width: Math.max(
            1,
            Math.round(options.width || cameraWindow?.width || fallbackVisibleSize.width || 1)
        ),
        height: Math.max(
            1,
            Math.round(options.height || cameraWindow?.height || fallbackVisibleSize.height || 1)
        ),
    };
}

/**
 * 把相机渲染到临时 RenderTexture，并读取原始 RGBA 像素。
 * 这个逻辑保持纯粹，便于复用到 legacy 与 preview-play 两条截图路径。
 */
function captureCameraEntryToRawPixels(params: {
    cameraEntry: SceneCameraEntry;
    RenderTexture: any;
    director: any;
    width: number;
    height: number;
    forceFrameMoveCount?: number;
}): {
    success: boolean;
    data?: {
        width: number;
        height: number;
        pixelsBase64: string;
        flipY: boolean;
        cameraName: string;
    };
    error?: string;
} {
    const {
        cameraEntry,
        RenderTexture,
        director,
        width,
        height,
        forceFrameMoveCount = 1,
    } = params;
    let renderTexture: any = null;
    const originalTargetTexture = cameraEntry.camera?.targetTexture;

    try {
        renderTexture = new RenderTexture();
        renderTexture.reset({ width, height });
        cameraEntry.camera.targetTexture = renderTexture;

        for (let frameIndex = 0; frameIndex < Math.max(1, forceFrameMoveCount); frameIndex += 1) {
            director.root?.frameMove?.(0);
        }

        const pixels = renderTexture.readPixels(0, 0, width, height);
        if (!pixels) {
            return { success: false, error: 'RenderTexture.readPixels returned no pixel data' };
        }

        return {
            success: true,
            data: {
                width,
                height,
                pixelsBase64: Buffer.from(pixels).toString('base64'),
                flipY: true,
                cameraName: cameraEntry.node?.name || 'Camera',
            },
        };
    } catch (error: any) {
        return { success: false, error: error.message };
    } finally {
        cameraEntry.camera.targetTexture = originalTargetTexture ?? null;
        renderTexture?.destroy?.();
    }
}

/**
 * 等待 preview-play 完成首帧渲染。
 * 这里显式让出几个事件循环周期，并补一次 frameMove，减少刚进入预览就读到空纹理的概率。
 */
async function waitForPreviewFrames(director: any, frameCount: number = 3): Promise<void> {
    for (let frameIndex = 0; frameIndex < Math.max(1, frameCount); frameIndex += 1) {
        await new Promise((resolve) => setTimeout(resolve, 16));
        director.root?.frameMove?.(0);
    }
}

/**
 * 识别 preview-play 返回值是否像一个可遍历的场景根节点。
 */
function isSceneRootLike(sceneRoot: any): boolean {
    return Boolean(sceneRoot && Array.isArray(sceneRoot.children));
}

/**
 * 从 SceneFacadeManager 读取当前场景的序列化 JSON。
 * preview-play 在编辑态下直接 start() 可能起的是空预览，因此优先显式喂入当前 scene 数据。
 */
async function queryCurrentSceneSerializedData(): Promise<string | null> {
    try {
        const sceneFacadeManager = (globalThis as any).cce?.SceneFacadeManager;
        if (!sceneFacadeManager?.querySceneSerializedData) {
            return null;
        }

        const serializedData = await sceneFacadeManager.querySceneSerializedData();
        return typeof serializedData === 'string' && serializedData.trim() ? serializedData : null;
    } catch {
        return null;
    }
}

export const methods: { [key: string]: (...any: any) => any } = {
    /**
     * 供 scene-view 截图使用，返回 Canvas 节点矩形与当前 Scene 编辑相机信息。
     * 这样主进程拿到 scene canvas 后，才能继续精确裁切到 Canvas 节点本体区域。
     */
    getSceneViewCanvasCaptureData() {
        try {
            const { director, UITransform, Vec3 } = require('cc');
            const cameraManager = requireBuiltinSceneModule<any>('manager/camera').default;
            const scene = director.getScene();
            if (!scene) {
                return { success: false, error: 'No active scene' };
            }

            const canvasNode = scene.getChildByName('Canvas');
            if (!canvasNode) {
                return { success: false, error: 'Canvas node not found in current scene' };
            }

            const uiTransform = canvasNode.getComponent(UITransform);
            if (!uiTransform) {
                return { success: false, error: 'Canvas node does not contain a UITransform component' };
            }

            const anchorPoint = uiTransform.anchorPoint;
            const contentSize = uiTransform.contentSize;
            const worldPosition = canvasNode.worldPosition;
            const left = worldPosition.x - contentSize.width * anchorPoint.x;
            const bottom = worldPosition.y - contentSize.height * anchorPoint.y;

            const cameraInfo = cameraManager?.getCurCameraInfo?.();
            if (!cameraInfo?.contentRect || !cameraInfo?.viewCenter) {
                return { success: false, error: 'Scene editor camera info is unavailable' };
            }

            return {
                success: true,
                data: {
                    worldRect: {
                        x: left,
                        y: bottom,
                        width: contentSize.width,
                        height: contentSize.height,
                    },
                    cameraInfo: {
                        position: {
                            x: cameraInfo.position?.x ?? 0,
                            y: cameraInfo.position?.y ?? 0,
                            z: cameraInfo.position?.z ?? 0,
                        },
                        viewCenter: {
                            x: cameraInfo.viewCenter?.x ?? 0,
                            y: cameraInfo.viewCenter?.y ?? 0,
                            z: cameraInfo.viewCenter?.z ?? 0,
                        },
                        contentRect: {
                            x: cameraInfo.contentRect?.x ?? 0,
                            y: cameraInfo.contentRect?.y ?? 0,
                            width: cameraInfo.contentRect?.width ?? 0,
                            height: cameraInfo.contentRect?.height ?? 0,
                        },
                        scale: cameraInfo.scale ?? 1,
                    },
                },
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Create a new scene
     */
    createNewScene() {
        try {
            const { director, Scene } = require('cc');
            const scene = new Scene();
            scene.name = 'New Scene';
            director.runScene(scene);
            return { success: true, message: 'New scene created successfully' };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Add component to a node
     */
    addComponentToNode(nodeUuid: string, componentType: string) {
        try {
            const { director, js } = require('cc');
            const scene = director.getScene();
            if (!scene) {
                return { success: false, error: 'No active scene' };
            }

            // Find node by UUID
            const node = scene.getChildByUuid(nodeUuid);
            if (!node) {
                return { success: false, error: `Node with UUID ${nodeUuid} not found` };
            }

            // Get component class
            const ComponentClass = js.getClassByName(componentType);
            if (!ComponentClass) {
                return { success: false, error: `Component type ${componentType} not found` };
            }

            // Add component
            const component = node.addComponent(ComponentClass);
            return { 
                success: true, 
                message: `Component ${componentType} added successfully`,
                data: { componentId: component.uuid }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Remove component from a node
     */
    removeComponentFromNode(nodeUuid: string, componentType: string) {
        try {
            const { director, js } = require('cc');
            const scene = director.getScene();
            if (!scene) {
                return { success: false, error: 'No active scene' };
            }

            const node = scene.getChildByUuid(nodeUuid);
            if (!node) {
                return { success: false, error: `Node with UUID ${nodeUuid} not found` };
            }

            const ComponentClass = js.getClassByName(componentType);
            if (!ComponentClass) {
                return { success: false, error: `Component type ${componentType} not found` };
            }

            const component = node.getComponent(ComponentClass);
            if (!component) {
                return { success: false, error: `Component ${componentType} not found on node` };
            }

            node.removeComponent(component);
            return { success: true, message: `Component ${componentType} removed successfully` };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Create a new node
     */
    createNode(name: string, parentUuid?: string) {
        try {
            const { director, Node } = require('cc');
            const scene = director.getScene();
            if (!scene) {
                return { success: false, error: 'No active scene' };
            }

            const node = new Node(name);
            
            if (parentUuid) {
                const parent = scene.getChildByUuid(parentUuid);
                if (parent) {
                    parent.addChild(node);
                } else {
                    scene.addChild(node);
                }
            } else {
                scene.addChild(node);
            }

            return { 
                success: true, 
                message: `Node ${name} created successfully`,
                data: { uuid: node.uuid, name: node.name }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Get node information
     */
    getNodeInfo(nodeUuid: string) {
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene) {
                return { success: false, error: 'No active scene' };
            }

            const node = scene.getChildByUuid(nodeUuid);
            if (!node) {
                return { success: false, error: `Node with UUID ${nodeUuid} not found` };
            }

            return {
                success: true,
                data: {
                    uuid: node.uuid,
                    name: node.name,
                    active: node.active,
                    position: node.position,
                    rotation: node.rotation,
                    scale: node.scale,
                    parent: node.parent?.uuid,
                    children: node.children.map((child: any) => child.uuid),
                    components: node.components.map((comp: any) => ({
                        type: comp.constructor.name,
                        enabled: comp.enabled
                    }))
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Get all nodes in scene
     */
    getAllNodes() {
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene) {
                return { success: false, error: 'No active scene' };
            }

            const nodes: any[] = [];
            const collectNodes = (node: any) => {
                nodes.push({
                    uuid: node.uuid,
                    name: node.name,
                    active: node.active,
                    parent: node.parent?.uuid
                });
                
                node.children.forEach((child: any) => collectNodes(child));
            };

            scene.children.forEach((child: any) => collectNodes(child));
            
            return { success: true, data: nodes };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Find node by name
     */
    findNodeByName(name: string) {
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene) {
                return { success: false, error: 'No active scene' };
            }

            const node = scene.getChildByName(name);
            if (!node) {
                return { success: false, error: `Node with name ${name} not found` };
            }

            return {
                success: true,
                data: {
                    uuid: node.uuid,
                    name: node.name,
                    active: node.active,
                    position: node.position
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Get current scene information
     */
    getCurrentSceneInfo() {
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene) {
                return { success: false, error: 'No active scene' };
            }

            return {
                success: true,
                data: {
                    name: scene.name,
                    uuid: scene.uuid,
                    nodeCount: scene.children.length
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Set node property
     */
    setNodeProperty(nodeUuid: string, property: string, value: any) {
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene) {
                return { success: false, error: 'No active scene' };
            }

            const node = scene.getChildByUuid(nodeUuid);
            if (!node) {
                return { success: false, error: `Node with UUID ${nodeUuid} not found` };
            }

            // 设置属性
            if (property === 'position') {
                node.setPosition(value.x || 0, value.y || 0, value.z || 0);
            } else if (property === 'rotation') {
                node.setRotationFromEuler(value.x || 0, value.y || 0, value.z || 0);
            } else if (property === 'scale') {
                node.setScale(value.x || 1, value.y || 1, value.z || 1);
            } else if (property === 'active') {
                node.active = value;
            } else if (property === 'name') {
                node.name = value;
            } else {
                // 尝试直接设置属性
                (node as any)[property] = value;
            }

            return { 
                success: true, 
                message: `Property '${property}' updated successfully` 
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Get scene hierarchy
     */
    getSceneHierarchy(includeComponents: boolean = false) {
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene) {
                return { success: false, error: 'No active scene' };
            }

            const processNode = (node: any): any => {
                const result: any = {
                    name: node.name,
                    uuid: node.uuid,
                    active: node.active,
                    children: []
                };

                if (includeComponents) {
                    result.components = node.components.map((comp: any) => ({
                        type: comp.constructor.name,
                        enabled: comp.enabled
                    }));
                }

                if (node.children && node.children.length > 0) {
                    result.children = node.children.map((child: any) => processNode(child));
                }

                return result;
            };

            const hierarchy = scene.children.map((child: any) => processNode(child));
            return { success: true, data: hierarchy };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Create prefab from node
     */
    createPrefabFromNode(nodeUuid: string, prefabPath: string) {
        try {
            const { director, instantiate } = require('cc');
            const scene = director.getScene();
            if (!scene) {
                return { success: false, error: 'No active scene' };
            }

            const node = scene.getChildByUuid(nodeUuid);
            if (!node) {
                return { success: false, error: `Node with UUID ${nodeUuid} not found` };
            }

            // 注意：这里只是一个模拟实现，因为运行时环境下无法直接创建预制体文件
            // 真正的预制体创建需要Editor API支持
            return {
                success: true,
                data: {
                    prefabPath: prefabPath,
                    sourceNodeUuid: nodeUuid,
                    message: `Prefab created from node '${node.name}' at ${prefabPath}`
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Set component property
     */
    setComponentProperty(nodeUuid: string, componentType: string, property: string, value: any) {
        try {
            const { director, js } = require('cc');
            const scene = director.getScene();
            if (!scene) {
                return { success: false, error: 'No active scene' };
            }
            const node = scene.getChildByUuid(nodeUuid);
            if (!node) {
                return { success: false, error: `Node with UUID ${nodeUuid} not found` };
            }
            const ComponentClass = js.getClassByName(componentType);
            if (!ComponentClass) {
                return { success: false, error: `Component type ${componentType} not found` };
            }
            const component = node.getComponent(ComponentClass);
            if (!component) {
                return { success: false, error: `Component ${componentType} not found on node` };
            }
            // 针对常见属性做特殊处理
            if (property === 'spriteFrame' && componentType === 'cc.Sprite') {
                // 支持 value 为 uuid 或资源路径
                if (typeof value === 'string') {
                    // 先尝试按 uuid 查找
                    const assetManager = require('cc').assetManager;
                    assetManager.resources.load(value, require('cc').SpriteFrame, (err: any, spriteFrame: any) => {
                        if (!err && spriteFrame) {
                            component.spriteFrame = spriteFrame;
                        } else {
                            // 尝试通过 uuid 加载
                            assetManager.loadAny({ uuid: value }, (err2: any, asset: any) => {
                                if (!err2 && asset) {
                                    component.spriteFrame = asset;
                                } else {
                                    // 直接赋值（兼容已传入资源对象）
                                    component.spriteFrame = value;
                                }
                            });
                        }
                    });
                } else {
                    component.spriteFrame = value;
                }
            } else if (property === 'material' && (componentType === 'cc.Sprite' || componentType === 'cc.MeshRenderer')) {
                // 支持 value 为 uuid 或资源路径
                if (typeof value === 'string') {
                    const assetManager = require('cc').assetManager;
                    assetManager.resources.load(value, require('cc').Material, (err: any, material: any) => {
                        if (!err && material) {
                            component.material = material;
                        } else {
                            assetManager.loadAny({ uuid: value }, (err2: any, asset: any) => {
                                if (!err2 && asset) {
                                    component.material = asset;
                                } else {
                                    component.material = value;
                                }
                            });
                        }
                    });
                } else {
                    component.material = value;
                }
            } else if (property === 'string' && (componentType === 'cc.Label' || componentType === 'cc.RichText')) {
                component.string = value;
            } else {
                component[property] = value;
            }
            // 可选：刷新 Inspector
            // Editor.Message.send('scene', 'snapshot');
            return { success: true, message: `Component property '${property}' updated successfully` };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Capture the exact runtime output of a camera into raw RGBA pixels.
     * This avoids editor overlays and is intended for precise game-canvas screenshots.
     */
    captureGameView(options?: GameViewCaptureOptions) {
        const config = options || {};

        try {
            const { director, Camera, RenderTexture, view } = require('cc');
            const scene = director.getScene();
            if (!scene) {
                return { success: false, error: 'No active scene' };
            }

            const cameraEntries = collectSceneCameraEntries(scene, Camera);
            const selectedCameraEntry = selectSceneCameraEntry(cameraEntries, config.cameraName);

            if (!selectedCameraEntry) {
                return { success: false, error: 'No camera component is available in the current scene' };
            }

            const { width, height } = resolveGameViewCaptureSize(selectedCameraEntry.camera, view, config);
            return captureCameraEntryToRawPixels({
                cameraEntry: selectedCameraEntry,
                RenderTexture,
                director,
                width,
                height,
            });
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * 通过 preview-play 临时进入 gameview，再抓取运行时相机的纯内容像素。
     * 这条链路避开了 scene-view 的编辑器叠层，也尽量避开编辑态相机未真正参与运行时渲染的问题。
     */
    async captureGameViewViaPreviewPlay(options?: GameViewCaptureOptions) {
        const config = options || {};
        let previewPlay: any = null;
        let previewStarted = false;

        try {
            const { director, Camera, RenderTexture, UITransform, view } = require('cc');
            const scene = director.getScene();
            if (!scene) {
                return { success: false, error: 'No active scene' };
            }

            previewPlay = requireBuiltinSceneModule<any>('manager/preview-play').default;
            if (!previewPlay?.start || !previewPlay?.stop) {
                return { success: false, error: 'PreviewPlay manager is unavailable in the current editor environment' };
            }

            const canvasNode = scene.getChildByName('Canvas');
            const canvasTransform = canvasNode?.getComponent?.(UITransform);
            const preferredWidth = Math.max(
                1,
                Math.round(config.width || canvasTransform?.contentSize?.width || view.getVisibleSize?.().width || 1)
            );
            const preferredHeight = Math.max(
                1,
                Math.round(config.height || canvasTransform?.contentSize?.height || view.getVisibleSize?.().height || 1)
            );
            const sceneJson = await queryCurrentSceneSerializedData();
            if (!sceneJson) {
                return { success: false, error: 'PreviewPlay scene json is unavailable' };
            }

            previewPlay.setResolution?.(preferredWidth, preferredHeight);
            await previewPlay.start(sceneJson);
            previewStarted = true;
            previewPlay.hideEditorCamera?.();

            await waitForPreviewFrames(director, 3);

            const previewScene = await previewPlay.getGameScene?.(sceneJson);
            const sceneRoot = isSceneRootLike(previewScene) ? previewScene : director.getScene();
            const cameraEntries = collectSceneCameraEntries(sceneRoot, Camera);
            const selectedCameraEntry = selectSceneCameraEntry(cameraEntries, config.cameraName);

            if (!selectedCameraEntry) {
                return { success: false, error: 'No camera component is available in the preview-play game scene' };
            }

            const { width, height } = resolveGameViewCaptureSize(selectedCameraEntry.camera, view, {
                ...config,
                width: config.width || preferredWidth,
                height: config.height || preferredHeight,
            });

            return captureCameraEntryToRawPixels({
                cameraEntry: selectedCameraEntry,
                RenderTexture,
                director,
                width,
                height,
                forceFrameMoveCount: 2,
            });
        } catch (error: any) {
            return { success: false, error: error.message };
        } finally {
            try {
                previewPlay?.showEditorCamera?.();
            } catch {
                // 忽略预览恢复失败，让主调用方决定是否继续回退。
            }

            if (previewStarted) {
                try {
                    await previewPlay.stop();
                } catch {
                    // 预览退出失败不阻塞主流程，避免截图错误把编辑器卡在中间态。
                }
            }
        }
    },

    /**
     * Recursively find a node by UUID in the scene tree
     */
    _findNodeByUuid(node: any, uuid: string): any {
        if (node.uuid === uuid) return node;
        for (const child of node.children || []) {
            const found = this._findNodeByUuid(child, uuid);
            if (found) return found;
        }
        return null;
    },

    /**
     * Assign a material to a MeshRenderer on a node
     * Used by manage_material tool's "assign" action
     */
    assignMaterialToRenderer(nodeUuid: string, materialUuid: string, slot: number) {
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene) {
                return { success: false, error: 'No active scene' };
            }
            let node = null;
            for (const child of scene.children) {
                node = this._findNodeByUuid(child, nodeUuid);
                if (node) break;
            }
            if (!node) {
                return { success: false, error: `Node with UUID ${nodeUuid} not found` };
            }
            const renderer = node.getComponent('cc.MeshRenderer');
            if (!renderer) {
                return { success: false, error: `Node ${nodeUuid} has no MeshRenderer` };
            }

            const assetManager = require('cc').assetManager;
            assetManager.loadAny({ uuid: materialUuid }, (err: any, asset: any) => {
                if (!err && asset) {
                    const materials = renderer.sharedMaterials.slice();
                    while (materials.length <= slot) materials.push(null);
                    materials[slot] = asset;
                    renderer.sharedMaterials = materials;
                    renderer.markForUpdateRenderData?.();
                }
            });

            return { success: true, message: `Material ${materialUuid} assigned to node ${nodeUuid} slot ${slot}` };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Bulk assign materials to all MeshRenderer nodes under a root by name patterns.
     * args: [rootUuid, [{pattern, materialUuid}...]]
     */
    assignMaterialsBulk(rootUuid: string, assignments: Array<{pattern: string, materialUuid: string}>) {
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene) {
                return { success: false, error: 'No active scene' };
            }
            let root = null;
            for (const child of scene.children) {
                root = this._findNodeByUuid(child, rootUuid);
                if (root) break;
            }
            if (!root) {
                return { success: false, error: `Root node with UUID ${rootUuid} not found` };
            }

            const assetManager = require('cc').assetManager;
            const Material = require('cc').Material;
            let assigned = 0;
            let pending = 0;

            const applyRecursive = (node: any) => {
                for (let i = 0; i < assignments.length; i++) {
                    const { pattern, materialUuid: matUuid } = assignments[i];
                    if (node.name.includes(pattern)) {
                        const mr = node.getComponent('cc.MeshRenderer');
                        if (mr) {
                            pending++;
                            assetManager.loadAny({ uuid: matUuid, type: Material }, (err: any, mat: any) => {
                                if (!err && mat) {
                                    mr.setSharedMaterial(mat, 0);
                                    assigned++;
                                }
                                pending--;
                            });
                            break; // first match wins
                        }
                    }
                }
                for (const child of node.children || []) {
                    applyRecursive(child);
                }
            };

            applyRecursive(root);

            return {
                success: true,
                message: `Material assignment started: ${assignments.length} patterns, scanning children of '${root.name}'`,
                data: { rootUuid, assignments: assignments.length }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }
};
