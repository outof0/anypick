/**
 * Normalize a slug used for account or profile directory names.
 *
 * Human-friendly input is accepted and auto-slugified instead of rejected:
 *   "Kiro Key - 1k"  →  "kiro-key-1k"
 *   "Work Team"      →  "work-team"
 *
 * Result is safe for filesystem paths: lowercase, [a-z0-9._-], no spaces.
 */

const MAX_SLUG_LEN = 64;

export function normalizeSlug(raw: string, kind = 'name'): string {
  if (raw == null || String(raw).trim() === '') {
    throw new Error(`${kind} is required.`);
  }

  // Unicode normalize + strip combining marks so "café" → "cafe"
  let name = String(raw)
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  // Path separators and parent refs must never survive
  name = name.replace(/[/\\]+/g, '-').replace(/\.\.+/g, '.');

  // Everything that is not a safe slug char → hyphen (spaces, punctuation, …)
  name = name.replace(/[^a-z0-9._-]+/g, '-');

  // Collapse runs of separators (keep dots as single dots when repeated)
  name = name.replace(/-+/g, '-').replace(/_+/g, '_').replace(/\.+/g, '.');

  // Trim leading/trailing separators
  name = name.replace(/^[-._]+|[-._]+$/g, '');

  if (!name) {
    throw new Error(`${kind} "${raw}" has no usable characters. Use letters or digits.`);
  }

  if (name.length > MAX_SLUG_LEN) {
    name = name.slice(0, MAX_SLUG_LEN).replace(/[-._]+$/g, '');
  }

  // Must start with alphanumeric after cleanup
  if (!/^[a-z0-9]/.test(name)) {
    throw new Error(`${kind} "${raw}" must start with a letter or digit after normalization.`);
  }

  return name;
}

/**
 * Original display form of a name (trimmed), for use as a human label.
 * Returns undefined when it is empty or identical to the slug.
 */
export function displayLabelFromName(raw: string, slug: string): string | undefined {
  const label = String(raw).trim();
  if (!label || label === slug) {
    return undefined;
  }
  return label;
}

export function normalizeAccountName(raw: string): string {
  return normalizeSlug(raw, 'Account name');
}

export function normalizeProfileName(raw: string): string {
  return normalizeSlug(raw, 'Profile name');
}
