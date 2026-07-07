import assert from 'node:assert/strict';
import {
    reloadExtensionByName,
    type ReloadExtensionDeps,
} from '../tools/editor-tools';

async function run(): Promise<void> {
    const calls: string[] = [];
    const deps: ReloadExtensionDeps = {
        getExtensionPath: (extensionName: string) => {
            calls.push(`get:${extensionName}`);
            return `D:/Extensions/${extensionName}`;
        },
        disableExtension: (extensionPath: string) => {
            calls.push(`disable:${extensionPath}`);
        },
        enableExtension: (extensionPath: string) => {
            calls.push(`enable:${extensionPath}`);
        },
        reloadCurrentExtension: async (extensionName: string, extensionPath: string) => {
            calls.push(`helper:${extensionName}:${extensionPath}`);
            return {
                extensionName,
                extensionPath,
                scheduled: true,
            };
        },
    };

    const reloadResult = await reloadExtensionByName('other-extension', 'cocos-mcp-server', deps);
    assert.deepEqual(
        reloadResult,
        {
            extensionName: 'other-extension',
            extensionPath: 'D:/Extensions/other-extension',
        },
        'should return resolved extension info after disable/enable reload',
    );
    assert.deepEqual(
        calls,
        [
            'get:other-extension',
            'disable:D:/Extensions/other-extension',
            'enable:D:/Extensions/other-extension',
        ],
        'should reload extension by disabling and enabling the resolved path',
    );

    const selfReloadResult = await reloadExtensionByName('cocos-mcp-server', 'cocos-mcp-server', deps);
    assert.deepEqual(
        selfReloadResult,
        {
            extensionName: 'cocos-mcp-server',
            extensionPath: 'D:/Extensions/cocos-mcp-server',
            scheduled: true,
        },
        'should delegate current extension reload to helper flow instead of direct disable/enable',
    );
    assert.equal(
        calls.includes('helper:cocos-mcp-server:D:/Extensions/cocos-mcp-server'),
        true,
        'should route current extension reload through helper implementation',
    );

    await assert.rejects(
        () => reloadExtensionByName('missing-extension', 'cocos-mcp-server', {
            ...deps,
            getExtensionPath: () => undefined,
        }),
        /extension not found/i,
        'should reject when the target extension path cannot be resolved',
    );

    await assert.rejects(
        () => reloadExtensionByName('cocos-mcp-server', 'cocos-mcp-server', {
            ...deps,
            reloadCurrentExtension: undefined as any,
        }),
        /current extension reload is unavailable/i,
        'should reject when current extension helper reload support is unavailable',
    );
}

run().then(() => {
    console.log('editor-tools-reload-extension-test: ok');
}).catch((error) => {
    console.error('editor-tools-reload-extension-test: failed');
    console.error(error);
    process.exitCode = 1;
});
