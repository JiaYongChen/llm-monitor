/** HTTP 转发模块 — 非流式 + 流式 SSE 透传 */
export declare function forwardRequest(method: string, url: string, headers: Record<string, string>, body?: Buffer): Promise<{
    status: number;
    json: any;
    text: string;
    durationMs: number;
}>;
export declare function forwardStream(method: string, url: string, headers: Record<string, string>, body?: Buffer): Promise<{
    stream: ReadableStream;
    collectResult: () => Promise<{
        status: number;
        json: any;
        text: string;
        durationMs: number;
    }>;
}>;
