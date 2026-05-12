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

const OPEN_CODE_SCHEMA = 'https://opencode.ai/config.json';
const MCP_SERVER_NAME = 'cocos-mcp';
const COMMAND_NAME = 'node';

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

function upsertTomlMcpServerBlock(
    existingContent: string,
    serverName: string,
    lines: string[],
): string {
    const trimmed = existingContent.replace(/\s+$/, '');
    const header = `[mcp_servers.${serverName}]`;
    const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const blockPattern = new RegExp(`(?:^|\\n)${escapedHeader}\\n(?:[^\\[]*(?:\\n|$))*`, 'm');
    const newBlock = `${header}\n${lines.join('\n')}`;

    if (blockPattern.test(trimmed)) {
        return trimmed.replace(blockPattern, (match) => {
            const prefix = match.startsWith('\n') ? '\n' : '';
            return `${prefix}${newBlock}\n`;
        }).replace(/\s+$/, '') + '\n';
    }

    const hasMcpSection = /\[mcp_servers\]/.test(trimmed);
    let nextContent = trimmed;
    if (!hasMcpSection) {
        nextContent = nextContent ? `${nextContent}\n\n[mcp_servers]` : '[mcp_servers]';
    }

    return `${nextContent}\n\n${newBlock}\n`;
}

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

function writeCodexConfig(configPath: string, adapterPath: string): void {
    const existingContent = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    const blockLines = [
        'type = "stdio"',
        `command = ${formatTomlString(COMMAND_NAME)}`,
        `args = ${formatTomlArray([adapterPath])}`,
    ];

    const nextContent = upsertTomlMcpServerBlock(existingContent, MCP_SERVER_NAME, blockLines);
    fs.writeFileSync(configPath, nextContent);
}

function configureSingleClient(target: 'opencode' | 'codex', location: ConfigLocation): ConfigureClientResult {
    const adapterAbsolutePath = getProjectAdapterPath();
    ensureAdapterExists(adapterAbsolutePath);

    const adapterPath = getProjectRelativeAdapterPath(adapterAbsolutePath);
    const configPath = target === 'opencode'
        ? getOpenCodeConfigPath(location)
        : getCodexConfigPath(location);

    ensureParentDirectoryExists(configPath);

    if (target === 'opencode') {
        writeOpenCodeConfig(configPath, adapterPath);
    } else {
        writeCodexConfig(configPath, adapterPath);
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
