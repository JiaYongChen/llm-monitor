/**
 * SQLite 数据库核心模块 — 数据库实例管理、落盘节流、查询辅助
 *
 * 由 db.ts 拆分而来（db.ts 保留建表与 CRUD）：sql.js 的数据库完全在内存中运行，
 * 写入后需调用 saveDb() 持久化到磁盘。采用单例模式，所有模块共享同一个数据库实例。
 */

import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { writeFileSync, renameSync } from 'node:fs';
import { DB_PATH } from './config.js';

// ── 模块级状态 ──

let SQL: SqlJsStatic | null = null;
let db: Database | null = null;
let currentDbPath: string = DB_PATH;

// ── 初始化（供 db.ts 的 initDb 使用）──

/** initDb 设置当前数据库路径（saveDb 使用） */
export function setCurrentDbPath(path: string): void {
  currentDbPath = path;
}

/** 当前数据库路径（迁移备份等使用） */
export function getCurrentDbPath(): string {
  return currentDbPath;
}

/** 初始化 sql.js WASM（initDb 调用一次） */
export async function initSqlJsCore(): Promise<void> {
  if (SQL) return;
  SQL = await initSqlJs();
}

/** 创建数据库实例并绑定到当前模块（initDb 加载/新建后调用） */
export function setDb(newDb: Database): void {
  db = newDb;
}

/** 获取 sql.js 静态实例（initDb 构造 Database 用） */
export function getSql(): SqlJsStatic {
  if (!SQL) throw new Error('sql.js 未初始化，请先调用 initSqlJsCore()');
  return SQL;
}

/** 获取数据库实例（必须先在 initDb 之后调用） */
export function getDb(): Database {
  if (!db) throw new Error('数据库未初始化，请先调用 initDb()');
  return db;
}

// ── 写入节流：避免每次写操作都全量导出数据库 ──

let saveDirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveSafetyInterval: ReturnType<typeof setInterval> | null = null;
const SAVE_DEBOUNCE_MS = 500; // 500ms 内无新写入再落盘
const SAVE_SAFETY_MS = 2000;  // 安全网：每 2s 强制检查一次 dirty，防止去抖+异常退出丢失窗口数据

function flushSaveSync(dbPath?: string): void {
  if (!db) return;
  const path = dbPath ?? currentDbPath;
  const data = db.export();
  const buffer = Buffer.from(data);
  const tmp = path + '.tmp';
  writeFileSync(tmp, buffer);
  renameSync(tmp, path);
  saveDirty = false;
}

/** 将内存中的数据库持久化到磁盘（原子写入：先写临时文件再 rename，防止进程被 kill 时文件损坏）。
 *  默认使用去抖机制合并高频写入；传 immediate=true 可强制立即落盘（closeDb 时使用）。 */
export function saveDb(dbPath?: string, immediate = false): void {
  if (!db) return;
  if (immediate) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    flushSaveSync(dbPath);
    return;
  }
  saveDirty = true;
  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (saveDirty) flushSaveSync(dbPath);
    }, SAVE_DEBOUNCE_MS);
  }
}

/** 启动定期落盘安全网（initDb 时调用，closeDb 时清除） */
export function startSaveSafetyNet(): void {
  if (saveSafetyInterval) return;
  saveSafetyInterval = setInterval(() => {
    if (saveDirty) {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      flushSaveSync();
    }
  }, SAVE_SAFETY_MS);
  // 允许定时器不阻止进程退出
  if (saveSafetyInterval && typeof saveSafetyInterval === 'object' && 'unref' in saveSafetyInterval) {
    (saveSafetyInterval as any).unref();
  }
}

/** 关闭数据库（立即保存并关闭） */
export function closeDb(): void {
  if (saveSafetyInterval) { clearInterval(saveSafetyInterval); saveSafetyInterval = null; }
  if (db) {
    saveDb(undefined, true);
    db.close();
    db = null;
  }
  SQL = null;
  currentDbPath = DB_PATH;
}

// ── 辅助 ──

/** 将 sql.js 的 Statement 结果行转为对象 */
export function rowToDict(columns: string[], row: any[]): Record<string, any> {
  const obj: Record<string, any> = {};
  for (let i = 0; i < columns.length; i++) {
    obj[columns[i]] = row[i];
  }
  return obj;
}

/** 执行 SELECT 查询，返回对象数组（导出供测试使用） */
export function queryAll(sql: string, params?: any[]): Record<string, any>[] {
  const d = getDb();
  const stmt = d.prepare(sql);
  if (params) stmt.bind(params);
  const results: Record<string, any>[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    results.push(row);
  }
  stmt.free();
  return results;
}

/** 执行 SELECT 查询，返回第一行 */
export function queryOne(sql: string, params?: any[]): Record<string, any> | null {
  const d = getDb();
  const stmt = d.prepare(sql);
  if (params) stmt.bind(params);
  let result: Record<string, any> | null = null;
  if (stmt.step()) {
    result = stmt.getAsObject();
  }
  stmt.free();
  return result;
}

/** 执行 INSERT 并返回新行的 id（使用 RETURNING 子句） */
export function executeInsert(sql: string, params?: any[]): number {
  const d = getDb();
  const stmt = d.prepare(sql);
  if (params) stmt.bind(params);
  if (stmt.step()) {
    const vals = stmt.get();
    stmt.free();
    saveDb();
    return vals && vals.length > 0 ? Number(vals[0]) : 0;
  }
  stmt.free();
  saveDb();
  return 0;
}

/** 执行 UPDATE/DELETE，返回影响行数 */
export function execute(sql: string, params?: any[]): number {
  const d = getDb();
  d.run(sql, params);
  saveDb();
  return d.getRowsModified();
}

/** 裸 SQL 执行（带参数绑定；迁移事务内使用，避免 execute() 的落盘去抖副作用） */
export function runRaw(sql: string, params?: any[]): void {
  const d = getDb();
  if (params) d.run(sql, params);
  else d.run(sql);
}
