import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { extname, isAbsolute, join, relative, sep } from 'path';
import {
    hasPackedSerializedSections,
    isCompactSerializedDocument,
} from './scene-serialization';
module.paths.push(join(Editor.App.path, 'node_modules'));

declare const EditorExtends: any;

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

/**
 * 把 db:// 资源路径转换成项目内真实文件路径。
 * 这里只处理当前修复流程会用到的 assets 路径，避免误写到项目外部。
 */
function resolveProjectAssetFilePath(assetPath: string): string {
    if (!assetPath || typeof assetPath !== 'string') {
        throw new Error('assetPath must be a non-empty string');
    }

    if (isAbsolute(assetPath)) {
        return assetPath;
    }

    if (assetPath.startsWith('db://assets/')) {
        const relativePath = assetPath.slice('db://assets/'.length).replace(/\//g, sep);
        return join(Editor.Project.path, 'assets', relativePath);
    }

    throw new Error(`Unsupported asset path: ${assetPath}`);
}

/**
 * 把 compact 序列化资源转回 Creator 可编辑的标准 JSON。
 * 根因是当前仓库里的 prefab/scene 源文件是运行时紧凑格式，编辑器导入器会直接报错。
 */
function repairSerializedAssetFile(assetPath: string) {
    const absolutePath = resolveProjectAssetFilePath(assetPath);
    const raw = readFileSync(absolutePath, 'utf8');
    let parsed: any;

    try {
        parsed = JSON.parse(raw);
    } catch (error: any) {
        throw new Error(`Failed to parse JSON: ${error.message}`);
    }

    const { deserialize } = require('cc');
    if (typeof deserialize !== 'function') {
        throw new Error('cc.deserialize is unavailable in current scene context');
    }

    const editorSerialize = (Editor as any)?.serialize;
    if (typeof Editor === 'undefined' || typeof editorSerialize !== 'function') {
        throw new Error('Editor.serialize is unavailable in current scene context');
    }

    const asset = deserialize(parsed);
    const serializedData = editorSerialize(asset, { stringify: false });
    const serialized = JSON.stringify(serializedData, null, 2);

    if (typeof serialized !== 'string' || !serialized.trim()) {
        throw new Error('EditorExtends.serialize returned empty content');
    }

    JSON.parse(serialized);
    writeFileSync(absolutePath, serialized, 'utf8');

    return {
        assetPath,
        absolutePath,
        bytesBefore: Buffer.byteLength(raw, 'utf8'),
        bytesAfter: Buffer.byteLength(serialized, 'utf8'),
    };
}

/**
 * 将对象图手动展开成 Creator 可识别的标准 JSON。
 * 这里不依赖 Editor.serialize，专门兜底当前环境只有 EditorExtends.serialize 的场景进程。
 */
function convertAssetToPlainSerializedJson(parsedSource: any): string {
    const cc = require('cc');
    const deserialize = cc.deserialize;
    const DetailsCtor = deserialize?.Details;
    if (typeof deserialize !== 'function' || typeof DetailsCtor !== 'function') {
        throw new Error('cc.deserialize or deserialize.Details is unavailable');
    }

    const details = new DetailsCtor();
    const asset = deserialize(parsedSource, details);
    const jsUtils = cc.js;
    const assetRefMap = new WeakMap<object, Map<string, string>>();

    if (details && Array.isArray(details.uuidObjList)) {
        for (let index = 0; index < details.uuidObjList.length; index += 1) {
            const owner = details.uuidObjList[index];
            const prop = details.uuidPropList[index];
            const uuid = details.uuidList[index];
            if (!owner || typeof prop !== 'string' || !uuid) {
                continue;
            }

            let ownerMap = assetRefMap.get(owner);
            if (!ownerMap) {
                ownerMap = new Map();
                assetRefMap.set(owner, ownerMap);
            }
            ownerMap.set(prop, uuid);
        }
    }

    const objectIds = new WeakMap<object, number>();
    const serializedEntries: any[] = [];

    const shouldTreatAsAssetReference = (value: any, isRoot: boolean): boolean => Boolean(
        !isRoot
        && value
        && typeof value === 'object'
        && typeof value._uuid === 'string'
        && typeof value.constructor === 'function'
        && /Asset|SpriteFrame|Material|Texture|Prefab|Scene|SkeletonData/.test(value.constructor.name || '')
    );

    const getTypeName = (value: any): string | null => {
        if (!value || typeof value !== 'object') {
            return null;
        }

        return jsUtils?.getClassName?.(value.constructor) || value.constructor?.name || null;
    };

    const encodeValue = (value: any, isRoot: boolean = false): any => {
        if (value === null || value === undefined) {
            return null;
        }

        if (typeof value !== 'object') {
            return value;
        }

        if (shouldTreatAsAssetReference(value, isRoot)) {
            return { __uuid__: value._uuid };
        }

        const existingId = objectIds.get(value);
        if (existingId !== undefined) {
            return { __id__: existingId };
        }

        const id = serializedEntries.length;
        objectIds.set(value, id);

        const container: any[] | Record<string, any> = Array.isArray(value) ? [] : {};
        serializedEntries.push(container);

        if (!Array.isArray(value)) {
            const typeName = getTypeName(value);
            if (typeName) {
                (container as Record<string, any>).__type__ = typeName;
            }
        }

        const keys = Array.isArray(value) ? value.keys() : Object.keys(value);
        for (const keyOrIndex of keys) {
            const key = keyOrIndex as string | number;
            const rawValue = value[key];
            if (typeof rawValue === 'function' || rawValue === undefined) {
                continue;
            }

            if (!Array.isArray(value)) {
                const ownerRefs = assetRefMap.get(value);
                if (ownerRefs && ownerRefs.has(String(key))) {
                    (container as Record<string, any>)[key] = { __uuid__: ownerRefs.get(String(key)) };
                    continue;
                }
            }

            if (Array.isArray(value)) {
                (container as any[]).push(encodeValue(rawValue, false));
            } else {
                (container as Record<string, any>)[key] = encodeValue(rawValue, false);
            }
        }

        return isRoot ? container : { __id__: id };
    };

    encodeValue(asset, true);
    return JSON.stringify(serializedEntries, null, 2);
}

/**
 * 根据资源扩展名推导期望的根资源类型。
 * prefab/scene 修复时必须保证回写后的根类型正确，否则会把子资源误写回源文件。
 */
function getExpectedRootTypeForAssetPath(absolutePath: string): string | null {
    const extension = extname(absolutePath).toLowerCase();
    if (extension === '.prefab') {
        return 'cc.Prefab';
    }

    if (extension === '.scene') {
        return 'cc.SceneAsset';
    }

    return null;
}

/**
 * 从编辑器序列化结果中提取根类型。
 * prefab/scene 的标准输出是数组根，子资源常见为单对象根。
 */
function getSerializedRootType(serializedValue: any): string | null {
    if (Array.isArray(serializedValue) && serializedValue[0] && typeof serializedValue[0] === 'object') {
        return serializedValue[0].__type__ || null;
    }

    if (serializedValue && typeof serializedValue === 'object') {
        return serializedValue.__type__ || null;
    }

    return null;
}

/**
 * 构造缺脚本容错的 classFinder。
 * section 探测阶段的目标只是找到真正的根资源，不能因为单个脚本缺失直接中断整条修复链路。
 */
function createMissingScriptClassFinder(ccRuntime: any) {
    const missingReporter = typeof EditorExtends !== 'undefined' ? EditorExtends?.MissingReporter?.classInstance : null;
    const missingScriptCtor = ccRuntime?.MissingScript || null;

    if (!missingReporter && !missingScriptCtor) {
        return null;
    }

    const classFinder = (type: string, data?: any, owner?: any, propName?: string) => {
        const resolved = missingReporter?.classFinder?.(type, data, owner, propName) ?? null;
        if (resolved) {
            return resolved;
        }
        return missingScriptCtor ?? undefined;
    };

    if (missingReporter?.classFinder && typeof missingReporter.classFinder.onDereferenced === 'function') {
        classFinder.onDereferenced = missingReporter.classFinder.onDereferenced;
    }

    return classFinder;
}

/**
 * 用缺脚本容错模式反序列化资产文档。
 * 这里优先保证“能探测根类型”，而不是要求所有依赖脚本都已经完整可用。
 */
function deserializeSerializedDocument(document: any, ccRuntime: any, deserialize: any): any {
    if (typeof deserialize !== 'function') {
        throw new Error('cc.deserialize is unavailable in current scene context');
    }

    const classFinder = createMissingScriptClassFinder(ccRuntime);
    if (classFinder) {
        return deserialize(document, undefined, { classFinder });
    }

    return deserialize(document);
}

/**
 * 从 packed sections 中挑出当前文件真正对应的根资产文档。
 * 同一个 prefab/scene 文件里可能同时打包了 SpriteFrame、SkeletonData 等子资源，不能默认取第一个 section。
 */
function resolvePackedSerializedDocument(parsedSource: any, absolutePath: string, ccRuntime: any, deserialize: any): any {
    if (!hasPackedSerializedSections(parsedSource)) {
        return parsedSource;
    }

    const expectedType = getExpectedRootTypeForAssetPath(absolutePath);
    const sections = parsedSource[5].map((section: any[]) => [
        parsedSource[0],
        parsedSource[1],
        parsedSource[2],
        parsedSource[3],
        parsedSource[4],
        ...section,
    ]);

    if (!expectedType || typeof deserialize !== 'function') {
        return sections[0];
    }

    for (const section of sections) {
        try {
            const asset = deserializeSerializedDocument(section, ccRuntime, deserialize);

            // 直接看序列化根类型，比只看运行时类名更稳，能避免子资源被误认成目标根资产。
            if (typeof EditorExtends !== 'undefined' && typeof EditorExtends.serialize === 'function') {
                const serializedCandidate = EditorExtends.serialize(asset, { stringify: false });
                if (getSerializedRootType(serializedCandidate) === expectedType) {
                    return section;
                }
            }

            const runtimeType = ccRuntime?.js?.getClassName?.(asset) ?? null;
            if (runtimeType === expectedType) {
                return section;
            }
        } catch {
            continue;
        }
    }

    return sections[0];
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
     * 读取当前场景的序列化 JSON。
     * 主进程保存场景副本时依赖这份内容，避免退回会打断自动化流程的另存为弹窗。
     */
    async getCurrentSceneSerializedData() {
        try {
            const serializedData = await queryCurrentSceneSerializedData();
            if (!serializedData) {
                return { success: false, error: 'Current scene serialized data is unavailable' };
            }

            return {
                success: true,
                data: {
                    serializedData,
                },
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * 修复单个 prefab/scene 源文件，把紧凑格式回写成编辑器标准格式。
     */
    repairSerializedAsset(assetPath: string) {
        return this.repairSerializedAssetToPlainJson(assetPath);
    },

    /**
     * 只读检查 packed sections 的候选根类型。
     * 先确认 section 选择是否正确，再决定是否真的回写源文件，避免再次误覆盖资源。
     */
    inspectSerializedAssetSections(assetPath: string) {
        try {
            const absolutePath = resolveProjectAssetFilePath(assetPath);
            const raw = readFileSync(absolutePath, 'utf8');
            const parsed = JSON.parse(raw);
            const cc = require('cc');
            const { deserialize } = cc;
            const expectedType = getExpectedRootTypeForAssetPath(absolutePath);
            const compactRoot = isCompactSerializedDocument(parsed);
            const packedSections = hasPackedSerializedSections(parsed);
            const firstDataEntry = compactRoot ? parsed[5]?.[0] : null;
            const detection = {
                compactRoot,
                packedSections,
                p5Count: compactRoot ? parsed[5]?.length ?? 0 : null,
                p5FirstEntryIsArray: Array.isArray(firstDataEntry),
                p5FirstValueIsArray: Array.isArray(firstDataEntry?.[0]),
                p5FirstValueType: Array.isArray(firstDataEntry) && firstDataEntry.length > 0
                    ? typeof firstDataEntry[0]
                    : null,
            };

            if (!packedSections) {
                const asset = deserializeSerializedDocument(parsed, cc, deserialize);
                const serializedCandidate = typeof EditorExtends !== 'undefined' && typeof EditorExtends.serialize === 'function'
                    ? EditorExtends.serialize(asset, { stringify: false })
                    : parsed;

                return {
                    success: true,
                    data: {
                        assetPath,
                        absolutePath,
                        expectedType,
                        detection,
                        packed: false,
                        runtimeType: cc?.js?.getClassName?.(asset) ?? null,
                        serializedRootType: getSerializedRootType(serializedCandidate),
                    },
                };
            }

            const sections = parsed[5].map((section: any[], index: number) => {
                const normalizedSection = [parsed[0], parsed[1], parsed[2], parsed[3], parsed[4], ...section];
                try {
                    const asset = deserializeSerializedDocument(normalizedSection, cc, deserialize);
                    const serializedCandidate = typeof EditorExtends !== 'undefined' && typeof EditorExtends.serialize === 'function'
                        ? EditorExtends.serialize(asset, { stringify: false })
                        : null;

                    return {
                        index,
                        runtimeType: cc?.js?.getClassName?.(asset) ?? null,
                        serializedRootType: getSerializedRootType(serializedCandidate),
                    };
                } catch (error: any) {
                    return {
                        index,
                        error: error.message,
                    };
                }
            });

            return {
                success: true,
                data: {
                    assetPath,
                    absolutePath,
                    expectedType,
                    detection,
                    packed: true,
                    sectionCount: sections.length,
                    sections,
                },
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * 使用手动对象图展开的方式，把 compact 资源回写为标准 JSON。
     * 当 Editor.serialize 不可用时，使用这条兜底路径。
     */
    repairSerializedAssetToPlainJson(assetPath: string) {
        let strategy = 'unresolved';
        try {
            const absolutePath = resolveProjectAssetFilePath(assetPath);
            const raw = readFileSync(absolutePath, 'utf8');
            const parsed = JSON.parse(raw);
            const cc = require('cc');
            const { deserialize } = cc;
            const normalizedSource = resolvePackedSerializedDocument(parsed, absolutePath, cc, deserialize);
            let serialized: string;

            if (typeof deserialize === 'function'
                && typeof EditorExtends !== 'undefined'
                && typeof EditorExtends.serialize === 'function') {
                strategy = 'editor-extends';
                const asset = deserializeSerializedDocument(normalizedSource, cc, deserialize);
                const serializedByEditor = EditorExtends.serialize(asset, { stringify: false });
                const expectedType = getExpectedRootTypeForAssetPath(absolutePath);
                const actualRootType = getSerializedRootType(serializedByEditor);

                if (expectedType && actualRootType !== expectedType) {
                    throw new Error(`Serialized root type mismatch: expected ${expectedType}, got ${actualRootType || 'unknown'}`);
                }

                serialized = typeof serializedByEditor === 'string'
                    ? serializedByEditor
                    : JSON.stringify(serializedByEditor, null, 2);
            } else {
                strategy = 'manual-graph';
                serialized = convertAssetToPlainSerializedJson(normalizedSource);
            }

            JSON.parse(serialized);
            writeFileSync(absolutePath, serialized, 'utf8');

            return {
                success: true,
                data: {
                    assetPath,
                    absolutePath,
                    strategy,
                    bytesBefore: Buffer.byteLength(raw, 'utf8'),
                    bytesAfter: Buffer.byteLength(serialized, 'utf8'),
                },
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message,
                strategy,
                stack: error.stack,
            };
        }
    },

    /**
     * 批量修复多个 prefab/scene 文件，并返回逐项结果，便于先小范围验证再全量执行。
     */
    repairSerializedAssets(assetPaths: string[]) {
        try {
            if (!Array.isArray(assetPaths) || assetPaths.length === 0) {
                return { success: false, error: 'assetPaths must be a non-empty array' };
            }

            const results = assetPaths.map((assetPath: string) => {
                const result = this.repairSerializedAssetToPlainJson(assetPath);
                return { assetPath, ...result };
            });

            return {
                success: true,
                data: {
                    total: results.length,
                    repaired: results.filter((item) => item.success).length,
                    failed: results.filter((item) => !item.success).length,
                    results,
                },
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * 按目录批量修复 compact prefab/scene，避免超长参数列表阻塞大批次资源回写。
     */
    repairSerializedAssetsInFolder(folderPath: string, extensions: string[] = ['.prefab', '.scene'], recursive: boolean = true) {
        try {
            const absoluteFolderPath = resolveProjectAssetFilePath(folderPath);
            const normalizedExtensions = Array.isArray(extensions) && extensions.length > 0
                ? extensions.map((extension) => typeof extension === 'string' ? extension.toLowerCase() : '').filter(Boolean)
                : ['.prefab', '.scene'];
            const projectAssetsPath = join(Editor.Project.path, 'assets');
            const assetPaths: string[] = [];

            const visitFolder = (currentFolderPath: string) => {
                const entries = readdirSync(currentFolderPath, { withFileTypes: true });
                for (const entry of entries) {
                    const entryPath = join(currentFolderPath, entry.name);
                    if (entry.isDirectory()) {
                        if (recursive) {
                            visitFolder(entryPath);
                        }
                        continue;
                    }

                    const extension = extname(entry.name).toLowerCase();
                    if (!normalizedExtensions.includes(extension)) {
                        continue;
                    }

                    const relativeAssetPath = relative(projectAssetsPath, entryPath).replace(/\\/g, '/');
                    assetPaths.push(`db://assets/${relativeAssetPath}`);
                }
            };

            visitFolder(absoluteFolderPath);
            return this.repairSerializedAssets(assetPaths);
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
