/**
 * Antigravity OAuth credential loading + parsing.
 *
 * Antigravity logins are not stored under ~/.gemini; the credential lives in
 * the OS credential store (via the Go library github.com/zalando/go-keyring,
 * service="gemini", account/username="antigravity"), or in a portable file
 * passed explicitly. This module is imported by both the proxy child process
 * (to serve requests) and the main process (to snapshot the credential when
 * adding an account). It has no project dependencies so it stays a leaf.
 *
 * Storage format differs by OS (confirmed from go-keyring source):
 *   macOS   — Keychain generic password, value = "go-keyring-base64:" + base64(JSON)
 *             (base64 only on darwin, to survive the `security` CLI).
 *   Linux   — Secret Service (D-Bus), attributes {service, username}, raw JSON value.
 *   Windows — Credential Manager, target "gemini:antigravity", raw JSON blob.
 * The JSON payload is {token:{access_token,refresh_token,token_type,expiry}}.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const KEYRING_SERVICE = 'gemini';
const KEYRING_ACCOUNT = 'antigravity';
const ANTIGRAVITY_OAUTH_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_OAUTH_CLIENT_SECRET = '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';

export interface GeminiOAuthCredentials {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
}

export interface AntigravityKeyringPayload {
  token?: {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expiry?: string;
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** True on platforms where we know how to read the credential store. */
export function antigravityKeychainSupported(): boolean {
  return (
    process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32'
  );
}

async function readFromKeychain(): Promise<string> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync(
        '/usr/bin/security',
        ['find-generic-password', '-s', KEYRING_SERVICE, '-a', KEYRING_ACCOUNT, '-w'],
        { encoding: 'utf8', maxBuffer: 1024 * 1024 },
      );
      return stdout;
    } catch {
      throw new Error(
        'Cannot read Antigravity OAuth from macOS Keychain (service=gemini, account=antigravity).',
      );
    }
  }

  if (process.platform === 'linux') {
    // libsecret's secret-tool; go-keyring writes attributes {service, username}.
    try {
      const { stdout } = await execFileAsync(
        'secret-tool',
        ['lookup', 'service', KEYRING_SERVICE, 'username', KEYRING_ACCOUNT],
        { encoding: 'utf8', maxBuffer: 1024 * 1024 },
      );
      if (!stdout.trim()) {
        throw new Error('empty');
      }
      return stdout;
    } catch {
      throw new Error(
        'Cannot read Antigravity OAuth from the Secret Service (service=gemini, username=antigravity). Is secret-tool (libsecret-tools) installed and the login keyring unlocked?',
      );
    }
  }

  if (process.platform === 'win32') {
    // Windows Credential Manager; go-keyring target is "service:username".
    // CredRead via P/Invoke — cmdkey cannot print the blob. The blob is stored
    // as UTF-16LE bytes; decode back to a string.
    const target = `${KEYRING_SERVICE}:${KEYRING_ACCOUNT}`;
    const script = [
      "$ErrorActionPreference='Stop';",
      '$sig=@"',
      '[DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)]',
      'public static extern bool CredRead(string target,int type,int flags,out IntPtr cred);',
      '[DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);',
      '"@;',
      '$t=Add-Type -MemberDefinition $sig -Name Cred -Namespace W -PassThru;',
      '$p=[IntPtr]::Zero;',
      `if(-not $t::CredRead('${target}',1,0,[ref]$p)){exit 1};`,
      '$blobSize=[Runtime.InteropServices.Marshal]::ReadInt32($p,16);',
      '$blobPtr=[Runtime.InteropServices.Marshal]::ReadIntPtr($p,24);',
      '$bytes=New-Object byte[] $blobSize;',
      '[Runtime.InteropServices.Marshal]::Copy($blobPtr,$bytes,0,$blobSize);',
      '$t::CredFree($p);',
      '[Console]::Out.Write([Text.Encoding]::Unicode.GetString($bytes));',
    ].join('');
    try {
      const { stdout } = await execFileAsync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', maxBuffer: 1024 * 1024 },
      );
      if (!stdout.trim()) {
        throw new Error('empty');
      }
      return stdout;
    } catch {
      throw new Error(
        'Cannot read Antigravity OAuth from Windows Credential Manager (target=gemini:antigravity).',
      );
    }
  }

  throw new Error(
    `Antigravity OAuth auto-discovery is not supported on ${process.platform}; pass a credential file instead.`,
  );
}

export async function loadAntigravityOAuthCredentials(
  credentialFile?: string,
): Promise<GeminiOAuthCredentials | null> {
  const raw = credentialFile ? await readFile(credentialFile, 'utf8') : await readFromKeychain();
  return parseAntigravityOAuthCredential(raw);
}

/**
 * The credential store's own payload, undiminished.
 *
 * `loadAntigravityOAuthCredentials` reduces the token to what the proxy needs;
 * a snapshot that has to be written back must keep the whole thing, or the
 * account restored later is not the account that was saved.
 */
export async function readAntigravityOAuthPayload(
  credentialFile?: string,
): Promise<AntigravityKeyringPayload | null> {
  const raw = credentialFile ? await readFile(credentialFile, 'utf8') : await readFromKeychain();
  const parsed = decodeStoreValue(raw);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  if ('token' in parsed) {
    const payload = parsed as AntigravityKeyringPayload;
    return payload.token?.refresh_token ? payload : null;
  }
  // A snapshot written before this shape existed, or a portable file the user
  // assembled by hand: wrap it so write-back has one code path.
  const flat = parsed as GeminiOAuthCredentials;
  return flat.refresh_token
    ? { token: { refresh_token: flat.refresh_token, token_type: flat.token_type ?? 'Bearer' } }
    : null;
}

/**
 * Older Hotplug snapshots kept only the durable refresh token. Antigravity's
 * desktop client expects a usable access token in its keychain item and does
 * not refresh that reduced shape during setup, so materialize one before a
 * restore. Newer whole payloads are returned unchanged.
 */
export async function hydrateAntigravityOAuthPayload(
  payload: AntigravityKeyringPayload,
  fetchImpl: FetchLike = fetch,
): Promise<AntigravityKeyringPayload> {
  if (payload.token?.access_token) {
    return payload;
  }
  if (!payload.token?.refresh_token) {
    throw new Error('Cannot refresh an Antigravity credential with no refresh token.');
  }

  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
      client_secret: ANTIGRAVITY_OAUTH_CLIENT_SECRET,
      refresh_token: payload.token.refresh_token,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Antigravity OAuth refresh failed (${response.status}).`);
  }

  const result: unknown = await response.json();
  if (
    !result ||
    typeof result !== 'object' ||
    typeof (result as Record<string, unknown>).access_token !== 'string'
  ) {
    throw new Error('Antigravity OAuth refresh returned no access token.');
  }
  const expiresIn = (result as Record<string, unknown>).expires_in;
  const expiry =
    typeof expiresIn === 'number' && Number.isFinite(expiresIn)
      ? new Date(Date.now() + expiresIn * 1_000).toISOString()
      : payload.token.expiry;
  return {
    ...payload,
    token: {
      ...payload.token,
      access_token: (result as Record<string, unknown>).access_token as string,
      ...(expiry ? { expiry } : {}),
    },
  };
}

/**
 * Put a snapshotted Antigravity credential back into the OS credential store,
 * so Antigravity itself follows an account switch rather than only Hotplug's
 * proxy — the whole point of switching.
 *
 * Writes with an update flag wherever the platform offers one: updating in
 * place keeps the existing item's access control, so Antigravity reads it back
 * without a new authorization prompt. Creating the item from nothing cannot
 * inherit an ACL that was never granted, and the first read will prompt.
 */
export async function saveAntigravityOAuthCredential(
  payload: AntigravityKeyringPayload,
): Promise<void> {
  if (!payload.token?.refresh_token) {
    throw new Error('Refusing to write an Antigravity credential with no refresh token.');
  }
  const json = JSON.stringify(payload);

  if (process.platform === 'darwin') {
    // Batch mode with a hex-encoded value, so the token is never an argv entry
    // visible to `ps`. Same call shape as the read above, hence the same item.
    const value = `go-keyring-base64:${Buffer.from(json, 'utf8').toString('base64')}`;
    const hex = Buffer.from(value, 'utf8').toString('hex');
    await runWithStdin(
      '/usr/bin/security',
      ['-i'],
      `add-generic-password -U -s "${KEYRING_SERVICE}" -a "${KEYRING_ACCOUNT}" -X ${hex}\n`,
    );
    return;
  }

  if (process.platform === 'linux') {
    await runWithStdin(
      'secret-tool',
      ['store', '--label=gemini', 'service', KEYRING_SERVICE, 'username', KEYRING_ACCOUNT],
      json,
    );
    return;
  }

  if (process.platform === 'win32') {
    const target = `${KEYRING_SERVICE}:${KEYRING_ACCOUNT}`;
    const script = [
      "$ErrorActionPreference='Stop';",
      '$sig=@"',
      '[DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)]',
      'public static extern bool CredWrite(ref CRED cred,int flags);',
      '[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct CRED {',
      'public int Flags; public int Type; public string TargetName; public string Comment;',
      'public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;',
      'public int Persist; public int AttributeCount; public IntPtr Attributes;',
      'public string TargetAlias; public string UserName; }',
      '"@;',
      '$t=Add-Type -MemberDefinition $sig -Name CredW -Namespace W -PassThru;',
      // The blob is read from stdin so the token stays out of the command line.
      '$json=[Console]::In.ReadToEnd();',
      '$bytes=[Text.Encoding]::Unicode.GetBytes($json);',
      '$p=[Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length);',
      '[Runtime.InteropServices.Marshal]::Copy($bytes,0,$p,$bytes.Length);',
      '$c=New-Object W.CredW+CRED;',
      '$c.Type=1; $c.Persist=2;',
      `$c.TargetName='${target}'; $c.UserName='${KEYRING_ACCOUNT}';`,
      '$c.CredentialBlobSize=$bytes.Length; $c.CredentialBlob=$p;',
      'if(-not $t::CredWrite([ref]$c,0)){[Runtime.InteropServices.Marshal]::FreeHGlobal($p);exit 1};',
      '[Runtime.InteropServices.Marshal]::FreeHGlobal($p);',
    ].join('');
    await runWithStdin('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], json);
    return;
  }

  throw new Error(
    `Writing the Antigravity OAuth credential is not supported on ${process.platform}.`,
  );
}

/** Feed a secret to a helper over stdin rather than argv. */
function runWithStdin(command: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: 10_000 }, (err) => {
      if (err) {
        reject(new Error(`${command} failed while writing the Antigravity credential.`));
        return;
      }
      resolve();
    });
    child.stdin?.end(input);
  });
}

/**
 * Is there an Antigravity credential in the OS credential store?
 *
 * This asks only whether the entry exists and never reads its value, which is
 * what keeps it cheap enough for `detectLive()`: on macOS the Keychain access
 * prompt is raised by reading the secret (`security ... -w`), not by listing an
 * item's attributes. Use `loadAntigravityOAuthCredentials` when you need the
 * credential itself and the prompt is acceptable.
 */
export async function antigravityCredentialExists(): Promise<boolean> {
  try {
    if (process.platform === 'darwin') {
      await execFileAsync('/usr/bin/security', [
        'find-generic-password',
        '-s',
        KEYRING_SERVICE,
        '-a',
        KEYRING_ACCOUNT,
      ]);
      return true;
    }
    if (process.platform === 'linux') {
      const { stdout } = await execFileAsync('secret-tool', [
        'search',
        'service',
        KEYRING_SERVICE,
        'username',
        KEYRING_ACCOUNT,
      ]);
      return stdout.trim().length > 0;
    }
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('cmdkey', [
        `/list:${KEYRING_SERVICE}:${KEYRING_ACCOUNT}`,
      ]);
      return /target:/i.test(stdout);
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Remove the Antigravity credential from the OS credential store so Antigravity
 * prompts for a fresh sign-in. Local only — the OAuth grant stays valid upstream.
 *
 * Returns false when there was nothing to delete or the platform is unsupported;
 * a missing entry is the desired end state either way.
 */
export async function deleteAntigravityOAuthCredential(): Promise<boolean> {
  if (process.platform === 'darwin') {
    try {
      await execFileAsync('/usr/bin/security', [
        'delete-generic-password',
        '-s',
        KEYRING_SERVICE,
        '-a',
        KEYRING_ACCOUNT,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  if (process.platform === 'linux') {
    try {
      await execFileAsync('secret-tool', [
        'clear',
        'service',
        KEYRING_SERVICE,
        'username',
        KEYRING_ACCOUNT,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  if (process.platform === 'win32') {
    try {
      await execFileAsync('cmdkey', [`/delete:${KEYRING_SERVICE}:${KEYRING_ACCOUNT}`]);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

/** Normalize a nested {token:{...}} payload down to a flat credential. */
function fromKeyringPayload(payload: AntigravityKeyringPayload): GeminiOAuthCredentials | null {
  const token = payload.token;
  if (!token?.refresh_token) {
    return null;
  }
  // Deliberately drop access_token: Antigravity may fail to persist its most
  // recently refreshed access token, so the proxy always refreshes from the
  // durable refresh_token at start rather than trusting a possibly-stale one.
  return {
    refresh_token: token.refresh_token,
    token_type: token.token_type ?? 'Bearer',
  };
}

/** Unwrap the platform's envelope and parse. macOS base64s; the rest are raw. */
function decodeStoreValue(raw: string): unknown {
  let value = raw.trim();
  if (value.startsWith('go-keyring-base64:')) {
    value = Buffer.from(value.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Antigravity OAuth credential has an unsupported format.');
  }
}

export function parseAntigravityOAuthCredential(raw: string): GeminiOAuthCredentials | null {
  const parsed = decodeStoreValue(raw);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  // Nested go-keyring payload shape.
  if ('token' in parsed) {
    return fromKeyringPayload(parsed as AntigravityKeyringPayload);
  }
  // Flat credential shape (e.g. a portable file already normalized).
  const flat = parsed as GeminiOAuthCredentials;
  return flat.refresh_token || flat.access_token ? flat : null;
}
