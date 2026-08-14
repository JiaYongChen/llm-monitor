/** Vitest 测试工具 — 创建临时数据库（同时注入临时 body 目录，测试不碰真实数据目录） */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { setBodyDir } from '../proxy/db-body.js';

export function createTempDb(): { dbPath: string; bodyDir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'llm-monitor-test-'));
  const bodyDir = join(dir, 'bodyData');
  setBodyDir(bodyDir);
  return {
    dbPath: join(dir, 'test.db'),
    bodyDir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
