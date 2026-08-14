/** 类别颜色注册系统测试 — 色板种子 / 注册 / 迁移 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, queryAll } from '../proxy/db.js';
import { seedPalette, registerCategoryColor, PALETTE_SIZE, PALETTE_COLORS } from '../proxy/colors.js';
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
    expect(rows[0]).toEqual({ idx: 0, color: '#1f77b4' });
    expect(rows[1]).toEqual({ idx: 1, color: '#ff7f0e' });
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
  it('新类别分配最小未占色位（tool 池：codex/claudecode 已注册占 0/1 → kimi 取 idx2）', () => {
    // 前置：先注册内置两个工具（空表时最小空位分配 → codex=0、claudecode=1；Task 3 迁移前本测试自建前置，不依赖迁移）
    expect(registerCategoryColor('tool', 'codex')).toBe(0);
    expect(registerCategoryColor('tool', 'claudecode')).toBe(1);
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
    // 前置：注册内置两个供应商（openai=0、anthropic=1）
    expect(registerCategoryColor('provider', 'openai')).toBe(0);
    expect(registerCategoryColor('provider', 'anthropic')).toBe(1);
    expect(registerCategoryColor('provider', 'deepseek')).toBe(2);
    expect(registerCategoryColor('provider', 'glm')).toBe(3);
  });

  it('32 色位全占后循环复用 idx0', () => {
    // 前置：再注册 32 个新名字必占满全部色位（与既有占用无关，自包含）
    for (let i = 0; i < PALETTE_SIZE; i++) {
      registerCategoryColor('tool', `t-${String(i).padStart(2, '0')}`);
    }
    // 此刻 0~31 全占 → 下一个循环复用 idx0
    expect(registerCategoryColor('tool', 'overflow-tool')).toBe(0);
  });
});
