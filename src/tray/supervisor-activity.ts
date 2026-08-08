import type { TrayActivityKind, TrayActivityService } from './activity';
import type { TrayMutationCommand } from './protocol';

export function activityKindForMutation(
  operation: TrayMutationCommand['operation'],
): TrayActivityKind {
  if (operation.startsWith('account-')) {
    return 'account';
  }
  if (operation.startsWith('gateway-')) {
    return 'gateway';
  }
  if (operation.startsWith('setting-')) {
    return 'settings';
  }
  if (operation === 'client-reset') {
    return 'settings';
  }
  if (operation === 'hub-source-toggle') {
    return 'proxy';
  }
  if (operation.startsWith('proxy-')) {
    return 'proxy';
  }
  return 'system';
}

export async function recordTrayActivity(
  activity: TrayActivityService,
  message: string,
  isError: boolean,
  kind: TrayActivityKind,
): Promise<void> {
  await activity.record(message, isError, kind).catch((err: unknown) => {
    process.stderr.write(
      `[tray] Activity could not be saved: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  });
}
