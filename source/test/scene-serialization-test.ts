import assert from 'node:assert/strict';
import {
    hasPackedSerializedSections,
    isCompactSerializedDocument,
} from '../scene-serialization';

/**
 * 验证 compact 资源结构识别，避免把普通 prefab 的 data 数组误当成多 section 文档。
 */
function run(): void {
    const simpleCompactPrefab = [
        1,
        0,
        ['node', 'root', 'data'],
        [
            ['cc.Prefab', ['_name'], 2],
            ['cc.Node', ['_name', '_layer', '_components', '_prefab'], 1, 9, 4],
        ],
        [
            [3, 0, 2],
            [0, 0, 2],
        ],
        [
            [1, 'S0'],
            [2, 'S0', 33554432],
        ],
        0,
        [0, 1, 1, 0],
        [],
        [],
        [],
    ];

    const nestedCompactPrefab = [
        1,
        ['f42Pw/zQJNN6BShYkm/ptd@f9941'],
        ['node', '_spriteFrame', 'root', 'data'],
        [
            ['cc.Node', ['_name'], 1],
            ['cc.Prefab', ['_name'], 2],
        ],
        [
            [0, 0, 1],
            [1, 0, 2],
        ],
        [
            [1, 'g1_1'],
            [0, 'shadow', 33554432],
            [0, 'g1_1', 33554432],
        ],
        0,
        [0, 2, 1, 0],
        [0, 0, 0],
        [1, 1, 1],
        [0, 0, 1],
    ];

    const packedSectionsCandidate = [
        1,
        0,
        [],
        [],
        [],
        [
            [[1, 'section-a'], [2, 'section-a-node']],
            [[1, 'section-b'], [2, 'section-b-node']],
        ],
        0,
        [],
        [],
        [],
        [],
    ];

    assert.equal(isCompactSerializedDocument(simpleCompactPrefab), true, 'should recognize compact prefab root array');
    assert.equal(hasPackedSerializedSections(simpleCompactPrefab), false, 'should not treat prefab data entries as packed sections');

    assert.equal(isCompactSerializedDocument(nestedCompactPrefab), true, 'should recognize nested compact prefab root array');
    assert.equal(hasPackedSerializedSections(nestedCompactPrefab), false, 'should not treat multi-node compact prefab data as packed sections');

    assert.equal(isCompactSerializedDocument(packedSectionsCandidate), true, 'should still recognize packed-section candidate as compact root array');
    assert.equal(hasPackedSerializedSections(packedSectionsCandidate), true, 'should allow explicitly nested section arrays');
}

try {
    run();
    console.log('scene-serialization-test: ok');
} catch (error) {
    console.error('scene-serialization-test: failed');
    console.error(error);
    process.exitCode = 1;
}
