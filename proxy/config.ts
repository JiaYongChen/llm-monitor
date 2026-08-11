import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const DATA_DIR = join(homedir(), '.llm-monitor');
const DB_PATH = join(DATA_DIR, 'calls.db');

/** 从 CLI 参数或环境变量解析端口，优先级：CLI --port 8400 > env > 默认值 */
function resolvePort(flag: string, envVar: string, fallback: number): number {
  // 1) CLI 参数（--port=8400 / --port 8400）
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith(flag + '=')) {
      const raw = arg.slice(flag.length + 1);
      if (/^\d+$/.test(raw)) {
        const v = parseInt(raw, 10);
        if (v >= 1 && v <= 65535) return v;
      }
      console.warn(`非法端口值 "${raw}"（应为 1-65535 纯数字），使用默认 ${fallback}`);
    }
    if (arg === flag && i + 1 < process.argv.length) {
      const next = process.argv[i + 1];
      if (next.startsWith('--')) continue;
      if (/^\d+$/.test(next)) {
        const v = parseInt(next, 10);
        if (v >= 1 && v <= 65535) return v;
      }
      console.warn(`非法端口值 "${next}"（应为 1-65535 纯数字），使用默认 ${fallback}`);
    }
  }
  // 2) 环境变量（连通 notify-start.ps1 的 LLM_MONITOR_WEBUI_PORT）
  const env = process.env[envVar];
  if (env && /^\d+$/.test(env)) {
    const v = parseInt(env, 10);
    if (v >= 1 && v <= 65535) return v;
  }
  // 3) 默认值
  return fallback;
}

const PORT = resolvePort('--port', 'LLM_MONITOR_PORT', 9400);
const WEBUI_PORT = resolvePort('--webui-port', 'LLM_MONITOR_WEBUI_PORT', 9401);
const SESSION_TIMEOUT_SEC = 180;
const AUTO_CLEANUP_DAYS = 0;

function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
}

export { PORT, WEBUI_PORT, DATA_DIR, DB_PATH, SESSION_TIMEOUT_SEC, AUTO_CLEANUP_DAYS, ensureDataDir };
