import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const DATA_DIR = join(homedir(), '.llm-monitor');
const DB_PATH = join(DATA_DIR, 'calls.db');
const PORT = 9400;
const WEBUI_PORT = 9401;
const SESSION_TIMEOUT_SEC = 180;
const AUTO_CLEANUP_DAYS = 0;

function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
}

export { PORT, WEBUI_PORT, DATA_DIR, DB_PATH, SESSION_TIMEOUT_SEC, AUTO_CLEANUP_DAYS, ensureDataDir };
