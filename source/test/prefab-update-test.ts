import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrefabTools } from '../tools/prefab-tools';

/** 描述一次保存请求的模拟编辑器状态和预期结果。 */
interface SaveCase {
    name: string;
    node?: unknown;
    prefabPath?: string;
    nodeUuid?: string;
    queryError?: unknown;
    applyError?: unknown;
    error?: RegExp;
    expectedApply?: boolean;
}

/** 通过公开工具入口验证保存协议和校验失败时的禁止写入行为。 */
async function run(): Promise<void> {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-prefab-update-'));
    const originalEditor = (globalThis as any).Editor;
    const prefabPath = 'db://assets/Test.prefab';
    const prefabUuid = 'target-prefab-uuid';
    const nodeUuid = 'instance-root-uuid';
    const root = { __prefab__: { rootUuid: nodeUuid, uuid: prefabUuid } };
    const tools = new PrefabTools();

    try {
        fs.mkdirSync(path.join(projectPath, 'assets'));
        fs.writeFileSync(path.join(projectPath, 'assets', 'Test.prefab'), '[]');
        fs.writeFileSync(path.join(projectPath, 'assets', 'Test.prefab.meta'), JSON.stringify({ uuid: prefabUuid }));
        fs.writeFileSync(path.join(projectPath, 'assets', 'NoMeta.prefab'), '[]');
        fs.writeFileSync(path.join(projectPath, 'assets', 'Wrong.json'), '[]');
        fs.writeFileSync(path.join(projectPath, 'assets', 'Wrong.json.meta'), JSON.stringify({ uuid: prefabUuid }));

        const cases: SaveCase[] = [
            { name: '保存匹配的实例根节点', node: root, expectedApply: true },
            { name: '拒绝缺失资源', prefabPath: 'db://assets/Missing.prefab', node: root, error: /Asset not found/ },
            { name: '拒绝无资源 UUID', prefabPath: 'db://assets/NoMeta.prefab', node: root, error: /有效 UUID/ },
            { name: '拒绝非预制体资源', prefabPath: 'db://assets/Wrong.json', node: root, error: /预制体/ },
            { name: '拒绝空资源路径', prefabPath: '', node: root, error: /prefabPath 不能为空/ },
            { name: '拒绝空节点 UUID', nodeUuid: '', node: root, error: /实例根节点 UUID/ },
            { name: '拒绝不存在的节点', node: null, error: /节点不存在/ },
            { name: '拒绝普通节点', node: {}, error: /未关联有效的预制体实例/ },
            { name: '拒绝缺失根节点信息', node: { __prefab__: { uuid: prefabUuid } }, error: /未关联有效/ },
            { name: '拒绝缺失关联资源信息', node: { __prefab__: { rootUuid: nodeUuid } }, error: /未关联有效/ },
            {
                name: '拒绝预制体子节点并提示根节点',
                nodeUuid: 'child-uuid',
                node: root,
                error: /必须是预制体实例根节点，请使用: instance-root-uuid/,
            },
            {
                name: '拒绝不同预制体资源',
                node: { __prefab__: { rootUuid: nodeUuid, uuid: 'other-prefab-uuid' } },
                error: /预制体资源不匹配/,
            },
            { name: '返回节点查询错误', queryError: new Error('query failed'), error: /query failed/ },
            { name: '返回保存错误', node: root, applyError: new Error('apply failed'), error: /apply failed/, expectedApply: true },
            { name: '返回非 Error 异常', node: root, applyError: 'save rejected', error: /save rejected/, expectedApply: true },
        ];

        for (const scenario of cases) {
            const calls: Array<{ channel: string; method: string; args: unknown[] }> = [];
            const requestedNode = scenario.nodeUuid ?? nodeUuid;
            (globalThis as any).Editor = {
                Project: { path: projectPath },
                Message: {
                    // 只模拟 IPC；任何非预期消息都失败，确保测试不会触发真实编辑器操作。
                    request: async (channel: string, method: string, ...args: unknown[]) => {
                        calls.push({ channel, method, args });
                        assert.equal(channel, 'scene');
                        if (method === 'query-node') {
                            assert.deepEqual(args, [requestedNode]);
                            if (scenario.queryError !== undefined) {
                                throw scenario.queryError;
                            }
                            return scenario.node;
                        }
                        assert.equal(method, 'apply-prefab');
                        assert.deepEqual(args, [requestedNode], '保存必须仅传根节点 UUID 字符串');
                        if (scenario.applyError !== undefined) {
                            throw scenario.applyError;
                        }
                    },
                },
            };

            const result = await tools.execute('update_prefab', {
                prefabPath: scenario.prefabPath ?? prefabPath,
                nodeUuid: requestedNode,
            });
            if (scenario.error) {
                assert.equal(result.success, false, scenario.name);
                assert.match(result.error ?? '', scenario.error, scenario.name);
            } else {
                assert.deepEqual(result, { success: true, message: 'Prefab updated successfully' }, scenario.name);
            }
            assert.equal(
                calls.filter(call => call.method === 'apply-prefab').length,
                scenario.expectedApply ? 1 : 0,
                `${scenario.name}: 校验失败不得调用保存接口`,
            );
            if (scenario.expectedApply) {
                assert.deepEqual(calls.map(call => call.method), ['query-node', 'apply-prefab'], scenario.name);
            }
        }
        console.log(`prefab-update-test: ${cases.length} cases passed`);
    } finally {
        (globalThis as any).Editor = originalEditor;
        fs.rmSync(projectPath, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error('prefab-update-test: failed', error);
    process.exitCode = 1;
});
