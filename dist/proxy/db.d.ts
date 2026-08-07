/**
 * SQLite 数据库模块 — 基于 sql.js (纯 WASM，无需编译)
 *
 * sql.js 的数据库完全在内存中运行，写入后需调用 saveDb() 持久化到磁盘。
 * 采用单例模式，所有模块共享同一个数据库实例。
 */
import { type Database } from 'sql.js';
import type { CallRecord } from '../shared/types.js';
/** 初始化 sql.js + 数据库，建表。调用一次即可。 */
export declare function initDb(dbPath?: string): Promise<void>;
/** 获取数据库实例（必须先在 initDb 之后调用） */
export declare function getDb(): Database;
/** 将内存中的数据库持久化到磁盘 */
export declare function saveDb(dbPath?: string): void;
/** 关闭数据库（先保存） */
export declare function closeDb(): void;
/** 插入调用记录，返回新 id */
export declare function insertCall(r: CallRecord): number;
/** 列出调用记录 */
export declare function listCalls(sessionId?: number, limit?: number, offset?: number): Record<string, any>[];
/** 获取单条调用 */
export declare function getCall(callId: number): Record<string, any> | null;
/** 查找或创建会话，返回 session id */
export declare function upsertSession(fingerprint: string, tool: string, endpoint: string): number;
/** 更新会话统计 */
export declare function updateSessionStats(sessionId: number, cost: number, tokens: number): void;
/** 列出会话 */
export declare function listSessions(tool?: string, status?: string, limit?: number): Record<string, any>[];
/** 获取单条会话 */
export declare function getSession(sessionId: number): Record<string, any> | null;
/** 重命名会话 */
export declare function updateSessionLabel(sessionId: number, label: string): void;
/** 合并两个会话 */
export declare function mergeSessions(sourceId: number, targetId: number): void;
/** 聚合统计 */
export declare function getStats(groupBy: string): Record<string, any>[];
/** 清理旧数据 */
export declare function cleanupOldCalls(days: number): number;
/** 清空所有调用和会话 */
export declare function clearAllCalls(): void;
/** 列出定价 */
export declare function listPricing(): Record<string, any>[];
/** 新增或更新定价 */
export declare function upsertPricing(provider: string, model: string, inputPrice: number, cacheInputPrice: number, outputPrice: number): number;
/** 删除定价 */
export declare function deletePricing(pricingId: number): void;
/** 列出所有 provider 配置 */
export declare function listProviderConfigs(): Record<string, any>[];
/** 获取单个 provider 的配置（base_url 为空时返回官方地址） */
export declare function getProviderConfig(provider: string): {
    base_url: string;
    api_key: string;
    enabled: boolean;
} | null;
/** 更新 provider 配置 */
export declare function updateProviderConfig(provider: string, baseUrl: string, apiKey: string, enabled: boolean): void;
/** 新增自定义 provider */
export declare function addProviderConfig(provider: string, baseUrl: string, apiKey: string): number;
/** 删除 provider 配置 */
export declare function deleteProviderConfig(provider: string): void;
