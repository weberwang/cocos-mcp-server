import assert from 'node:assert/strict';
import {
    normalizeSceneSaveAsPath,
    saveSceneAssetDirect,
} from '../tools/scene-tools';

async function run(): Promise<void> {
    assert.equal(
        normalizeSceneSaveAsPath('db://assets/scenes/Main.scene'),
        'db://assets/scenes/Main.scene',
        'should keep explicit scene asset path unchanged',
    );

    assert.throws(
        () => normalizeSceneSaveAsPath(''),
        /path is required/,
        'should reject empty save path',
    );

    assert.throws(
        () => normalizeSceneSaveAsPath('assets/scenes/Main.scene'),
        /path must be a db:\/\/ asset path/,
        'should reject non-db path',
    );

    assert.throws(
        () => normalizeSceneSaveAsPath('db://assets/scenes/Main'),
        /path must end with \.scene/,
        'should reject path without .scene suffix',
    );

    const writes: Array<{ url: string; content: string }> = [];
    const refreshes: string[][] = [];
    const result = await saveSceneAssetDirect({
        path: 'db://assets/scenes/Copy.scene',
        serializedData: '[{"__type__":"cc.SceneAsset"}]',
        saveAsset: async (url: string, content: string) => {
            writes.push({ url, content });
        },
        refreshAssetsAndWait: async (request) => {
            refreshes.push(request.urls);
            return {
                readyUrls: request.urls,
                pendingUrls: [],
                elapsedMs: 0,
                metaReady: true,
            };
        },
        queryUuid: async () => 'scene-copy-uuid',
    });

    assert.deepEqual(
        writes,
        [{ url: 'db://assets/scenes/Copy.scene', content: '[{"__type__":"cc.SceneAsset"}]' }],
        'should write serialized scene directly to the requested asset path',
    );
    assert.deepEqual(
        refreshes,
        [['db://assets/scenes/Copy.scene']],
        'should refresh the direct-saved scene asset once',
    );
    assert.deepEqual(
        result,
        { path: 'db://assets/scenes/Copy.scene', uuid: 'scene-copy-uuid' },
        'should return the saved scene path and refreshed uuid',
    );
}

run().then(() => {
    console.log('scene-tools-save-scene-as-test: ok');
}).catch((error) => {
    console.error('scene-tools-save-scene-as-test: failed');
    console.error(error);
    process.exitCode = 1;
});
