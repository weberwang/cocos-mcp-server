import assert from 'node:assert/strict';
import { refreshAssetsAndWait } from '../asset-db-wrapper';

async function run(): Promise<void> {
    const calls: string[] = [];
    let now = 0;
    let metaCheckCount = 0;

    const successResult = await refreshAssetsAndWait(
        {
            urls: [
                'db://assets/textures/player.png',
                'db://assets/textures/player.png',
                'db://assets/textures/enemy.png',
            ],
            timeoutMs: 30,
            pollIntervalMs: 10,
        },
        {
            refreshFolder: async (folder: string) => {
                calls.push(`folder:${folder}`);
            },
            refreshAsset: async (url: string) => {
                calls.push(`asset:${url}`);
            },
            metaExists: (url: string) => {
                metaCheckCount += 1;
                if (url.endsWith('player.png')) {
                    return metaCheckCount >= 2;
                }
                return metaCheckCount >= 3;
            },
            now: () => now,
            sleep: async (ms: number) => {
                now += ms;
            },
        }
    );

    assert.deepEqual(
        calls,
        [
            'folder:db://assets/textures',
            'asset:db://assets/textures/player.png',
            'asset:db://assets/textures/enemy.png',
        ],
        'should refresh the parent folder once and then refresh each distinct asset'
    );
    assert.deepEqual(
        successResult.readyUrls,
        [
            'db://assets/textures/player.png',
            'db://assets/textures/enemy.png',
        ],
        'should report all distinct assets as ready after their meta files appear'
    );
    assert.deepEqual(successResult.pendingUrls, [], 'should not leave pending assets when all meta files become ready');
    assert.equal(successResult.metaReady, true, 'should mark the batch as ready when no pending assets remain');
    assert.equal(successResult.elapsedMs, 10, 'should stop waiting as soon as the final meta file becomes ready');

    const timeoutResult = await refreshAssetsAndWait(
        {
            urls: ['db://assets/textures/missing.png'],
            timeoutMs: 20,
            pollIntervalMs: 10,
            refreshParentFolders: false,
        },
        {
            refreshFolder: async () => {
                throw new Error('refreshFolder should not be called when refreshParentFolders=false');
            },
            refreshAsset: async (url: string) => {
                calls.push(`timeout:${url}`);
            },
            metaExists: () => false,
            now: () => now,
            sleep: async (ms: number) => {
                now += ms;
            },
        }
    );

    assert.deepEqual(timeoutResult.readyUrls, [], 'should not report ready assets when meta files never appear');
    assert.deepEqual(
        timeoutResult.pendingUrls,
        ['db://assets/textures/missing.png'],
        'should return pending assets after timeout so callers can retry or inspect failures'
    );
    assert.equal(timeoutResult.metaReady, false, 'should mark the batch as not ready when pending assets remain');
    assert.equal(timeoutResult.elapsedMs, 20, 'should wait until the configured timeout before giving up');
}

run().then(() => {
    console.log('asset-refresh-wait-test: ok');
}).catch((error) => {
    console.error('asset-refresh-wait-test: failed');
    console.error(error);
    process.exitCode = 1;
});
