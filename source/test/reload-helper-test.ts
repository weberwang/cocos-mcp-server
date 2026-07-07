import assert from 'node:assert/strict';
import path from 'node:path';
import {
    DEFAULT_EXTENSION_SELF_RELOAD_DELAY_MS,
    RELOAD_HELPER_EXTENSION_NAME,
    ensureReloadHelperExtension,
    requestCurrentExtensionReload,
    resolveBundledReloadHelperPath,
    type EnsureReloadHelperExtensionDeps,
    type RequestCurrentExtensionReloadDeps,
} from '../reload-helper';

async function run(): Promise<void> {
    const currentExtensionPath = 'D:/Projects/Cocos/MyGame/extensions/cocos-mcp-server';
    assert.equal(
        resolveBundledReloadHelperPath(currentExtensionPath),
        path.join(currentExtensionPath, 'support-packages', RELOAD_HELPER_EXTENSION_NAME),
        'should resolve bundled helper under support-packages directory',
    );

    const calls: string[] = [];
    const registerDeps: EnsureReloadHelperExtensionDeps = {
        getExtensionPath: (extensionName: string) => {
            calls.push(`get:${extensionName}`);
            return extensionName === RELOAD_HELPER_EXTENSION_NAME ? undefined : undefined;
        },
        registerExtension: (extensionPath: string) => {
            calls.push(`register:${extensionPath}`);
        },
        enableExtension: (extensionPath: string) => {
            calls.push(`enable:${extensionPath}`);
        },
    };

    const ensureResult = ensureReloadHelperExtension(currentExtensionPath, registerDeps);
    assert.equal(ensureResult.registered, true, 'should register helper when helper extension is not yet known');
    assert.equal(
        ensureResult.helperPath,
        path.join(currentExtensionPath, 'support-packages', RELOAD_HELPER_EXTENSION_NAME),
        'should use bundled helper path when helper is not registered yet',
    );
    assert.deepEqual(
        calls,
        [
            `get:${RELOAD_HELPER_EXTENSION_NAME}`,
            `register:${ensureResult.helperPath}`,
            `enable:${ensureResult.helperPath}`,
        ],
        'should register and enable helper extension in order',
    );

    const ensureExistingResult = ensureReloadHelperExtension(currentExtensionPath, {
        getExtensionPath: () => 'D:/ExistingHelper',
        registerExtension: () => {
            throw new Error('register should not be called when helper already exists');
        },
        enableExtension: (extensionPath: string) => {
            assert.equal(extensionPath, 'D:/ExistingHelper');
        },
    });
    assert.equal(ensureExistingResult.registered, false, 'should reuse existing helper registration');

    let requestArgs: { helperName: string; extensionName: string; delayMs: number } | null = null;
    const requestDeps: RequestCurrentExtensionReloadDeps = {
        requestReload: async (helperName: string, extensionName: string, delayMs: number) => {
            requestArgs = { helperName, extensionName, delayMs };
            return {
                success: true,
                data: {
                    extensionName,
                    extensionPath: 'D:/Projects/Cocos/MyGame/extensions/cocos-mcp-server',
                    scheduled: true,
                },
            };
        },
    };

    const requestResult = await requestCurrentExtensionReload(
        'cocos-mcp-server',
        'D:/Projects/Cocos/MyGame/extensions/cocos-mcp-server',
        requestDeps,
    );
    assert.deepEqual(
        requestArgs,
        {
            helperName: RELOAD_HELPER_EXTENSION_NAME,
            extensionName: 'cocos-mcp-server',
            delayMs: DEFAULT_EXTENSION_SELF_RELOAD_DELAY_MS,
        },
        'should forward self reload request to helper with default delay',
    );
    assert.deepEqual(
        requestResult,
        {
            extensionName: 'cocos-mcp-server',
            extensionPath: 'D:/Projects/Cocos/MyGame/extensions/cocos-mcp-server',
            scheduled: true,
        },
        'should normalize helper response into reload result',
    );
}

run().then(() => {
    console.log('reload-helper-test: ok');
}).catch((error) => {
    console.error('reload-helper-test: failed');
    console.error(error);
    process.exitCode = 1;
});
