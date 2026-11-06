import * as AssetDB from '../asset-db-wrapper';
import { ToolResponse } from '../types';

/** 校验实例根节点与目标资源后，将实例改动保存到预制体。 */
export async function updatePrefabAsset(prefabPath: string, nodeUuid: string): Promise<ToolResponse> {
    try {
        if (typeof prefabPath !== 'string' || !prefabPath.trim()) {
            throw new Error('prefabPath 不能为空');
        }
        if (typeof nodeUuid !== 'string' || !nodeUuid.trim()) {
            throw new Error('nodeUuid 必须是预制体实例根节点 UUID');
        }

        const assetInfo = await AssetDB.queryAssetInfo(prefabPath);
        if (assetInfo.type !== 'cc.Prefab' || !assetInfo.uuid?.trim()) {
            throw new Error(`目标资源必须是具有有效 UUID 的预制体: ${prefabPath}`);
        }

        const node = await Editor.Message.request('scene', 'query-node', nodeUuid);
        if (!node) {
            throw new Error(`节点不存在: ${nodeUuid}`);
        }
        const prefab = node.__prefab__;
        if (!prefab || typeof prefab.rootUuid !== 'string' || !prefab.rootUuid ||
            typeof prefab.uuid !== 'string' || !prefab.uuid) {
            throw new Error(`节点未关联有效的预制体实例: ${nodeUuid}`);
        }
        if (prefab.rootUuid !== nodeUuid) {
            throw new Error(`nodeUuid 必须是预制体实例根节点，请使用: ${prefab.rootUuid}`);
        }
        // apply-prefab 根据实例关联资源保存，prefabPath 本身不能指定写入目标。
        if (prefab.uuid !== assetInfo.uuid) {
            throw new Error(`预制体资源不匹配: 实例关联 ${prefab.uuid}，目标资源为 ${assetInfo.uuid}`);
        }

        // 编辑器要求实例根节点 UUID 字符串，传入对象无法按原生保存流程定位实例。
        await Editor.Message.request('scene', 'apply-prefab', nodeUuid);
        return { success: true, message: 'Prefab updated successfully' };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}
