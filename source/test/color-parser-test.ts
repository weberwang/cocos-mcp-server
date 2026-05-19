import { normalizeColorObject, parseColorString } from '../tools/color-parser';

/**
 * 颜色解析回归测试。
 * 覆盖十六进制与被错误序列化的 JSON 颜色字符串，防止 set_component_property 再次因为输入抖动报错。
 */
function runColorParserTests(): void {
    assertColor(
        parseColorString('#FF7518'),
        { r: 255, g: 117, b: 24, a: 255 },
        '应正确解析 6 位十六进制颜色'
    );

    assertColor(
        parseColorString('#FF7518CC'),
        { r: 255, g: 117, b: 24, a: 204 },
        '应正确解析 8 位十六进制颜色'
    );

    assertColor(
        parseColorString('{"r":255,"g":117,"b":24,"a":255}'),
        { r: 255, g: 117, b: 24, a: 255 },
        '应兼容被序列化后的 JSON 颜色字符串'
    );

    assertColor(
        normalizeColorObject({ r: '260' as unknown as number, g: -5, b: 24.4, a: undefined }),
        { r: 255, g: 0, b: 24.4, a: 255 },
        '应对颜色对象做边界收敛'
    );

    assertThrows(
        () => parseColorString('red'),
        'Invalid color format',
        '非法字符串仍应报错，避免静默吞掉错误输入'
    );

    console.log('color-parser-test: PASS');
}

/**
 * 尺寸解析回归测试。
 * 先覆盖当前已知故障场景，保证字符串化后的 size 对象不会再在 set_component_property 分支里被拒绝。
 */
function runSizeParserTests(parseSizeString: (input: string) => { width: number; height: number }): void {
    assertSize(
        parseSizeString('{"width":320,"height":180}'),
        { width: 320, height: 180 },
        '应兼容被序列化后的 JSON 尺寸字符串'
    );

    assertThrows(
        () => parseSizeString('320x180'),
        'Invalid size format',
        '非法尺寸字符串仍应报错'
    );

    console.log('size-parser-test: PASS');
}

/**
 * 比较颜色通道值。
 * 使用明确断言可以在没有测试框架的情况下快速定位是哪一个通道回归。
 */
function assertColor(actual: { r: number; g: number; b: number; a: number }, expected: { r: number; g: number; b: number; a: number }, message: string): void {
    const keys: Array<'r' | 'g' | 'b' | 'a'> = ['r', 'g', 'b', 'a'];
    for (const key of keys) {
        if (actual[key] !== expected[key]) {
            throw new Error(`${message}：通道 ${key} 期望 ${expected[key]}，实际 ${actual[key]}`);
        }
    }
}

/**
 * 断言函数抛出预期错误。
 * 这里保留子串匹配，避免后续优化报错文案时把测试绑得过死。
 */
function assertThrows(fn: () => void, expectedMessagePart: string, message: string): void {
    try {
        fn();
    } catch (error: any) {
        if (String(error?.message || error).includes(expectedMessagePart)) {
            return;
        }
        throw new Error(`${message}：实际抛出 ${String(error?.message || error)}`);
    }

    throw new Error(`${message}：预期抛错但未抛出`);
}

runColorParserTests();
try {
    // 延迟 require，确保这里先作为红灯测试暴露未实现状态。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { parseSizeString } = require('../tools/size-parser') as { parseSizeString: (input: string) => { width: number; height: number } };
    runSizeParserTests(parseSizeString);
} catch (error: any) {
    throw new Error(`size-parser-test 未通过：${String(error?.message || error)}`);
}

/**
 * 比较尺寸值。
 * 独立断言有助于快速定位是宽还是高的兼容逻辑回归。
 */
function assertSize(actual: { width: number; height: number }, expected: { width: number; height: number }, message: string): void {
    if (actual.width !== expected.width) {
        throw new Error(`${message}：width 期望 ${expected.width}，实际 ${actual.width}`);
    }

    if (actual.height !== expected.height) {
        throw new Error(`${message}：height 期望 ${expected.height}，实际 ${actual.height}`);
    }
}
