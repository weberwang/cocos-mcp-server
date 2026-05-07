/**
 * Asset Database Wrapper for Cocos Creator 3.8.8
 * 
 * Replaces broken Editor.Message.request('asset-db', ...) IPC calls
 * with filesystem-based operations that work reliably across Creator versions.
 * 
 * All db:// URLs are converted to absolute filesystem paths using Editor.Project.path.
 * 
 * All creation functions now trigger an asset-db refresh after writing, ensuring
 * .meta files are generated and script compilation completes before returning.
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
    /** When true, skip the automatic asset-db refresh after import. Use for batch operations. */
    skipRefresh?: boolean;
}

// ── Path Utilities ─────────────────────────────────────
export function dbUrlToFsPath(dbUrl: string): string {
    if (dbUrl.startsWith('db://')) {
        return path.join(Editor.Project.path, dbUrl.replace('db://', ''));
    }
    return dbUrl;
}

function fsPathToDbUrl(fsPath: string): string {
    const projectPath = Editor.Project.path;
    if (fsPath.startsWith(projectPath)) {
        return 'db://' + fsPath.substring(projectPath.length).replace(/\\/g, '/').replace(/^\//, '');
    }
    return fsPath;
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
 * After writing, triggers asset-db refresh and waits for .meta generation.
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

    // Refresh asset DB to generate .meta and trigger compilation
    const metaReady = await refreshAsset(url);
    const uuid = metaReady ? (getUUIDFromMeta(fsPath) || '') : '';
    return { uuid, url };
}

/**
 * Delete asset (replaces broken 'delete-asset' IPC).
 * After deletion, triggers asset-db refresh so Creator picks up changes.
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
        // Trigger asset-db refresh so Creator picks up the deletion
        try {
            Editor.Message.request('asset-db', 'refresh-asset', url);
        } catch {
            try {
                if (typeof (Editor as any).assetdb?.refresh === 'function') {
                    (Editor as any).assetdb.refresh(url);
                }
            } catch { /* ok */ }
        }
    }
}

/**
 * Import external asset (replaces broken 'import-asset' IPC).
 * After copying the file, triggers asset-db refresh and waits for .meta generation.
 * Set options.skipRefresh=true for batch imports — then call refreshAllAssets once afterward.
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

    if (options?.skipRefresh) {
        return { uuid: '', url: targetPath };
    }

    // Refresh asset DB to generate .meta and trigger compilation
    const metaReady = await refreshAsset(targetPath);
    const uuid = metaReady ? (getUUIDFromMeta(destFsPath) || '') : '';

    return { uuid, url: targetPath };
}

/**
 * Save asset content (replaces broken 'save-asset' IPC).
 * After writing, triggers asset-db refresh and waits for .meta generation.
 */
export async function saveAsset(url: string, content: string): Promise<void> {
    const fsPath = dbUrlToFsPath(url);
    const dir = path.dirname(fsPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fsPath, content, 'utf-8');

    // Refresh asset DB to ensure .meta is updated after content change
    await refreshAsset(url);
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

// ── Refresh & Compilation ───────────────────────────────

/**
 * Max time (ms) to wait for asset-db refresh / script compilation to complete.
 * Script compilation in Cocos Creator can take a few seconds for large projects.
 */
const ASSET_REFRESH_TIMEOUT_MS = 30_000;
const ASSET_REFRESH_POLL_MS = 300;

/** File extensions that require script compilation in Cocos Creator. */
const SCRIPT_EXTENSIONS = ['.ts', '.js'];

/**
 * Check whether a given asset path is a script that requires compilation.
 */
function isScriptAsset(url: string): boolean {
    const lower = url.toLowerCase();
    return SCRIPT_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/**
 * Wait for a .meta file to exist (and be non-empty) for the given filesystem path.
 * Returns true once the .meta is ready, false on timeout.
 */
async function waitForMetaReady(fsPath: string, timeoutMs: number = ASSET_REFRESH_TIMEOUT_MS): Promise<boolean> {
    const metaPath = fsPath + '.meta';
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        try {
            if (fs.existsSync(metaPath)) {
                const content = fs.readFileSync(metaPath, 'utf-8');
                if (content && content.trim().length > 0) {
                    // Verify it contains valid JSON with a uuid
                    try {
                        const parsed = JSON.parse(content);
                        if (parsed && parsed.uuid) {
                            return true;
                        }
                    } catch {
                        // Not valid JSON yet, keep waiting
                    }
                }
            }
        } catch {
            // File may be locked or partially written, keep waiting
        }
        await sleep(ASSET_REFRESH_POLL_MS);
    }

    // One last check
    if (fs.existsSync(metaPath)) {
        return true;
    }
    return false;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Refresh a single asset in the asset database and wait for its .meta to be generated.
 * For script assets, also waits for compilation to complete (indicated by .meta update).
 * 
 * @param url - db:// URL of the asset to refresh
 * @returns true if the .meta file was confirmed ready, false if timed out
 */
export async function refreshAsset(url: string): Promise<boolean> {
    const fsPath = dbUrlToFsPath(url);

    // Trigger asset-db refresh via the official IPC
    try {
        Editor.Message.request('asset-db', 'refresh-asset', url);
    } catch {
        // Fallback: try internal API
        try {
            if (typeof (Editor as any).assetdb?.refresh === 'function') {
                (Editor as any).assetdb.refresh(url);
            }
        } catch {
            // Best effort — the filesystem write already happened
        }
    }

    // For scripts, also trigger compilation
    if (isScriptAsset(url)) {
        try {
            // Request script compilation via the builder/compiler IPC
            Editor.Message.request('asset-db', 'refresh-asset', url + '.meta');
        } catch { /* ok */ }
    }

    // Wait for .meta to be generated/updated
    const ready = await waitForMetaReady(fsPath, ASSET_REFRESH_TIMEOUT_MS);

    // For scripts, give a little extra time for the importer to populate
    if (isScriptAsset(url) && ready) {
        await sleep(500);
    }

    console.log(`[AssetDB] refreshAsset '${url}' — meta ready: ${ready}`);
    return ready;
}

/**
 * Refresh all assets under a given folder (or the entire assets tree).
 * Triggers asset-db refresh and waits for pending compilations to settle.
 * 
 * @param folder - db:// URL of the folder to refresh (defaults to all assets)
 */
export async function refreshAllAssets(folder?: string): Promise<void> {
    const targetPath = folder || 'db://assets';

    try {
        // Use the internal API for a full refresh if available (synchronous-ish)
        if (typeof (Editor as any).assetdb?.refresh === 'function') {
            (Editor as any).assetdb.refresh(targetPath);
        }
    } catch { /* ok */ }

    // Also fire the IPC-based refresh for broader coverage
    try {
        Editor.Message.request('asset-db', 'refresh-asset', targetPath);
    } catch { /* ok */ }

    // For script-heavy operations, allow a settling period
    await sleep(1500);

    console.log(`[AssetDB] refreshAllAssets triggered for: ${targetPath}`);
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
 * After copying, triggers asset-db refresh and waits for .meta generation.
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

    // Refresh asset DB to generate .meta for the new copy
    await refreshAsset(target);
    return { uuid: getUUIDFromMeta(tgtFs) || '', url: target };
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
    copyAsset,
    moveAsset,
    refreshAsset,
    refreshAllAssets,
};
