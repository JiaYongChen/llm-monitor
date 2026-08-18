/** 存量库兼容升级回归：旧 schema 的 provider_models（无价格列）经 initDb 应补上价格列且数据保留 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import initSqlJs from 'sql.js';
import { createTempDb } from './setup.js';
import { initDb, closeDb, queryAll, seedProviderModels } from '../proxy/db.js';

const tmp = createTempDb();

beforeAll(async () => {
  // 手工构造旧 schema 数据库文件：provider_models 只有 6 列（价格列加入之前的历史形态）
  const SQL = await initSqlJs();
  const old = new SQL.Database();
  old.run(`
    CREATE TABLE provider_models (
      provider   TEXT NOT NULL,
      model      TEXT NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      available  INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (provider, model)
    )
  `);
  old.run(`INSERT INTO provider_models (provider, model) VALUES ('anthropic', 'claude-legacy')`);
  writeFileSync(tmp.dbPath, Buffer.from(old.export()));
  old.close();
  await initDb(tmp.dbPath);
});

afterAll(async () => {
  closeDb();
  tmp.cleanup();
});

describe('存量库 provider_models 价格列兼容升级', () => {
  it('initDb 后补上四个价格列', () => {
    const cols = queryAll('PRAGMA table_info(provider_models)');
    const names = cols.map(r => r.name as string);
    expect(names).toEqual(expect.arrayContaining(['input_price', 'cache_input_price', 'output_price', 'currency']));
  });

  it('旧行数据保留且价格列为默认 0', () => {
    const row = queryAll("SELECT * FROM provider_models WHERE provider = 'anthropic' AND model = 'claude-legacy'");
    expect(row).toHaveLength(1);
    expect(row[0].input_price).toBe(0);
    expect(row[0].currency).toBe('USD');
  });

  it('seedProviderModels 可正常写入价格', () => {
    expect(() => seedProviderModels(
      [{ provider: 'anthropic', model: 'claude-new', input_price: 3, cache_input_price: 0.5, output_price: 15, currency: 'USD' }],
      123,
    )).not.toThrow();
    const row = queryAll("SELECT * FROM provider_models WHERE model = 'claude-new'");
    expect(row).toHaveLength(1);
    expect(row[0].input_price).toBe(3);
  });
});
