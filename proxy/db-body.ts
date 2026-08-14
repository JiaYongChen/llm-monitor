/** body 文件存储 — 每调用一文件：bodyData/<sessionId>/<createdAtMs>-<callId>.json
 *  纯文件系统操作，不依赖数据库模块（孤儿对账等需要 DB 的逻辑由调用方实现）。 */
import { mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BODY_DIR } from './config.js';
import { getDb, queryAll, saveDb } from './db-core.js';

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

/** 处理一批存量 body：SELECT 未迁移行 → 写文件 → 列置 NULL。返回剩余未迁移行数。 */
export function migrateLegacyBodies(batchSize = 500): number {
  const d = getDb();
  // 列可能已 DROP（门控竞态/重复调用）→ 探测后返回 0
  const colCheck = queryAll("SELECT name FROM pragma_table_info('calls') WHERE name IN ('request_body', 'response_body')");
  if (colCheck.length === 0) return 0;
  const rows = queryAll(
    'SELECT id, session_id, created_at, request_body, response_body FROM calls WHERE request_body IS NOT NULL OR response_body IS NOT NULL LIMIT ?',
    [batchSize],
  );
  for (const row of rows) {
    writeBody(Number(row.session_id), Number(row.id), Number(row.created_at), (row.request_body as string | null), (row.response_body as string | null));
    d.run('UPDATE calls SET request_body = NULL, response_body = NULL WHERE id = ?', [row.id]);
  }
  if (rows.length > 0) saveDb();
  const remaining = queryAll('SELECT COUNT(*) AS cnt FROM calls WHERE request_body IS NOT NULL OR response_body IS NOT NULL')[0];
  return Number(remaining.cnt) || 0;
}

/** body 迁移收尾：删除 body 列 + VACUUM 压缩 + 门控 */
export function finishBodyMigration(): void {
  const d = getDb();
  try { d.run('ALTER TABLE calls DROP COLUMN request_body'); } catch {}
  try { d.run('ALTER TABLE calls DROP COLUMN response_body'); } catch {}
  d.run('VACUUM');
  d.run("INSERT OR REPLACE INTO metadata (key, value) VALUES ('bodies_migrated', '1')");
  saveDb(undefined, true);
  console.log('[db] body 迁移完成：calls 表 body 列已删除并压缩');
}

let bodyMigrationTimer: ReturnType<typeof setInterval> | null = null;

/** 启动 body 渐进迁移调度（门控已置位或无需迁移时立即收尾；重复调用忽略） */
export function startBodyMigration(batchSize = 500, intervalMs = 100): void {
  if (bodyMigrationTimer) return;   // 已启动：重复调用忽略
  const gated = queryAll("SELECT value FROM metadata WHERE key = 'bodies_migrated'")[0];
  if (gated?.value === '1') return;
  bodyMigrationTimer = setInterval(() => {
    try {
      const remaining = migrateLegacyBodies(batchSize);
      if (remaining === 0) {
        finishBodyMigration();
        stopBodyMigration();
      }
    } catch (err) {
      console.warn('[db] body 迁移处理失败（下次轮询重试）:', (err as Error).message);
    }
  }, intervalMs);
  if (bodyMigrationTimer && typeof bodyMigrationTimer === 'object' && 'unref' in bodyMigrationTimer) {
    (bodyMigrationTimer as any).unref();
  }
}

export function stopBodyMigration(): void {
  if (bodyMigrationTimer) { clearInterval(bodyMigrationTimer); bodyMigrationTimer = null; }
}

/** 孤儿对账：删除 calls 表中已不存在的 body 文件（启动后台任务调用；低频） */
export function reconcileOrphanBodies(): number {
  const files = listBodyFiles();
  if (files.length === 0) return 0;
  const d = getDb();
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
