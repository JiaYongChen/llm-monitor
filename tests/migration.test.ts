/** migrateToolCanonicalNames 历史数据迁移测试 — 独立临时库，避免与其他测试共享库互相污染 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  initDb, closeDb, getDb, queryAll, listToolConfigs, updateToolConfig,
  migrateToolCanonicalNames, migrateLowercaseNames, listProviderConfigs,
  saveDb, listProviderModels,
} from '../proxy/db.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();
beforeAll(async () => { await initDb(tmp.dbPath); });
afterAll(() => { closeDb(); tmp.cleanup(); });

// 直接调用迁移前清除单次执行门控（initDb 启动时已执行过一次）
const clearGate = () => getDb().run("DELETE FROM metadata WHERE key = 'tool_canonical_migrated'");
// 小写迁移门控同模式清理
const clearLowerGate = () => getDb().run("DELETE FROM metadata WHERE key = 'lowercase_migrated'");

describe('migrateToolCanonicalNames 历史数据迁移', () => {
  it('归一化各表旧工具名', () => {
    clearGate();
    const d = getDb();
    // 直接 SQL 构造旧数据（绕过归一化函数）
    d.run(`INSERT INTO sessions (tool, fingerprint, status, created_at) VALUES ('claudeCode', 'fp_legacy_1', 'active', 1)`);
    d.run(`INSERT INTO calls (session_id, provider, model, endpoint, method, status_code, duration_ms, fingerprint, tool, created_at)
           VALUES (1, 'OpenAI', 'gpt-legacy', '/v1/x', 'POST', 200, 10, 'fp_legacy_1', 'codex', 1)`);
    d.run(`INSERT INTO tool_config (tool, upstream_provider) VALUES ('codex', 'OpenAI')`);

    migrateToolCanonicalNames();

    expect(queryAll(`SELECT tool FROM sessions WHERE fingerprint = 'fp_legacy_1'`)[0].tool).toBe('ClaudeCode');
    expect(queryAll(`SELECT tool FROM calls WHERE fingerprint = 'fp_legacy_1'`)[0].tool).toBe('Codex');
    const tc = listToolConfigs().filter((r: any) => r.tool.toLowerCase() === 'codex');
    expect(tc).toHaveLength(1);
    expect(tc[0].tool).toBe('Codex');
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
           VALUES (1, 'Anthropic', 'm-prov', '/v1/x', 'POST', 200, 10, 'fp_prov_variant', 'ClaudeCode', 1)`);

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

describe('migrateLowercaseNames 小写迁移', () => {
  it('工具/供应商/模型全链路转小写', () => {
    clearLowerGate();
    const d = getDb();
    // 清掉旧迁移用例残留的 'Codex' 主键行，避免 INSERT 撞主键（与其他用例 fixture 隔离）
    d.run(`DELETE FROM tool_config WHERE LOWER(tool) = 'codex'`);
    // 直接 SQL 构造旧数据（绕过归一化函数，模拟历史 CamelCase 数据）
    d.run(`INSERT INTO sessions (tool, fingerprint, status, created_at) VALUES ('ClaudeCode', 'fp_lc_1', 'active', 1)`);
    d.run(`INSERT INTO calls (session_id, provider, model, endpoint, method, status_code, duration_ms, fingerprint, tool, created_at)
           VALUES (1, 'OpenAI', 'GPT-5', '/v1/x', 'POST', 200, 10, 'fp_lc_1', 'Codex', 1)`);
    d.run(`INSERT INTO tool_config (tool, upstream_provider, upstream_model) VALUES ('Codex', 'OpenAI', 'GLM-X')`);

    migrateLowercaseNames();

    expect(queryAll(`SELECT tool FROM sessions WHERE fingerprint = 'fp_lc_1'`)[0].tool).toBe('claudecode');
    const call = queryAll(`SELECT * FROM calls WHERE fingerprint = 'fp_lc_1'`)[0];
    expect(call.provider).toBe('openai');
    expect(call.model).toBe('gpt-5');
    expect(call.tool).toBe('codex');
    const tc = queryAll(`SELECT * FROM tool_config WHERE LOWER(tool) = 'codex'`);
    expect(tc).toHaveLength(1);
    expect(tc[0].tool).toBe('codex');
    expect(tc[0].upstream_provider).toBe('openai');
    expect(tc[0].upstream_model).toBe('glm-x');
  });

  it('provider_config 大小写变体收敛为一行并小写', () => {
    clearLowerGate();
    const d = getDb();
    // 使用独立供应商名，避免与旧迁移用例残留的 'zhipu' 行互相污染
    d.run(`INSERT INTO provider_config (provider, base_url, api_key, enabled) VALUES ('Moonshot', 'https://a.example', '', 1)`);
    d.run(`INSERT INTO provider_config (provider, base_url, api_key, enabled) VALUES ('MOONSHOT', '', 'k-variant', 1)`);

    migrateLowercaseNames();

    const rows = listProviderConfigs().filter((p: any) => p.provider.toLowerCase() === 'moonshot');
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('moonshot');
    expect(rows[0].base_url).toBe('https://a.example');
    expect(rows[0].api_key).toBe('k-variant');
  });

  it('单次执行门控：已迁移则跳过', () => {
    clearLowerGate();
    migrateLowercaseNames();
    const d = getDb();
    d.run(`INSERT INTO sessions (tool, fingerprint, status, created_at) VALUES ('NEWTOOL', 'fp_lc_gate', 'active', 1)`);
    migrateLowercaseNames();
    expect(queryAll(`SELECT tool FROM sessions WHERE fingerprint = 'fp_lc_gate'`)[0].tool).toBe('NEWTOOL');
  });
});

describe('老库 pricing 表直删', () => {
  // 独立临时库 + 本用例位于文件末尾（用例内会 closeDb 切换单例，之后无其他用例依赖共享库）
  it('老库含 pricing 表：initDb 后 pricing 被 DROP，迁移不报错（定价不迁移）', async () => {
    // 模拟老库：先关闭 beforeAll 打开的共享库，让 initDb 真正切换到独立库
    const old = createTempDb();
    closeDb();
    await initDb(old.dbPath);
    // 用 raw SQL 模拟老库 pricing 存量（当前 initDb 已不建 pricing，需手动建后再重启验证 DROP）
    const d = getDb();
    d.run(`CREATE TABLE IF NOT EXISTS pricing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL, model TEXT NOT NULL,
      input_price REAL NOT NULL, cache_input_price REAL NOT NULL, output_price REAL NOT NULL,
      unit TEXT NOT NULL DEFAULT 'per_1M_tokens', currency TEXT NOT NULL DEFAULT 'CNY',
      effective_from TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(provider, model, effective_from)
    )`);
    d.run(`INSERT INTO pricing (provider, model, input_price, cache_input_price, output_price) VALUES ('legacy-prov', 'legacy-model', 1, 0.5, 2)`);
    saveDb();
    closeDb();
    // 重新打开（新版本 initDb）：pricing 应被 DROP
    await initDb(old.dbPath);
    const rows = queryAll("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pricing'");
    expect(rows).toHaveLength(0);
    // provider_models 不含迁移数据（不迁移历史定价）
    expect(listProviderModels().filter(r => r.provider === 'legacy-prov')).toHaveLength(0);
    closeDb();
    old.cleanup();
  });
});
