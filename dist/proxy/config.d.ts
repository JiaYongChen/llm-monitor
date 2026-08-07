declare const DATA_DIR: string;
declare const DB_PATH: string;
declare const PORT = 9400;
declare const SESSION_TIMEOUT_SEC = 180;
declare const AUTO_CLEANUP_DAYS = 0;
declare function ensureDataDir(): void;
export { PORT, DATA_DIR, DB_PATH, SESSION_TIMEOUT_SEC, AUTO_CLEANUP_DAYS, ensureDataDir };
