/**
 * Asset Database Wrapper for Cocos Creator 3.8.8
 * 
 * Replaces broken Editor.Message.request('asset-db', ...) IPC calls
 * with filesystem-based operations that work reliably across Creator versions.
 * 
 * All db:// URLs are converted to absolute filesystem paths using Editor.Project.path.
 */
import * as fs from 'fs';
import * as path from 'path';

// ── Types ──────────────────────────────────────────────
export interface AssetInfo {
    name: string;
    uuid: string;
    url: string;
    type: string;
    size: number;
    isDirectory: boolean;
    meta?: { ver: string; importer: string };
}

export interface ImportOptions {
    overwrite?: boolean;
    rename?: boolean;
}

export interface CreatedAssetResult {
    url: string;
    uuid: string;
    metaReady?: boolean;
}

/**
 * 批量刷新资源并等待对应 .meta 就绪的请求参数。
 */
export interface RefreshAssetsAndWaitRequest {
    urls: string[];
    timeoutMs?: number;
    pollIntervalMs?: number;
    refreshParentFolders?: boolean;
}

/**
 * 批量刷新资源并等待对应 .meta 就绪的执行结果。
 */
export interface RefreshAssetsAndWaitResult {
    readyUrls: string[];
    pendingUrls: string[];
    elapsedMs: number;
    metaReady: boolean;
}

/**
 * 允许测试注入刷新和等待能力，避免依赖真实编辑器环境。
 */
export interface RefreshAssetsAndWaitDeps {
    refreshFolder: (folder: string) => Promise<void> | void;
    refreshAsset: (url: string) => Promise<void> | void;
    metaExists: (url: string) => boolean;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
}

// ── Path Utilities ─────────────────────────────────────
export function dbUrlToFsPath(dbUrl: string): string {
    if (dbUrl.startsWith('db://')) {
        return path.join(Editor.Project.path, dbUrl.replace('db://', ''));
    }
    return dbUrl;
}

export function throwIfAssetExists(
    assetUrl: string,
    overwrite: boolean,
    assetExists: (normalizedUrl: string) => boolean,
    normalizeUrl: (url: string) => string
): string {
    const normalizedUrl = normalizeUrl(assetUrl);
    if (!overwrite && assetExists(normalizedUrl)) {
        throw new Error(`Asset already exists: ${normalizedUrl}`);
    }
    return normalizedUrl;
}

export function ensureCreatedAssetIsReady<T extends CreatedAssetResult>(asset: T): T {
    if (!asset.uuid || !asset.uuid.trim()) {
        throw new Error(`Created asset is missing uuid: ${asset.url}`);
    }
    if (asset.metaReady === false) {
        throw new Error(`Created asset meta is not ready: ${asset.url}`);
    }
    return asset;
}

function fsPathToDbUrl(fsPath: string): string {
    const projectPath = Editor.Project.path;
    if (fsPath.startsWith(projectPath)) {
        return 'db://' + fsPath.substring(projectPath.length).replace(/\\/g, '/').replace(/^\//, '');
    }
    return fsPath;
}

/**
 * 统一去重并过滤空资源路径，避免批处理时重复刷新同一资源。
 */
function uniqueUrls(urls: string[]): string[] {
    const results: string[] = [];
    const seen = new Set<string>();
    for (const url of urls) {
        const normalized = url.trim();
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        results.push(normalized);
    }
    return results;
}

/**
 * 从资源 URL 推导父目录，用于先刷新目录再刷新具体资源。
 */
function getParentFolderUrl(url: string): string {
    const lastSlashIndex = url.lastIndexOf('/');
    if (lastSlashIndex <= 'db://assets'.length) {
        return 'db://assets';
    }
    return url.slice(0, lastSlashIndex);
}

function getUUIDFromMeta(assetPath: string): string | null {
    try {
        const metaPath = assetPath + '.meta';
        if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            return meta.uuid || null;
        }
    } catch { /* ignore */ }
    return null;
}

function determineAssetType(fsPath: string, isDir: boolean): string {
    if (isDir) return 'folder';
    const ext = path.extname(fsPath).toLowerCase();
    const typeMap: Record<string, string> = {
        '.scene': 'cc.SceneAsset',
        '.prefab': 'cc.Prefab',
        '.ts': 'cc.Script',
        '.js': 'cc.Script',
        '.png': 'cc.ImageAsset',
        '.jpg': 'cc.ImageAsset',
        '.jpeg': 'cc.ImageAsset',
        '.gif': 'cc.ImageAsset',
        '.tga': 'cc.ImageAsset',
        '.bmp': 'cc.ImageAsset',
        '.psd': 'cc.ImageAsset',
        '.mtl': 'cc.Material',
        '.fbx': 'cc.Mesh',
        '.obj': 'cc.Mesh',
        '.dae': 'cc.Mesh',
        '.gltf': 'cc.Mesh',
        '.glb': 'cc.Mesh',
        '.mp3': 'cc.AudioClip',
        '.ogg': 'cc.AudioClip',
        '.wav': 'cc.AudioClip',
        '.m4a': 'cc.AudioClip',
        '.anim': 'cc.AnimationClip',
        '.animask': 'cc.AnimMask',
        '.controller': 'cc.AnimatorController',
        '.atlas': 'cc.SpriteAtlas',
        '.json': 'cc.JsonAsset',
        '.txt': 'cc.TextAsset',
        '.md': 'cc.TextAsset',
    };
    return typeMap[ext] || 'cc.Asset';
}

function matchPattern(fsPath: string, pattern: string): boolean {
    const projectPath = Editor.Project.path;
    const relativePath = fsPath.substring(projectPath.length).replace(/\\/g, '/').replace(/^\//, '');
    const dbPath = 'db://' + relativePath;
    return globMatch(dbPath, pattern);
}

function globMatch(str: string, pattern: string): boolean {
    const re = new RegExp(
        '^' + pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*\*/g, '§§DOUBLESTAR§§')
            .replace(/\*/g, '[^/]*')
            .replace(/§§DOUBLESTAR§§/g, '.*')
            .replace(/\?/g, '.')
        + '$'
    );
    return re.test(str);
}

function recursiveReadDir(dir: string, maxDepth: number = 20): string[] {
    const results: string[] = [];
    if (maxDepth <= 0) return results;
    try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
            const fullPath = path.join(dir, entry);
            try {
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    results.push(fullPath);
                    results.push(...recursiveReadDir(fullPath, maxDepth - 1));
                } else {
                    // Skip .meta files themselves
                    if (!entry.endsWith('.meta')) {
                        results.push(fullPath);
                    }
                }
            } catch { /* skip inaccessible */ }
        }
    } catch { /* skip inaccessible */ }
    return results;
}

// ── Core Asset Operations ──────────────────────────────

/**
 * Query assets matching a glob pattern (replaces broken 'query-assets' IPC).
 * Pattern examples: 'db://assets/**\/*.scene', 'db://assets/prefabs/**\/*.prefab'
 */
export async function queryAssets(pattern: string): Promise<AssetInfo[]> {
    const projectPath = Editor.Project.path;
    const assetsDir = path.join(projectPath, 'assets');
    const allPaths = recursiveReadDir(assetsDir);
    const results: AssetInfo[] = [];

    for (const fsPath of allPaths) {
        if (matchPattern(fsPath, pattern)) {
            const isDir = fs.statSync(fsPath).isDirectory();
            const url = fsPathToDbUrl(fsPath);
            const name = path.basename(fsPath);
            const uuid = isDir ? '' : (getUUIDFromMeta(fsPath) || '');
            const type = determineAssetType(fsPath, isDir);
            const size = isDir ? 0 : fs.statSync(fsPath).size;

            results.push({ name, uuid, url, type, size, isDirectory: isDir });
        }
    }

    return results;
}

/**
 * Get detailed asset info for a single asset (replaces broken 'query-asset-info' IPC).
 */
export async function queryAssetInfo(assetPath: string): Promise<AssetInfo> {
    const fsPath = dbUrlToFsPath(assetPath);
    if (!fs.existsSync(fsPath)) {
        throw new Error(`Asset not found: ${assetPath}`);
    }
    const stat = fs.statSync(fsPath);
    const url = fsPathToDbUrl(fsPath);
    const name = path.basename(fsPath);
    const uuid = stat.isDirectory() ? '' : (getUUIDFromMeta(fsPath) || '');
    const type = determineAssetType(fsPath, stat.isDirectory());
    const size = stat.isDirectory() ? 0 : stat.size;
    const info: AssetInfo = { name, uuid, url, type, size, isDirectory: stat.isDirectory() };

    // Try to read meta
    try {
        const metaPath = fsPath + '.meta';
        if (fs.existsSync(metaPath)) {
            info.meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        }
    } catch { /* no meta */ }

    return info;
}

/**
 * Resolve UUID from URL (replaces broken 'query-uuid' IPC).
 */
export async function queryUuid(url: string): Promise<string | null> {
    const fsPath = dbUrlToFsPath(url);
    const uuid = getUUIDFromMeta(fsPath);
    if (uuid) return uuid;

    // If not a file, return null
    if (!fs.existsSync(fsPath)) return null;
    return null;
}

/**
 * Resolve URL from UUID (replaces broken 'query-url' IPC).
 */
export async function queryUrl(uuid: string): Promise<string | null> {
    const projectPath = Editor.Project.path;
    const assetsDir = path.join(projectPath, 'assets');
    const allMetaPaths = recursiveReadDir(assetsDir)
        .filter(p => !fs.statSync(p).isDirectory())
        .map(p => p + '.meta');

    for (const metaPath of allMetaPaths) {
        try {
            if (fs.existsSync(metaPath)) {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                if (meta.uuid === uuid) {
                    return fsPathToDbUrl(metaPath.replace('.meta', ''));
                }
            }
        } catch { /* skip */ }
    }
    return null;
}

/**
 * Create asset or folder (replaces broken 'create-asset' IPC).
 */
export async function createAsset(url: string, content: string | null = null, options?: any): Promise<{ uuid: string; url: string }> {
    const fsPath = dbUrlToFsPath(url);

    if (content === null) {
        // Create directory
        if (!fs.existsSync(fsPath)) {
            fs.mkdirSync(fsPath, { recursive: true });
        }
        return { uuid: '', url };
    }

    // Create file with content
    const dir = path.dirname(fsPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fsPath, content, 'utf-8');
    const uuid = getUUIDFromMeta(fsPath) || '';
    return { uuid, url };
}

/**
 * Delete asset (replaces broken 'delete-asset' IPC).
 */
export async function deleteAsset(url: string): Promise<void> {
    const fsPath = dbUrlToFsPath(url);
    if (fs.existsSync(fsPath)) {
        const stat = fs.statSync(fsPath);
        if (stat.isDirectory()) {
            fs.rmSync(fsPath, { recursive: true, force: true });
        } else {
            fs.unlinkSync(fsPath);
            // Also delete .meta file
            const metaPath = fsPath + '.meta';
            if (fs.existsSync(metaPath)) {
                fs.unlinkSync(metaPath);
            }
        }
        // Trigger asset-db refresh so Creator picks up changes
        try {
            Editor.Message.request('asset-db', 'refresh-asset', url);
        } catch { /* refresh might not work, but deletion was successful */ }
    }
}

/**
 * Import external asset (replaces broken 'import-asset' IPC).
 */
export async function importAsset(sourcePath: string, targetPath: string, options?: ImportOptions): Promise<{ uuid: string; url: string }> {
    const destFsPath = dbUrlToFsPath(targetPath);

    if (!fs.existsSync(sourcePath)) {
        throw new Error(`Source file not found: ${sourcePath}`);
    }

    const destDir = path.dirname(destFsPath);
    if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
    }

    // Copy the file
    fs.copyFileSync(sourcePath, destFsPath);

    // Try to refresh
    try {
        Editor.Message.request('asset-db', 'refresh-asset', targetPath);
    } catch { /* may fail but import succeeded */ }

    return { uuid: '', url: targetPath };
}

/**
 * Save asset content (replaces broken 'save-asset' IPC).
 */
export async function saveAsset(url: string, content: string): Promise<void> {
    const fsPath = dbUrlToFsPath(url);
    const dir = path.dirname(fsPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fsPath, content, 'utf-8');
}

/**
 * 触发资源刷新并轮询对应 .meta 是否就绪。
 * 这里显式等待 .meta 文件出现，主要用于批量落盘后的收口步骤。
 */
export async function refreshAssetsAndWait(
    request: RefreshAssetsAndWaitRequest,
    deps?: RefreshAssetsAndWaitDeps
): Promise<RefreshAssetsAndWaitResult> {
    const urls = uniqueUrls(request.urls ?? []);
    if (urls.length === 0) {
        throw new Error('At least one asset url is required');
    }

    const timeoutMs = Math.max(request.timeoutMs ?? 10000, 0);
    const pollIntervalMs = Math.max(request.pollIntervalMs ?? 200, 1);
    const resolvedDeps: RefreshAssetsAndWaitDeps = deps ?? {
        refreshFolder: async (folder: string) => {
            if (typeof (Editor as any).assetdb?.refresh === 'function') {
                await (Editor as any).assetdb.refresh(folder);
                return;
            }
            await Editor.Message.request('asset-db', 'refresh-asset', folder);
        },
        refreshAsset: async (url: string) => {
            await Editor.Message.request('asset-db', 'refresh-asset', url);
        },
        metaExists: (url: string) => {
            const metaPath = dbUrlToFsPath(url) + '.meta';
            return fs.existsSync(metaPath);
        },
        now: () => Date.now(),
        sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    };

    if (request.refreshParentFolders !== false) {
        const folders = uniqueUrls(urls.map(getParentFolderUrl));
        for (const folder of folders) {
            await resolvedDeps.refreshFolder(folder);
        }
    }

    for (const url of urls) {
        await resolvedDeps.refreshAsset(url);
    }

    const pending = new Set(urls);
    const startTime = resolvedDeps.now();

    while (pending.size > 0) {
        for (const url of Array.from(pending)) {
            if (resolvedDeps.metaExists(url)) {
                pending.delete(url);
            }
        }

        if (pending.size === 0) {
            break;
        }

        const elapsedMs = resolvedDeps.now() - startTime;
        if (elapsedMs >= timeoutMs) {
            break;
        }

        await resolvedDeps.sleep(pollIntervalMs);
    }

    const elapsedMs = resolvedDeps.now() - startTime;
    const pendingUrls = urls.filter((url) => pending.has(url));
    return {
        readyUrls: urls.filter((url) => !pending.has(url)),
        pendingUrls,
        elapsedMs,
        metaReady: pendingUrls.length === 0,
    };
}

/**
 * Re-import asset (triggers Creator to re-read the file).
 */
export async function reimportAsset(url: string): Promise<void> {
    try {
        // Try the actual reimport IPC first (may not exist in all versions)
        Editor.Message.request('asset-db', 'reimport-asset', url).catch(() => {
            // Fallback: refresh
            Editor.Message.request('asset-db', 'refresh-asset', url);
        });
    } catch {
        // If both fail, the asset still exists on disk
    }
}

/**
 * Check if asset database is ready (replaces broken 'query-ready' IPC).
 */
export async function queryReady(): Promise<boolean> {
    // Asset-db is always "ready" if we're using filesystem operations
    return true;
}

/**
 * Generate available URL (replaces broken 'generate-available-url' IPC).
 */
export async function generateAvailableUrl(url: string): Promise<string> {
    const fsPath = dbUrlToFsPath(url);
    if (!fs.existsSync(fsPath)) return url;

    // Try appending numbers
    const ext = path.extname(fsPath);
    const baseName = fsPath.substring(0, fsPath.length - ext.length);
    for (let i = 1; i < 1000; i++) {
        const candidate = `${baseName}-${i}${ext}`;
        if (!fs.existsSync(candidate)) {
            return fsPathToDbUrl(candidate);
        }
    }
    return url;
}

/**
 * Open asset with external program.
 */
export async function openAssetExternal(urlOrUUID: string): Promise<void> {
    let fsPath: string;
    if (urlOrUUID.startsWith('db://')) {
        fsPath = dbUrlToFsPath(urlOrUUID);
    } else {
        // UUID lookup
        const url = await queryUrl(urlOrUUID);
        if (!url) throw new Error(`Asset not found for UUID: ${urlOrUUID}`);
        fsPath = dbUrlToFsPath(url);
    }
    if (fs.existsSync(fsPath)) {
        // Use platform-appropriate command
        const { exec } = require('child_process');
        const platform = process.platform;
        if (platform === 'win32') {
            exec(`start "" "${fsPath}"`);
        } else if (platform === 'darwin') {
            exec(`open "${fsPath}"`);
        } else {
            exec(`xdg-open "${fsPath}"`);
        }
    }
}

/**
 * Save asset meta data.
 */
export async function saveAssetMeta(urlOrUUID: string, content: string): Promise<void> {
    let fsPath: string;
    if (urlOrUUID.startsWith('db://')) {
        fsPath = dbUrlToFsPath(urlOrUUID) + '.meta';
    } else {
        const url = await queryUrl(urlOrUUID);
        if (!url) throw new Error(`Asset not found for UUID: ${urlOrUUID}`);
        fsPath = dbUrlToFsPath(url) + '.meta';
    }
    fs.writeFileSync(fsPath, content, 'utf-8');

    // Try to refresh the meta
    try {
        Editor.Message.request('asset-db', 'refresh-asset', urlOrUUID);
    } catch { /* ok */ }
}

/**
 * Copy asset to target location.
 */
export async function copyAsset(source: string, target: string, overwrite: boolean = false): Promise<{ uuid: string; url: string }> {
    const srcFs = dbUrlToFsPath(source);
    const tgtFs = dbUrlToFsPath(target);

    if (!fs.existsSync(srcFs)) {
        throw new Error(`Source not found: ${source}`);
    }
    if (fs.existsSync(tgtFs) && !overwrite) {
        throw new Error(`Target exists: ${target}`);
    }

    const stat = fs.statSync(srcFs);
    if (stat.isDirectory()) {
        copyDirSync(srcFs, tgtFs);
    } else {
        const destDir = path.dirname(tgtFs);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(srcFs, tgtFs);
        // Copy .meta too
        const srcMeta = srcFs + '.meta';
        if (fs.existsSync(srcMeta)) {
            fs.copyFileSync(srcMeta, tgtFs + '.meta');
        }
    }

    try { Editor.Message.request('asset-db', 'refresh-asset', target); } catch { /* ok */ }
    return { uuid: '', url: target };
}

/**
 * Move asset to target location.
 */
export async function moveAsset(source: string, target: string, overwrite: boolean = false): Promise<{ uuid: string; url: string }> {
    await copyAsset(source, target, overwrite);
    await deleteAsset(source);
    return { uuid: '', url: target };
}

function copyDirSync(src: string, dest: string): void {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src);
    for (const entry of entries) {
        const srcPath = path.join(src, entry);
        const destPath = path.join(dest, entry);
        const stat = fs.statSync(srcPath);
        if (stat.isDirectory()) {
            copyDirSync(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

export default {
    queryAssets,
    queryAssetInfo,
    queryUuid,
    queryUrl,
    createAsset,
    deleteAsset,
    importAsset,
    saveAsset,
    reimportAsset,
    queryReady,
    generateAvailableUrl,
    openAssetExternal,
    saveAssetMeta,
    refreshAssetsAndWait,
    copyAsset,
    moveAsset,
};
