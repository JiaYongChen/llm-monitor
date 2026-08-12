/** 日期序列工具：为图表生成指定范围和时区的完整日期（天级）序列 */

/**
 * 生成指定范围和时区的完整日期序列。
 * 基于 UTC 时间加上时区偏移得到目标时区的"今天"（与后端 getDailyStats 窗口同法）。
 * - today / yesterday：按天（daily_stats 为天级粒度，各返回 1 个 "YYYY-MM-DD" 标签）
 * - thisMonth / lastMonth / N d：按天（"YYYY-MM-DD"）
 */
export function fillDateRange(range: string, tz: number): string[] {
  const now = new Date();
  // 基于 UTC 时间加上时区偏移得到目标时区的"今天"
  const utcNow = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + tz * 3600000);
  const pad = (n: number) => String(n).padStart(2, '0');

  // 辅助：返回目标时区当天的午夜
  const tzMidnight = (daysOffset = 0) => new Date(utcNow.getFullYear(), utcNow.getMonth(), utcNow.getDate() + daysOffset);

  if (range === 'today') {
    // daily_stats 为天级粒度（后端今日数据聚合为一个 YYYY-MM-DD 行），只返回今天一个天级标签
    const start = tzMidnight();
    return [`${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`];
  }
  if (range === 'yesterday') {
    // 同理，yesterday 只返回昨天一个天级标签
    const start = tzMidnight(-1);
    return [`${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`];
  }
  if (range === 'thisMonth') {
    const start = new Date(utcNow.getFullYear(), utcNow.getMonth(), 1);
    const end = new Date(utcNow.getFullYear(), utcNow.getMonth(), utcNow.getDate());
    const r: string[] = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      r.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    }
    return r;
  }
  if (range === 'lastMonth') {
    const start = new Date(utcNow.getFullYear(), utcNow.getMonth() - 1, 1);
    const end = new Date(utcNow.getFullYear(), utcNow.getMonth(), 0);
    const r: string[] = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      r.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    }
    return r;
  }
  // 7d / 14d / 30d / 60d
  const days = parseInt(range) || 30;
  const r: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(utcNow);
    d.setDate(d.getDate() - i);
    r.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  }
  return r;
}

/** X 轴标签格式化：小时级取 "HH:MM"，天级取 "MM-DD" */
export function fmtXAxis(d: string, hourly?: boolean): string {
  if (hourly) return d.slice(11, 16); // '2024-01-15 14:00' → '14:00'
  return d.slice(5); // '2024-01-15' → '01-15'
}
