import { EgressPolicyError } from './errors';

export function exactOriginAllowlist(origins: readonly string[]): readonly string[] {
  const normalized = origins.map((origin) => {
    const url = new URL(origin);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new EgressPolicyError(`Invalid egress origin: ${url.origin}`);
    }
    return url.origin;
  });
  return [...new Set(normalized)];
}
