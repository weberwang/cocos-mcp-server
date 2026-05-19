/**
 * 尺寸值结构定义。
 * 统一 size 属性在 MCP 工具链中的输入输出形态，避免不同入口各自做不一致的宽高兜底。
 */
export interface ParsedSizeValue {
    width: number;
    height: number;
}

/**
 * 解析尺寸字符串。
 * 兼容被上游错误序列化后的 JSON 尺寸对象字符串，保证 set_component_property 的 size 分支不会误拒合法数据。
 */
export function parseSizeString(sizeStr: string): ParsedSizeValue {
    const str = sizeStr.trim();

    if (str.startsWith('{') && str.endsWith('}')) {
        try {
            const parsed = JSON.parse(str) as Partial<ParsedSizeValue>;
            return normalizeSizeObject(parsed, sizeStr);
        } catch {
            // 统一走下面的错误文案，避免把 JSON 解析细节泄漏到工具响应里。
        }
    }

    throw new Error(`Invalid size format: "${sizeStr}". Only JSON size objects are supported (e.g., "{\\"width\\":320,\\"height\\":180}")`);
}

/**
 * 规范化尺寸对象。
 * 对宽高缺省和异常值做收敛，保证写回场景的数据始终是数值类型。
 */
export function normalizeSizeObject(size: Partial<ParsedSizeValue>, rawInput?: string): ParsedSizeValue {
    const hasWidth = size.width !== undefined;
    const hasHeight = size.height !== undefined;
    if (!hasWidth && !hasHeight) {
        throw new Error(`Invalid size object${rawInput ? `: "${rawInput}"` : ''}. Missing width/height.`);
    }

    return {
        width: normalizeSizeNumber(size.width),
        height: normalizeSizeNumber(size.height)
    };
}

/**
 * 规范化尺寸数值。
 * 这里不做最小值限制，保持与现有逻辑一致，只保证最终是有限数字。
 */
function normalizeSizeNumber(value: unknown): number {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : 0;
}
