/**
 * 配置 CRUD 与名称归一化模块 — 由 db.ts 拆分而来（db.ts 保留建表与调用/会话 CRUD）
 *
 * 依赖方向：db-config → db-core 单向。存储不变量：库中工具名/供应商名/模型名均为小写
 * （写入时归一化），查询只做精确等值，不做 LOWER 兜底。
 */

import { queryAll, queryOne, execute, executeInsert } from './db-core.js';
import { BUILTIN_PROVIDERS } from './db-migrations.js';

// ── 名称归一化 ──

/** 工具名别名（小写 → 小写规范名）：仅处理内置别名，其余工具名小写即规范 */
const TOOL_ALIASES: Record<string, string> = {
  claude: 'claudecode',
  chatgpt: 'codex',
};

/** 工具名归一化：小写 + 内置别名（claude→claudecode、chatgpt→codex）。
 *  存储不变量：库中所有工具名为小写，因此无需查表。 */
export function normalizeToolName(tool: string): string {
  if (!tool) return tool;
  const lower = tool.toLowerCase();
  return TOOL_ALIASES[lower] ?? lower;
}

/** 供应商名归一化：统一小写（存储不变量：库中所有供应商名为小写） */
export function normalizeProviderName(provider: string): string {
  if (!provider) return provider;
  return provider.toLowerCase();
}

// ── Tool Config ──

/** 列出所有工具配置 */
export function listToolConfigs(): Record<string, any>[] {
  return queryAll('SELECT * FROM tool_config', []);
}

/** 获取单个工具的配置（存储不变量全小写，调用方已归一化；精确等值查询） */
export function getToolConfig(tool: string): Record<string, any> | null {
  return queryOne('SELECT * FROM tool_config WHERE tool = ?', [tool]);
}

/** 更新工具级上游配置（upsert，工具名 / 供应商名 / 模型名大小写不敏感归一化） */
export function updateToolConfig(tool: string, upstreamProvider: string | null, upstreamModel: string | null): void {
  const name = normalizeToolName(tool);
  const prov = upstreamProvider ? normalizeProviderName(upstreamProvider) : upstreamProvider;
  const model = upstreamModel ? upstreamModel.toLowerCase() : upstreamModel;
  const now = Date.now();
  execute(
    `INSERT INTO tool_config (tool, upstream_provider, upstream_model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tool) DO UPDATE SET upstream_provider = excluded.upstream_provider, upstream_model = excluded.upstream_model, updated_at = excluded.updated_at`,
    [name, prov, model, now, now],
  );
}

// ── Pricing CRUD ──

/** 列出定价 */
export function listPricing(): Record<string, any>[] {
  return queryAll('SELECT * FROM pricing ORDER BY id');
}

/** 新增或更新定价 */
export function upsertPricing(
  provider: string, model: string,
  inputPrice: number, cacheInputPrice: number, outputPrice: number,
  currency?: string,
  isDefault?: boolean,
): number {
  provider = normalizeProviderName(provider);
  model = model.toLowerCase();
  const cur = currency || 'CNY';
  const def = isDefault ? 1 : 0;
  // sql.js 不支持 ON CONFLICT，用先查再插入/更新的方式（provider/model 入参已归一化，精确等值去重）
  const existing = queryOne(
    'SELECT id, is_default FROM pricing WHERE provider = ? AND model = ? AND effective_from IS NULL',
    [provider, model],
  );
  if (existing) {
    // 默认条目只更新价格和币种，不覆盖 is_default 标记
    const keepDefault = existing.is_default ? 1 : def;
    execute(
      'UPDATE pricing SET input_price = ?, cache_input_price = ?, output_price = ?, currency = ?, is_default = ?, updated_at = ? WHERE id = ?',
      [inputPrice, cacheInputPrice, outputPrice, cur, keepDefault, Date.now(), existing.id],
    );
    return Number(existing.id);
  }
  const now = Date.now();
  return executeInsert(
    'INSERT INTO pricing (provider, model, input_price, cache_input_price, output_price, currency, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
    [provider, model, inputPrice, cacheInputPrice, outputPrice, cur, def, now, now],
  );
}

/** 删除定价（默认条目不可删除） */
export function deletePricing(pricingId: number): { ok: boolean; error?: string } {
  const row = queryOne('SELECT is_default FROM pricing WHERE id = ?', [pricingId]);
  if (!row) return { ok: false, error: '定价不存在' };
  if (row.is_default) return { ok: false, error: '默认定价不可删除' };
  execute('DELETE FROM pricing WHERE id = ?', [pricingId]);
  return { ok: true };
}

// ── Provider Config CRUD ──

const OFFICIAL_URLS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};
const OFFICIAL_ANTHROPIC_URLS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
};

/** 列出所有 provider 配置（内置供应商兜底官方 URL） */
export function listProviderConfigs(): Record<string, any>[] {
  const rows = queryAll('SELECT * FROM provider_config ORDER BY provider');
  return rows.map(row => ({
    ...row,
    base_url: row.base_url || OFFICIAL_URLS[row.provider] || '',
    base_url_anthropic: row.base_url_anthropic || OFFICIAL_ANTHROPIC_URLS[row.provider] || '',
  }));
}

/** 获取单个 provider 的配置（存储不变量全小写，调用方已归一化；base_url 为空时返回官方地址） */
export function getProviderConfig(provider: string): { provider: string; base_url: string; base_url_anthropic: string; api_key: string; enabled: boolean } | null {
  // 精确等值查询（存储不变量全小写，调用方需先归一化）
  const row = queryOne('SELECT * FROM provider_config WHERE provider = ?', [provider]);
  if (!row) return null;
  const resolved = row.provider || provider;
  const defaultUrl = OFFICIAL_URLS[resolved] || OFFICIAL_URLS[resolved.toLowerCase()] || '';
  return {
    provider: resolved,
    base_url: row.base_url || defaultUrl,
    base_url_anthropic: row.base_url_anthropic || '',
    api_key: row.api_key || '',
    enabled: row.enabled === 1,
  };
}

/** 内置供应商检查（大小写不敏感） */
function isBuiltinProvider(provider: string): boolean {
  return [...BUILTIN_PROVIDERS].some(b => b.toLowerCase() === provider.toLowerCase());
}

/** 更新 provider 配置（内置供应商不允许停用；供应商名大小写不敏感定位规范行） */
export function updateProviderConfig(provider: string, data: { enabled?: boolean; api_key?: string; base_url?: string; base_url_anthropic?: string }): { ok: boolean; error?: string } {
  // 内置供应商不允许停用（大小写不敏感）
  if (data.enabled === false && isBuiltinProvider(provider)) {
    return { ok: false, error: `内置供应商 "${provider}" 不可停用` };
  }
  const sets: string[] = [];
  const vals: any[] = [];
  if (data.enabled !== undefined) { sets.push('enabled = ?'); vals.push(data.enabled ? 1 : 0); }
  if (data.api_key !== undefined) { sets.push('api_key = ?'); vals.push(data.api_key); }
  if (data.base_url !== undefined) { sets.push('base_url = ?'); vals.push(data.base_url); }
  if (data.base_url_anthropic !== undefined) { sets.push('base_url_anthropic = ?'); vals.push(data.base_url_anthropic); }
  if (sets.length === 0) return { ok: true };
  sets.push('updated_at = ?'); vals.push(Date.now());
  // 大小写不敏感解析到小写名后按小写名更新（会话覆写存的是小写名，级联清理须一致）
  const canonical = normalizeProviderName(provider);
  vals.push(canonical);
  execute(`UPDATE provider_config SET ${sets.join(', ')} WHERE provider = ?`, vals);
  // 停用时自动清除所有引用该供应商的会话上游覆写（provider + model）
  if (data.enabled === false) {
    const cleared = execute('UPDATE sessions SET upstream_provider = NULL, upstream_model = NULL WHERE upstream_provider = ?', [canonical]);
    if (cleared > 0) {
      console.log(`已清除 ${cleared} 个会话的 "${canonical}" 上游覆写`);
    }
  }
  return { ok: true };
}

/** 新增自定义 provider（大小写不敏感去重：与内置供应商仅大小写不同时提示已存在；既有自定义供应商更新现有行） */
export function addProviderConfig(provider: string, baseUrl: string, baseUrlAnthropic: string, apiKey: string): number {
  const existing = queryOne('SELECT id, provider FROM provider_config WHERE provider = ?', [provider])
    ?? queryOne('SELECT id, provider FROM provider_config WHERE LOWER(provider) = LOWER(?)', [provider]);
  if (existing && isBuiltinProvider(existing.provider as string)) {
    // 内置供应商（大小写不敏感）已存在 → 不允许新增同名供应商，由调用方提示用户
    throw new Error(`供应商已存在：内置供应商 "${existing.provider}" 不可重复添加`);
  }
  if (existing) {
    // 既有自定义供应商 → 更新配置，保持其启用/停用状态（不强制启用）
    execute(
      'UPDATE provider_config SET base_url = ?, base_url_anthropic = ?, api_key = ?, updated_at = ? WHERE id = ?',
      [baseUrl, baseUrlAnthropic, apiKey, Date.now(), existing.id],
    );
    return Number(existing.id);
  }
  // 不存在同名（大小写不敏感）供应商 → 按新供应商插入（供应商名归一化为小写）
  const name = normalizeProviderName(provider);
  const now = Date.now();
  const id = executeInsert(
    'INSERT INTO provider_config (provider, base_url, base_url_anthropic, api_key, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?) RETURNING id',
    [name, baseUrl, baseUrlAnthropic, apiKey, now, now],
  );
  return id;
}

/** 删除 provider 配置（内置供应商不可删除；供应商名大小写不敏感定位规范行） */
export function deleteProviderConfig(provider: string): { ok: boolean; error?: string } {
  if (isBuiltinProvider(provider)) {
    return { ok: false, error: `内置供应商 "${provider}" 不可删除` };
  }
  const canonical = normalizeProviderName(provider);
  execute('DELETE FROM provider_config WHERE provider = ?', [canonical]);
  // 同时清除引用该供应商的会话上游覆写（按小写名匹配）
  const cleared = execute('UPDATE sessions SET upstream_provider = NULL, upstream_model = NULL WHERE upstream_provider = ?', [canonical]);
  if (cleared > 0) {
    console.log(`已清除 ${cleared} 个会话的 "${canonical}" 上游覆写`);
  }
  return { ok: true };
}

// ── Settings ──

export function getSetting(key: string): string | null {
  const row = queryOne('SELECT value FROM metadata WHERE key = ?', [key]);
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  const existing = queryOne('SELECT key FROM metadata WHERE key = ?', [key]);
  if (existing) {
    execute('UPDATE metadata SET value = ? WHERE key = ?', [value, key]);
  } else {
    execute('INSERT INTO metadata (key, value) VALUES (?, ?)', [key, value]);
  }
}
