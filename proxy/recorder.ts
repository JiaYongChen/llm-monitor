/** 后台消费者 — 从队列取出 CallRecord，归一化 → 定价 → 计费 → 写入数据库 */
import type { CallRecord, NormalizedTokens, Pricing } from '../shared/types.js';
import { normalizeTokens, detectFormatFromUrl, detectFormatFromTool } from './normalizer.js';
import { matchPricing, calculateCost } from './pricing.js';
import { insertCall, updateSessionStats, listPricing, upsertHourlyStat } from './db.js';
import { writeBody } from './db-body.js';
import { registerCategoryColor } from './colors.js';
import { getRates } from './rates.js';

// ── 队列 ──
const queue: CallRecord[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

/** 入队一条调用记录 */
export function enqueueRecord(record: CallRecord): void {
  queue.push(record);
}

/** 启动后台消费者 */
export function startRecorder(): void {
  if (timer) return;
  timer = setInterval(() => {
    while (queue.length > 0) {
      const record = queue.shift()!;
      try {
        processRecord(record);
      } catch (err) {
        console.error('处理调用记录失败:', err);
      }
    }
  }, 100);
}

/** 停止消费者 */
export function stopRecorder(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // 处理剩余队列
  while (queue.length > 0) {
    const record = queue.shift()!;
    try { processRecord(record); } catch {}
  }
}

function processRecord(record: CallRecord): void {
  // 0. 时间同源三处：created_at / 统计 / body 文件名
  const now = Date.now();
  record.created_at = now;

  // 1. 归一化 — 由上游 URL 决定解析方式（实际响应格式），而非工具类型
  if (record.response_body && record.prompt_tokens == null) {
    try {
      const respBody = JSON.parse(record.response_body);
      const format = record.target_url ? detectFormatFromUrl(record.target_url) : detectFormatFromTool(record.tool);
      const tokens = normalizeTokens(format, respBody);
      record.prompt_tokens = tokens.prompt_tokens ?? null;
      record.output_tokens = tokens.output_tokens ?? null;
      record.cache_read_tokens = tokens.cache_read_tokens ?? null;
      record.cache_write_tokens = tokens.cache_write_tokens ?? null;
      record.uncached_input = tokens.uncached_input ?? null;
    } catch {
      // 响应体非 JSON（如原始 SSE 整流失败），token 保持 null，静默容忍
    }
  }

  // 2. 定价匹配 + 费用计算（缺汇率时抛错不阻塞入库，容忍 cost=0）
  if (record.prompt_tokens != null || record.output_tokens != null) {
    try {
      const allPricing = listPricing() as Pricing[];
      const pricing = matchPricing(record.provider, record.model, allPricing);
      if (pricing) {
        const tokens: NormalizedTokens = {
          prompt_tokens: record.prompt_tokens,
          output_tokens: record.output_tokens,
          cache_read_tokens: record.cache_read_tokens,
          cache_write_tokens: record.cache_write_tokens,
          uncached_input: record.uncached_input,
        };
        const rates = getRates();
        const costs = calculateCost(tokens, pricing, rates);
        record.input_cost = costs.input_cost;
        record.output_cost = costs.output_cost;
        record.total_cost = costs.total_cost;
        record.cache_savings = costs.cache_savings;
      }
    } catch (err) {
      console.error('计费计算失败，以 cost=0 入库:', err);
    }
  }

  // 3. 类别颜色注册：首次出现的工具/供应商自动占位（'unknown' 不注册，名称归一化在函数内完成）
  //    注册失败不影响调用记录入库（与计费同风格：非关键步骤抛错容忍）
  try {
    if (record.tool && record.tool !== 'unknown') registerCategoryColor('tool', record.tool);
    if (record.provider) registerCategoryColor('provider', record.provider);
  } catch (err) {
    console.error('类别颜色注册失败（不影响入库）:', err);
  }

  // 4. 写入数据库（body 列不再写入，值为 NULL）
  const callId = insertCall(record);

  // 4.5 body 外置写入（先 DB 后文件；失败仅降级详情展示）
  if (record.session_id && (record.request_body != null || record.response_body != null)) {
    try {
      writeBody(record.session_id, callId, now, record.request_body, record.response_body);
    } catch (err) {
      console.warn('body 文件写入失败（详情页将降级显示）:', err);
    }
  }

  // 5. 更新会话统计
  const totalTokens = (record.prompt_tokens || 0) + (record.output_tokens || 0);
  if (record.session_id) {
    updateSessionStats(record.session_id, record.total_cost, totalTokens);
  }

  // 6. 累加小时统计（独立于 calls 表，删除操作不影响；hour_ms 由 createdAtMs 整数运算得出，写入端零时区）
  upsertHourlyStat(
    record.provider, record.model, record.tool || 'unknown',
    record.total_cost, record.prompt_tokens || 0, record.output_tokens || 0,
    record.uncached_input || 0, record.cache_read_tokens || 0,
    now,
  );
}
