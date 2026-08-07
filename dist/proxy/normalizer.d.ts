/** Token 归一化模块 — 四家 provider usage → 统一字段 */
import type { NormalizedTokens } from '../shared/types.js';
export declare function normalizeTokens(provider: string, responseBody: Record<string, any>): NormalizedTokens;
