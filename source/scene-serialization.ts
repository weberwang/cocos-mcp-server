/**
 * 判断是否为 Creator 的 compact 序列化根数组。
 * 这里只识别当前修复链路真正会处理的紧凑结构，避免把普通 JSON 资源误送进 compact 分支。
 */
export function isCompactSerializedDocument(source: unknown): source is any[] {
    return Boolean(
        Array.isArray(source)
        && typeof source[0] === 'number'
        && Array.isArray(source[2])
        && Array.isArray(source[3])
        && Array.isArray(source[4])
        && Array.isArray(source[5])
    );
}

/**
 * 判断 compact 根数组里是否真的包含“多 section 文档”。
 * 普通 prefab/scene 的 data 区本身也是数组，之前误把它当成 section 容器，直接导致根资源被拆坏。
 */
export function hasPackedSerializedSections(source: unknown): boolean {
    if (!isCompactSerializedDocument(source)) {
        return false;
    }

    const dataEntries = source[5];
    if (!Array.isArray(dataEntries) || dataEntries.length === 0) {
        return false;
    }

    return dataEntries.every((entry) => (
        Array.isArray(entry)
        && entry.length > 0
        && Array.isArray(entry[0])
    ));
}
