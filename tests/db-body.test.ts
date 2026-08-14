/** db-body 文件操作测试 — 独立临时 body 目录，不与真实数据目录交互 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setBodyDir, bodyFilePath, writeBody, readBody, deleteSessionBodies, moveSessionBodies, clearAllBodies, listBodyFiles } from '../proxy/db-body.js';

const dir = mkdtempSync(join(tmpdir(), 'llm-monitor-body-test-'));
const tmpBodyDir = join(dir, 'bodyData');
setBodyDir(tmpBodyDir);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('db-body 文件操作', () => {
  it('writeBody 后 readBody 精确读回', () => {
    writeBody(1, 10, 1786604160000, '{"model":"c"}', '{"ok":true}');
    expect(existsSync(bodyFilePath(1, 10, 1786604160000))).toBe(true);
    const body = readBody(1, 10, 1786604160000);
    expect(body?.request).toBe('{"model":"c"}');
    expect(body?.response).toBe('{"ok":true}');
  });

  it('readBody 文件缺失返回 null', () => {
    expect(readBody(1, 999, 1786604160000)).toBeNull();
  });

  it('readBody 文件损坏（非 JSON）返回 null', () => {
    writeBody(2, 20, 1786604160000, 'r', 's');
    writeFileSync(bodyFilePath(2, 20, 1786604160000), 'not-json');
    expect(readBody(2, 20, 1786604160000)).toBeNull();
  });

  it('deleteSessionBodies 删除整个会话目录', () => {
    writeBody(3, 30, 1786604160000, 'r', 's');
    writeBody(3, 31, 1786604160001, 'r', 's');
    deleteSessionBodies(3);
    expect(readBody(3, 30, 1786604160000)).toBeNull();
    expect(readBody(3, 31, 1786604160001)).toBeNull();
  });

  it('moveSessionBodies 移动源目录全部文件到目标目录并删除源目录', () => {
    writeBody(4, 40, 1786604160000, 'r4', 's4');
    writeBody(5, 50, 1786604160001, 'r5', 's5');
    moveSessionBodies(4, 5);
    expect(readBody(4, 40, 1786604160000)).toBeNull();        // 源路径失效
    expect(readBody(5, 40, 1786604160000)?.request).toBe('r4'); // 目标路径可读（文件名含 callId 不冲突）
    expect(readBody(5, 50, 1786604160001)?.request).toBe('r5'); // 目标原有文件保留
  });

  it('clearAllBodies 清空 bodyData 目录', () => {
    writeBody(6, 60, 1786604160000, 'r', 's');
    clearAllBodies();
    expect(readBody(6, 60, 1786604160000)).toBeNull();
    expect(listBodyFiles()).toHaveLength(0);
  });

  it('listBodyFiles 扫描出会话与 callId', () => {
    writeBody(7, 70, 1786604160000, 'r', 's');
    const files = listBodyFiles();
    expect(files.some(f => f.sessionId === 7 && f.callId === 70)).toBe(true);
  });
});
