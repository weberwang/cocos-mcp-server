import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

import * as AssetDB from '../asset-db-wrapper';
import { ToolDefinition, ToolExecutor, ToolResponse } from '../types';

/**
 * 保存场景时用于判断是否需要退回“另存为”的依赖接口。
 */
export interface SaveAsFallbackDeps {
    getCurrentSceneUuid: () => Promise<string | null>;
    getSceneAssetUrl: (uuid: string) => Promise<string | null>;
    ensureSceneAssetExists: (url: string) => Promise<void>;
}

export type CaptureScreenshotMode = 'editor' | 'scene-view' | 'game-view';

/**
 * 截图工具入参。
 */
export interface CaptureScreenshotOptions {
    mode?: CaptureScreenshotMode;
    outputPath?: string;
    format?: 'png';
}

/**
 * 统一归一化后的截图参数。
 */
export interface ResolvedCaptureScreenshotOptions {
    mode: CaptureScreenshotMode;
    outputPath: string;
    format: 'png';
}

/**
 * 从编辑器 DOM 中抽取出来的可截图区域候选。
 */
export interface ScreenshotSurfaceCandidate {
    tagName: string;
    id: string;
    className: string;
    x: number;
    y: number;
    width: number;
    height: number;
    hintText?: string;
}

/**
 * 窗口或内容区域边界。
 */
export interface DesktopCaptureBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * 原生图像尺寸。
 */
export interface DesktopCaptureSize {
    width: number;
    height: number;
}

/**
 * 传给 NativeImage.crop 的矩形区域。
 */
export interface DesktopCaptureCropRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Scene 视图编辑相机的最小信息，用来把 Cocos 世界坐标换算成 Scene 画布像素坐标。
 */
export interface SceneViewEditorCameraInfo {
    viewCenter: {
        x: number;
        y: number;
        z?: number;
    };
    contentRect: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    scale: number;
}

/**
 * Cocos Canvas 节点在世界坐标系下的矩形包围盒。
 */
export interface SceneViewCanvasWorldRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Scene 视图截图的最终裁切矩形。
 */
export interface SceneViewCanvasCropRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Scene 视图截图的调试信息，便于验证是否真的裁到了 Canvas 节点本体。
 */
export interface SceneViewCaptureInfo {
    strategy: 'canvas-node-crop' | 'full-canvas' | 'region-crop';
    cropApplied: boolean;
    cropRect?: SceneViewCanvasCropRect;
    candidateTagName?: string;
    candidateId?: string;
}

/**
 * 最小化的桌面采集源结构，方便在测试里做纯数据断言。
 */
export interface DesktopCaptureSourceLike {
    id: string;
    thumbnail?: {
        isEmpty?: () => boolean;
    };
}

/**
 * 场景脚本回传的原始像素结果。
 */
export interface RawPixelCaptureResult {
    width: number;
    height: number;
    pixelsBase64: string;
    flipY?: boolean;
    cameraName?: string;
}

/**
 * 判断原始像素结果是否包含有效内容，避免把全零黑图当成成功截图。
 */
export function hasMeaningfulRawPixelData(captureResult: RawPixelCaptureResult): boolean {
    if (
        !captureResult ||
        captureResult.width <= 0 ||
        captureResult.height <= 0 ||
        typeof captureResult.pixelsBase64 !== 'string' ||
        !captureResult.pixelsBase64
    ) {
        return false;
    }

    const pixelBuffer = Buffer.from(captureResult.pixelsBase64, 'base64');
    if (pixelBuffer.length === 0) {
        return false;
    }

    for (const byte of pixelBuffer) {
        if (byte !== 0) {
            return true;
        }
    }

    return false;
}

/**
 * PNG 文件签名。
 */
const PNG_SIGNATURE = Buffer.from([
    0x89, 0x50, 0x4e, 0x47,
    0x0d, 0x0a, 0x1a, 0x0a
]);

/**
 * CRC32 查表缓存，避免重复计算。
 */
let _crc32Table: Uint32Array | null = null;

/**
 * 用于在多个编辑器窗口之间选择 Scene 截图目标的摘要信息。
 */
export interface SceneViewWindowCandidate {
    windowId: number;
    isFocused: boolean;
    candidates: ScreenshotSurfaceCandidate[];
    selectedCandidate?: ScreenshotSurfaceCandidate | null;
    targetWindow?: any;
}

/**
 * 判断场景原文件缺失时是否应该退回另存为。
 */
export async function shouldFallbackToSaveAsWhenOriginalSceneMissing(
    deps: SaveAsFallbackDeps
): Promise<boolean> {
    const sceneUuid = await deps.getCurrentSceneUuid();
    if (!sceneUuid) {
        return false;
    }

    const sceneAssetUrl = await deps.getSceneAssetUrl(sceneUuid);
    if (!sceneAssetUrl) {
        return true;
    }

    try {
        await deps.ensureSceneAssetExists(sceneAssetUrl);
        return false;
    } catch (error: any) {
        return typeof error?.message === 'string' && error.message.includes('Asset not found');
    }
}

/**
 * 统一整理截图参数，确保未显式传路径时也能稳定落盘。
 */
export function resolveCaptureScreenshotOptions(
    options: CaptureScreenshotOptions = {},
    tempRoot: string = os.tmpdir()
): ResolvedCaptureScreenshotOptions {
    const mode = options.mode ?? 'editor';
    const format = options.format ?? 'png';
    const outputPath = options.outputPath
        ? path.resolve(options.outputPath)
        : path.join(tempRoot, `cocos-editor-shot-${Date.now()}.${format}`);

    return {
        mode,
        outputPath,
        format
    };
}

/**
 * 为 scene-view 模式挑选最可信的画布候选。
 * 优先 scene / viewport 语义节点，其次回退到面积最大的 canvas。
 */
export function pickScreenshotSurfaceCandidate(
    candidates: ScreenshotSurfaceCandidate[],
    mode: CaptureScreenshotMode
): ScreenshotSurfaceCandidate | null {
    if (!Array.isArray(candidates) || candidates.length === 0) {
        return null;
    }

    const scoredCandidates = candidates
        .filter((candidate) => candidate.width > 0 && candidate.height > 0)
        .map((candidate) => {
            const hintText = `${candidate.tagName} ${candidate.id} ${candidate.className} ${candidate.hintText ?? ''}`.toLowerCase();
            let score = candidate.width * candidate.height;

            if (candidate.tagName === 'canvas') {
                score += 500_000;
            }

            if (mode === 'scene-view') {
                if (candidate.tagName === 'canvas') {
                    // Scene 视图需要尽量贴近真实绘制画布，优先级应高于包裹它的大容器。
                    score += 20_000_000;
                }
                if (hintText.includes('scene')) {
                    score += 10_000_000;
                }
                if (hintText.includes('viewport')) {
                    score += 4_000_000;
                }
                if (hintText.includes('game')) {
                    score -= 1_000_000;
                }
            }

            return {
                candidate,
                score
            };
        })
        .sort((left, right) => right.score - left.score);

    return scoredCandidates[0]?.candidate ?? null;
}

/**
 * 将内容区内的 DOM 坐标换算成桌面窗口缩略图上的裁切坐标。
 * 这里显式考虑标题栏和窗口边框偏移，避免裁切结果错位。
 */
export function resolveDesktopCaptureCropRect(options: {
    candidate: ScreenshotSurfaceCandidate;
    windowBounds: DesktopCaptureBounds;
    contentBounds: DesktopCaptureBounds;
    sourceSize: DesktopCaptureSize;
}): DesktopCaptureCropRect {
    const { candidate, windowBounds, contentBounds, sourceSize } = options;
    const contentOffsetX = contentBounds.x - windowBounds.x;
    const contentOffsetY = contentBounds.y - windowBounds.y;
    const scaleX = sourceSize.width / Math.max(windowBounds.width, 1);
    const scaleY = sourceSize.height / Math.max(windowBounds.height, 1);

    const x = Math.max(0, Math.round((contentOffsetX + candidate.x) * scaleX));
    const y = Math.max(0, Math.round((contentOffsetY + candidate.y) * scaleY));
    const width = Math.max(1, Math.round(candidate.width * scaleX));
    const height = Math.max(1, Math.round(candidate.height * scaleY));

    return {
        x,
        y,
        width: Math.min(width, Math.max(sourceSize.width - x, 1)),
        height: Math.min(height, Math.max(sourceSize.height - y, 1))
    };
}

/**
 * 根据 Scene 编辑相机信息，把 Canvas 节点世界矩形换算成 scene canvas 内的像素裁切区域。
 * 这里按 2D 正交视图的中心点与缩放关系计算，优先服务当前项目的 Scene 视图精准截图。
 */
export function calculateSceneViewCanvasCropRect(options: {
    worldRect: SceneViewCanvasWorldRect;
    cameraInfo: SceneViewEditorCameraInfo;
    canvasWidth: number;
    canvasHeight: number;
}): SceneViewCanvasCropRect | null {
    const { worldRect, cameraInfo, canvasWidth, canvasHeight } = options;
    if (
        !worldRect ||
        !cameraInfo ||
        !Number.isFinite(worldRect.x) ||
        !Number.isFinite(worldRect.y) ||
        !Number.isFinite(worldRect.width) ||
        !Number.isFinite(worldRect.height) ||
        !Number.isFinite(cameraInfo.scale) ||
        !Number.isFinite(cameraInfo.contentRect?.x) ||
        !Number.isFinite(cameraInfo.contentRect?.y) ||
        !Number.isFinite(cameraInfo.contentRect?.width) ||
        !Number.isFinite(cameraInfo.contentRect?.height) ||
        !Number.isFinite(cameraInfo.viewCenter?.x) ||
        !Number.isFinite(cameraInfo.viewCenter?.y) ||
        canvasWidth <= 0 ||
        canvasHeight <= 0
    ) {
        return null;
    }

    const centerX = cameraInfo.contentRect.x + cameraInfo.contentRect.width / 2;
    const centerY = cameraInfo.contentRect.y + cameraInfo.contentRect.height / 2;
    const left = centerX + (worldRect.x - cameraInfo.viewCenter.x) * cameraInfo.scale;
    const right = centerX + (worldRect.x + worldRect.width - cameraInfo.viewCenter.x) * cameraInfo.scale;
    const bottom = centerY + (worldRect.y - cameraInfo.viewCenter.y) * cameraInfo.scale;
    const top = centerY + (worldRect.y + worldRect.height - cameraInfo.viewCenter.y) * cameraInfo.scale;

    const normalizedLeft = Math.min(left, right);
    const normalizedRight = Math.max(left, right);
    const normalizedBottom = Math.min(bottom, top);
    const normalizedTop = Math.max(bottom, top);

    const x = Math.max(0, Math.floor(normalizedLeft));
    const y = Math.max(0, Math.floor(canvasHeight - normalizedTop));
    const width = Math.min(
        Math.max(1, Math.ceil(normalizedRight - normalizedLeft)),
        Math.max(canvasWidth - x, 1)
    );
    const height = Math.min(
        Math.max(1, Math.ceil(normalizedTop - normalizedBottom)),
        Math.max(canvasHeight - y, 1)
    );

    if (width <= 1 || height <= 1) {
        return null;
    }

    return { x, y, width, height };
}

/**
 * 基于 scene canvas 像素内容自动裁切主要前景区域。
 * 设计目标是剔除顶部工具条、细坐标轴与大面积网格背景，尽量保留 Canvas 主体画面。
 */
export function detectSceneViewForegroundCropRect(options: {
    pixelBuffer: Buffer;
    width: number;
    height: number;
    ignoreTopPx?: number;
}): SceneViewCanvasCropRect | null {
    const { pixelBuffer, width, height } = options;
    const ignoreTopPx = Math.max(0, options.ignoreTopPx ?? 0);
    if (!Buffer.isBuffer(pixelBuffer) || width <= 0 || height <= 0 || pixelBuffer.length < width * height * 4) {
        return null;
    }

    const buildGrayHistogram = (): number[] => {
        const histogram = new Array<number>(256).fill(0);
        for (let y = ignoreTopPx; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const offset = (y * width + x) * 4;
                const blue = pixelBuffer[offset];
                const green = pixelBuffer[offset + 1];
                const red = pixelBuffer[offset + 2];
                const gray = Math.round((red * 299 + green * 587 + blue * 114) / 1000);
                histogram[gray] += 1;
            }
        }
        return histogram;
    };

    const histogram = buildGrayHistogram();
    let backgroundGray = 0;
    let backgroundCount = -1;
    for (let gray = 0; gray < histogram.length; gray += 1) {
        if (histogram[gray] > backgroundCount) {
            backgroundGray = gray;
            backgroundCount = histogram[gray];
        }
    }

    const tolerance = 18;
    const rowCounts = new Array<number>(height).fill(0);
    const colCounts = new Array<number>(width).fill(0);

    for (let y = ignoreTopPx; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const offset = (y * width + x) * 4;
            const blue = pixelBuffer[offset];
            const green = pixelBuffer[offset + 1];
            const red = pixelBuffer[offset + 2];
            const gray = Math.round((red * 299 + green * 587 + blue * 114) / 1000);
            const colorSpread = Math.max(red, green, blue) - Math.min(red, green, blue);
            const isForeground = Math.abs(gray - backgroundGray) > tolerance || colorSpread > 24;
            if (isForeground) {
                rowCounts[y] += 1;
                colCounts[x] += 1;
            }
        }
    }

    const minRowForeground = Math.max(4, Math.round(width * 0.08));
    const minColForeground = Math.max(4, Math.round(height * 0.08));

    const pickLargestContinuousRange = (counts: number[], minCount: number, startIndex: number = 0) => {
        let bestStart = -1;
        let bestEnd = -1;
        let currentStart = -1;

        for (let index = startIndex; index < counts.length; index += 1) {
            if (counts[index] >= minCount) {
                if (currentStart < 0) {
                    currentStart = index;
                }
            } else if (currentStart >= 0) {
                if (bestStart < 0 || index - currentStart > bestEnd - bestStart + 1) {
                    bestStart = currentStart;
                    bestEnd = index - 1;
                }
                currentStart = -1;
            }
        }

        if (currentStart >= 0 && (bestStart < 0 || counts.length - currentStart > bestEnd - bestStart + 1)) {
            bestStart = currentStart;
            bestEnd = counts.length - 1;
        }

        return bestStart >= 0 && bestEnd >= bestStart
            ? { start: bestStart, end: bestEnd }
            : null;
    };

    const rowRange = pickLargestContinuousRange(rowCounts, minRowForeground, ignoreTopPx);
    const colRange = pickLargestContinuousRange(colCounts, minColForeground, 0);

    const top = rowRange?.start ?? -1;
    const bottom = rowRange?.end ?? -1;
    const left = colRange?.start ?? -1;
    const right = colRange?.end ?? -1;

    if (top < 0 || bottom < top || left < 0 || right < left) {
        return null;
    }

    return {
        x: left,
        y: top,
        width: right - left + 1,
        height: bottom - top + 1,
    };
}

/**
 * 归一化 Electron 的窗口源 id，忽略 webContents 后缀差异。
 * 例如 `window:330806:1` 与 `window:330806:0` 会被视为同一顶层窗口。
 */
function normalizeDesktopCaptureWindowId(mediaSourceId: string): string {
    return String(mediaSourceId).split(':').slice(0, 2).join(':');
}

/**
 * 在桌面采集结果里定位与当前编辑器窗口最匹配的源。
 * 先走精确匹配，再退回到相同顶层窗口句柄匹配。
 */
export function findDesktopCaptureSource<T extends DesktopCaptureSourceLike>(
    sources: T[],
    mediaSourceId: string
): T | null {
    if (!Array.isArray(sources) || sources.length === 0) {
        return null;
    }

    const exactSource = sources.find((source) => source?.id === mediaSourceId);
    if (exactSource && !exactSource.thumbnail?.isEmpty?.()) {
        return exactSource;
    }

    const normalizedWindowId = normalizeDesktopCaptureWindowId(mediaSourceId);
    const siblingSources = sources.filter(
        (source) => normalizeDesktopCaptureWindowId(source?.id ?? '') === normalizedWindowId
    );
    const nonEmptySibling = siblingSources.find((source) => !source.thumbnail?.isEmpty?.());

    return nonEmptySibling ?? siblingSources[0] ?? exactSource ?? null;
}

/**
 * 将 canvas 导出的 PNG data URL 解码为 Buffer，便于统一走文件落盘流程。
 */
export function decodePngDataUrl(dataUrl: string): Buffer {
    const normalized = String(dataUrl || '').trim();
    const prefix = 'data:image/png;base64,';
    if (!normalized.startsWith(prefix)) {
        throw new Error('Scene view capture did not return a PNG data url');
    }

    return Buffer.from(normalized.slice(prefix.length), 'base64');
}

/**
 * 将场景脚本返回的原始 RGBA 像素编码为 PNG。
 * 默认会做一次垂直翻转，因为 readPixels 常见返回是自底向上的。
 */
export async function encodeRawRgbaToPng(captureResult: RawPixelCaptureResult): Promise<Buffer> {
    const pixelBuffer = Buffer.from(captureResult.pixelsBase64, 'base64');
    const normalizedPixels = captureResult.flipY === false
        ? pixelBuffer
        : flipRgbaRows(pixelBuffer, captureResult.width, captureResult.height);
    const scanlines = buildPngScanlines(normalizedPixels, captureResult.width, captureResult.height);
    const compressedScanlines = zlib.deflateSync(scanlines);
    const ihdrPayload = Buffer.alloc(13);

    ihdrPayload.writeUInt32BE(captureResult.width, 0);
    ihdrPayload.writeUInt32BE(captureResult.height, 4);
    ihdrPayload[8] = 8; // bit depth
    ihdrPayload[9] = 6; // RGBA
    ihdrPayload[10] = 0; // compression
    ihdrPayload[11] = 0; // filter
    ihdrPayload[12] = 0; // interlace

    return Buffer.concat([
        PNG_SIGNATURE,
        buildPngChunk('IHDR', ihdrPayload),
        buildPngChunk('IDAT', compressedScanlines),
        buildPngChunk('IEND', Buffer.alloc(0))
    ]);
}

/**
 * 按行翻转 RGBA 像素，修正 readPixels 常见的倒置结果。
 */
function flipRgbaRows(pixelBuffer: Buffer, width: number, height: number): Buffer {
    const rowStride = width * 4;
    const flippedBuffer = Buffer.alloc(pixelBuffer.length);

    for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
        const sourceOffset = rowIndex * rowStride;
        const targetOffset = (height - rowIndex - 1) * rowStride;
        pixelBuffer.copy(flippedBuffer, targetOffset, sourceOffset, sourceOffset + rowStride);
    }

    return flippedBuffer;
}

/**
 * 按 PNG 规范构造 scanline 数据，每行前置一个 filter byte。
 */
function buildPngScanlines(pixelBuffer: Buffer, width: number, height: number): Buffer {
    const rowStride = width * 4;
    const scanlineBuffer = Buffer.alloc(height * (rowStride + 1));

    for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
        const sourceOffset = rowIndex * rowStride;
        const targetOffset = rowIndex * (rowStride + 1);
        scanlineBuffer[targetOffset] = 0; // filter type 0
        pixelBuffer.copy(
            scanlineBuffer,
            targetOffset + 1,
            sourceOffset,
            sourceOffset + rowStride
        );
    }

    return scanlineBuffer;
}

/**
 * 构造单个 PNG chunk。
 */
function buildPngChunk(chunkType: string, payload: Buffer): Buffer {
    const typeBuffer = Buffer.from(chunkType, 'ascii');
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(payload.length, 0);

    const crcBuffer = Buffer.alloc(4);
    crcBuffer.writeUInt32BE(calculateCrc32(Buffer.concat([typeBuffer, payload])), 0);

    return Buffer.concat([lengthBuffer, typeBuffer, payload, crcBuffer]);
}

/**
 * 生成 CRC32 查表。
 */
function getCrc32Table(): Uint32Array {
    if (_crc32Table) {
        return _crc32Table;
    }

    const table = new Uint32Array(256);
    for (let tableIndex = 0; tableIndex < 256; tableIndex += 1) {
        let crc = tableIndex;
        for (let bitIndex = 0; bitIndex < 8; bitIndex += 1) {
            crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
        }
        table[tableIndex] = crc >>> 0;
    }

    _crc32Table = table;
    return table;
}

/**
 * 计算 PNG chunk 所需的 CRC32。
 */
function calculateCrc32(buffer: Buffer): number {
    const table = getCrc32Table();
    let crc = 0xffffffff;

    for (const byte of buffer) {
        crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }

    return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 在多个 BrowserWindow 摘要中选择最可能包含 Scene 画布的那个。
 * 只要某个窗口能挑出 scene-view 候选，就优先它，而不是盲目信任当前焦点窗口。
 */
export function pickSceneViewWindowCandidate(
    windowCandidates: SceneViewWindowCandidate[]
): SceneViewWindowCandidate | null {
    if (!Array.isArray(windowCandidates) || windowCandidates.length === 0) {
        return null;
    }

    const enrichedCandidates = windowCandidates
        .map((entry) => ({
            ...entry,
            selectedCandidate: entry.selectedCandidate ?? pickScreenshotSurfaceCandidate(entry.candidates, 'scene-view')
        }))
        .filter((entry) => entry.selectedCandidate);

    enrichedCandidates.sort((left, right) => {
        const leftArea = (left.selectedCandidate?.width ?? 0) * (left.selectedCandidate?.height ?? 0);
        const rightArea = (right.selectedCandidate?.width ?? 0) * (right.selectedCandidate?.height ?? 0);
        if (rightArea !== leftArea) {
            return rightArea - leftArea;
        }
        if (left.isFocused !== right.isFocused) {
            return left.isFocused ? -1 : 1;
        }
        return left.windowId - right.windowId;
    });

    return enrichedCandidates[0] ?? null;
}

/**
 * 编辑器级工具，负责菜单、撤销、保存与截图等宿主能力。
 */
export class EditorTools implements ToolExecutor {
    /**
     * 返回 editor 分类下的 MCP 工具定义。
     */
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'get_state',
                description: 'Get current editor state: play mode, pause mode, and active scene path',
                inputSchema: { type: 'object', properties: {} }
            },
            {
                name: 'execute_menu_command',
                description: 'Execute an allowlisted Creator menu command by path',
                inputSchema: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Menu path, e.g. File/Save Scene' }
                    },
                    required: ['path']
                }
            },
            {
                name: 'undo',
                description: 'Undo the last editor operation',
                inputSchema: { type: 'object', properties: {} }
            },
            {
                name: 'redo',
                description: 'Redo the last undone editor operation',
                inputSchema: { type: 'object', properties: {} }
            },
            {
                name: 'save_scene',
                description: 'Save the currently open scene',
                inputSchema: { type: 'object', properties: {} }
            },
            {
                name: 'capture_screenshot',
                description: 'Capture the current Cocos Creator editor window, scene-view canvas, or exact runtime game canvas to a PNG file',
                inputSchema: {
                    type: 'object',
                    properties: {
                        mode: {
                            type: 'string',
                            description: 'Capture target mode',
                            enum: ['editor', 'scene-view', 'game-view'],
                            default: 'editor'
                        },
                        outputPath: {
                            type: 'string',
                            description: 'Optional output path for the PNG file'
                        },
                        format: {
                            type: 'string',
                            description: 'Output image format',
                            enum: ['png'],
                            default: 'png'
                        }
                    }
                }
            }
        ];
    }

    /**
     * 分发 editor 工具调用。
     */
    async execute(toolName: string, args: any): Promise<ToolResponse> {
        switch (toolName) {
            case 'get_state':
                return this.getState();
            case 'execute_menu_command':
                return this.executeMenuCommand(args.path);
            case 'undo':
                return this.undo();
            case 'redo':
                return this.redo();
            case 'save_scene':
                return this.saveScene();
            case 'capture_screenshot':
                return this.captureScreenshot(args);
            default:
                throw new Error(`Unknown editor tool: ${toolName}`);
        }
    }

    /**
     * 获取当前编辑器状态摘要。
     */
    private async getState(): Promise<ToolResponse> {
        try {
            const tree: any = await Editor.Message.request('scene', 'query-node-tree');
            const sceneName = tree?.name || 'Unknown';
            const projectPath = Editor.Project?.path || '';

            return {
                success: true,
                data: {
                    sceneName,
                    sceneUuid: tree?.uuid || '',
                    projectPath,
                    nodeCount: tree?.children?.length || 0,
                    message: `Current scene: ${sceneName}`
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }

    /**
     * 执行编辑器菜单命令。
     */
    private async executeMenuCommand(menuPath: string): Promise<ToolResponse> {
        try {
            await (Editor.Message.request as any)('editor', 'send-to-main-menu', menuPath);
            return { success: true, message: `Menu command executed: ${menuPath}` };
        } catch {
            try {
                (Editor.Menu as any).sendToMain(menuPath);
                return { success: true, message: `Menu command executed (fallback): ${menuPath}` };
            } catch (error: any) {
                return { success: false, error: `Failed to execute menu command: ${error.message}` };
            }
        }
    }

    /**
     * 撤销上一步操作。
     */
    private async undo(): Promise<ToolResponse> {
        try {
            await Editor.Message.request('editor', 'undo');
            return { success: true, message: 'Undo executed' };
        } catch {
            try {
                (Editor as any).Undo.undo();
                return { success: true, message: 'Undo executed (fallback)' };
            } catch (error: any) {
                return { success: false, error: error.message };
            }
        }
    }

    /**
     * 重做上一步操作。
     */
    private async redo(): Promise<ToolResponse> {
        try {
            await Editor.Message.request('editor', 'redo');
            return { success: true, message: 'Redo executed' };
        } catch {
            try {
                (Editor as any).Undo.redo();
                return { success: true, message: 'Redo executed (fallback)' };
            } catch (error: any) {
                return { success: false, error: error.message };
            }
        }
    }

    /**
     * 保存当前场景；如果原始资源缺失，则退回“另存为”。
     */
    private async saveScene(): Promise<ToolResponse> {
        try {
            await Editor.Message.request('scene', 'save-scene');
            return { success: true, message: 'Scene saved' };
        } catch (error: any) {
            const shouldFallbackToSaveAs = await shouldFallbackToSaveAsWhenOriginalSceneMissing({
                getCurrentSceneUuid: async () => this.getCurrentSceneUuid(),
                getSceneAssetUrl: async (uuid: string) => AssetDB.queryUrl(uuid),
                ensureSceneAssetExists: async (url: string) => {
                    await AssetDB.queryAssetInfo(url);
                }
            });

            if (!shouldFallbackToSaveAs) {
                return { success: false, error: error.message };
            }

            try {
                await (Editor.Message.request as any)('scene', 'save-as-scene');
                return {
                    success: true,
                    message: 'Scene save dialog opened because the original scene asset is missing'
                };
            } catch (saveAsError: any) {
                return { success: false, error: saveAsError.message };
            }
        }
    }

    /**
     * 获取当前场景 UUID，优先用 query-node-tree，失败后退回 query-current-scene。
     */
    private async getCurrentSceneUuid(): Promise<string | null> {
        try {
            const tree: any = await Editor.Message.request('scene', 'query-node-tree');
            if (
                tree &&
                typeof tree === 'object' &&
                !Array.isArray(tree) &&
                typeof tree.uuid === 'string' &&
                tree.uuid
            ) {
                return tree.uuid;
            }
        } catch {
            // Continue to query-current-scene fallback.
        }

        try {
            const currentScene: any = await Editor.Message.request('scene', 'query-current-scene');
            if (currentScene && typeof currentScene.uuid === 'string' && currentScene.uuid) {
                return currentScene.uuid;
            }
        } catch {
            // Ignore and report no resolvable current scene.
        }

        return null;
    }

    /**
     * 截图入口。
     * `editor` 抓整个编辑器窗口，`scene-view` 抓当前 Scene 画布区域。
     */
    private async captureScreenshot(args: CaptureScreenshotOptions = {}): Promise<ToolResponse> {
        const options = resolveCaptureScreenshotOptions(args);

        try {
            const electron = require('electron');
            const browserWindow = electron?.BrowserWindow;
            if (!browserWindow?.getAllWindows) {
                return {
                    success: false,
                    error: 'Electron BrowserWindow API is not available in the current editor environment'
                };
            }

            const windows = browserWindow.getAllWindows();
            if (!Array.isArray(windows) || windows.length === 0) {
                return {
                    success: false,
                    error: 'No editor window is available to capture'
                };
            }

            const focusedWindow =
                windows.find((entry: any) => typeof entry?.isFocused === 'function' && entry.isFocused()) ??
                windows[0];

            const pngBuffer = options.mode === 'game-view'
                ? await this.captureGameViewPngBuffer()
                : options.mode === 'scene-view'
                    ? await this.captureSceneViewPngBuffer(windows)
                    : this.captureNativeImageToPngBuffer(await this.captureWindowNativeImage(focusedWindow));

            if (!pngBuffer || !Buffer.isBuffer(pngBuffer) || pngBuffer.length === 0) {
                return {
                    success: false,
                    error: 'The capture pipeline returned an empty image buffer'
                };
            }

            fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
            fs.writeFileSync(options.outputPath, pngBuffer);

            return {
                success: true,
                data: {
                    mode: options.mode,
                    format: options.format,
                    outputPath: options.outputPath,
                    size: pngBuffer.length
                },
                message: `Screenshot saved to ${options.outputPath}`
            };
        } catch (error: any) {
            return {
                success: false,
                error: `Failed to capture editor screenshot: ${error.message}`
            };
        }
    }

    /**
     * 将原生窗口图像统一转成 PNG buffer。
     */
    private captureNativeImageToPngBuffer(captureResult: {
        image: any;
    }): Buffer {
        return captureResult.image?.toPNG?.();
    }

    /**
     * 通过场景脚本直接读取运行时相机输出，得到精确的游戏画布 PNG。
     */
    private async captureGameViewPngBuffer(): Promise<Buffer> {
        const rawCaptureResult = await this.captureGameViewRawPixels();
        return encodeRawRgbaToPng(rawCaptureResult);
    }

    /**
     * 使用桌面采集获取真实窗口像素。
     * 这里避开 `capturePage()` 对原生合成层抓白屏的问题。
     */
    private async captureWindowNativeImage(targetWindow: any): Promise<{
        image: any;
        windowBounds: DesktopCaptureBounds;
        contentBounds: DesktopCaptureBounds;
    }> {
        const electron = require('electron');
        const desktopCapturer = electron?.desktopCapturer;
        const screen = electron?.screen;
        if (!desktopCapturer?.getSources || !screen?.getDisplayMatching) {
            throw new Error('Electron desktop capture APIs are not available in the current editor environment');
        }

        if (typeof targetWindow?.getMediaSourceId !== 'function') {
            throw new Error('The selected editor window does not expose a media source id');
        }

        const windowBounds = targetWindow.getBounds();
        const contentBounds = typeof targetWindow.getContentBounds === 'function'
            ? targetWindow.getContentBounds()
            : windowBounds;
        const mediaSourceId = targetWindow.getMediaSourceId();
        const display = screen.getDisplayMatching(windowBounds);
        const scaleFactor = display?.scaleFactor || 1;
        const thumbnailSize = {
            width: Math.max(1, Math.round(windowBounds.width * scaleFactor)),
            height: Math.max(1, Math.round(windowBounds.height * scaleFactor))
        };

        const sources = await desktopCapturer.getSources({
            types: ['window'],
            thumbnailSize
        });
        const source = findDesktopCaptureSource(sources, mediaSourceId);
        if (!source?.thumbnail || source.thumbnail.isEmpty?.()) {
            throw new Error(`Desktop capture source not found or empty for window ${mediaSourceId}`);
        }

        return {
            image: source.thumbnail,
            windowBounds,
            contentBounds
        };
    }

    /**
     * 在整窗截图基础上裁出 Scene 视图区域。
     */
    private async captureSceneViewPngBuffer(windows: any[]): Promise<Buffer> {
        const selectedWindow = await this.resolveSceneViewWindow(windows);
        const candidate = selectedWindow.selectedCandidate!;
        const webContents = selectedWindow.targetWindow?.webContents;

        if (candidate.tagName === 'canvas') {
            const sceneViewCapture = await this.captureSceneViewDataUrl(selectedWindow);
            return decodePngDataUrl(sceneViewCapture.dataUrl);
        }

        if (webContents?.capturePage) {
            try {
                const image = await webContents.capturePage({
                    x: Math.max(0, Math.round(candidate.x)),
                    y: Math.max(0, Math.round(candidate.y)),
                    width: Math.max(1, Math.round(candidate.width)),
                    height: Math.max(1, Math.round(candidate.height))
                });
                const pngBuffer = image?.toPNG?.();
                if (pngBuffer && Buffer.isBuffer(pngBuffer) && pngBuffer.length > 0) {
                    return pngBuffer;
                }
            } catch {
                // Fall back to canvas export below when region capture is unavailable.
            }
        }

        const sceneViewCapture = await this.captureSceneViewDataUrl(selectedWindow);
        return decodePngDataUrl(sceneViewCapture.dataUrl);
    }

    /**
     * 调用场景脚本抓取当前游戏相机的原始像素。
     */
    private async captureGameViewRawPixels(): Promise<RawPixelCaptureResult> {
        const previewCaptureResult = await this.tryCaptureGameViewRawPixelsViaMethod('captureGameViewViaPreviewPlay');
        if (previewCaptureResult && hasMeaningfulRawPixelData(previewCaptureResult)) {
            return previewCaptureResult;
        }

        const legacyCaptureResult = await this.captureGameViewRawPixelsViaMethod('captureGameView');
        if (!hasMeaningfulRawPixelData(legacyCaptureResult)) {
            throw new Error('Game view capture returned blank pixel data from both preview-play and legacy paths');
        }

        return legacyCaptureResult;
    }

    /**
     * 通过指定的 scene script 方法抓取游戏视图像素。
     * 这里拆成独立方法，方便未来继续扩展更多截图通道。
     */
    private async captureGameViewRawPixelsViaMethod(method: string): Promise<RawPixelCaptureResult> {
        const result = await Editor.Message.request('scene', 'execute-scene-script', {
            name: 'cocos-mcp-server',
            method,
            args: [{}]
        });

        return this.parseRawPixelCaptureResult(result, method);
    }

    /**
     * 尝试走某条截图通道；如果通道不存在或执行失败，返回 null 交给上层回退。
     */
    private async tryCaptureGameViewRawPixelsViaMethod(method: string): Promise<RawPixelCaptureResult | null> {
        try {
            return await this.captureGameViewRawPixelsViaMethod(method);
        } catch {
            return null;
        }
    }

    /**
     * 统一解析 scene script 返回的原始像素结构，保证各条截图通道的返回格式一致。
     */
    private parseRawPixelCaptureResult(result: any, method: string): RawPixelCaptureResult {
        if (!result?.success) {
            throw new Error(result?.error || `Scene capture script method '${method}' did not complete successfully`);
        }

        const data = result.data || result;
        if (
            typeof data?.width !== 'number' ||
            typeof data?.height !== 'number' ||
            typeof data?.pixelsBase64 !== 'string' ||
            !data.pixelsBase64
        ) {
            throw new Error(`Scene capture script method '${method}' returned incomplete pixel data`);
        }

        return {
            width: data.width,
            height: data.height,
            pixelsBase64: data.pixelsBase64,
            flipY: data.flipY !== false,
            cameraName: data.cameraName
        };
    }

    /**
     * 从编辑器 DOM 中寻找可见画布候选。
     * 这些坐标是内容区坐标，后续会再映射到窗口缩略图。
     */
    private async queryScreenshotSurfaceCandidates(targetWindow: any): Promise<ScreenshotSurfaceCandidate[]> {
        if (!targetWindow?.webContents?.executeJavaScript) {
            return [];
        }

        try {
            const candidates = await targetWindow.webContents.executeJavaScript(`
                (() => {
                    const visitedRoots = new Set();
                    const safeQueryAll = (root, selector) => {
                        try {
                            return root?.querySelectorAll ? Array.from(root.querySelectorAll(selector)) : [];
                        } catch {
                            return [];
                        }
                    };

                    const collectRoots = (root, output) => {
                        if (!root || visitedRoots.has(root)) return;
                        visitedRoots.add(root);
                        output.push(root);

                        const nodes = safeQueryAll(root, '*');
                        for (const node of nodes) {
                            if (node?.shadowRoot) {
                                collectRoots(node.shadowRoot, output);
                            }
                            if (node?.tagName === 'IFRAME') {
                                try {
                                    if (node.contentDocument) {
                                        collectRoots(node.contentDocument, output);
                                    }
                                } catch {
                                    // Ignore cross-origin or sandboxed iframes.
                                }
                            }
                        }
                    };

                    const isVisible = (element) => {
                        if (!element) return false;
                        let rect;
                        try {
                            rect = element.getBoundingClientRect();
                        } catch {
                            return false;
                        }
                        if (rect.width <= 1 || rect.height <= 1) return false;
                        let style;
                        try {
                            const view = element.ownerDocument?.defaultView || window;
                            style = view.getComputedStyle(element);
                        } catch {
                            return false;
                        }
                        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
                    };

                    const collectHintText = (element) => {
                        const parts = [];
                        let current = element;
                        let depth = 0;
                        while (current && depth < 4) {
                            parts.push(current.tagName || '');
                            parts.push(current.id || '');
                            parts.push(typeof current.className === 'string' ? current.className : '');
                            current = current.parentElement;
                            depth += 1;
                        }
                        return parts.join(' ');
                    };

                    const toCandidate = (element) => {
                        const rect = element.getBoundingClientRect();
                        return {
                            tagName: (element.tagName || '').toLowerCase(),
                            id: element.id || '',
                            className: typeof element.className === 'string' ? element.className : '',
                            x: rect.left,
                            y: rect.top,
                            width: rect.width,
                            height: rect.height,
                            hintText: collectHintText(element),
                        };
                    };

                    const results = [];
                    const visited = new Set();
                    const roots = [];
                    collectRoots(document, roots);

                    const maybePush = (element) => {
                        if (!element || visited.has(element) || !isVisible(element)) return;
                        visited.add(element);
                        results.push(toCandidate(element));
                    };

                    for (const root of roots) {
                        safeQueryAll(root, 'canvas').forEach(maybePush);
                        safeQueryAll(root, '[id], [class]').forEach((element) => {
                            const text = collectHintText(element).toLowerCase();
                            if (/scene|game|viewport|preview/.test(text)) {
                                maybePush(element);
                            }
                        });
                    }

                    return results;
                })()
            `);

            return Array.isArray(candidates) ? candidates : [];
        } catch {
            return [];
        }
    }

    /**
     * 直接在编辑器 DOM 中定位 Scene 画布并导出 data URL。
     * 这条链路不依赖桌面采集，更接近用户真正看到的 Scene 画布内容。
     */
    private async resolveSceneViewWindow(windows: any[]): Promise<SceneViewWindowCandidate> {
        const windowCandidates = await Promise.all(
            windows.map(async (windowEntry: any, index: number) => ({
                windowId: typeof windowEntry?.id === 'number' ? windowEntry.id : index,
                isFocused: typeof windowEntry?.isFocused === 'function' ? windowEntry.isFocused() : false,
                targetWindow: windowEntry,
                candidates: await this.queryScreenshotSurfaceCandidates(windowEntry)
            }))
        );
        const selectedWindow = pickSceneViewWindowCandidate(windowCandidates);
        if (!selectedWindow?.selectedCandidate || !selectedWindow.targetWindow?.webContents?.executeJavaScript) {
            throw new Error('No visible scene-view surface was found in the current editor windows');
        }

        return selectedWindow;
    }

    /**
     * 回退路径：直接从目标 canvas 导出 PNG data URL。
     * 只有区域截图不可用时才会走到这里。
     */
    private async captureSceneViewDataUrl(selectedWindow: SceneViewWindowCandidate): Promise<{
        dataUrl: string;
        captureInfo: SceneViewCaptureInfo;
    }> {
        if (!selectedWindow?.selectedCandidate || !selectedWindow.targetWindow?.webContents?.executeJavaScript) {
            throw new Error('No visible scene-view surface was found in the current editor windows');
        }

        const sceneViewCanvasCaptureData = await this.querySceneViewCanvasCaptureData();
        const captureResult = await selectedWindow.targetWindow.webContents.executeJavaScript(`
            (() => {
                const visitedRoots = new Set();
                const safeQueryAll = (root, selector) => {
                    try {
                        return root?.querySelectorAll ? Array.from(root.querySelectorAll(selector)) : [];
                    } catch {
                        return [];
                    }
                };

                const collectRoots = (root, output) => {
                    if (!root || visitedRoots.has(root)) return;
                    visitedRoots.add(root);
                    output.push(root);

                    const nodes = safeQueryAll(root, '*');
                    for (const node of nodes) {
                        if (node?.shadowRoot) {
                            collectRoots(node.shadowRoot, output);
                        }
                        if (node?.tagName === 'IFRAME') {
                            try {
                                if (node.contentDocument) {
                                    collectRoots(node.contentDocument, output);
                                }
                            } catch {
                                // Ignore cross-origin or sandboxed iframes.
                            }
                        }
                    }
                };

                const collectHintText = (element) => {
                    const parts = [];
                    let current = element;
                    let depth = 0;
                    while (current && depth < 4) {
                        parts.push(current.tagName || '');
                        parts.push(current.id || '');
                        parts.push(typeof current.className === 'string' ? current.className : '');
                        current = current.parentElement;
                        depth += 1;
                    }
                    return parts.join(' ');
                };

                const cropCanvasToDataUrl = (canvas, cropRect) => {
                    const exportCanvas = document.createElement('canvas');
                    exportCanvas.width = cropRect.width;
                    exportCanvas.height = cropRect.height;
                    const exportContext = exportCanvas.getContext('2d');
                    if (!exportContext) {
                        throw new Error('2D canvas context is unavailable while cropping scene view');
                    }
                    exportContext.drawImage(
                        canvas,
                        cropRect.x,
                        cropRect.y,
                        cropRect.width,
                        cropRect.height,
                        0,
                        0,
                        cropRect.width,
                        cropRect.height,
                    );
                    return exportCanvas.toDataURL('image/png');
                };

                const detectForegroundCropRect = (canvas, ignoreTopPx = 0) => {
                    const context = canvas.getContext('2d');
                    if (!context) {
                        return null;
                    }
                    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
                    const pixelBuffer = Buffer.from(imageData.data.buffer);
                    return (${detectSceneViewForegroundCropRect.toString()})({
                        pixelBuffer,
                        width: canvas.width,
                        height: canvas.height,
                        ignoreTopPx,
                    });
                };

                const target = ${JSON.stringify(selectedWindow.selectedCandidate)};
                const roots = [];
                collectRoots(document, roots);
                const matchingCanvas = roots
                    .flatMap((root) => safeQueryAll(root, 'canvas'))
                    .find((element) => {
                        let rect;
                        try {
                            rect = element.getBoundingClientRect();
                        } catch {
                            return false;
                        }
                        const candidate = {
                            tagName: (element.tagName || '').toLowerCase(),
                            id: element.id || '',
                            className: typeof element.className === 'string' ? element.className : '',
                            x: rect.left,
                            y: rect.top,
                            width: rect.width,
                            height: rect.height,
                            hintText: collectHintText(element),
                        };

                        const sameIdentity =
                            candidate.tagName === target.tagName &&
                            candidate.id === target.id &&
                            candidate.className === target.className;
                        const sameBounds =
                            Math.abs(candidate.x - target.x) < 1 &&
                            Math.abs(candidate.y - target.y) < 1 &&
                            Math.abs(candidate.width - target.width) < 1 &&
                            Math.abs(candidate.height - target.height) < 1;

                        return sameIdentity || sameBounds;
                    });

                if (!matchingCanvas || typeof matchingCanvas.toDataURL !== 'function') {
                    throw new Error('Scene view canvas could not be resolved for toDataURL capture');
                }

                const buildFallbackResult = () => {
                    const autoCropRect = detectForegroundCropRect(matchingCanvas, 32);
                    if (autoCropRect) {
                        return {
                            dataUrl: cropCanvasToDataUrl(matchingCanvas, autoCropRect),
                            captureInfo: {
                                strategy: 'canvas-node-crop',
                                cropApplied: true,
                                cropRect: autoCropRect,
                                candidateTagName: target.tagName,
                                candidateId: target.id,
                            },
                        };
                    }
                    return {
                        dataUrl: matchingCanvas.toDataURL('image/png'),
                        captureInfo: {
                            strategy: 'full-canvas',
                            cropApplied: false,
                            candidateTagName: target.tagName,
                            candidateId: target.id,
                        },
                    };
                };

                const cropOptions = ${JSON.stringify(sceneViewCanvasCaptureData)};
                if (
                    typeof window.__CC_CAPTURE_SCENE_VIEW_CANVAS__ !== 'function' ||
                    matchingCanvas.width <= 0 ||
                    matchingCanvas.height <= 0
                ) {
                    return buildFallbackResult();
                }

                try {
                    const canvasCapture = window.__CC_CAPTURE_SCENE_VIEW_CANVAS__({
                        canvasWidth: matchingCanvas.width,
                        canvasHeight: matchingCanvas.height,
                        cropOptions,
                    });
                    if (!canvasCapture?.cropRect) {
                        return {
                            dataUrl: matchingCanvas.toDataURL('image/png'),
                            captureInfo: {
                                strategy: 'full-canvas',
                                cropApplied: false,
                                candidateTagName: target.tagName,
                                candidateId: target.id,
                            },
                        };
                    }

                    return {
                        dataUrl: cropCanvasToDataUrl(matchingCanvas, canvasCapture.cropRect),
                        captureInfo: {
                            strategy: 'canvas-node-crop',
                            cropApplied: true,
                            cropRect: canvasCapture.cropRect,
                            candidateTagName: target.tagName,
                            candidateId: target.id,
                        },
                    };
                } catch {
                    return buildFallbackResult();
                }
            })()
        `);

        if (typeof captureResult?.dataUrl !== 'string' || !captureResult.dataUrl) {
            throw new Error('Scene view capture returned an empty data url');
        }

        return captureResult;
    }

    /**
     * 查询 Scene 进程里的 Canvas 节点矩形与编辑相机信息。
     * 这是 scene-view 精确裁切的输入数据，拿不到时会安全回退到整块 scene canvas。
     */
    private async querySceneViewCanvasCaptureData(): Promise<{
        worldRect: SceneViewCanvasWorldRect;
        cameraInfo: SceneViewEditorCameraInfo;
    } | null> {
        try {
            const result = await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'cocos-mcp-server',
                method: 'getSceneViewCanvasCaptureData',
                args: [],
            });
            if (!result?.success || !result?.data?.worldRect || !result?.data?.cameraInfo) {
                return null;
            }
            return result.data;
        } catch {
            return null;
        }
    }
}
