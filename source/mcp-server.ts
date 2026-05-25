import * as http from 'http';
import * as url from 'url';
import { v4 as uuidv4 } from 'uuid';
import { MCPServerSettings, ServerStatus, MCPClient, ToolDefinition } from './types';
import { SceneTools } from './tools/scene-tools';
import { NodeTools } from './tools/node-tools';
import { ComponentTools } from './tools/component-tools';
import { PrefabTools } from './tools/prefab-tools';
import { ProjectTools } from './tools/project-tools';
import { DebugTools } from './tools/debug-tools';
import { PreferencesTools } from './tools/preferences-tools';
import { ServerTools } from './tools/server-tools';
import { BroadcastTools } from './tools/broadcast-tools';
import { SceneAdvancedTools } from './tools/scene-advanced-tools';
import { SceneViewTools } from './tools/scene-view-tools';
import { ReferenceImageTools } from './tools/reference-image-tools';
import { AssetAdvancedTools } from './tools/asset-advanced-tools';
import { ValidationTools } from './tools/validation-tools';
import { EditorTools } from './tools/editor-tools';
import { BatchTools } from './tools/batch-tools';
import { ManageTools, getEnabledCategories } from './tools/tool-groups';
import { MaterialTools } from './tools/material-tools';

// 统一维护插件对外暴露的版本号，避免状态接口、能力接口和握手信息各自漂移。
const MCP_SERVER_VERSION = '1.5.1';

export class MCPServer {
    private settings: MCPServerSettings;
    private httpServer: http.Server | null = null;
    private clients: Map<string, MCPClient> = new Map();
    private tools: Record<string, any> = {};
    private toolsList: ToolDefinition[] = [];
    private enabledTools: any[] = []; // 存储启用的工具列表

    constructor(settings: MCPServerSettings) {
        this.settings = settings;
        this.initializeTools();
    }

    private initializeTools(): void {
        try {
            console.log('[MCPServer] Initializing tools...');
            this.tools.scene = new SceneTools();
            this.tools.node = new NodeTools();
            this.tools.component = new ComponentTools();
            this.tools.prefab = new PrefabTools();
            this.tools.project = new ProjectTools();
            this.tools.debug = new DebugTools();
            this.tools.preferences = new PreferencesTools();
            this.tools.server = new ServerTools();
            this.tools.broadcast = new BroadcastTools();
            this.tools.sceneAdvanced = new SceneAdvancedTools();
            this.tools.sceneView = new SceneViewTools();
            this.tools.referenceImage = new ReferenceImageTools();
            this.tools.assetAdvanced = new AssetAdvancedTools();
            this.tools.validation = new ValidationTools();
            this.tools.editor = new EditorTools();
            this.tools.batch = new BatchTools(this.executeToolCall.bind(this));
            this.tools.meta = new ManageTools();
            this.tools.material = new MaterialTools();
            console.log('[MCPServer] Tools initialized successfully');
        } catch (error) {
            console.error('[MCPServer] Error initializing tools:', error);
            throw error;
        }
    }

    public async start(): Promise<void> {
        if (this.httpServer) {
            console.log('[MCPServer] Server is already running');
            return;
        }

        try {
            console.log(`[MCPServer] Starting HTTP server on port ${this.settings.port}...`);
            this.httpServer = http.createServer(this.handleHttpRequest.bind(this));

            await new Promise<void>((resolve, reject) => {
                this.httpServer!.listen(this.settings.port, '127.0.0.1', () => {
                    console.log(`[MCPServer] ✅ HTTP server started successfully on http://127.0.0.1:${this.settings.port}`);
                    console.log(`[MCPServer] Health check: http://127.0.0.1:${this.settings.port}/health`);
                    console.log(`[MCPServer] MCP endpoint: http://127.0.0.1:${this.settings.port}/mcp`);
                    resolve();
                });
                this.httpServer!.on('error', (err: any) => {
                    console.error('[MCPServer] ❌ Failed to start server:', err);
                    if (err.code === 'EADDRINUSE') {
                        console.error(`[MCPServer] Port ${this.settings.port} is already in use. Please change the port in settings.`);
                    }
                    reject(err);
                });
            });

            this.setupTools();
            console.log('[MCPServer] 🚀 MCP Server is ready for connections');
        } catch (error) {
            console.error('[MCPServer] ❌ Failed to start server:', error);
            throw error;
        }
    }

    private setupTools(): void {
        this.toolsList = [];
        const enabledCats = getEnabledCategories();
        
        // 如果没有启用工具配置，返回所有工具（但按 group 过滤）
        if (!this.enabledTools || this.enabledTools.length === 0) {
            for (const [category, toolSet] of Object.entries(this.tools)) {
                // Skip categories not in any active group
                if (!enabledCats.has(category)) continue;
                
                const tools = toolSet.getTools();
                for (const tool of tools) {
                    this.toolsList.push({
                        name: `${category}_${tool.name}`,
                        description: tool.description,
                        inputSchema: tool.inputSchema
                    });
                }
            }
        } else {
            // 根据启用的工具配置过滤
            const enabledToolNames = new Set(this.enabledTools.map(tool => `${tool.category}_${tool.name}`));
            
            for (const [category, toolSet] of Object.entries(this.tools)) {
                if (!enabledCats.has(category)) continue;
                
                const tools = toolSet.getTools();
                for (const tool of tools) {
                    const toolName = `${category}_${tool.name}`;
                    if (enabledToolNames.has(toolName)) {
                        this.toolsList.push({
                            name: toolName,
                            description: tool.description,
                            inputSchema: tool.inputSchema
                        });
                    }
                }
            }
        }
        
        console.log(`[MCPServer] Setup tools: ${this.toolsList.length} tools available (active groups: ${[...enabledCats].join(', ')})`);
    }

    public getFilteredTools(enabledTools: any[]): ToolDefinition[] {
        if (!enabledTools || enabledTools.length === 0) {
            return this.toolsList; // 如果没有过滤配置，返回所有工具
        }

        const enabledToolNames = new Set(enabledTools.map(tool => `${tool.category}_${tool.name}`));
        return this.toolsList.filter(tool => enabledToolNames.has(tool.name));
    }

    public async executeToolCall(toolName: string, args: any): Promise<any> {
        // Apply category aliases: asset.* → project.* or assetAdvanced.*
        const aliasMap: Record<string, [string, string]> = {
            'asset_get_info': ['project', 'get_asset_info'],
            'asset_list': ['project', 'get_assets'],
            'asset_create': ['project', 'create_asset'],
            'asset_find': ['project', 'find_asset_by_name'],
            'asset_find_by_name': ['project', 'find_asset_by_name'],
            'asset_get_details': ['project', 'get_asset_details'],
            'asset_query_uuid': ['project', 'query_asset_uuid'],
            'asset_query_url': ['project', 'query_asset_url'],
            'asset_query_asset_path': ['project', 'query_asset_path'],
            'asset_create_script': ['project', 'create_script'],
            'asset_create_text_asset': ['project', 'create_text_asset'],
            'asset_delete': ['project', 'delete_asset'],
            'asset_move': ['project', 'move_asset'],
            'asset_refresh': ['project', 'refresh_assets'],
            'asset_import_asset': ['project', 'import_asset'],
            'asset_copy_asset': ['project', 'copy_asset'],
            'asset_save_asset': ['project', 'save_asset'],
            'asset_reimport_asset': ['project', 'reimport_asset'],
            'asset_read_meta': ['project', 'read_meta'],
            'asset_save_meta': ['assetAdvanced', 'save_asset_meta'],
            'asset_generate_url': ['assetAdvanced', 'generate_available_url'],
            'asset_db_ready': ['assetAdvanced', 'query_asset_db_ready'],
            'asset_open_external': ['assetAdvanced', 'open_asset_external'],
            'asset_batch_import': ['assetAdvanced', 'batch_import_assets'],
            'asset_refresh_and_wait': ['assetAdvanced', 'refresh_assets_and_wait'],
            'asset_batch_delete': ['assetAdvanced', 'batch_delete_assets'],
            'asset_validate_references': ['assetAdvanced', 'validate_asset_references'],
            'asset_get_dependencies': ['assetAdvanced', 'get_asset_dependencies'],
            'asset_get_unused': ['assetAdvanced', 'get_unused_assets'],
            'asset_compress_textures': ['assetAdvanced', 'compress_textures'],
            'asset_export_manifest': ['assetAdvanced', 'export_asset_manifest'],
            // Scene read tools
            'scene_get_current_scene': ['scene', 'get_current_scene'],
            'scene_get_scene_list': ['scene', 'get_scene_list'],
            'scene_get_scene_hierarchy': ['scene', 'get_scene_hierarchy'],
            'scene_get_hierarchy': ['scene', 'get_scene_hierarchy'],
            'scene_inspect_node': ['scene', 'inspect_node'],
            'scene_find_nodes': ['scene', 'find_nodes'],
            'scene_get_selected_nodes': ['scene', 'get_selected_nodes'],
            // Scene write
            'scene_open_scene': ['scene', 'open_scene'],
            'scene_save_scene': ['scene', 'save_scene'],
            'scene_create_scene': ['scene', 'create_scene'],
            'scene_save_scene_as': ['scene', 'save_scene_as'],
            'scene_close_scene': ['scene', 'close_scene'],
            'scene_create_node': ['scene', 'create_node'],
            'scene_update_node_transform': ['scene', 'update_node_transform'],
            'scene_update_node_properties': ['scene', 'update_node_properties'],
            'scene_delete_node': ['scene', 'delete_node'],
            'scene_manage_components': ['scene', 'manage_components'],
            // Node
            'node_get_node_info': ['node', 'get_node_info'],
            'node_create_node': ['node', 'create_node'],
            'node_find_nodes': ['node', 'find_nodes'],
            'node_find_node_by_name': ['node', 'find_node_by_name'],
            'node_get_all_nodes': ['node', 'get_all_nodes'],
            'node_set_node_property': ['node', 'set_node_property'],
            'node_set_node_transform': ['node', 'set_node_transform'],
            'node_delete_node': ['node', 'delete_node'],
            'node_move_node': ['node', 'move_node'],
            'node_duplicate_node': ['node', 'duplicate_node'],
            'node_detect_node_type': ['node', 'detect_node_type'],
            // Component
            'component_add_component': ['component', 'add_component'],
            'component_remove_component': ['component', 'remove_component'],
            'component_get_components': ['component', 'get_components'],
            'component_get_component_info': ['component', 'get_component_info'],
            'component_get_available_components': ['component', 'get_available_components'],
            'component_attach_script': ['component', 'attach_script'],
            'component_set_component_property': ['component', 'set_component_property'],
            // Prefab
            'prefab_get_prefab_list': ['prefab', 'get_prefab_list'],
            'prefab_get_prefab_info': ['prefab', 'get_prefab_info'],
            'prefab_validate_prefab': ['prefab', 'validate_prefab'],
            'prefab_load_prefab': ['prefab', 'load_prefab'],
            'prefab_duplicate_prefab': ['prefab', 'duplicate_prefab'],
            'prefab_instantiate_prefab': ['prefab', 'instantiate_prefab'],
            'prefab_create_prefab': ['prefab', 'create_prefab'],
            'prefab_update_prefab': ['prefab', 'update_prefab'],
            'prefab_revert_prefab': ['prefab', 'revert_prefab'],
            'prefab_restore_prefab_node': ['prefab', 'restore_prefab_node'],
            'prefab_create_from_node': ['prefab', 'create_from_node'],
            'prefab_instantiate': ['prefab', 'instantiate'],
            'prefab_inspect': ['prefab', 'inspect'],
            // Editor
            'editor_get_state': ['editor', 'get_state'],
            'editor_execute_menu_command': ['editor', 'execute_menu_command'],
            'editor_undo': ['editor', 'undo'],
            'editor_redo': ['editor', 'redo'],
            'editor_save_scene': ['editor', 'save_scene'],
            // Debug
            'debug_get_console_logs': ['debug', 'get_console_logs'],
            'debug_clear_console': ['debug', 'clear_console'],
            'debug_execute_script': ['debug', 'execute_script'],
            'debug_get_node_tree': ['debug', 'get_node_tree'],
            'debug_get_performance_stats': ['debug', 'get_performance_stats'],
            'debug_validate_scene': ['debug', 'validate_scene'],
            'debug_get_editor_info': ['debug', 'get_editor_info'],
            'debug_get_project_logs': ['debug', 'get_project_logs'],
            'debug_get_log_file_info': ['debug', 'get_log_file_info'],
            'debug_search_project_logs': ['debug', 'search_project_logs'],
            // Batch
            'batch_execute': ['batch', 'execute'],
            // Meta / Tool management
            'meta_manage_tools': ['meta', 'manage_tools'],
            // Material
            'material_manage_material': ['material', 'manage_material'],
        };

        if (aliasMap[toolName]) {
            const [cat, method] = aliasMap[toolName];
            if (this.tools[cat]) {
                return await this.tools[cat].execute(method, args);
            }
        }

        const parts = toolName.split('_');
        const category = parts[0];
        const toolMethodName = parts.slice(1).join('_');
        
        if (this.tools[category]) {
            return await this.tools[category].execute(toolMethodName, args);
        }
        
        throw new Error(`Tool ${toolName} not found`);
    }

    public getClients(): MCPClient[] {
        return Array.from(this.clients.values());
    }
    public getAvailableTools(): ToolDefinition[] {
        return this.toolsList;
    }

    public updateEnabledTools(enabledTools: any[]): void {
        console.log(`[MCPServer] Updating enabled tools: ${enabledTools.length} tools`);
        this.enabledTools = enabledTools;
        this.setupTools(); // 重新设置工具列表
    }

    public getSettings(): MCPServerSettings {
        return this.settings;
    }

    private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const parsedUrl = url.parse(req.url || '', true);
        const pathname = parsedUrl.pathname;
        
        // Set CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        
        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }
        
        try {
            if (pathname === '/mcp' && req.method === 'POST') {
                await this.handleMCPRequest(req, res);
            } else if (pathname === '/mcp' && req.method === 'GET') {
                res.writeHead(405);
                res.end();
            } else if (pathname === '/mcp' && req.method === 'DELETE') {
                res.writeHead(405);
                res.end();
            } else if (pathname === '/health' && req.method === 'GET') {
                res.setHeader('Content-Type', 'application/json');
                res.writeHead(200);
                res.end(JSON.stringify({ status: 'ok', tools: this.toolsList.length }));
            } else if (pathname === '/status' && req.method === 'GET') {
                res.setHeader('Content-Type', 'application/json');
                res.writeHead(200);
                res.end(JSON.stringify({
                    running: !!this.httpServer,
                    version: MCP_SERVER_VERSION,
                    creatorVersion: '3.8.8',
                    projectPath: Editor.Project?.path || '',
                    port: this.settings.port,
                    writesEnabled: false,
                    activeInstanceId: `creator-${this.settings.port}`
                }));
            } else if (pathname === '/capabilities' && req.method === 'GET') {
                res.setHeader('Content-Type', 'application/json');
                res.writeHead(200);
                res.end(JSON.stringify({
                    tools: this.toolsList.map(t => t.name),
                    writeTools: [],
                    bridgeVersion: MCP_SERVER_VERSION
                }));
            } else if (pathname === '/call-tool' && req.method === 'POST') {
                await this.handleCallToolApi(req, res);
            } else if (pathname?.startsWith('/api/') && req.method === 'POST') {
                await this.handleSimpleAPIRequest(req, res, pathname);
            } else if (pathname === '/api/tools' && req.method === 'GET') {
                res.setHeader('Content-Type', 'application/json');
                res.writeHead(200);
                res.end(JSON.stringify({ tools: this.getSimplifiedToolsList() }));
            } else {
                res.setHeader('Content-Type', 'application/json');
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Not found' }));
            }
        } catch (error) {
            console.error('HTTP request error:', error);
            res.setHeader('Content-Type', 'application/json');
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    }
    
    private async handleMCPRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        let body = '';
        
        req.on('data', (chunk) => {
            body += chunk.toString();
        });
        
        req.on('end', async () => {
            try {
                // Enhanced JSON parsing with better error handling
                let message;
                try {
                    message = JSON.parse(body);
                } catch (parseError: any) {
                    // Try to fix common JSON issues
                    const fixedBody = this.fixCommonJsonIssues(body);
                    try {
                        message = JSON.parse(fixedBody);
                        console.log('[MCPServer] Fixed JSON parsing issue');
                    } catch (secondError) {
                        throw new Error(`JSON parsing failed: ${parseError.message}. Original body: ${body.substring(0, 500)}...`);
                    }
                }
                
                if (this.isNotification(message)) {
                    await this.handleNotification(message);
                    res.writeHead(204);
                    res.end();
                    return;
                }

                const response = await this.handleMessage(message);
                res.setHeader('Content-Type', 'application/json');
                res.writeHead(200);
                res.end(JSON.stringify(response));
            } catch (error: any) {
                console.error('Error handling MCP request:', error);
                res.setHeader('Content-Type', 'application/json');
                res.writeHead(400);
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: null,
                    error: {
                        code: -32700,
                        message: `Parse error: ${error.message}`
                    }
                }));
            }
        });
    }

    private isNotification(message: any): boolean {
        return !!message
            && message.jsonrpc === '2.0'
            && typeof message.method === 'string'
            && !Object.prototype.hasOwnProperty.call(message, 'id');
    }

    private async handleNotification(message: any): Promise<void> {
        switch (message.method) {
            case 'notifications/initialized':
                console.log('[MCPServer] Client initialized notification received');
                return;
            default:
                console.warn(`[MCPServer] Ignoring unsupported notification: ${message.method}`);
        }
    }

    private async handleMessage(message: any): Promise<any> {
        const { id, method, params } = message;

        try {
            let result: any;

            switch (method) {
                case 'resources/list':
                    result = { resources: [] };
                    break;
                case 'resources/templates/list':
                    result = { resourceTemplates: [] };
                    break;
                case 'tools/list':
                    result = { tools: this.getAvailableTools() };
                    break;
                case 'tools/call':
                    const { name, arguments: args } = params;
                    const toolResult = await this.executeToolCall(name, args);
                    result = { content: [{ type: 'text', text: JSON.stringify(toolResult) }] };
                    break;
                case 'initialize':
                    // MCP initialization
                    result = {
                        protocolVersion: '2024-11-05',
                        capabilities: {
                            tools: {}
                        },
                        serverInfo: {
                            name: 'cocos-mcp-server',
                            version: MCP_SERVER_VERSION
                        }
                    };
                    break;
                default:
                    throw new Error(`Unknown method: ${method}`);
            }

            return {
                jsonrpc: '2.0',
                id,
                result
            };
        } catch (error: any) {
            return {
                jsonrpc: '2.0',
                id,
                error: {
                    code: -32603,
                    message: error.message
                }
            };
        }
    }

    private fixCommonJsonIssues(jsonStr: string): string {
        let fixed = jsonStr;
        
        // Fix common escape character issues
        fixed = fixed
            // Fix unescaped quotes in strings
            .replace(/([^\\])"([^"]*[^\\])"([^,}\]:])/g, '$1\\"$2\\"$3')
            // Fix unescaped backslashes
            .replace(/([^\\])\\([^"\\\/bfnrt])/g, '$1\\\\$2')
            // Fix trailing commas
            .replace(/,(\s*[}\]])/g, '$1')
            // Fix single quotes (should be double quotes)
            .replace(/'/g, '"')
            // Fix common control characters
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t');
        
        return fixed;
    }

    public stop(): void {
        if (this.httpServer) {
            this.httpServer.close();
            this.httpServer = null;
            console.log('[MCPServer] HTTP server stopped');
        }

        this.clients.clear();
    }

    public getStatus(): ServerStatus {
        return {
            running: !!this.httpServer,
            port: this.settings.port,
            clients: 0 // HTTP is stateless, no persistent clients
        };
    }

    private async handleSimpleAPIRequest(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
        let body = '';
        
        req.on('data', (chunk) => {
            body += chunk.toString();
        });
        
        req.on('end', async () => {
            try {
                // Extract tool name from path like /api/node/set_position
                const pathParts = pathname.split('/').filter(p => p);
                if (pathParts.length < 3) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Invalid API path. Use /api/{category}/{tool_name}' }));
                    return;
                }
                
                const category = pathParts[1];
                const toolName = pathParts[2];
                const fullToolName = `${category}_${toolName}`;
                
                // Parse parameters with enhanced error handling
                let params;
                try {
                    params = body ? JSON.parse(body) : {};
                } catch (parseError: any) {
                    // Try to fix JSON issues
                    const fixedBody = this.fixCommonJsonIssues(body);
                    try {
                        params = JSON.parse(fixedBody);
                        console.log('[MCPServer] Fixed API JSON parsing issue');
                    } catch (secondError: any) {
                        res.writeHead(400);
                        res.end(JSON.stringify({
                            error: 'Invalid JSON in request body',
                            details: parseError.message,
                            receivedBody: body.substring(0, 200)
                        }));
                        return;
                    }
                }
                
                // Execute tool
                const result = await this.executeToolCall(fullToolName, params);
                
                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    tool: fullToolName,
                    result: result
                }));
                
            } catch (error: any) {
                console.error('Simple API error:', error);
                res.writeHead(500);
                res.end(JSON.stringify({
                    success: false,
                    error: error.message,
                    tool: pathname
                }));
            }
        });
    }

    private getSimplifiedToolsList(): any[] {
        return this.toolsList.map(tool => {
            const parts = tool.name.split('_');
            const category = parts[0];
            const toolName = parts.slice(1).join('_');
            
            return {
                name: tool.name,
                category: category,
                toolName: toolName,
                description: tool.description,
                apiPath: `/api/${category}/${toolName}`,
                curlExample: this.generateCurlExample(category, toolName, tool.inputSchema)
            };
        });
    }

    private generateCurlExample(category: string, toolName: string, schema: any): string {
        // Generate sample parameters based on schema
        const sampleParams = this.generateSampleParams(schema);
        const jsonString = JSON.stringify(sampleParams, null, 2);
        
        return `curl -X POST http://127.0.0.1:8585/api/${category}/${toolName} \\
  -H "Content-Type: application/json" \\
  -d '${jsonString}'`;
    }

    private generateSampleParams(schema: any): any {
        if (!schema || !schema.properties) return {};
        
        const sample: any = {};
        for (const [key, prop] of Object.entries(schema.properties as any)) {
            const propSchema = prop as any;
            switch (propSchema.type) {
                case 'string':
                    sample[key] = propSchema.default || 'example_string';
                    break;
                case 'number':
                    sample[key] = propSchema.default || 42;
                    break;
                case 'boolean':
                    sample[key] = propSchema.default || true;
                    break;
                case 'object':
                    sample[key] = propSchema.default || { x: 0, y: 0, z: 0 };
                    break;
                default:
                    sample[key] = 'example_value';
            }
        }
        return sample;
    }

    private async handleCallToolApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', async () => {
            const startMs = Date.now();
            try {
                const { tool, args } = JSON.parse(body);
                // MCP server sends dot notation (scene.get_scene_list), convert to underscore
                const toolName = (tool || '').replace(/\./g, '_');
                const result = await this.executeToolCall(toolName, args || {});
                res.writeHead(200);
                res.end(JSON.stringify({
                    ok: true,
                    data: result,
                    meta: { durationMs: Date.now() - startMs }
                }));
            } catch (err: any) {
                res.writeHead(200);
                res.end(JSON.stringify({
                    ok: false,
                    error: { code: 'ERR_INTERNAL', message: err.message || String(err) },
                    meta: { durationMs: Date.now() - startMs }
                }));
            }
        });
    }

    public updateSettings(settings: MCPServerSettings) {
        this.settings = settings;
        if (this.httpServer) {
            this.stop();
            this.start();
        }
    }
}

// HTTP transport doesn't need persistent connections
// MCP over HTTP uses request-response pattern
