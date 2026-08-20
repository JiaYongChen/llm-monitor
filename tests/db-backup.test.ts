/** 数据库备份与恢复测试（.bak 轮转 + 损坏/缺失恢复） */
import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { initDb, closeDb, saveDb, setSetting, getSetting } from '../proxy/db.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();
afterAll(() => { closeDb(); tmp.cleanup(); });

describe('数据库备份与恢复', () => {
  it('saveDb 落盘时上一版本轮转为 .bak 备份', async () => {
    await initDb(tmp.dbPath);
    setSetting('k', 'v1');
    saveDb(undefined, true); // 首次 flush：创建主文件，尚无备份
    setSetting('k', 'v2');
    saveDb(undefined, true); // 第二次 flush：v1 轮转为 .bak
    expect(existsSync(tmp.dbPath + '.bak')).toBe(true);
    closeDb(); // closeDb 再次落盘：.bak 更新为 v2
  });

  it('主文件损坏时从 .bak 备份恢复', async () => {
    // 破坏主文件（模拟写入撕裂/磁盘错误）
    writeFileSync(tmp.dbPath, Buffer.from('not a sqlite database'));
    await initDb(tmp.dbPath);
    // 从备份恢复：数据完整可读
    expect(getSetting('k')).toBe('v2');
    closeDb();
  });

  it('主文件缺失时从 .bak 备份恢复', async () => {
    rmSync(tmp.dbPath); // 模拟落盘的两次 rename 之间进程中断
    expect(existsSync(tmp.dbPath + '.bak')).toBe(true);
    await initDb(tmp.dbPath);
    expect(getSetting('k')).toBe('v2');
    closeDb();
  });
});
