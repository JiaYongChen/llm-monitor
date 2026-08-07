/** 汇率模块测试 — mock db.js 与 fetch */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 注意：rates.js 内部以 './db.js' 导入，mock 路径必须指向其真实模块位置（相对本文件为 ../proxy/db.js），
// 否则 vitest 解析出的模块 ID 不一致，mock 不会命中。
const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();

beforeEach(() => {
  vi.resetModules();
  mockGetSetting.mockReset();
  mockSetSetting.mockReset();
});

afterEach(() => {
  vi.doUnmock('../proxy/db.js');
});

describe('rates', () => {
  it('兜底汇率覆盖 4 个非 CNY 币种', async () => {
    const { FALLBACK_RATES } = await import('../proxy/rates.js');
    const currencies = ['USD', 'EUR', 'JPY', 'GBP'];
    for (const c of currencies) {
      const key = `CNY→${c}`;
      expect(FALLBACK_RATES[key]).toBeDefined();
      expect(FALLBACK_RATES[key]).toBeGreaterThan(0);
    }
  });

  it('getRates 从 metadata 解析汇率', async () => {
    const cached = {
      'CNY→USD': 0.15,
      'CNY→EUR': 0.13,
      'CNY→JPY': 23.5,
      'CNY→GBP': 0.11,
    };
    mockGetSetting.mockImplementation((key: string) => (key === 'exchange_rates' ? JSON.stringify(cached) : null));
    vi.doMock('../proxy/db.js', () => ({ getSetting: mockGetSetting, setSetting: mockSetSetting }));

    const { getRates } = await import('../proxy/rates.js');
    const rates = getRates();
    expect(rates['CNY→USD']).toBe(0.15);
    expect(rates['CNY→EUR']).toBe(0.13);
    expect(rates['CNY→JPY']).toBe(23.5);
    expect(rates['CNY→GBP']).toBe(0.11);
  });

  it('getRates 无缓存时返回兜底汇率', async () => {
    mockGetSetting.mockReturnValue(null);
    vi.doMock('../proxy/db.js', () => ({ getSetting: mockGetSetting, setSetting: mockSetSetting }));

    const { getRates } = await import('../proxy/rates.js');
    const rates = getRates();
    expect(rates['CNY→USD']).toBe(0.1482);
    expect(rates['CNY→EUR']).toBe(0.1284);
    expect(rates['CNY→JPY']).toBe(23.39);
    expect(rates['CNY→GBP']).toBe(0.11);
  });

  it('refreshRates 成功时写入 metadata', async () => {
    mockGetSetting.mockReturnValue(null);
    vi.doMock('../proxy/db.js', () => ({ getSetting: mockGetSetting, setSetting: mockSetSetting }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        base: 'CNY',
        date: '2026-08-06',
        rates: { USD: 0.14817, EUR: 0.12837, JPY: 23.386, GBP: 0.11002 },
      }),
    });

    try {
      const { refreshRates } = await import('../proxy/rates.js');
      const result = await refreshRates();

      // 转换后的内部格式（CNY→XXX）与精度（保留 8 位小数）
      expect(result.rates['CNY→USD']).toBeCloseTo(0.1482, 3);
      expect(result.rates['CNY→EUR']).toBeCloseTo(0.1284, 3);
      expect(result.rates['CNY→JPY']).toBeCloseTo(23.39, 1);
      expect(result.rates['CNY→GBP']).toBeCloseTo(0.11, 3);

      // 写入 metadata 两次：exchange_rates + rates_updated_at
      expect(mockSetSetting).toHaveBeenCalledTimes(2);
      expect(mockSetSetting).toHaveBeenNthCalledWith(1, 'exchange_rates', expect.stringContaining('CNY→USD'));
      expect(mockSetSetting).toHaveBeenNthCalledWith(2, 'rates_updated_at', expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
