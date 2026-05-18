import assert from 'node:assert/strict';
import { shouldFallbackToSaveAsWhenOriginalSceneMissing } from '../tools/editor-tools';

async function run(): Promise<void> {
    await assert.doesNotReject(async () => {
        const result = await shouldFallbackToSaveAsWhenOriginalSceneMissing({
            getCurrentSceneUuid: async () => null,
            getSceneAssetUrl: async () => 'db://assets/scenes/Main.scene',
            ensureSceneAssetExists: async () => undefined
        });

        assert.equal(result, false, 'missing scene uuid should not trigger save-as fallback');
    });

    await assert.doesNotReject(async () => {
        const result = await shouldFallbackToSaveAsWhenOriginalSceneMissing({
            getCurrentSceneUuid: async () => 'scene-uuid',
            getSceneAssetUrl: async () => null,
            ensureSceneAssetExists: async () => undefined
        });

        assert.equal(result, true, 'missing source asset url should trigger save-as fallback');
    });

    await assert.doesNotReject(async () => {
        const result = await shouldFallbackToSaveAsWhenOriginalSceneMissing({
            getCurrentSceneUuid: async () => 'scene-uuid',
            getSceneAssetUrl: async () => 'db://assets/scenes/Main.scene',
            ensureSceneAssetExists: async () => {
                throw new Error('Asset not found: db://assets/scenes/Main.scene');
            }
        });

        assert.equal(result, true, 'missing source scene asset should trigger save-as fallback');
    });

    await assert.doesNotReject(async () => {
        const result = await shouldFallbackToSaveAsWhenOriginalSceneMissing({
            getCurrentSceneUuid: async () => 'scene-uuid',
            getSceneAssetUrl: async () => 'db://assets/scenes/Main.scene',
            ensureSceneAssetExists: async () => undefined
        });

        assert.equal(result, false, 'existing source scene asset should not trigger save-as fallback');
    });

    await assert.doesNotReject(async () => {
        const result = await shouldFallbackToSaveAsWhenOriginalSceneMissing({
            getCurrentSceneUuid: async () => 'scene-uuid',
            getSceneAssetUrl: async () => 'db://assets/scenes/Main.scene',
            ensureSceneAssetExists: async () => {
                throw new Error('Permission denied');
            }
        });

        assert.equal(result, false, 'non-existence save failures should not trigger save-as fallback');
    });
}

run().then(() => {
    console.log('editor-tools-save-scene-test: ok');
}).catch((error) => {
    console.error('editor-tools-save-scene-test: failed');
    console.error(error);
    process.exitCode = 1;
});
