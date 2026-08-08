import React from 'react';
import type { HotplugApp } from '../../core/app';
import { normalizeAccountName } from '../../utils/slug';
import {
  buildHotplugPreview,
  loadAccountDetail,
  loadRootModel,
  receiptFromSwitchResult,
  suggestAccountSlug,
  type HotplugHomeRow,
  type ProviderPoolRow,
} from '../model';
import type { CredentialDraft, Screen } from '../model/screen';
import { errorText, type TuiShell } from '../use-tui-shell';
import type { TuiNav } from '../use-tui-nav';

/**
 * Saved-login lifecycle: switch, refresh, save the live login, and prepare a
 * provider for another sign-in.
 *
 * The provider picker rows live here because both entry points that fill them
 * (`startAdd` with no provider, and `startImport`) are account flows; the
 * add-provider screen only reads them back.
 */
export interface AccountActions {
  providerPickRows: ProviderPoolRow[];
  providerPickPurpose: 'add' | 'import';
  startAdd: (providerId?: string) => void;
  startImport: () => void;
  openAccountDetail: (providerId: string, name: string, back: Screen) => void;
  openSwitchConfirm: (row: HotplugHomeRow) => Promise<void>;
  doSwitch: (providerId: string, name: string) => Promise<void>;
  doRefresh: (row: HotplugHomeRow, all?: boolean) => Promise<void>;
  confirmSaveCurrent: (row: HotplugHomeRow) => void;
  doSave: (providerId: string, rawName: string, opts?: { source?: 'antigravity' }) => Promise<void>;
  doSaveCredential: (draft: CredentialDraft) => Promise<void>;
  startCredentialInput: (providerId: string, kind: string) => void;
  doPrepareAnother: (providerId: string, source?: 'antigravity') => Promise<void>;
  startSaveName: (providerId: string, identity?: string, source?: 'antigravity') => void;
  recheckLogin: (providerId: string, source?: 'antigravity') => Promise<void>;
  confirmDelete: (row: HotplugHomeRow, usingApps: readonly string[]) => void;
}

export function useAccountActions(app: HotplugApp, shell: TuiShell, nav: TuiNav): AccountActions {
  const { screen, go, setSelectedIndex, withBusy, setError, setReceipt, reportOk, reportFail } =
    shell;
  const { setPreview, setAccountDetail, openSwitch, openAccounts } = nav;

  const [providerPickRows, setProviderPickRows] = React.useState<ProviderPoolRow[]>([]);
  const [providerPickPurpose, setProviderPickPurpose] = React.useState<'add' | 'import'>('add');

  const openProviderPicker = (purpose: 'add' | 'import', preselectProviderId?: string) => {
    setReceipt(null);
    setSelectedIndex(0);
    setProviderPickPurpose(purpose);
    void (async () => {
      const root = await loadRootModel(app);
      setProviderPickRows(root.providers);
      const idx = preselectProviderId
        ? root.providers.findIndex((p) => p.providerId === preselectProviderId)
        : -1;
      setSelectedIndex(idx >= 0 ? idx : 0);
      go({ kind: 'add-provider' });
    })();
  };

  /**
   * Enter the add-account flow, always through the provider picker.
   *
   * `providerId` only preselects a row. Skipping the picker would make a
   * provider with no saved logins unreachable: it has no row to put the cursor
   * on, so the cursor's provider would be the only one `a` could ever add.
   */
  const startAdd = (providerId?: string) => {
    openProviderPicker('add', providerId);
  };

  const startImport = () => {
    openProviderPicker('import');
  };

  const openAccountDetail = (providerId: string, name: string, back: Screen) => {
    setReceipt(null);
    void (async () => {
      try {
        const detail = await loadAccountDetail(app, providerId, name);
        setAccountDetail(detail);
        go({ kind: 'account-detail', providerId, name, back });
      } catch (err) {
        setError(errorText(err));
      }
    })();
  };

  const doSwitch = async (providerId: string, name: string) => {
    setError(undefined);
    await withBusy(`Switching to ${name}`, async () => {
      try {
        const result = await app.accounts.use(providerId, name);
        setReceipt(receiptFromSwitchResult(result));
        await openSwitch(`${providerId}/${result.to}`);
      } catch (err) {
        setError(errorText(err));
      }
    });
  };

  const openSwitchConfirm = async (row: HotplugHomeRow) => {
    if (row.rowKind === 'save-live') {
      const slug = suggestAccountSlug(row.liveIdentity ?? row.identity);
      go({
        kind: 'text-input',
        purpose: 'save-name',
        providerId: row.providerId,
        label: 'Name',
        initial: slug,
        hint: row.liveIdentity
          ? `Save ${row.liveIdentity} as a ${row.providerName} login.`
          : `Save the live ${row.providerName} login.`,
        preview: `Saved as ${row.providerId}/${slug}`,
        back: { kind: 'hotplug', focusRef: row.ref },
      });
      return;
    }
    await withBusy(`Checking ${row.providerName}`, async () => {
      try {
        const p = await buildHotplugPreview(app, row.providerId, row.name);
        if (p.alreadyActive && row.isLiveMatch) {
          setReceipt({
            title: '',
            lines: [
              {
                kind: 'info',
                text: `${row.providerName} already uses ${row.name}`,
              },
            ],
          });
          await openSwitch(row.ref);
          return;
        }
        // Changed login decision
        if (p.alreadyActive && row.providerRelation === 'drift') {
          go({
            kind: 'confirm',
            path: ['switch', 'changed login'],
            title: `${row.providerName} is signed in as ${row.liveIdentity ?? 'a different login'}.`,
            body: [
              `The saved login ${row.name} contains ${row.identity ?? 'another identity'}.`,
              '',
              'Press enter to switch back to the saved login,',
              'or esc to leave it as-is.',
            ],
            confirmLabel: 'switch back',
            back: { kind: 'hotplug', focusRef: row.ref },
            action: async () => {
              await doSwitch(row.providerId, row.name);
            },
          });
          return;
        }
        setPreview(p);
        go({
          kind: 'hotplug-preview',
          providerId: row.providerId,
          name: row.name,
        });
      } catch (err) {
        reportFail(err);
      }
    });
  };

  const doRefresh = async (row: HotplugHomeRow, all = false) => {
    await withBusy(`Refreshing ${row.ref}`, async () => {
      try {
        const results = all
          ? await app.accounts.refresh(row.providerId, undefined, { all: true })
          : await app.accounts.refresh(row.providerId, row.name);
        const refreshed = results.filter((r) => r.ok).length;
        const failed = results.filter((r) => !r.ok);
        if (failed.length === 0) {
          setReceipt({
            title: '',
            lines: results.map((r) => ({
              kind: 'ok' as const,
              text: `Refreshed ${r.target}`,
            })),
          });
        } else if (refreshed > 0) {
          setReceipt({
            title: '',
            lines: [
              {
                kind: 'warn',
                text: `Refreshed ${refreshed} login${refreshed === 1 ? '' : 's'}. ${
                  failed.length
                } login needs attention.`,
              },
            ],
          });
        } else {
          setReceipt({
            title: '',
            lines: [
              {
                kind: 'fail',
                text:
                  row.active && row.providerRelation === 'drift'
                    ? `Couldn't refresh ${row.ref}. Press s to save the current login instead.`
                    : `Couldn't refresh ${row.ref}. Check the saved login, then try again.`,
              },
            ],
          });
        }
        if (screen.kind === 'accounts') {
          await openAccounts(row.ref);
        } else {
          await openSwitch(row.ref);
        }
      } catch (err) {
        reportFail(err);
      }
    });
  };

  const confirmSaveCurrent = (row: HotplugHomeRow) => {
    setReceipt(null);
    go({
      kind: 'confirm',
      path: ['accounts', 'save current'],
      title: `Save the current ${row.providerName} login over ${row.ref}?`,
      body: [
        `Saved      ${row.identity ?? '—'}`,
        `Current    ${row.liveIdentity ?? '—'}`,
        '',
        "This replaces Hotplug's saved copy. The tool stays signed in.",
      ],
      confirmLabel: 'save current',
      cancelLabel: 'keep saved login',
      danger: true,
      back:
        screen.kind === 'accounts'
          ? { kind: 'accounts', focusRef: row.ref }
          : {
              kind: 'hotplug',
              focusRef: row.ref,
            },
      action: async () => {
        await withBusy(`Saving ${row.ref}`, async () => {
          try {
            const meta = await app.accounts.save(row.providerId, row.name, { force: true });
            reportOk(`Saved current login to ${row.providerId}/${meta.name}`);
            if (screen.kind === 'accounts') {
              await openAccounts(`${row.providerId}/${meta.name}`);
            } else {
              await openSwitch(`${row.providerId}/${meta.name}`);
            }
          } catch (err) {
            reportFail(err, `Couldn't save the current login to ${row.ref}.`);
          }
        });
      },
    });
  };

  const doSave = async (
    providerId: string,
    rawName: string,
    opts: { source?: 'antigravity' } = {},
  ) => {
    let name: string;
    try {
      name = normalizeAccountName(rawName);
    } catch {
      setError('Name needs at least one letter or number.');
      return;
    }
    if (!name) {
      setError('Name needs at least one letter or number.');
      return;
    }
    const current = await app.accounts.current(providerId);
    const existingIdentityName = current.live.identity
      ? await app.accounts.findNameByIdentity(providerId, current.live.identity)
      : null;
    if (existingIdentityName && existingIdentityName !== name) {
      go({
        kind: 'confirm',
        path: ['accounts', 'save'],
        title: `${current.live.identity} is already saved as ${providerId}/${existingIdentityName}.`,
        body: [
          'Save the current login over that existing account?',
          '',
          'No duplicate account will be created. The tool stays signed in.',
        ],
        confirmLabel: 'override existing',
        cancelLabel: 'choose another name',
        danger: true,
        back: {
          kind: 'text-input',
          purpose: 'save-name',
          providerId,
          label: 'Name',
          initial: name,
          back: { kind: 'add-mode', providerId },
        },
        action: async () => {
          await withBusy(`Saving ${providerId}/${existingIdentityName}`, async () => {
            const meta = await app.accounts.save(providerId, existingIdentityName, {
              force: true,
              source: opts.source,
            });
            reportOk(`Saved ${providerId}/${meta.name}`);
            await openAccounts(`${providerId}/${meta.name}`);
          });
        },
      });
      return;
    }

    const existing = await app.accounts.get(providerId, name);
    if (existing) {
      go({
        kind: 'confirm',
        path: ['accounts', 'save'],
        title: `Replace the saved login ${providerId}/${name}?`,
        body: [
          `Existing    ${existing.meta.identity ?? '—'}`,
          `New         (current live login)`,
          '',
          "This replaces Hotplug's saved copy. The tool stays signed in.",
        ],
        confirmLabel: 'replace',
        cancelLabel: 'choose another name',
        danger: true,
        back: {
          kind: 'text-input',
          purpose: 'save-name',
          providerId,
          label: 'Name',
          initial: name,
          back: { kind: 'add-mode', providerId },
        },
        action: async () => {
          await withBusy(`Saving ${providerId}/${name}`, async () => {
            const meta = await app.accounts.save(providerId, name, {
              force: true,
              source: opts.source,
            });
            reportOk(`Saved ${providerId}/${meta.name}`);
            await openAccounts(`${providerId}/${meta.name}`);
          });
        },
      });
      return;
    }
    await withBusy(`Saving ${providerId}/${name}`, async () => {
      try {
        const meta = await app.accounts.save(providerId, name, { source: opts.source });
        reportOk(`Saved ${providerId}/${meta.name}`);
        await openAccounts(`${providerId}/${meta.name}`);
      } catch (err) {
        reportFail(err, "Couldn't save this login.");
        go({ kind: 'add-mode', providerId });
      }
    });
  };

  const startCredentialInput = (providerId: string, kind: string) => {
    setReceipt(null);
    setError(undefined);
    setSelectedIndex(0);
    go({
      kind: 'credential-form',
      providerId,
      credentialKind: kind,
      back: { kind: 'add-mode', providerId },
    });
  };

  const doSaveCredential = async (draft: CredentialDraft) => {
    const { providerId } = draft;
    let name: string;
    try {
      name = normalizeAccountName(draft.name);
    } catch {
      setError('Name needs at least one letter or number.');
      return;
    }
    if (!name) {
      setError('Name needs at least one letter or number.');
      return;
    }
    const reopenForm: Screen = {
      kind: 'credential-form',
      providerId,
      credentialKind: draft.kind,
      draft,
      back: { kind: 'add-mode', providerId },
    };
    const input = { kind: draft.kind, secret: draft.secret, options: draft.options };
    const commit = async () => {
      await withBusy(`Saving ${providerId}/${name}`, async () => {
        try {
          const meta = await app.accounts.save(providerId, name, { input, force: true });
          reportOk(`Saved ${providerId}/${meta.name}`);
          await openAccounts(`${providerId}/${meta.name}`);
        } catch (err) {
          reportFail(err, "Couldn't save this credential.");
          // Back to the filled-in form: a rejected key or region is what failed,
          // and it is the one thing the user cannot re-derive from the error.
          go(reopenForm);
        }
      });
    };

    // No identity check against the live login here: a typed credential is not
    // what the provider's tool is signed in as, so a match would be a coincidence.
    const existing = await app.accounts.get(providerId, name);
    if (existing) {
      go({
        kind: 'confirm',
        path: ['accounts', 'save'],
        title: `Replace the saved login ${providerId}/${name}?`,
        body: [
          `Existing    ${existing.meta.identity ?? '—'}`,
          `New         (the ${draft.kind} you just entered)`,
          '',
          "This replaces Hotplug's saved copy.",
        ],
        confirmLabel: 'replace',
        cancelLabel: 'choose another name',
        danger: true,
        back: reopenForm,
        action: commit,
      });
      return;
    }
    await commit();
  };

  const doPrepareAnother = async (providerId: string, source?: 'antigravity') => {
    const displayName =
      source === 'antigravity' ? 'Antigravity' : app.accounts.provider(providerId).name;
    await withBusy(`Preparing ${displayName} for another login`, async () => {
      try {
        const result = await app.accounts.stash(providerId, { source });
        go({
          kind: 'stash-result',
          providerId,
          source,
          displayName,
          cleared: result.cleared,
          backedUpTo: result.backedUpTo,
          previousIdentity: result.previousIdentity,
          matchedByIdentity: result.matchedByIdentity,
          skippedBackup: result.skippedBackup,
        });
      } catch (err) {
        reportFail(err, `Couldn't prepare ${providerId}.`);
        go({ kind: 'accounts' });
      }
    });
  };

  /**
   * Confirm removing a saved login.
   *
   * `usingApps` is passed in rather than derived here: the binding rows belong to
   * the proxy domain, and this hook must not reach into it just to word a warning.
   */
  const confirmDelete = (row: HotplugHomeRow, usingApps: readonly string[]) => {
    setReceipt(null);
    go({
      kind: 'confirm',
      path: 'accounts',
      title: `Remove ${row.ref} from Hotplug?`,
      body: [
        row.identity ?? '',
        '',
        'This removes the saved login from Hotplug.',
        `It does not change the login currently used by ${row.providerName}.`,
        ...(usingApps.length
          ? [
              '',
              `${usingApps.join(' and ')} currently use${
                usingApps.length === 1 ? 's' : ''
              } this proxy and may stop working after removal.`,
            ]
          : []),
      ],
      confirmLabel: 'remove',
      danger: true,
      back: { kind: 'accounts', focusRef: row.ref },
      action: async () => {
        await withBusy(`Removing ${row.ref}`, async () => {
          try {
            await app.accounts.delete(row.providerId, row.name);
            reportOk(`Removed ${row.ref}`);
            await openAccounts();
          } catch (err) {
            setError(
              err instanceof Error
                ? err.message
                : `Couldn't remove ${row.ref}. Press enter to retry.`,
            );
          }
        });
      },
    });
  };

  const startSaveName = (providerId: string, identity?: string, source?: 'antigravity') => {
    const slug = source === 'antigravity' ? 'antigravity' : suggestAccountSlug(identity);
    go({
      kind: 'text-input',
      purpose: 'save-name',
      providerId,
      source,
      label: 'Name',
      initial: slug,
      hint:
        source === 'antigravity'
          ? 'Reads the Antigravity login from your OS credential store.'
          : `${providerId} stays signed in.`,
      preview: `Saved as ${providerId}/${slug}`,
      back: { kind: 'add-mode', providerId, source },
    });
  };

  /**
   * Look again for a live login the user was told to create outside Hotplug.
   *
   * Re-entering `add-mode` is what makes it offer "Save this login", so a
   * successful detection lands the user one keystroke from saving; a miss stays
   * on the same screen rather than navigating, because nothing has changed.
   */
  const recheckLogin = async (providerId: string, source?: 'antigravity') => {
    await withBusy('Checking logins', async () => {
      const provider = app.accounts.provider(providerId);
      const label = source === 'antigravity' ? 'Antigravity' : provider.name;
      const live =
        source && provider.detectLiveSource
          ? await provider.detectLiveSource(source)
          : (await app.accounts.current(providerId)).live;
      if (live.present) {
        go({ kind: 'add-mode', providerId, source });
      } else {
        setReceipt({
          title: '',
          lines: [{ kind: 'info', text: `– No ${label} login found yet.` }],
        });
      }
    });
  };

  return {
    providerPickRows,
    providerPickPurpose,
    startAdd,
    startImport,
    openAccountDetail,
    openSwitchConfirm,
    doSwitch,
    doRefresh,
    confirmSaveCurrent,
    doSave,
    doSaveCredential,
    startCredentialInput,
    doPrepareAnother,
    startSaveName,
    recheckLogin,
    confirmDelete,
  };
}
