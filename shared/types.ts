/** 代理层收集的原始调用记录 */
export interface CallRecord {
  provider: string;
  model: string;
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
  status: 'active' | 'ended';
  created_at: number;
  upstream_provider: string | null;
  upstream_model?: string | null;
}

/** 模型定价 */
export interface Pricing {
  id: number;
  provider: string;
  model: string;
  input_price: number;
  cache_input_price: number;
  output_price: number;
  unit: string;
  currency: string;
  effective_from: string | null;
}

/** 聚合统计项 */
export interface StatItem {
  key: string;
  count: number;
  total_cost: number;
  total_tokens: number;
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
