/** Vitest 测试工具 — 创建临时数据库 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

export function createTempDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'llm-monitor-test-'));
  return {
    dbPath: join(dir, 'test.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
