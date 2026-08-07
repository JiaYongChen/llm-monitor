/** Mock LLM API 服务器 — 模拟四家 provider 的 API 响应，用于测试 */
import { type FastifyInstance } from 'fastify';
export declare function createMockServer(): Promise<{
    app: FastifyInstance;
    url: string;
}>;
