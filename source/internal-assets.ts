/**
 * Internal Engine Asset UUID Resolver
 * 
 * Cocos Creator ships with built-in prefabs for 3D primitives, UI elements,
 * lights, etc. These are the same prefabs the editor uses for right-click
 * "Create → 3D Object" menu commands. Their UUIDs are recorded in
 * library/.internal-info.json — stable per engine version, not dynamic.
 * 
 * This module reads that mapping at startup so we can instantiate these
 * prefabs by path rather than hardcoding UUIDs.
 */
import * as fs from 'fs';
import * as path from 'path';

// ── Path constants (engine-internal, same across all 3.8.x projects) ──────

export const INTERNAL_3D_PREFABS: Record<string, string> = {
    box:      'db://internal/default_prefab/3d/Cube.prefab',
    sphere:   'db://internal/default_prefab/3d/Sphere.prefab',
    cylinder: 'db://internal/default_prefab/3d/Cylinder.prefab',
    cone:     'db://internal/default_prefab/3d/Cone.prefab',
    plane:    'db://internal/default_prefab/3d/Plane.prefab',
    quad:     'db://internal/default_prefab/3d/Quad.prefab',
    capsule:  'db://internal/default_prefab/3d/Capsule.prefab',
    torus:    'db://internal/default_prefab/3d/Torus.prefab',
};

// ── UUID cache (loaded once at startup) ──────────────────────────────────

let _cachedUuids: Record<string, string> | null = null;

/**
 * Read library/.internal-info.json and build a dbPath → UUID map.
 * Result is cached in memory — call as needed, it only reads disk once.
 */
export function loadInternalAssetUuids(): Record<string, string> {
    if (_cachedUuids) return _cachedUuids;

    const infoPath = path.join(Editor.Project.path, 'library', '.internal-info.json');
    if (!fs.existsSync(infoPath)) {
        console.warn('[InternalAssets] .internal-info.json not found at', infoPath);
        _cachedUuids = {};
        return _cachedUuids;
    }

    try {
        const raw = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
        const map: Record<string, { uuid?: string }> = raw.map || {};
        _cachedUuids = {};

        for (const [key, entry] of Object.entries(map)) {
            // Keys look like:  "default_prefab\\3d\\Cube.prefab"
            // We convert to:   "db://internal/default_prefab/3d/Cube.prefab"
            const dbPath = 'db://internal/' + key.replace(/\\/g, '/');
            if (entry.uuid) {
                _cachedUuids[dbPath] = entry.uuid;
            }
        }
        console.log(`[InternalAssets] Loaded ${Object.keys(_cachedUuids).length} internal UUIDs`);
    } catch (err) {
        console.error('[InternalAssets] Failed to load .internal-info.json:', err);
        _cachedUuids = {};
    }
    return _cachedUuids;
}

/**
 * Resolve a db://internal/... path to its asset UUID.
 */
export function getInternalAssetUuid(dbPath: string): string | null {
    const uuids = loadInternalAssetUuids();
    return uuids[dbPath] || null;
}

/**
 * Get the UUID of a built-in 3D primitive prefab by type name.
 * e.g. getPrimitivePrefabUuid('box') → '30da77a1-f02d-4ede-aa56-403452ee7fde'
 */
export function getPrimitivePrefabUuid(type: string): string | null {
    const dbPath = INTERNAL_3D_PREFABS[type];
    if (!dbPath) return null;
    return getInternalAssetUuid(dbPath);
}
