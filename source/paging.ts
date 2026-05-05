/**
 * Paging utilities for list-returning MCP tools.
 * 
 * Modeled after Unity-MCP's page_size + cursor pattern. All list tools
 * should accept optional page_size / cursor arguments and return paginated
 * responses to prevent unbounded data returns that crash or timeout.
 */

export interface PageArgs {
    page_size?: number;
    cursor?: number;
}

export interface PagedData<T> {
    items: T[];
    total: number;
    pageSize: number;
    cursor: number;
    hasMore: boolean;
}

/**
 * Extract paging parameters from tool arguments with sensible defaults.
 */
export function getPageArgs(args: any): { pageSize: number; cursor: number } {
    const pageSize = Math.min(Math.max(args?.page_size ?? 50, 1), 500);
    const cursor = Math.max(args?.cursor ?? 0, 0);
    return { pageSize, cursor };
}

/**
 * Slice an array and return paging metadata.
 * Usage in tool implementations:
 *   const { pageSize, cursor } = getPageArgs(args);
 *   const paged = paginate(allResults, pageSize, cursor);
 *   return { success: true, data: paged };
 */
export function paginate<T>(items: T[], pageSize: number, cursor: number): PagedData<T> {
    const total = items.length;
    const safeCursor = Math.min(cursor, Math.max(0, total - 1));
    const sliced = items.slice(safeCursor, safeCursor + pageSize);
    return {
        items: sliced,
        total,
        pageSize,
        cursor: safeCursor,
        hasMore: safeCursor + pageSize < total,
    };
}

/**
 * Standard paging parameter schema fragment for tool definitions.
 * Add this to inputSchema.properties when adding paging to a tool.
 */
export const PAGE_ARGS_SCHEMA = {
    page_size: {
        type: 'number',
        default: 50,
        description: 'Number of results per page (1-500, default: 50)',
    },
    cursor: {
        type: 'number',
        default: 0,
        description: 'Pagination cursor (offset for next page, default: 0)',
    },
};
