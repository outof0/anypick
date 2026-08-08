import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { AnyPickApp } from '../core/app';

async function pickProvider(accounts: AnyPickApp['accounts']): Promise<string | null> {
  const choice = await p.select({
    message: 'Which provider?',
    options: accounts.listProviders().map((provider) => ({
      value: provider.id,
      label: provider.name,
      hint: provider.id,
    })),
  });
  return p.isCancel(choice) ? null : choice;
}

/** Ask which sign-in source to use, for providers that expose more than one. */
async function pickSource(
  accounts: AnyPickApp['accounts'],
  provider: string,
): Promise<'gemini-cli' | 'antigravity' | null | undefined> {
  if (provider !== 'gemini' || !accounts.provider(provider).detectLiveSource) {
    return undefined;
  }
  const choice = await p.select({
    message: 'How do you sign in to Gemini?',
    options: [
      { value: 'gemini-cli', label: 'Gemini CLI', hint: 'API key or Google login under ~/.gemini' },
      { value: 'antigravity', label: 'Antigravity', hint: 'OAuth from your OS credential store' },
    ],
  });
  return p.isCancel(choice) ? null : choice;
}

export async function wizardAddAccount(accounts: AnyPickApp['accounts']): Promise<void> {
  const provider = await pickProvider(accounts);
  if (!provider) {
    return;
  }
  const source = await pickSource(accounts, provider);
  if (source === null) {
    return;
  }
  const target = accounts.provider(provider);
  const label = source ?? provider;
  const liveAuth =
    source && target.detectLiveSource
      ? await target.detectLiveSource(source)
      : (await accounts.current(provider)).live;
  const mode = await p.select({
    message: liveAuth.present
      ? `${label} is logged in${liveAuth.identity ? ` as ${liveAuth.identity}` : ''}`
      : `No live ${label} login detected`,
    options: [
      ...(liveAuth.present ? [{ value: 'current', label: 'Save the current account' }] : []),
      { value: 'new', label: 'Add another account' },
      { value: 'cancel', label: 'Cancel' },
    ],
  });
  if (p.isCancel(mode) || mode === 'cancel') {
    return;
  }
  const sourceFlag = source ? ` --source ${source}` : '';
  if (mode === 'new') {
    await accounts.stash(provider, { source });
    p.note(
      [
        `Live ${label} auth cleared (tokens kept on server).`,
        '',
        '1. Log in with the official tool',
        `2. anypick add account ${provider} --current --name work${sourceFlag}`,
      ].join('\n'),
      'next',
    );
    return;
  }
  const suggested = liveAuth.identity?.includes('@')
    ? liveAuth.identity.split('@')[0]
    : (liveAuth.identity ?? source ?? (await accounts.current(provider)).active ?? 'main');
  const name = await p.text({
    message: 'Save as',
    initialValue: suggested,
    validate: (value) => (value?.trim() ? undefined : 'Required'),
  });
  if (p.isCancel(name)) {
    return;
  }
  // Antigravity has no ~/.gemini identity, so saveCurrent's name resolution
  // (which reads the default source) would pick the wrong account.
  const meta = source
    ? await accounts.save(provider, name, { force: true, source })
    : await accounts.saveCurrent(provider, name);
  p.log.success(`Saved ${provider}/${meta.name}`);
  p.log.message(pc.dim(`  anypick use claude --with ${provider}/${meta.name}`));
}
