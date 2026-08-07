/** 路由注册 — 代理路由 + /api/* 查询路由 */
import type { FastifyInstance } from 'fastify';
import type { CallRecord } from '../shared/types.js';
/** 上游 URL 映射（测试时可替换为 mock server 地址） */
export declare const UPSTREAMS: Record<string, string>;
/** 从 provider_config 表加载上游配置 */
export declare function getConfiguredUpstream(provider: string): {
    base_url: string;
    api_key: string;
    enabled: boolean;
};
export declare function setEnqueueRef(fn: (record: CallRecord) => void): void;
export declare function registerProxyRoutes(app: FastifyInstance): Promise<void>;
