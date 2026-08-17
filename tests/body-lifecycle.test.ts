/** body 生命周期联动测试 — 删除/合并/清理操作同步维护 body 文件 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, insertCall, upsertSession, deleteSession, mergeSessions, cleanupOldCalls, deleteAllSessions, clearAllData } from '../proxy/db.js';
import { writeBody, readBody, listBodyFiles, reconcileOrphanBodies } from '../proxy/db-body.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();
beforeAll(async () => { await initDb(tmp.dbPath); });
afterAll(() => { closeDb(); tmp.cleanup(); });

const mkCall = (sid: number, fp: string, createdAt: number): number =>
  insertCall({
    provider: 'openai', model: 'gpt-4o', tool: 'codex', endpoint: '/v1/x', method: 'POST',
    target_url: null, downstream_url: null, source_ip: null, status_code: 200, error_message: null,
    duration_ms: 10, prompt_tokens: 1, output_tokens: 1, cache_read_tokens: null, cache_write_tokens: null,
    uncached_input: null, input_cost: 0, output_cost: 0, total_cost: 0, cache_savings: 0,
    request_body: null, response_body: null, fingerprint: fp, source_port: null, session_id: sid, created_at: createdAt,
  });

describe('body 生命周期联动', () => {
  it('deleteSession 同步删除会话 body 目录', () => {
    const sid = upsertSession('fp_del', 'codex', '/v1/x');
    const cid = mkCall(sid, 'fp_del_call', 1786600800000);
    writeBody(sid, cid, 1786600800000, 'r', 's');
    deleteSession(sid);
    expect(readBody(sid, cid, 1786600800000)).toBeNull();
  });

  it('mergeSessions 移动源会话 body 文件', () => {
    const src = upsertSession('fp_src', 'codex', '/v1/x');
    const dst = upsertSession('fp_dst', 'codex', '/v1/x');
    const cid = mkCall(src, 'fp_src_call', 1786600801000);
    writeBody(src, cid, 1786600801000, 'r', 's');
    mergeSessions(src, dst);
    expect(readBody(src, cid, 1786600801000)).toBeNull();
    expect(readBody(dst, cid, 1786600801000)?.request).toBe('r');
  });

  it('cleanupOldCalls 同步删除过期 body 文件', () => {
    const sid = upsertSession('fp_clean', 'codex', '/v1/x');
    const now = Date.now(); // 与 recorder 不变量一致：body 文件时间戳 = call.created_at
    const oldId = mkCall(sid, 'fp_clean_old', 1000); // 1970 年，必过期
    const newId = mkCall(sid, 'fp_clean_new', now);
    writeBody(sid, oldId, 1000, 'r', 's');
    writeBody(sid, newId, now, 'r', 's');
    cleanupOldCalls(1); // 删除 1 天前
    expect(readBody(sid, oldId, 1000)).toBeNull();
    expect(readBody(sid, newId, now)).not.toBeNull();
  });

  it('deleteAllSessions / clearAllData 清空 bodyData 目录', () => {
    const sid = upsertSession('fp_all', 'codex', '/v1/x');
    const cid = mkCall(sid, 'fp_all_call', 1786600802000);
    writeBody(sid, cid, 1786600802000, 'r', 's');
    deleteAllSessions();
    expect(listBodyFiles()).toHaveLength(0);

    const sid2 = upsertSession('fp_all2', 'codex', '/v1/x');
    const cid2 = mkCall(sid2, 'fp_all2_call', 1786600803000);
    writeBody(sid2, cid2, 1786600803000, 'r', 's');
    clearAllData();
    expect(listBodyFiles()).toHaveLength(0);
  });

  it('reconcileOrphanBodies 删除 calls 表中不存在的孤儿文件', () => {
    const sid = upsertSession('fp_orphan', 'codex', '/v1/x');
    // 孤儿文件：callId 不在 calls 表（99 不存在）
    writeBody(sid, 99, 1786600804000, 'r', 's');
    const removed = reconcileOrphanBodies();
    expect(removed).toBe(1);
    expect(readBody(sid, 99, 1786600804000)).toBeNull();
  });
});
