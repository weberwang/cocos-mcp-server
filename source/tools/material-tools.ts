/**
 * Material Management Tool
 *
 * Modeled after Unity-MCP's manage_material. Enables AI to create materials,
 * set properties (color, texture, shader), assign materials to renderers,
 * and inspect material configurations.
 */
import { ToolDefinition, ToolResponse, ToolExecutor } from '../types';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import * as AssetDB from '../asset-db-wrapper';

// ── Built-in effect names (used in .mtl __uuid__ field) ──
const BUILTIN_EFFECT_UUIDS: Record<string, string> = {
    standard: 'c8f66d17-351a-48da-a12c-0212d28575c4',
    unlit:    'a3cd009f-0ab0-420d-9278-b9fdab939bbc',
    toon:     '9b20a514-6cc3-49de-b216-b6b863046249',
};

// ── Tool Executor ──────────────────────────────────────────────────────

export class MaterialTools implements ToolExecutor {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'manage_material',
                description:
                    'Create, assign, and inspect materials. Actions: ' +
                    'create (make a new .mtl asset with shader + color), ' +
                    'assign (set material on a MeshRenderer), ' +
                    'get_info (read an existing material\'s properties).',
                inputSchema: {
                    type: 'object',
                    properties: {
                        action: {
                            type: 'string',
                            enum: ['create', 'assign', 'get_info'],
                            description: 'Operation to perform',
                        },
                        // ── create ──
                        material_path: {
                            type: 'string',
                            description: 'Asset path for the material (e.g. "db://assets/materials/Red.mat"). Required for create, assign, get_info.',
                        },
                        effect: {
                            type: 'string',
                            enum: ['standard', 'unlit', 'toon'],
                            default: 'standard',
                            description: 'Shader effect to use (default: standard)',
                        },
                        color: {
                            type: 'object',
                            description: 'Main color RGBA {r,g,b,a} (0-255). Used by create.',
                            properties: {
                                r: { type: 'number' },
                                g: { type: 'number' },
                                b: { type: 'number' },
                                a: { type: 'number' },
                            },
                        },
                        // ── assign ──
                        node_uuid: {
                            type: 'string',
                            description: 'Target node UUID (required for assign)',
                        },
                        slot: {
                            type: 'number',
                            default: 0,
                            description: 'Material slot index on the renderer (default: 0)',
                        },
                    },
                    required: ['action'],
                },
            },
        ];
    }

    async execute(toolName: string, args: any): Promise<ToolResponse> {
        if (toolName !== 'manage_material') {
            throw new Error(`Unknown tool: ${toolName}`);
        }

        switch (args.action) {
            case 'create':
                return this.createMaterial(args);
            case 'assign':
                return this.assignMaterial(args);
            case 'get_info':
                return this.getMaterialInfo(args);
            default:
                return { success: false, error: `Unknown action: ${args.action}` };
        }
    }

    // ── create ──────────────────────────────────────────────────────────

    private async createMaterial(args: any): Promise<ToolResponse> {
        const materialPath = args.material_path;
        if (!materialPath) {
            return { success: false, error: 'material_path is required (e.g. "db://assets/materials/MyMat.mtl")' };
        }

        const effectName = args.effect || 'standard';
        const effectUuid = BUILTIN_EFFECT_UUIDS[effectName];
        if (!effectUuid) {
            return { success: false, error: `Unknown effect: '${effectName}'. Use: standard, unlit, toon` };
        }

        const color = args.color || { r: 200, g: 200, b: 200, a: 255 };

        // Extract material display name from path (e.g. "MyMat" from ".../MyMat.mtl")
        const displayName = materialPath.split('/').pop()?.replace('.mtl', '') || 'Material';

        // Generate standard Cocos Creator 3.8 .mtl file content
        const mtlContent = this.buildMaterialJson(displayName, effectUuid, color);

        return new Promise((resolve) => {
            try {
                // Try editor API first
                Editor.Message.request('asset-db', 'create-asset', materialPath, mtlContent)
                    .then((result: any) => {
                    resolve({
                        success: true,
                        data: {
                            path: materialPath,
                            name: displayName,
                            effect: effectName,
                            effectUuid,
                            color,
                            message: `Material '${displayName}' created at ${materialPath}`,
                        },
                    });
                    })
                    .catch(() => {
                        // Fallback: write file directly + refresh
                        this.writeMaterialFile(materialPath, mtlContent)
                            .then(() => {
                                resolve({
                                    success: true,
                                    data: {
                                        path: materialPath,
                                        name: displayName,
                                        effect: effectName,
                                        effectUuid,
                                        color,
                                        message: `Material '${displayName}' created at ${materialPath} (filesystem fallback)`,
                                    },
                                });
                            })
                            .catch((err: any) => {
                                resolve({
                                    success: false,
                                    error: `Failed to create material: ${err.message}`,
                                });
                            });
                    });
            } catch (err: any) {
                resolve({ success: false, error: err.message });
            }
        });
    }

    /**
     * Build a standard Cocos Creator 3.8 .mtl JSON string.
     * _effectAsset.__uuid__ is the effect's asset UUID.
     */
    private buildMaterialJson(name: string, effectUuid: string, color: { r: number; g: number; b: number; a: number }): string {
        const data = {
            __type__: 'cc.Material',
            _name: name,
            _objFlags: 0,
            __editorExtras__: {},
            _native: '',
            _effectAsset: { __uuid__: effectUuid },
            _techIdx: 0,
            _defines: [{ USE_ALBEDO_MAP: false }],
            _states: [{ rasterizerState: {}, depthStencilState: {}, blendState: { targets: [{}] } }],
            _props: [{
                mainColor: { __type__: 'cc.Color', r: color.r, g: color.g, b: color.b, a: color.a },
                metallic: 0.1,
                roughness: 0.8,
            }],
        };
        return JSON.stringify(data, null, 2);
    }

    private async writeMaterialFile(dbPath: string, content: string): Promise<void> {
        const relPath = dbPath.replace('db://', '');
        const absPath = path.join(Editor.Project.path, relPath);
        const dir = path.dirname(absPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(absPath, content, 'utf-8');

        // Use saveAssetMeta so importer is correctly set to "material"
        // (direct fs .meta write gets overwritten by editor)
        const metaUuid = uuidv4();
        await AssetDB.saveAssetMeta(dbPath, JSON.stringify({
            ver: '1.0.21',
            importer: 'material',
            imported: true,
            uuid: metaUuid,
            files: ['.json'],
            subMetas: {},
            userData: {},
        }));
    }

    // ── assign ──────────────────────────────────────────────────────────

    private async assignMaterial(args: any): Promise<ToolResponse> {
        const { node_uuid, material_path, slot } = args;
        if (!node_uuid) return { success: false, error: 'node_uuid is required' };
        if (!material_path) return { success: false, error: 'material_path is required' };

        // Resolve material UUID from path
        let materialUuid = material_path;
        if (material_path.startsWith('db://')) {
            try {
                const relPath = material_path.replace('db://', '');
                const metaPath = path.join(Editor.Project.path, relPath + '.meta');
                if (fs.existsSync(metaPath)) {
                    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                    materialUuid = meta.uuid || material_path;
                }
            } catch { /* use path as-is */ }
        }

        return new Promise((resolve) => {
            // Use execute-scene-script for reliable material assignment
            const options = {
                name: 'cocos-mcp-server',
                method: 'assignMaterialToRenderer',
                args: [node_uuid, materialUuid, slot || 0],
            };

                Editor.Message.request('scene', 'execute-scene-script', options)
                .then((result: any) => {
                    if (result && result.success) {
                        resolve({
                            success: true,
                            message: `Material assigned to node ${node_uuid} slot ${slot || 0}`,
                        });
                    } else {
                        resolve({
                            success: false,
                            error: `Failed to assign material: ${result?.error || 'scene script returned failure'}`,
                        });
                    }
                })
                .catch((err: any) => {
                    resolve({ success: false, error: `Failed to assign material: ${err.message}` });
                });
        });
    }

    // ── get_info ────────────────────────────────────────────────────────

    private async getMaterialInfo(args: any): Promise<ToolResponse> {
        const materialPath = args.material_path;
        if (!materialPath) return { success: false, error: 'material_path is required' };

        try {
            let absPath: string;
            if (materialPath.startsWith('db://')) {
                absPath = path.join(Editor.Project.path, materialPath.replace('db://', ''));
            } else {
                absPath = materialPath;
            }

            if (!fs.existsSync(absPath)) {
                return { success: false, error: `Material not found: ${materialPath}` };
            }

            const raw = fs.readFileSync(absPath, 'utf-8');
            const data = JSON.parse(raw);
            const mtl = Array.isArray(data) ? data[0] : data;
            const effectUuid = mtl._effectAsset?.__uuid__ || '';
            const props = mtl._props?.[0] || {};

            return {
                success: true,
                data: {
                    path: materialPath,
                    effectUuid,
                    properties: props,
                },
            };
        } catch (err: any) {
            return { success: false, error: `Failed to read material: ${err.message}` };
        }
    }
}
