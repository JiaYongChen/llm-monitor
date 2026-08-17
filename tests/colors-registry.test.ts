/** 类别颜色注册系统测试 — 色板种子 / 注册 / 迁移
 *
 *  ⚠ 顺序依赖声明：本文件测试共享同一个临时数据库，vitest 按定义顺序串行执行。
 *  关键依赖链：「历史名称按字母序注册」测试会清空 category_colors 并重置迁移门控后重跑迁移，
 *  其后的「recorder 运行时注册」测试断言依赖该重跑结果（claudecode 仍为 idx1）。
 *  请勿在「启动迁移」describe 与「recorder 运行时注册」describe 之间插入依赖注册表状态的测试；
 *  如必须插入，请先为该测试自建前置状态或调整清表重跑的位置。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, queryAll, getDb, upsertSession, addProviderConfig } from '../proxy/db.js';
import { seedPalette, registerCategoryColor, migrateCategoryColors, migratePaletteSwap, getCategoryColors, PALETTE_SIZE, PALETTE_COLORS } from '../proxy/colors.js';
import { enqueueRecord, startRecorder, stopRecorder } from '../proxy/recorder.js';
import type { CallRecord } from '../shared/types.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();

beforeAll(async () => {
  await initDb(tmp.dbPath);
});
afterAll(() => { closeDb(); tmp.cleanup(); });

describe('色板种子', () => {
  it('initDb 后 color_palette 自动种入 32 色（light 主题）', () => {
    const rows = queryAll("SELECT idx, color FROM color_palette WHERE theme = 'light' ORDER BY idx");
    expect(rows.length).toBe(PALETTE_SIZE);
    expect(rows[0]).toEqual({ idx: 0, color: '#ff7f0e' });
    expect(rows[1]).toEqual({ idx: 1, color: '#1f77b4' });
    expect(rows[31]).toEqual({ idx: 31, color: '#999999' });
    expect(PALETTE_COLORS.length).toBe(32);
  });

  it('seedPalette 幂等：已种入时不重复插入', () => {
    seedPalette();
    const rows = queryAll("SELECT * FROM color_palette WHERE theme = 'light'");
    expect(rows.length).toBe(32);
  });
});

describe('运行时注册 registerCategoryColor', () => {
  it('新类别分配最小未占色位（tool 池：claudecode/codex 已注册占 0/1 → kimi 取 idx2）', () => {
    // 前置：先注册内置两个工具（空表时最小空位分配 → claudecode=0、codex=1；Task 3 迁移前本测试自建前置，不依赖迁移）
    expect(registerCategoryColor('tool', 'codex')).toBe(1);
    expect(registerCategoryColor('tool', 'claudecode')).toBe(0);
    const idx = registerCategoryColor('tool', 'kimi');
    expect(idx).toBe(2);
    const row = queryAll("SELECT * FROM category_colors WHERE kind = 'tool' AND name = 'kimi'");
    expect(row.length).toBe(1);
    expect(row[0].color_idx).toBe(2);
  });

  it('已注册类别幂等返回原色位', () => {
    expect(registerCategoryColor('tool', 'kimi')).toBe(2);
    expect(registerCategoryColor('tool', 'KIMI')).toBe(2); // 名称归一化小写
    expect(queryAll("SELECT * FROM category_colors WHERE kind = 'tool' AND name = 'kimi'").length).toBe(1);
  });

  it('provider 池独立注册（同样从最小空位开始）', () => {
    // 前置：注册内置两个供应商（openai=1、anthropic=0）
    expect(registerCategoryColor('provider', 'openai')).toBe(1);
    expect(registerCategoryColor('provider', 'anthropic')).toBe(0);
    expect(registerCategoryColor('provider', 'deepseek')).toBe(2);
    expect(registerCategoryColor('provider', 'glm')).toBe(3);
  });

  it('32 色位全占后循环复用（避开内置锚点 0/1）', () => {
    // 前置：再注册 32 个新名字必占满全部色位（与既有占用无关，自包含）
    for (let i = 0; i < PALETTE_SIZE; i++) {
      registerCategoryColor('tool', `t-${String(i).padStart(2, '0')}`);
    }
    // 此刻 0~31 全占 → 下一个按名称哈希映射到 [2,31]，不与内置锚点 claudecode(0)/codex(1) 撞色
    const idx = registerCategoryColor('tool', 'overflow-tool');
    expect(idx).toBeGreaterThanOrEqual(2);
    expect(idx).toBeLessThan(PALETTE_SIZE);
  });

  it('空名与 unknown 不注册（返回 -1 且不落库）', () => {
    expect(registerCategoryColor('tool', '')).toBe(-1);
    expect(registerCategoryColor('provider', '')).toBe(-1);
    expect(registerCategoryColor('tool', 'unknown')).toBe(-1);
    expect(registerCategoryColor('provider', 'UNKNOWN')).toBe(-1); // 归一化后判断
    expect(queryAll("SELECT * FROM category_colors WHERE name = 'unknown'").length).toBe(0);
    expect(queryAll("SELECT * FROM category_colors WHERE name = ''").length).toBe(0);
  });
});

describe('注册表查询 getCategoryColors', () => {
  it('特殊名称 __proto__ 不被原型污染吞掉', () => {
    registerCategoryColor('provider', '__proto__');
    const colors = getCategoryColors();
    expect(colors.providers['__proto__']).toBeGreaterThanOrEqual(0);
    expect(Object.keys(colors.providers)).toContain('__proto__');
  });

  it('色板表为空时兜底返回种子色值（查询不依赖已种子数据）', () => {
    const d = getDb();
    d.run("DELETE FROM color_palette WHERE theme = 'light'");
    const colors = getCategoryColors();
    expect(colors.palette.length).toBe(PALETTE_SIZE);
    expect(colors.palette[0]).toEqual({ idx: 0, color: '#ff7f0e' });
  });
});

describe('色板交换迁移 migratePaletteSwap', () => {
  it('老库旧序数据交换后内置类别显示色不变（门控幂等）', () => {
    const d = getDb();
    // 构造老库旧序：色板 0 蓝 1 橙、注册表 codex/openai→0、claudecode/anthropic→1
    // （色板表可能已被兜底测试清空 → 显式删除后插入旧序行，自包含构造）
    d.run("DELETE FROM color_palette WHERE theme = 'light'");
    d.run("INSERT INTO color_palette (theme, idx, color) VALUES ('light', 0, '#1f77b4'), ('light', 1, '#ff7f0e')");
    d.run("UPDATE category_colors SET color_idx = CASE name WHEN 'codex' THEN 0 WHEN 'claudecode' THEN 1 ELSE color_idx END WHERE kind = 'tool'");
    d.run("UPDATE category_colors SET color_idx = CASE name WHEN 'openai' THEN 0 WHEN 'anthropic' THEN 1 ELSE color_idx END WHERE kind = 'provider'");
    d.run("DELETE FROM metadata WHERE key = 'palette_01_swapped'");
    migratePaletteSwap();
    // 色板表：idx 0/1 颜色交换（#ff7f0e 在前）
    const palette = queryAll("SELECT idx, color FROM color_palette WHERE theme = 'light' ORDER BY idx");
    expect(palette[0]).toEqual({ idx: 0, color: '#ff7f0e' });
    expect(palette[1]).toEqual({ idx: 1, color: '#1f77b4' });
    // 注册表：色位 0↔1 交换 → 内置类别显示色不变（codex/openai 蓝、claudecode/anthropic 橙）
    const tools = queryAll("SELECT name, color_idx FROM category_colors WHERE kind = 'tool' AND name IN ('codex','claudecode')");
    expect(tools.find(r => r.name === 'codex')?.color_idx).toBe(1);
    expect(tools.find(r => r.name === 'claudecode')?.color_idx).toBe(0);
    const providers = queryAll("SELECT name, color_idx FROM category_colors WHERE kind = 'provider' AND name IN ('openai','anthropic')");
    expect(providers.find(r => r.name === 'openai')?.color_idx).toBe(1);
    expect(providers.find(r => r.name === 'anthropic')?.color_idx).toBe(0);
    // 门控幂等：重跑不重复交换
    migratePaletteSwap();
    const palette2 = queryAll("SELECT idx, color FROM color_palette WHERE theme = 'light' ORDER BY idx");
    expect(palette2[0]).toEqual({ idx: 0, color: '#ff7f0e' });
    expect(palette2[1]).toEqual({ idx: 1, color: '#1f77b4' });
  });
});

describe('启动迁移 migrateCategoryColors', () => {
  it('内置 4 类固定色位（initDb 已自动执行迁移）', () => {
    // 注意：Task 2 的测试可能已注册额外类别，按名断言而非全表 toEqual
    const tools = queryAll("SELECT name, color_idx FROM category_colors WHERE kind = 'tool'");
    const providers = queryAll("SELECT name, color_idx FROM category_colors WHERE kind = 'provider'");
    expect(tools.find(r => r.name === 'codex')?.color_idx).toBe(1);
    expect(tools.find(r => r.name === 'claudecode')?.color_idx).toBe(0);
    expect(providers.find(r => r.name === 'openai')?.color_idx).toBe(1);
    expect(providers.find(r => r.name === 'anthropic')?.color_idx).toBe(0);
  });

  it('metadata 门控幂等：重跑不产生重复行', () => {
    migrateCategoryColors();
    expect(queryAll("SELECT * FROM category_colors WHERE name = 'codex'").length).toBe(1);
  });

  it('历史名称按字母序注册（门控重置 + 清注册表后重跑）', async () => {
    const d = getDb();
    d.run('DELETE FROM category_colors');
    d.run("DELETE FROM metadata WHERE key = 'colors_migrated'");
    // 造历史数据（工具 kimi/glm/zebra-tool + 供应商 deepseek）
    upsertSession('fp_kimi', 'kimi', '/v1/chat/completions');
    upsertSession('fp_glm', 'glm', '/v1/chat/completions');
    upsertSession('fp_zebra', 'zebra-tool', '/v1/messages');
    addProviderConfig('deepseek', 'https://api.deepseek.com', '', '');
    migrateCategoryColors();
    const tools = queryAll("SELECT name, color_idx FROM category_colors WHERE kind = 'tool' ORDER BY color_idx");
    expect(tools).toEqual([
      { name: 'claudecode', color_idx: 0 },
      { name: 'codex', color_idx: 1 },
      { name: 'glm', color_idx: 2 },
      { name: 'kimi', color_idx: 3 },
      { name: 'zebra-tool', color_idx: 4 },
    ]);
    const providers = queryAll("SELECT name, color_idx FROM category_colors WHERE kind = 'provider' ORDER BY color_idx");
    expect(providers).toEqual([
      { name: 'anthropic', color_idx: 0 },
      { name: 'openai', color_idx: 1 },
      { name: 'deepseek', color_idx: 2 },
    ]);
  });
});

describe('recorder 运行时注册', () => {
  it('处理调用时自动注册新工具与新供应商', async () => {
    const sid = upsertSession('fp_color_reg', 'claudecode', '/v1/messages');
    const record: CallRecord = {
      provider: 'moonshot', model: 'kimi-k2', tool: 'claudecode',
      endpoint: '/v1/messages', method: 'POST',
      target_url: 'https://api.moonshot.cn/v1/messages', downstream_url: 'http://localhost:9400/claudecode/v1/messages', source_ip: '127.0.0.1',
      status_code: 200, error_message: null, duration_ms: 500,
      request_body: null,
      response_body: JSON.stringify({
        model: 'kimi-k2',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
      fingerprint: 'fp_color_reg', source_port: 54330, session_id: sid,
      prompt_tokens: null, output_tokens: null, cache_read_tokens: null,
      cache_write_tokens: null, uncached_input: null,
      input_cost: 0, output_cost: 0, total_cost: 0, cache_savings: 0,
    };
    startRecorder();
    enqueueRecord(record);
    try {
      // 轮询等待消费者处理完毕（固定 300ms 等待在慢环境偶发脆弱；recorder 为 100ms 轮询，2s 上限足够）
      const deadline = Date.now() + 2000;
      let prov: any[] = [];
      while (Date.now() < deadline) {
        prov = queryAll("SELECT * FROM category_colors WHERE kind = 'provider' AND name = 'moonshot'");
        if (prov.length === 1) break;
        await new Promise(r => setTimeout(r, 50));
      }
      expect(prov.length).toBe(1);
      expect(prov[0].color_idx).toBeGreaterThanOrEqual(0);
      // 已注册的内置工具不被覆盖（claudecode 仍为 idx0）
      expect(queryAll("SELECT color_idx FROM category_colors WHERE kind = 'tool' AND name = 'claudecode'")[0]?.color_idx).toBe(0);
    } finally {
      // 断言失败也要停掉 recorder，避免 interval 泄漏影响同文件后续用例
      stopRecorder();
    }
  });
});
