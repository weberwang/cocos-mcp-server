/**
 * Tool Group Management
 *
 * Modeled after Unity-MCP's manage_tools, this enables runtime toggling
 * of tool categories to reduce AI context pollution. Only "core" tools
 * are enabled by default; advanced domains must be explicitly activated.
 */
import { ToolDefinition, ToolResponse, ToolExecutor } from '../types';

// ── Group definitions ──────────────────────────────────────────────────

export interface ToolGroup {
    name: string;
    label: string;
    description: string;
    categories: string[];   // Maps to tool prefix categories (node, scene, etc.)
}

export const TOOL_GROUPS: ToolGroup[] = [
    { name: 'core',        label: 'Core',        description: 'Essential tools (always enabled)',         categories: ['scene', 'node', 'material'] },
    { name: 'component',   label: 'Components',  description: 'Component add/remove/property management', categories: ['component'] },
    { name: 'prefab',      label: 'Prefabs',     description: 'Prefab creation, instantiation, editing',  categories: ['prefab'] },
    { name: 'asset',       label: 'Assets',      description: 'Asset CRUD, import, analysis',             categories: ['project', 'assetAdvanced'] },
    { name: 'debug',       label: 'Debugging',   description: 'Console, logs, performance, validation',   categories: ['debug', 'validation'] },
    { name: 'editor',      label: 'Editor',      description: 'Editor state, menu commands, undo/redo',   categories: ['editor', 'sceneView', 'sceneAdvanced'] },
    { name: 'preferences', label: 'Preferences', description: 'Editor preferences and settings',           categories: ['preferences'] },
    { name: 'server',      label: 'Server',      description: 'Server status, network, broadcast',        categories: ['server', 'broadcast'] },
    { name: 'reference',   label: 'Reference Images', description: 'Reference image management',          categories: ['referenceImage'] },
    { name: 'batch',       label: 'Batch',       description: 'Batch execution for multi-command ops',    categories: ['batch'] },
];

// ── In-memory active group state ────────────────────────────────────────

let _activeGroups: Set<string> | null = null;

function getActiveGroups(): Set<string> {
    if (!_activeGroups) {
        // Default: only essential groups (prevents AI context pollution)
        _activeGroups = new Set(['core', 'component', 'prefab', 'asset', 'debug', 'editor', 'batch']);
    }
    return _activeGroups;
}

export function getEnabledCategories(): Set<string> {
    const groups = getActiveGroups();
    const categories = new Set<string>();
    for (const group of TOOL_GROUPS) {
        if (groups.has(group.name)) {
            for (const cat of group.categories) {
                categories.add(cat);
            }
        }
    }
    return categories;
}

export function isGroupActive(groupName: string): boolean {
    return getActiveGroups().has(groupName);
}

export function activateGroup(groupName: string): boolean {
    if (!TOOL_GROUPS.find(g => g.name === groupName)) return false;
    getActiveGroups().add(groupName);
    return true;
}

export function deactivateGroup(groupName: string): boolean {
    if (groupName === 'core') return false; // core cannot be deactivated
    return getActiveGroups().delete(groupName);
}

export function resetGroups(): void {
    _activeGroups = new Set(TOOL_GROUPS.map(g => g.name));
}

// ── MCP Tool: manage_tools ─────────────────────────────────────────────

export class ManageTools implements ToolExecutor {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'manage_tools',
                description:
                    'Manage which tool groups are visible in this session. ' +
                    'Use to reduce AI context pollution by disabling unused tool domains. ' +
                    'Actions: list_groups (show all), activate (enable a group), ' +
                    'deactivate (disable a group), reset (restore defaults).',
                inputSchema: {
                    type: 'object',
                    properties: {
                        action: {
                            type: 'string',
                            enum: ['list_groups', 'activate', 'deactivate', 'reset'],
                            description: 'Action to perform',
                        },
                        group: {
                            type: 'string',
                            description: 'Group name (required for activate/deactivate)',
                        },
                    },
                    required: ['action'],
                },
            },
        ];
    }

    async execute(toolName: string, args: any): Promise<ToolResponse> {
        if (toolName !== 'manage_tools') {
            throw new Error(`Unknown tool: ${toolName}`);
        }

        switch (args.action) {
            case 'list_groups':
                return {
                    success: true,
                    data: {
                        groups: TOOL_GROUPS.map(g => ({
                            name: g.name,
                            label: g.label,
                            description: g.description,
                            active: isGroupActive(g.name),
                        })),
                    },
                };
            case 'activate':
                if (!args.group) return { success: false, error: 'Missing group name' };
                if (activateGroup(args.group)) {
                    return { success: true, message: `Group '${args.group}' activated. Restart or refresh tools to apply.` };
                }
                return { success: false, error: `Unknown group: '${args.group}'` };
            case 'deactivate':
                if (!args.group) return { success: false, error: 'Missing group name' };
                if (args.group === 'core') return { success: false, error: 'Core group cannot be deactivated' };
                if (deactivateGroup(args.group)) {
                    return { success: true, message: `Group '${args.group}' deactivated. Restart or refresh tools to apply.` };
                }
                return { success: false, error: `Unknown group: '${args.group}'` };
            case 'reset':
                resetGroups();
                return { success: true, message: 'All groups reset to defaults' };
            default:
                return { success: false, error: `Unknown action: ${args.action}` };
        }
    }
}
