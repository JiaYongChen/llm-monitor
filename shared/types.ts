/** 代理层收集的原始调用记录 */
export interface CallRecord {
  provider: string;
  model: string;
  tool: string;
  endpoint: string;
  method: string;
  target_url: string | null;
  downstream_url: string | null;
  source_ip: string | null;
  status_code: number | null;
  error_message: string | null;
  duration_ms: number;
  prompt_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  uncached_input: number | null;
  input_cost: number;
  output_cost: number;
  total_cost: number;
  cache_savings: number;
  request_body: string | null;
  response_body: string | null;
  fingerprint: string;
  source_port: number | null;
  session_id: number | null;
  /** 调用归属时间戳（recorder 写入时统一取一次 now，body 文件名 / created_at / hour_ms 同源） */
  created_at?: number;
}

/** 数据库中完整的调用记录 */
export interface Call extends CallRecord {
  id: number;
  created_at: number;
}

/** 会话 */
export interface Session {
  id: number;
  tool: string;
  label: string | null;
  fingerprint: string;
  request_count: number;
  total_cost: number;
  total_tokens: number;
  first_call_at: number | null;
  last_call_at: number | null;
  first_endpoint: string | null;
  status: 'active' | 'ended' | 'pending';
  created_at: number;
  upstream_provider: string | null;
  upstream_model?: string | null;
}

/** provider_models 行（含价格列；价格 0 = 无定价） */
export interface ProviderModelRow {
  provider: string;
  model: string;
  enabled: number;
  available: number;
  input_price: number;
  cache_input_price: number;
  output_price: number;
  currency: string;
  created_at: number;
  updated_at: number;
}

/** 聚合统计项 */
export interface StatItem {
  key: string;
  count: number;
  total_cost: number;
  total_tokens: number;
}

/** 每日统计项 */
export interface DailyStatItem {
  date: string;
  count: number;
  total_cost: number;
  total_output_tokens: number;
  total_uncached_input: number;
  total_cache_read_tokens: number;
}

/** 归一化后的 Token */
export interface NormalizedTokens {
  prompt_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  uncached_input: number | null;
}

/** 应用配置 */
export interface AppConfig {
  port: number;
  data_dir: string;
  session_timeout_sec: number;
  auto_cleanup_days: number;
}

/** 费用计算结果 */
export interface CostResult {
  input_cost: number;
  output_cost: number;
  total_cost: number;
  cache_savings: number;
}
