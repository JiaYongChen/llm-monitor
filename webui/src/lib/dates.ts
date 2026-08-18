/** 日期序列工具：为图表生成指定范围和时区的完整日期序列（小时级/天级/月级/周级） */

/** ISO 周标签（周一为周首，首周为含 1 月 4 日那周）：'2026-W34' */
function isoWeekLabel(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;            // Mon=0 .. Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3);      // 本周周四（决定 ISO 年）
  const isoYear = date.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week1Monday = new Date(Date.UTC(isoYear, 0, 4 - ((jan4.getUTCDay() + 6) % 7)));
  const week = 1 + Math.round((date.getTime() - week1Monday.getTime()) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** ISO 周标签 → 该周周一（UTC 午夜）；格式不符返回 Invalid Date */
function isoWeekStart(label: string): Date {
  const m = label.match(/^(\d{4})-W(\d{2})$/);
  if (!m) return new Date(NaN);
  const isoYear = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week1Monday = new Date(Date.UTC(isoYear, 0, 4 - ((jan4.getUTCDay() + 6) % 7)));
  return new Date(week1Monday.getTime() + (week - 1) * 7 * 86400000);
}

/**
 * 生成指定范围和时区的完整日期序列。
 * 基于 UTC 时间加上时区偏移得到目标时区的"今天"（与后端 getDailyStats 窗口同法）。
 * - today / yesterday：按小时（后端 getDailyStats 返回 'YYYY-MM-DD HH:00' 小时标签，各 24 个）
 * - thisMonth / lastMonth / N d：按天（"YYYY-MM-DD"）
 */
export function fillDateRange(range: string, tz: number): string[] {
  const now = new Date();
  // 基于 UTC 时间加上时区偏移得到目标时区的"今天"
  const utcNow = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + tz * 3600000);
  const pad = (n: number) => String(n).padStart(2, '0');

  // 辅助：返回目标时区当天的午夜
  const tzMidnight = (daysOffset = 0) => new Date(utcNow.getFullYear(), utcNow.getMonth(), utcNow.getDate() + daysOffset);

  if (range === 'today' || range === 'yesterday') {
    // 短范围按小时展示：后端 getDailyStats 返回 'YYYY-MM-DD HH:00' 小时标签
    const start = tzMidnight(range === 'today' ? 0 : -1);
    const labels: string[] = [];
    for (let h = 0; h < 24; h++) {
      labels.push(`${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())} ${pad(h)}:00`);
    }
    return labels;
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
  if (range === 'thisQuarter' || range === 'lastQuarter') {
    // 季度按 ISO 周：逐天遍历季度日期算周标签，有序去重（首尾不完整周保留；thisQuarter 含未来周空桶）
    const quarterStartMonth = Math.floor(utcNow.getMonth() / 3) * 3;
    const start = new Date(utcNow.getFullYear(), range === 'thisQuarter' ? quarterStartMonth : quarterStartMonth - 3, 1);
    const end = range === 'thisQuarter'
      ? new Date(utcNow.getFullYear(), quarterStartMonth + 3, 0)   // 季度末月+1 的 0 日 = 季度末日（完整季度）
      : new Date(utcNow.getFullYear(), quarterStartMonth, 0);      // 本季度首日 - 1 天 = 上季度末日
    const labels: string[] = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const label = isoWeekLabel(d);
      if (labels[labels.length - 1] !== label) labels.push(label);
    }
    return labels;
  }
  if (range === 'thisYear' || range === 'lastYear') {
    // 年份按月：全年 12 个月（thisYear 的未来月份为空桶）
    const year = range === 'thisYear' ? utcNow.getFullYear() : utcNow.getFullYear() - 1;
    const labels: string[] = [];
    for (let m = 0; m < 12; m++) {
      labels.push(`${year}-${pad(m + 1)}`);
    }
    return labels;
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

/** X 轴标签格式化：按标签格式自判别——小时 'HH:00'，周 '2026-8(W34)'，月 'YYYY-MM'（完整年月），天 'YYYY-MM-DD' */
export function fmtXAxis(d: string): string {
  if (d.includes(' ')) return d.slice(11, 16); // '2026-08-18 14:00' → '14:00'
  if (d.includes('-W')) {
    // 周级 'GGGG-WVV' → '年-月(W周号)'：年/月取周起始日（周一），月份不补零
    const start = isoWeekStart(d);
    return `${start.getUTCFullYear()}-${start.getUTCMonth() + 1}(W${d.slice(6)})`;
  }
  if (d.length === 7) return d;                // '2026-08' → '2026-08'
  return d;                                    // '2026-08-18' → '2026-08-18'
}
