import assert from 'node:assert/strict';
import { throwIfAssetExists, ensureCreatedAssetIsReady } from '../asset-db-wrapper';
import {
    buildSceneAssetUrl,
    createSceneAsset,
    planSceneSwitchGuard,
} from '../tools/scene-tools';

async function run(): Promise<void> {
    assert.equal(
        buildSceneAssetUrl('db://assets/scenes', 'MainScene'),
        'db://assets/scenes/MainScene.scene',
        'should append scene name when savePath is a folder'
    );

    assert.equal(
        buildSceneAssetUrl('db://assets/scenes/', 'MainScene'),
        'db://assets/scenes/MainScene.scene',
        'should normalize trailing slash when savePath is a folder'
    );

    assert.equal(
        buildSceneAssetUrl('db://assets/scenes/MainScene.scene', 'IgnoredName'),
        'db://assets/scenes/MainScene.scene',
        'should preserve explicit scene file paths'
    );

    assert.throws(
        () => throwIfAssetExists('db://assets/scenes/Main.scene', false, () => true, (url: string) => url),
        /already exists/i,
        'should block overwriting an existing asset by default'
    );

    assert.doesNotThrow(
        () => throwIfAssetExists('db://assets/scenes/Main.scene', true, () => true, (url: string) => url),
        'should allow overwriting only when explicitly enabled'
    );

    assert.throws(
        () => ensureCreatedAssetIsReady({ url: 'db://assets/scenes/Main.scene', uuid: '', metaReady: true }),
        /uuid/i,
        'should reject created assets without a uuid'
    );

    assert.throws(
        () => ensureCreatedAssetIsReady({ url: 'db://assets/scenes/Main.scene', uuid: 'scene-uuid', metaReady: false }),
        /meta/i,
        'should reject created assets whose meta is not ready'
    );

    let openedUuid = '';
    let capturedOverwrite = true;
    const created = await createSceneAsset(
        {
            sceneName: 'MainScene',
            savePath: 'db://assets/scenes',
            openAfterCreate: true,
            overwrite: false,
        },
        {
            buildSceneContent: (sceneName: string) => JSON.stringify([{ sceneName }]),
            createAsset: async (url: string, content: string, options?: { overwrite?: boolean }) => {
                capturedOverwrite = options?.overwrite ?? true;
                assert.equal(url, 'db://assets/scenes/MainScene.scene');
                assert.match(content, /MainScene/);
                return { url, uuid: 'scene-uuid', metaReady: true };
            },
            openSceneByUuid: async (uuid: string) => {
                openedUuid = uuid;
            },
        }
    );

    assert.equal(capturedOverwrite, false, 'should pass overwrite=false into asset creation');
    assert.equal(openedUuid, 'scene-uuid', 'should open the created scene when requested');
    assert.deepEqual(created, {
        uuid: 'scene-uuid',
        url: 'db://assets/scenes/MainScene.scene',
        name: 'MainScene',
        opened: true,
    });

    assert.deepEqual(
        planSceneSwitchGuard({
            operation: 'open_scene',
            dirty: false,
            autoSave: false,
        }),
        {
            allowed: true,
            shouldSave: false,
            reason: null,
        },
        'clean scenes should allow switching without saving'
    );

    assert.deepEqual(
        planSceneSwitchGuard({
            operation: 'open_scene',
            dirty: true,
            autoSave: false,
        }),
        {
            allowed: false,
            shouldSave: false,
            reason: 'Current scene has unsaved changes. Pass autoSave=true to save before switching scenes.',
        },
        'dirty scenes should block switching by default to avoid save confirmation dialogs'
    );

    assert.deepEqual(
        planSceneSwitchGuard({
            operation: 'close_scene',
            dirty: true,
            autoSave: true,
        }),
        {
            allowed: true,
            shouldSave: true,
            reason: null,
        },
        'dirty scenes should allow explicit auto-save before closing'
    );

    assert.deepEqual(
        planSceneSwitchGuard({
            operation: 'close_scene',
            dirty: true,
            autoSave: false,
        }),
        {
            allowed: false,
            shouldSave: false,
            reason: 'Current scene has unsaved changes. Pass autoSave=true to save before closing the scene.',
        },
        'close_scene should expose a close-specific guard message when auto-save is not enabled'
    );
}

run().then(() => {
    console.log('scene-creation-flow-test: ok');
}).catch((error) => {
    console.error('scene-creation-flow-test: failed');
    console.error(error);
    process.exitCode = 1;
});
