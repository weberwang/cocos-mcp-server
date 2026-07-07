import assert from 'node:assert/strict';
import {
    reloadExtensionByName,
    type ReloadExtensionDeps,
} from '../tools/editor-tools';

async function run(): Promise<void> {
    const calls: string[] = [];
    let scheduledReloadPath = '';
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
        scheduleReload: (extensionPath: string) => {
            scheduledReloadPath = extensionPath;
            calls.push(`schedule:${extensionPath}`);
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
        'should schedule self reload instead of rejecting the current extension',
    );
    assert.equal(
        scheduledReloadPath,
        'D:/Extensions/cocos-mcp-server',
        'should schedule the current extension path for deferred reload',
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
            scheduleReload: undefined as any,
        }),
        /self reload is unavailable/i,
        'should reject when current extension reload lacks deferred scheduler support',
    );
}

run().then(() => {
    console.log('editor-tools-reload-extension-test: ok');
}).catch((error) => {
    console.error('editor-tools-reload-extension-test: failed');
    console.error(error);
    process.exitCode = 1;
});
