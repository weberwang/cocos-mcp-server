import { ToolDefinition, ToolResponse, ToolExecutor } from '../types';
import * as AssetDB from '../asset-db-wrapper';

/**
 * Batch execution tool — executes multiple MCP commands in a single HTTP
 * round-trip. Modeled after Unity-MCP's batch_execute, this dramatically
 * reduces latency for multi-object scene creation (e.g. 5 primitives in
 * one call instead of 5 separate requests).
 * 
 * Supports auto_refresh: when enabled, triggers a full asset-db refresh
 * after all commands complete, ensuring .meta files and compilation settle.
 */
export class BatchTools implements ToolExecutor {
    private executor: (toolName: string, args: any) => Promise<any>;

    /**
     * @param executor  A function that dispatches an individual tool call.
     *                  This is the MCPServer's executeToolCall — we call it
     *                  recursively for each command in the batch.
     */
    constructor(executor: (toolName: string, args: any) => Promise<any>) {
        this.executor = executor;
    }

    getTools(): ToolDefinition[] {
        return [
            {
                name: 'execute',
                description:
                    'Execute multiple MCP commands in a single batch for dramatically better performance. ' +
                    'STRONGLY RECOMMENDED when creating/modifying multiple objects, adding components to ' +
                    'multiple targets, or performing any repetitive operations. Reduces latency by up to ' +
                    '10x compared to sequential tool calls. Max 25 commands per batch by default.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        commands: {
                            type: 'array',
                            description: 'List of commands with "tool" and "arguments" keys.',
                            items: {
                                type: 'object',
                                properties: {
                                    tool: {
                                        type: 'string',
                                        description:
                                            'The MCP tool name (e.g. "node_create_node", "component_add_component")',
                                    },
                                    arguments: {
                                        type: 'object',
                                        description: 'Arguments for the tool call',
                                    },
                                },
                                required: ['tool', 'arguments'],
                            },
                        },
                        fail_fast: {
                            type: 'boolean',
                            default: true,
                            description: 'Stop processing after the first failure. Set to false to continue on errors.',
                        },
                        max_commands: {
                            type: 'number',
                            default: 25,
                            description: 'Maximum commands allowed in this batch (hard max: 100)',
                        },
                        auto_refresh: {
                            type: 'boolean',
                            default: false,
                            description: 'After all commands complete, trigger a full asset-db refresh to generate .meta files and wait for script compilation. Enable when batch includes asset creation (create_asset, save_asset, import_asset, create_scene, create_prefab, etc.).',
                        },
                        refresh_folder: {
                            type: 'string',
                            description: 'Asset folder to refresh after batch (default: all assets). Only used when auto_refresh is true.',
                        },
                    },
                    required: ['commands'],
                },
            },
        ];
    }

    async execute(toolName: string, args: any): Promise<ToolResponse> {
        if (toolName !== 'execute') {
            throw new Error(`Unknown batch tool: ${toolName}`);
        }
        return this.batchExecute(args);
    }

    private async batchExecute(args: any): Promise<ToolResponse> {
        const commands: Array<{ tool: string; arguments: any }> = args.commands;
        if (!Array.isArray(commands) || commands.length === 0) {
            return { success: false, error: 'commands array is required and must be non-empty' };
        }

        const maxCommands = Math.min(args.max_commands || 25, 100);
        if (commands.length > maxCommands) {
            return {
                success: false,
                error: `Too many commands: ${commands.length} (max: ${maxCommands})`,
            };
        }

        const failFast = args.fail_fast !== false; // default: true
        const results: any[] = [];
        const errors: any[] = [];
        const startTime = Date.now();

        for (let i = 0; i < commands.length; i++) {
            const cmd = commands[i];
            try {
                const toolResult = await this.executor(cmd.tool, cmd.arguments);
                results.push({
                    index: i,
                    tool: cmd.tool,
                    result: toolResult,
                });

                // If the tool returned an error and fail_fast is on, stop
                if (failFast && !toolResult.success) {
                    return {
                        success: false,
                        error: `Batch failed at command ${i} ("${cmd.tool}"): ${toolResult.error || 'unknown error'}`,
                        data: {
                            results,
                            errors: [{ index: i, tool: cmd.tool, error: toolResult.error }],
                            executed: i + 1,
                            total: commands.length,
                            durationMs: Date.now() - startTime,
                        },
                    };
                }
            } catch (err: any) {
                const errorMsg = err?.message || String(err);
                errors.push({ index: i, tool: cmd.tool, error: errorMsg });

                if (failFast) {
                    return {
                        success: false,
                        error: `Batch failed at command ${i} ("${cmd.tool}"): ${errorMsg}`,
                        data: {
                            results,
                            errors,
                            executed: i + 1,
                            total: commands.length,
                            durationMs: Date.now() - startTime,
                        },
                    };
                }
                // Otherwise, continue to next command
            }
        }

        const success = errors.length === 0;
        const response: ToolResponse = {
            success,
            message: success
                ? `All ${commands.length} commands executed successfully`
                : `${results.length} succeeded, ${errors.length} failed out of ${commands.length} total`,
            data: {
                results,
                errors,
                executed: commands.length,
                total: commands.length,
                durationMs: Date.now() - startTime,
            },
        };

        // Post-batch refresh: ensure .meta files and script compilation complete
        if (args.auto_refresh) {
            try {
                const folder = args.refresh_folder || undefined;
                console.log(`[BatchTools] Auto-refreshing assets${folder ? ` in ${folder}` : ''}...`);
                await AssetDB.refreshAllAssets(folder);
                response.data!.refreshCompleted = true;
                response.data!.refreshedFolder = folder || 'db://assets';
            } catch (refreshErr: any) {
                response.data!.refreshCompleted = false;
                response.data!.refreshError = refreshErr?.message || String(refreshErr);
                console.warn(`[BatchTools] Auto-refresh failed: ${refreshErr?.message || refreshErr}`);
            }
        }

        return response;
    }
}
