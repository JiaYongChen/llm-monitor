/** migrateToolCanonicalNames 历史数据迁移测试 — 独立临时库，避免与其他测试共享库互相污染 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  initDb, closeDb, getDb, queryAll, listToolConfigs, updateToolConfig,
  migrateToolCanonicalNames, listProviderConfigs,
} from '../proxy/db.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();
beforeAll(async () => { await initDb(tmp.dbPath); });
afterAll(() => { closeDb(); tmp.cleanup(); });

// 直接调用迁移前清除单次执行门控（initDb 启动时已执行过一次）
const clearGate = () => getDb().run("DELETE FROM metadata WHERE key = 'tool_canonical_migrated'");

describe('migrateToolCanonicalNames 历史数据迁移', () => {
  it('归一化各表旧工具名，daily_stats 主键冲突时合并', () => {
    clearGate();
    const d = getDb();
    // 直接 SQL 构造旧数据（绕过归一化函数）
    d.run(`INSERT INTO sessions (tool, fingerprint, status, created_at) VALUES ('claudeCode', 'fp_legacy_1', 'active', 1)`);
    d.run(`INSERT INTO calls (session_id, provider, model, endpoint, method, status_code, duration_ms, fingerprint, tool, created_at)
           VALUES (1, 'OpenAI', 'gpt-legacy', '/v1/x', 'POST', 200, 10, 'fp_legacy_1', 'codex', 1)`);
    d.run(`INSERT INTO tool_config (tool, upstream_provider) VALUES ('codex', 'OpenAI')`);
    // daily_stats：一行与规范名主键冲突（需合并），一行不冲突（直接改名）
    d.run(`INSERT INTO daily_stats (date, provider, model, tool, call_count, total_cost, prompt_tokens, output_tokens, uncached_input, cache_read_tokens)
           VALUES ('2026-08-01', 'OpenAI', 'm-legacy', 'Codex', 1, 0.1, 10, 5, 8, 2)`);
    d.run(`INSERT INTO daily_stats (date, provider, model, tool, call_count, total_cost, prompt_tokens, output_tokens, uncached_input, cache_read_tokens)
           VALUES ('2026-08-01', 'OpenAI', 'm-legacy', 'codex', 2, 0.2, 20, 10, 16, 4)`);
    d.run(`INSERT INTO daily_stats (date, provider, model, tool, call_count, total_cost, prompt_tokens, output_tokens, uncached_input, cache_read_tokens)
           VALUES ('2026-08-02', 'OpenAI', 'm-legacy', 'codex', 1, 0.05, 5, 2, 4, 1)`);

    migrateToolCanonicalNames();

    expect(queryAll(`SELECT tool FROM sessions WHERE fingerprint = 'fp_legacy_1'`)[0].tool).toBe('ClaudeCode');
    expect(queryAll(`SELECT tool FROM calls WHERE fingerprint = 'fp_legacy_1'`)[0].tool).toBe('Codex');
    const tc = listToolConfigs().filter((r: any) => r.tool.toLowerCase() === 'codex');
    expect(tc).toHaveLength(1);
    expect(tc[0].tool).toBe('Codex');
    // 冲突行合并：call_count = 1 + 2
    const merged = queryAll(`SELECT * FROM daily_stats WHERE date = '2026-08-01' AND model = 'm-legacy'`);
    expect(merged).toHaveLength(1);
    expect(merged[0].tool).toBe('Codex');
    expect(merged[0].call_count).toBe(3);
    expect(merged[0].total_cost).toBeCloseTo(0.3);
    // 非冲突行直接改名
    const renamed = queryAll(`SELECT * FROM daily_stats WHERE date = '2026-08-02' AND model = 'm-legacy'`);
    expect(renamed).toHaveLength(1);
    expect(renamed[0].tool).toBe('Codex');
  });

  it('tool_config 多变体一轮收敛并合并上游配置', () => {
    clearGate();
    const d = getDb();
    d.run(`DELETE FROM tool_config WHERE LOWER(tool) = 'codex'`);
    d.run(`INSERT INTO tool_config (tool, upstream_provider, upstream_model) VALUES ('codex', 'GLM', NULL)`);
    d.run(`INSERT INTO tool_config (tool, upstream_provider, upstream_model) VALUES ('CODEX', NULL, 'glm-model')`);

    migrateToolCanonicalNames();

    const rows = listToolConfigs().filter((r: any) => r.tool.toLowerCase() === 'codex');
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe('Codex');
    // 两个变体的非空配置都保留下来
    expect(rows[0].upstream_provider).toBe('GLM');
    expect(rows[0].upstream_model).toBe('glm-model');
  });

  it('chatgpt 历史数据不迁移（防止劫持同名自定义工具）', () => {
    clearGate();
    const d = getDb();
    d.run(`INSERT INTO sessions (tool, fingerprint, status, created_at) VALUES ('chatgpt', 'fp_chatgpt_legacy', 'active', 1)`);
    d.run(`INSERT INTO tool_config (tool, upstream_provider) VALUES ('chatgpt', 'OpenAI')`);

    migrateToolCanonicalNames();

    expect(queryAll(`SELECT tool FROM sessions WHERE fingerprint = 'fp_chatgpt_legacy'`)[0].tool).toBe('chatgpt');
    expect(listToolConfigs().some((r: any) => r.tool === 'chatgpt')).toBe(true);
  });

  it('自定义工具历史变体归一化到 tool_config 规范名', () => {
    clearGate();
    const d = getDb();
    updateToolConfig('cursor', 'OpenAI', null);
    d.run(`INSERT INTO sessions (tool, fingerprint, status, created_at) VALUES ('CURSOR', 'fp_cursor_variant', 'active', 1)`);

    migrateToolCanonicalNames();

    expect(queryAll(`SELECT tool FROM sessions WHERE fingerprint = 'fp_cursor_variant'`)[0].tool).toBe('cursor');
  });

  it('供应商历史变体归一化到 provider_config 规范名', () => {
    clearGate();
    const d = getDb();
    d.run(`INSERT INTO calls (session_id, provider, model, endpoint, method, status_code, duration_ms, fingerprint, tool, created_at)
           VALUES (1, 'anthropic', 'm-prov', '/v1/x', 'POST', 200, 10, 'fp_prov_variant', 'ClaudeCode', 1)`);

    migrateToolCanonicalNames();

    expect(queryAll(`SELECT provider FROM calls WHERE fingerprint = 'fp_prov_variant'`)[0].provider).toBe('anthropic');
  });

  it('provider_config 大小写变体收敛为一行并合并配置', () => {
    clearGate();
    const d = getDb();
    // 历史数据：旧版精确匹配插入可能产生同一供应商的大小写变体行
    d.run(`INSERT INTO provider_config (provider, base_url, api_key, enabled) VALUES ('zhipu', 'https://a.example', '', 1)`);
    d.run(`INSERT INTO provider_config (provider, base_url, api_key, enabled) VALUES ('ZHIPU', '', 'k-variant', 1)`);
    d.run(`INSERT INTO calls (session_id, provider, model, endpoint, method, status_code, duration_ms, fingerprint, tool, created_at)
           VALUES (1, 'ZHIPU', 'm-pp', '/v1/x', 'POST', 200, 10, 'fp_prov_pp', 'ClaudeCode', 1)`);

    migrateToolCanonicalNames();

    const rows = listProviderConfigs().filter((p: any) => p.provider.toLowerCase() === 'zhipu');
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('zhipu');  // 首行（rowid 小）为规范行
    expect(rows[0].base_url).toBe('https://a.example');
    expect(rows[0].api_key).toBe('k-variant');  // 规范行空字段由变体行补齐
    expect(queryAll(`SELECT provider FROM calls WHERE fingerprint = 'fp_prov_pp'`)[0].provider).toBe('zhipu');
  });

  it('内置供应商与大小写变体并存时保留内置行并合并配置', () => {
    clearGate();
    const d = getDb();
    // 种子行已小写化，插入大写变体模拟历史数据（小写变体会与种子主键冲突）
    d.run(`INSERT INTO provider_config (provider, base_url, api_key, enabled) VALUES ('OPENAI', 'https://gw.example', 'gw-key', 1)`);

    migrateToolCanonicalNames();

    const rows = listProviderConfigs().filter((p: any) => p.provider.toLowerCase() === 'openai');
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('openai');
    // 内置行空字段由变体行补齐（用户历史配置不丢失）
    expect(rows[0].base_url).toBe('https://gw.example');
    expect(rows[0].api_key).toBe('gw-key');
  });

  it('自定义工具 tool_config 大小写变体收敛并合并，会话数据确定性归一', () => {
    clearGate();
    const d = getDb();
    d.run(`DELETE FROM tool_config WHERE LOWER(tool) = 'cursor'`);
    d.run(`INSERT INTO tool_config (tool, upstream_provider, upstream_model) VALUES ('cursor', 'OpenAI', NULL)`);
    d.run(`INSERT INTO tool_config (tool, upstream_provider, upstream_model) VALUES ('CURSOR', NULL, 'gpt-x')`);
    d.run(`INSERT INTO sessions (tool, fingerprint, status, created_at) VALUES ('Cursor', 'fp_cursor_pp', 'active', 1)`);

    migrateToolCanonicalNames();

    const rows = listToolConfigs().filter((t: any) => t.tool.toLowerCase() === 'cursor');
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe('cursor');
    expect(rows[0].upstream_provider).toBe('openai');  // 供应商维度归一到小写种子名
    expect(rows[0].upstream_model).toBe('gpt-x');
    expect(queryAll(`SELECT tool FROM sessions WHERE fingerprint = 'fp_cursor_pp'`)[0].tool).toBe('cursor');
  });

  it('pricing 表 provider 归一化到规范名', () => {
    clearGate();
    const d = getDb();
    d.run(`INSERT INTO pricing (provider, model, input_price, cache_input_price, output_price)
           VALUES ('anthropic', 'claude-mig-x', 1, 0.5, 2)`);

    migrateToolCanonicalNames();

    expect(queryAll(`SELECT provider FROM pricing WHERE model = 'claude-mig-x'`)[0].provider).toBe('anthropic');
  });

  it('单次执行门控：已迁移则跳过', () => {
    clearGate();
    migrateToolCanonicalNames();
    const d = getDb();
    // 门控已设置 → 再次插入变体后调用不应生效
    d.run(`INSERT INTO sessions (tool, fingerprint, status, created_at) VALUES ('codex', 'fp_gated', 'active', 1)`);
    migrateToolCanonicalNames();
    expect(queryAll(`SELECT tool FROM sessions WHERE fingerprint = 'fp_gated'`)[0].tool).toBe('codex');
  });
});
