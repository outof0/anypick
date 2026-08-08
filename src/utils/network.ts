import { HotplugError } from './errors';

export function isLoopbackHost(host: string): boolean {
  const value = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
}

export function assertLoopbackHost(host: string): void {
  if (!isLoopbackHost(host)) {
    throw new HotplugError(
      `Proxy host must be loopback-only (127.0.0.1, ::1, or localhost), got "${host}".`,
      'PROXY_UNSAFE_HOST',
    );
  }
}
