/** 类别颜色注册系统测试 — 色板种子 / 注册 / 迁移 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, queryAll } from '../proxy/db.js';
import { seedPalette, PALETTE_SIZE, PALETTE_COLORS } from '../proxy/colors.js';
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
