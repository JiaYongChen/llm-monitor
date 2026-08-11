import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const DATA_DIR = join(homedir(), '.llm-monitor');
const DB_PATH = join(DATA_DIR, 'calls.db');

/** 从 CLI 参数解析端口：--port 8400 --webui-port 8401（也支持 --port=8400），未指定则用默认值 */
function resolvePort(flag: string, fallback: number): number {
  // 支持 --port=8400 和 --port 8400 两种写法
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    // --port=8400 形式
    if (arg.startsWith(flag + '=')) {
      const v = parseInt(arg.slice(flag.length + 1), 10);
      if (!isNaN(v) && v > 0 && v <= 65535) return v;
    }
    // --port 8400 形式
    if (arg === flag && i + 1 < process.argv.length) {
      const next = process.argv[i + 1];
      // 下一个参数不能是另一个 flag
      if (next.startsWith('--')) continue;
      const v = parseInt(next, 10);
      if (!isNaN(v) && v > 0 && v <= 65535) return v;
    }
  }
  return fallback;
}

const PORT = resolvePort('--port', 9400);
const WEBUI_PORT = resolvePort('--webui-port', 9401);
const SESSION_TIMEOUT_SEC = 180;
const AUTO_CLEANUP_DAYS = 0;

function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
}

export { PORT, WEBUI_PORT, DATA_DIR, DB_PATH, SESSION_TIMEOUT_SEC, AUTO_CLEANUP_DAYS, ensureDataDir };
