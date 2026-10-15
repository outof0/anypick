import { describe, expect, it, vi } from 'vitest';

import { detectLanguage, translateSource } from '../lib/i18n';

describe('detectLanguage', () => {
  it('does not map Traditional Chinese from Macau to the Simplified Chinese catalog', () => {
    vi.stubGlobal('navigator', { languages: ['zh-MO'], language: 'zh-MO' });
    try {
      expect(detectLanguage()).toBe('en');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('translateSource', () => {
  it('resolves exact English catalog copy', () => {
    expect(translateSource('Backup files contain working credentials', 'vi', 'vi')).toBe(
      'Tệp sao lưu chứa thông tin xác thực đang hoạt động',
    );
  });

  it('preserves values matched from a keyed English template', () => {
    expect(translateSource('Change Codex Connection', 'vi', 'vi')).toBe('Đổi kết nối của Codex');
  });

  it('localizes dynamic proxy labels and status details', () => {
    expect(translateSource('Claude proxy', 'vi', 'vi')).toBe('Proxy Claude');
    expect(translateSource('Running · Port 5200', 'vi', 'vi')).toBe('Đang chạy · Cổng 5200');
  });

  it('leaves unrelated service text untouched', () => {
    expect(translateSource('Opaque provider error 42', 'vi', 'vi')).toBe('Opaque provider error 42');
  });
});
