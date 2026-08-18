/** 类别颜色注册系统测试 — 色板种子 / 注册 / 内置色位 / 查询
 *
 *  ⚠ 顺序依赖声明：本文件测试共享同一个临时数据库，vitest 按定义顺序串行执行。
 *  关键依赖链：「运行时注册」与「内置色位注册」测试注册了内置色位（claudecode=0、codex=1、anthropic=0、openai=1），
 *  其后的「recorder 运行时注册」测试断言依赖该结果（claudecode 仍为 idx0）。
 *  请勿在「内置色位注册」describe 与「recorder 运行时注册」describe 之间插入清空 category_colors 的测试；
 *  如必须插入，请先为该测试自建前置状态。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, queryAll, getDb, upsertSession } from '../proxy/db.js';
import { seedPalette, registerCategoryColor, registerBuiltinCategoryColors, getCategoryColors, PALETTE_SIZE, PALETTE_COLORS } from '../proxy/colors.js';
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

describe('内置色位注册 registerBuiltinCategoryColors', () => {
  it('内置类别固定色位初始化幂等', () => {
    registerBuiltinCategoryColors();
    const colors = getCategoryColors();
    // 断言内置工具/供应商色位与 BUILTIN_COLOR_IDX 一致（claudecode/anthropic→0 橙、codex/openai→1 蓝）
    expect(colors.tools['claudecode']).toBe(0);
    expect(colors.tools['codex']).toBe(1);
    expect(colors.providers['anthropic']).toBe(0);
    expect(colors.providers['openai']).toBe(1);
    registerBuiltinCategoryColors(); // 二次调用不报错、不重复注册（INSERT OR IGNORE）
    const again = getCategoryColors();
    expect(again.tools['claudecode']).toBe(0);
    expect(again.tools['codex']).toBe(1);
    expect(again.providers['anthropic']).toBe(0);
    expect(again.providers['openai']).toBe(1);
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
