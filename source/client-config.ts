import * as fs from 'node:fs';
import * as path from 'node:path';

export type AIClientTarget = 'opencode' | 'codex' | 'all';
export type ConfigLocation = 'local' | 'global';

interface ConfigureClientResult {
    client: 'opencode' | 'codex';
    path: string;
}

interface ConfigureClientsResponse {
    success: boolean;
    paths?: ConfigureClientResult[];
    path?: string;
    message?: string;
    error?: string;
}

/**
 * 项目内 MCP 服务配置。
 * 这里只读取 Codex 接入所需的最小字段，避免把面板配置和客户端写入逻辑耦得过深。
 */
interface McpServerProjectSettings {
    port?: number;
}

const OPEN_CODE_SCHEMA = 'https://opencode.ai/config.json';
const MCP_SERVER_NAME = 'cocos-mcp';
const COMMAND_NAME = 'node';
const DEFAULT_MCP_PORT = 9527;

function getProjectAdapterPath(): string {
    return path.join(Editor.Project.path, 'extensions', 'cocos-mcp-server', 'stdio-adapter', 'build', 'index.js');
}

function ensureAdapterExists(adapterPath: string): void {
    if (!fs.existsSync(adapterPath)) {
        throw new Error(
            `Missing stdio adapter: ${adapterPath}\nRun npm run build in extensions/cocos-mcp-server/stdio-adapter first.`,
        );
    }
}

function getProjectRelativeAdapterPath(adapterPath: string): string {
    return path.relative(Editor.Project.path, adapterPath).replace(/\\/g, '/');
}

function getOpenCodeConfigPath(location: ConfigLocation): string {
    if (location === 'global') {
        const home = process.env.USERPROFILE || process.env.HOME || '~';
        return path.join(home, '.config', 'opencode', 'opencode.json');
    }

    return path.join(Editor.Project.path, 'opencode.json');
}

function getCodexConfigPath(location: ConfigLocation): string {
    if (location === 'global') {
        const home = process.env.USERPROFILE || process.env.HOME || '~';
        return path.join(home, '.codex', 'config.toml');
    }

    return path.join(Editor.Project.path, '.codex', 'config.toml');
}

function ensureParentDirectoryExists(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function readJsonConfig(filePath: string, fallback: Record<string, unknown>): Record<string, unknown> {
    if (!fs.existsSync(filePath)) {
        return { ...fallback };
    }

    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        console.warn(`[MCP] Failed to parse JSON config, recreating: ${filePath}`, error);
        return { ...fallback };
    }
}

function formatTomlString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function formatTomlArray(values: string[]): string {
    return `[${values.map(formatTomlString).join(', ')}]`;
}

/**
 * 读取项目当前保存的 MCP 端口。
 * HTTP 与 stdio 两种接入都会依赖这个端口，因此统一从项目设置里读取。
 */
function getProjectMcpPort(): string {
    const settingsPath = path.join(Editor.Project.path, 'settings', 'mcp-server.json');
    if (!fs.existsSync(settingsPath)) {
        return String(DEFAULT_MCP_PORT);
    }

    try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as McpServerProjectSettings;
        if (typeof settings.port === 'number' && Number.isInteger(settings.port) && settings.port > 0) {
            return String(settings.port);
        }
    } catch (error) {
        console.warn(`[MCP] Failed to parse server settings, using default port: ${settingsPath}`, error);
    }

    return String(DEFAULT_MCP_PORT);
}

/**
 * 生成项目当前 MCP HTTP 地址。
 * Codex 原生支持 HTTP MCP，这里优先输出直连地址，避免再经过 stdio 适配层。
 */
function getProjectMcpUrl(): string {
    return `http://127.0.0.1:${getProjectMcpPort()}/mcp`;
}

/**
 * 在 TOML 中更新指定 MCP 服务器块，同时覆盖它的子表，例如 `.env`。
 * 这样再次写入时不会残留旧协议配置或旧子表。
 */
function upsertTomlMcpServerBlock(
    existingContent: string,
    serverName: string,
    lines: string[],
): string {
    const header = `[mcp_servers.${serverName}]`;
    const sectionName = `mcp_servers.${serverName}`;
    const normalizedContent = existingContent.replace(/\r\n/g, '\n').replace(/\s+$/, '');
    const sourceLines = normalizedContent ? normalizedContent.split('\n') : [];
    const newBlockLines = [header, ...lines];

    const parseSectionName = (line: string): string | null => {
        const match = line.match(/^\[([^\]]+)\]$/);
        return match ? match[1] : null;
    };

    let blockStart = -1;
    let blockEnd = sourceLines.length;

    for (let index = 0; index < sourceLines.length; index += 1) {
        const section = parseSectionName(sourceLines[index]);
        if (!section) {
            continue;
        }

        if (section === sectionName) {
            blockStart = index;
            for (let cursor = index + 1; cursor < sourceLines.length; cursor += 1) {
                const nextSection = parseSectionName(sourceLines[cursor]);
                if (nextSection && nextSection !== sectionName && !nextSection.startsWith(`${sectionName}.`)) {
                    blockEnd = cursor;
                    break;
                }
            }
            break;
        }
    }

    if (blockStart >= 0) {
        const updatedLines = [
            ...sourceLines.slice(0, blockStart),
            ...newBlockLines,
            ...sourceLines.slice(blockEnd),
        ];
        return `${updatedLines.join('\n').replace(/\s+$/, '')}\n`;
    }

    const hasMcpSection = sourceLines.some((line) => line.trim() === '[mcp_servers]');
    const appendedLines = [...sourceLines];

    if (!hasMcpSection) {
        if (appendedLines.length > 0 && appendedLines[appendedLines.length - 1].trim() !== '') {
            appendedLines.push('');
        }
        appendedLines.push('[mcp_servers]', '');
    } else if (appendedLines.length > 0 && appendedLines[appendedLines.length - 1].trim() !== '') {
        appendedLines.push('');
    }

    appendedLines.push(...newBlockLines);
    return `${appendedLines.join('\n').replace(/\s+$/, '')}\n`;
}

/**
 * 写入 OpenCode 配置。
 * 这里保持原有结构，只负责把 stdio 适配器注册给 OpenCode。
 */
function writeOpenCodeConfig(configPath: string, adapterPath: string): void {
    const config = readJsonConfig(configPath, { $schema: OPEN_CODE_SCHEMA });
    const normalizedConfig = { ...config, $schema: OPEN_CODE_SCHEMA } as Record<string, any>;

    normalizedConfig.mcp = {
        ...(normalizedConfig.mcp || {}),
        [MCP_SERVER_NAME]: {
            type: 'local',
            command: [COMMAND_NAME, adapterPath],
            enabled: true,
            timeout: 30000,
        },
    };

    fs.writeFileSync(configPath, JSON.stringify(normalizedConfig, null, 2));
}

/**
 * 写入 Codex 项目配置。
 * Codex 直接使用 HTTP MCP，避免依赖额外的 stdio 适配器构建产物。
 */
function writeCodexConfig(configPath: string): void {
    const existingContent = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    const blockLines = [
        `url = ${formatTomlString(getProjectMcpUrl())}`,
    ];

    const nextContent = upsertTomlMcpServerBlock(existingContent, MCP_SERVER_NAME, blockLines);
    fs.writeFileSync(configPath, nextContent);
}

/**
 * 按客户端类型写入配置。
 * OpenCode 继续走本地 stdio 代理；Codex 则改为直接写入 HTTP MCP 地址。
 */
function configureSingleClient(target: 'opencode' | 'codex', location: ConfigLocation): ConfigureClientResult {
    const configPath = target === 'opencode'
        ? getOpenCodeConfigPath(location)
        : getCodexConfigPath(location);

    ensureParentDirectoryExists(configPath);

    if (target === 'opencode') {
        const adapterAbsolutePath = getProjectAdapterPath();
        ensureAdapterExists(adapterAbsolutePath);
        const adapterPath = getProjectRelativeAdapterPath(adapterAbsolutePath);
        writeOpenCodeConfig(configPath, adapterPath);
    } else {
        writeCodexConfig(configPath);
    }

    return {
        client: target,
        path: configPath,
    };
}

export function configureAIClients(target: AIClientTarget, location: ConfigLocation): ConfigureClientsResponse {
    try {
        const targets: Array<'opencode' | 'codex'> = target === 'all' ? ['opencode', 'codex'] : [target];
        const results = targets.map((client) => configureSingleClient(client, location));

        return {
            success: true,
            path: results.length === 1 ? results[0].path : undefined,
            paths: results,
            message: results
                .map((item) => `${item.client}: ${item.path}`)
                .join('\n'),
        };
    } catch (error: any) {
        return {
            success: false,
            error: error?.message ?? 'Configuration failed: unknown error',
        };
    }
}
