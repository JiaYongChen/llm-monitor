import { normalizeTokens } from './normalizer.js';
import { matchPricing, calculateCost } from './pricing.js';
import { insertCall, updateSessionStats, listPricing } from './db.js';
// ── 队列 ──
const queue = [];
let timer = null;
/** 入队一条调用记录 */
export function enqueueRecord(record) {
    queue.push(record);
}
/** 启动后台消费者 */
export function startRecorder() {
    if (timer)
        return;
    timer = setInterval(() => {
        while (queue.length > 0) {
            const record = queue.shift();
            try {
                processRecord(record);
            }
            catch (err) {
                console.error('处理调用记录失败:', err);
            }
        }
    }, 100);
}
/** 停止消费者 */
export function stopRecorder() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    // 处理剩余队列
    while (queue.length > 0) {
        const record = queue.shift();
        try {
            processRecord(record);
        }
        catch { }
    }
}
function processRecord(record) {
    // 1. 归一化
    if (record.response_body && record.prompt_tokens == null) {
        try {
            const respBody = JSON.parse(record.response_body);
            const tokens = normalizeTokens(record.provider, respBody);
            record.prompt_tokens = tokens.prompt_tokens ?? null;
            record.output_tokens = tokens.output_tokens ?? null;
            record.cache_read_tokens = tokens.cache_read_tokens ?? null;
            record.cache_write_tokens = tokens.cache_write_tokens ?? null;
            record.uncached_input = tokens.uncached_input ?? null;
        }
        catch { }
    }
    // 2. 定价匹配 + 费用计算
    if (record.prompt_tokens != null || record.output_tokens != null) {
        const allPricing = listPricing();
        const pricing = matchPricing(record.provider, record.model, allPricing);
        if (pricing) {
            const tokens = {
                prompt_tokens: record.prompt_tokens,
                output_tokens: record.output_tokens,
                cache_read_tokens: record.cache_read_tokens,
                cache_write_tokens: record.cache_write_tokens,
                uncached_input: record.uncached_input,
            };
            const costs = calculateCost(tokens, pricing);
            record.input_cost = costs.input_cost;
            record.output_cost = costs.output_cost;
            record.total_cost = costs.total_cost;
            record.cache_savings = costs.cache_savings;
        }
    }
    // 3. 写入数据库
    insertCall(record);
    // 4. 更新会话统计
    const totalTokens = (record.prompt_tokens || 0) + (record.output_tokens || 0);
    if (record.session_id) {
        updateSessionStats(record.session_id, record.total_cost, totalTokens);
    }
}
//# sourceMappingURL=recorder.js.map