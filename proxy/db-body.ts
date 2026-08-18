/** body 文件存储 — 每调用一文件：bodyData/<sessionId>/<createdAtMs>-<callId>.json
 *  文件读写（writeBody/readBody）+ 删除联动（deleteSessionBodies/moveSessionBodies/clearAllBodies）+ 孤儿文件对账（reconcileOrphanBodies）。 */
import { mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BODY_DIR } from './config.js';
import { queryAll } from './db-core.js';

/** 当前 body 根目录（默认 DATA_DIR/bodyData，测试可注入临时目录） */
let bodyDir = BODY_DIR;

/** 测试注入临时 body 目录 */
export function setBodyDir(dir: string): void {
  bodyDir = dir;
}

/** 路径纯函数推导：calls 表无需存储路径列 */
export function bodyFilePath(sessionId: number, callId: number, createdAtMs: number): string {
  return join(bodyDir, String(sessionId), `${createdAtMs}-${callId}.json`);
}

/** 写入一条调用的 body（先确保会话目录存在；抛错由调用方降级） */
export function writeBody(sessionId: number, callId: number, createdAtMs: number, request: string | null, response: string | null): void {
  const file = bodyFilePath(sessionId, callId, createdAtMs);
  mkdirSync(join(bodyDir, String(sessionId)), { recursive: true });
  writeFileSync(file, JSON.stringify({ request, response }), 'utf-8');
}

/** 读取一条调用的 body；文件缺失或解析失败返回 null（调用方降级显示） */
export function readBody(sessionId: number, callId: number, createdAtMs: number): { request: string | null; response: string | null } | null {
  const file = bodyFilePath(sessionId, callId, createdAtMs);
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    return { request: parsed.request ?? null, response: parsed.response ?? null };
  } catch {
    return null;
  }
}

/** 删除整个会话的 body 目录 */
export function deleteSessionBodies(sessionId: number): void {
  rmSync(join(bodyDir, String(sessionId)), { recursive: true, force: true });
}

/** 合并会话：把源目录全部文件移动到目标目录（目标目录已有文件时逐个 rename），最后删除源目录 */
export function moveSessionBodies(sourceId: number, targetId: number): void {
  if (sourceId === targetId) return;   // 同 id：rename 是 no-op 但 rmSync 会删掉整个目录 → 数据丢失路径，直接返回
  const srcDir = join(bodyDir, String(sourceId));
  if (!existsSync(srcDir)) return;
  const dstDir = join(bodyDir, String(targetId));
  mkdirSync(dstDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    renameSync(join(srcDir, name), join(dstDir, name));
  }
  rmSync(srcDir, { recursive: true, force: true });
}

/** 清空整个 bodyData 目录 */
export function clearAllBodies(): void {
  rmSync(bodyDir, { recursive: true, force: true });
}

/** 列出全部 body 文件（孤儿对账用）：文件名解析出 sessionId 与 callId */
export function listBodyFiles(): Array<{ path: string; sessionId: number; callId: number }> {
  const out: Array<{ path: string; sessionId: number; callId: number }> = [];
  if (!existsSync(bodyDir)) return out;
  for (const dirName of readdirSync(bodyDir)) {
    const sessionId = Number(dirName);
    if (!Number.isInteger(sessionId)) continue;
    const dirPath = join(bodyDir, dirName);
    try {
      for (const name of readdirSync(dirPath)) {
        const m = name.match(/^\d+-(\d+)\.json$/);
        if (!m) continue;
        out.push({ path: join(dirPath, name), sessionId, callId: Number(m[1]) });
      }
    } catch {}
  }
  return out;
}

/** 孤儿对账：删除 calls 表中已不存在的 body 文件（启动后台任务调用；低频） */
export function reconcileOrphanBodies(): number {
  const files = listBodyFiles();
  if (files.length === 0) return 0;
  const ids = new Set<number>();
  // 分页扫描 calls 构建存活集合（避免一次 SELECT 百万 id）
  let offset = 0;
  while (true) {
    const rows = queryAll('SELECT id FROM calls ORDER BY id LIMIT 10000 OFFSET ?', [offset]);
    if (rows.length === 0) break;
    for (const r of rows) ids.add(Number(r.id));
    offset += rows.length;
  }
  let removed = 0;
  for (const f of files) {
    if (!ids.has(f.callId)) {
      try { rmSync(f.path); removed++; } catch {}
    }
  }
  return removed;
}
