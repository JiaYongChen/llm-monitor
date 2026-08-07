/** 后台消费者 — 从队列取出 CallRecord，归一化 → 定价 → 计费 → 写入数据库 */
import type { CallRecord } from '../shared/types.js';
/** 入队一条调用记录 */
export declare function enqueueRecord(record: CallRecord): void;
/** 启动后台消费者 */
export declare function startRecorder(): void;
/** 停止消费者 */
export declare function stopRecorder(): void;
