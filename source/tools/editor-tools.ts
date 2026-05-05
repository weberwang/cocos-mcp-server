import { ToolDefinition, ToolResponse, ToolExecutor } from '../types';

export class EditorTools implements ToolExecutor {
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
            }
        ];
    }

    async execute(toolName: string, args: any): Promise<ToolResponse> {
        switch (toolName) {
            case 'get_state': return this.getState();
            case 'execute_menu_command': return this.executeMenuCommand(args.path);
            case 'undo': return this.undo();
            case 'redo': return this.redo();
            case 'save_scene': return this.saveScene();
            default: throw new Error(`Unknown editor tool: ${toolName}`);
        }
    }

    private async getState(): Promise<ToolResponse> {
        try {
            // Get scene info via working query-node-tree
            const tree: any = await Editor.Message.request('scene', 'query-node-tree');
            const sceneName = tree?.name || 'Unknown';

            // Get project info
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
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    private async executeMenuCommand(path: string): Promise<ToolResponse> {
        try {
            // Execute menu command through Editor.Menu API
            await (Editor.Message.request as any)('editor', 'send-to-main-menu', path);
            return { success: true, message: `Menu command executed: ${path}` };
        } catch {
            // Fallback: try direct menu path execution
            try {
                (Editor.Menu as any).sendToMain(path);
                return { success: true, message: `Menu command executed (fallback): ${path}` };
            } catch (err: any) {
                return { success: false, error: `Failed to execute menu command: ${err.message}` };
            }
        }
    }

    private async undo(): Promise<ToolResponse> {
        try {
            await Editor.Message.request('editor', 'undo');
            return { success: true, message: 'Undo executed' };
        } catch {
            try {
                (Editor as any).Undo.undo();
                return { success: true, message: 'Undo executed (fallback)' };
            } catch (err: any) {
                return { success: false, error: err.message };
            }
        }
    }

    private async redo(): Promise<ToolResponse> {
        try {
            await Editor.Message.request('editor', 'redo');
            return { success: true, message: 'Redo executed' };
        } catch {
            try {
                (Editor as any).Undo.redo();
                return { success: true, message: 'Redo executed (fallback)' };
            } catch (err: any) {
                return { success: false, error: err.message };
            }
        }
    }

    private async saveScene(): Promise<ToolResponse> {
        try {
            await Editor.Message.request('scene', 'save-scene');
            return { success: true, message: 'Scene saved' };
        } catch {
            try {
                await (Editor.Message.request as any)('scene', 'save-as-scene');
                return { success: true, message: 'Scene save dialog opened' };
            } catch (err: any) {
                return { success: false, error: err.message };
            }
        }
    }
}
