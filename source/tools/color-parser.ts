/**
 * 颜色值结构定义。
 * 统一约束 MCP 颜色转换输出，避免不同入口返回不一致的字段结构。
 */
export interface ParsedColorValue {
    r: number;
    g: number;
    b: number;
    a: number;
}

/**
 * 解析颜色字符串。
 * 支持标准十六进制格式，以及被上游错误序列化后的 JSON 颜色对象字符串，兼容现有调用链的输入抖动。
 */
export function parseColorString(colorStr: string): ParsedColorValue {
    const str = colorStr.trim();

    if (str.startsWith('#')) {
        if (str.length === 7) {
            return {
                r: parseInt(str.substring(1, 3), 16),
                g: parseInt(str.substring(3, 5), 16),
                b: parseInt(str.substring(5, 7), 16),
                a: 255
            };
        }

        if (str.length === 9) {
            return {
                r: parseInt(str.substring(1, 3), 16),
                g: parseInt(str.substring(3, 5), 16),
                b: parseInt(str.substring(5, 7), 16),
                a: parseInt(str.substring(7, 9), 16)
            };
        }
    }

    if (str.startsWith('{') && str.endsWith('}')) {
        try {
            const parsed = JSON.parse(str) as Partial<ParsedColorValue>;
            return normalizeColorObject(parsed, colorStr);
        } catch {
            // 这里保留统一报错，避免把 JSON 解析细节泄漏到调用层。
        }
    }

    throw new Error(`Invalid color format: "${colorStr}". Only hexadecimal format is supported (e.g., "#FF0000" or "#FF0000FF") or JSON color objects (e.g., "{\\"r\\":255,\\"g\\":0,\\"b\\":0,\\"a\\":255}")`);
}

/**
 * 规范化颜色对象。
 * 对越界和缺省值做收敛，保证最终写回 Cocos 的数据始终落在 0-255 范围内。
 */
export function normalizeColorObject(color: Partial<ParsedColorValue>, rawInput?: string): ParsedColorValue {
    const hasRgbChannel = color.r !== undefined || color.g !== undefined || color.b !== undefined;
    if (!hasRgbChannel) {
        throw new Error(`Invalid color object${rawInput ? `: "${rawInput}"` : ''}. Missing r/g/b channel.`);
    }

    return {
        r: clampColorChannel(color.r),
        g: clampColorChannel(color.g),
        b: clampColorChannel(color.b),
        a: color.a !== undefined ? clampColorChannel(color.a) : 255
    };
}

/**
 * 限制颜色通道范围。
 * 防止上游传入字符串、浮点数或越界值时污染场景序列化结果。
 */
function clampColorChannel(value: unknown): number {
    return Math.min(255, Math.max(0, Number(value) || 0));
}
