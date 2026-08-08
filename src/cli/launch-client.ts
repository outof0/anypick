/**
 * Shared client launch path used by `hotplug run` and the root launcher.
 */

import type { HotplugApp } from '../core/app';
import type { ResolvedTransport } from '../types';
import { ExitCode } from '../utils/errors';

export interface LaunchClientOpts {
  with?: string;
  model?: string;
  dryRun?: boolean;
  verbose?: boolean;
  json?: boolean;
  childArgs?: string[];
}

function clientBinary(client: string): string {
  switch (client) {
    case 'claude':
      return process.env.CLAUDE_BINARY ?? 'claude';
    case 'codex':
      return process.env.CODEX_BINARY ?? 'codex';
    case 'kiro':
      return process.env.KIRO_BINARY ?? 'kiro';
    default:
      return client;
  }
}

function publicTransport(transport: ResolvedTransport): Record<string, unknown> {
  const { managedProxy, ...rest } = transport;
  return {
    ...rest,
    ...(managedProxy
      ? {
          managedProxy: {
            provider: managedProxy.provider,
            ...(managedProxy.account ? { account: managedProxy.account } : {}),
            port: managedProxy.port,
          },
        }
      : {}),
  };
}

/**
 * Prepare ephemeral runtime and spawn the client binary.
 * Returns the process exit code (does not call process.exit).
 */
export async function launchClient(
  app: HotplugApp,
  client: string,
  opts: LaunchClientOpts = {},
): Promise<number> {
  const result = await app.bindingService.runPrepare(client, {
    with: opts.with,
    model: opts.model,
    // JSON is a machine-readable plan contract. Never perform activation,
    // spawn a proxy, or create a secret-bearing temporary home merely because
    // a caller asked for serialized output.
    dryRun: Boolean(opts.dryRun || opts.json),
    verbose: opts.verbose,
    childArgs: opts.childArgs,
  });

  if (opts.json || opts.dryRun) {
    if (opts.json) {
      console.log(
        JSON.stringify({
          client,
          source: result.plan.resolvedSource.display,
          transport: publicTransport(result.plan.transport),
          dryRun: result.dryRun,
          steps: result.plan.steps.map((s) => s.kind),
          proxyEndpoint: result.proxyEndpoint,
        }),
      );
    } else {
      console.log('Dry run — ephemeral plan:');
      for (const step of result.plan.steps) {
        console.log(`  · ${step.kind}${step.detail ? ` — ${step.detail}` : ''}`);
      }
    }
    return 0;
  }

  const bin = clientBinary(client);
  const childArgs = [...(result.isolated?.args ?? []), ...(opts.childArgs ?? [])];
  const { spawn } = await import('node:child_process');
  const inherited = result.isolated
    ? Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !/(?:API[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|SECRET|PASSWORD|CREDENTIAL|AWS_|GOOGLE_|AZURE_)/i.test(
              key,
            ),
        ),
      )
    : process.env;
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    ...result.isolated?.environment,
  };
  if (!result.isolated && result.proxyEndpoint) {
    if (client === 'claude') {
      env.ANTHROPIC_BASE_URL = result.proxyEndpoint;
      env.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_AUTH_TOKEN ?? 'hotplug';
    }
  }

  const cleanup = async () => {
    if (result.cleanup) {
      try {
        await result.cleanup();
      } catch {
        // best-effort
      }
      return;
    }
    if (result.isolated) {
      try {
        await result.isolated.cleanup();
      } catch {
        // best-effort
      }
    }
  };

  let child: import('node:child_process').ChildProcess;
  try {
    child = spawn(bin, childArgs, {
      stdio: 'inherit',
      env,
      shell: false,
    });
  } catch {
    await cleanup();
    return ExitCode.MISSING_DEPENDENCY;
  }

  let childExited = false;
  let forwardedSignals = 0;
  const forward = (sig: NodeJS.Signals) => {
    if (childExited) {
      return;
    }
    forwardedSignals += 1;
    // A second interrupt is an explicit escalation request. `child.killed`
    // only means a signal was sent, not that the process has exited.
    child.kill(forwardedSignals > 1 ? 'SIGKILL' : sig);
  };
  const onSigInt = () => forward('SIGINT');
  const onSigTerm = () => forward('SIGTERM');
  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);

  try {
    const code: number = await new Promise((resolve) => {
      child.once('exit', (c, signal) => {
        childExited = true;
        if (signal) {
          resolve(128 + (signal === 'SIGINT' ? 2 : 15));
        } else {
          resolve(c ?? 1);
        }
      });
      child.once('error', () => {
        childExited = true;
        resolve(ExitCode.MISSING_DEPENDENCY);
      });
    });
    return code;
  } finally {
    process.off('SIGINT', onSigInt);
    process.off('SIGTERM', onSigTerm);
    await cleanup();
  }
}
