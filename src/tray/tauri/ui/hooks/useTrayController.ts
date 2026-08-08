import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  TrayActionSnapshot,
  TrayClientModelConfigSnapshot,
  TrayLogSourceSnapshot,
  TraySnapshot,
} from '../../../snapshot-types';
import type { TrayMutationOperation, TrayProxyLogsResult } from '../../../protocol';
import { createBridge } from '../lib/bridge';
import { decodePayload, encodePayload, requestId } from '../lib/html';
import { modelOptionForId, orderedModelRoles } from '../lib/routes';
import type { FormState, Notice, PendingResult, TrayTab } from '../lib/types';

const PRIMARY_TABS: TrayTab[] = ['Apps', 'Proxies', 'Logs'];

export function useTrayController() {
  const bridge = useMemo(() => createBridge(), []);
  const pendingRef = useRef(
    new Map<string, (payload?: { message?: string; status?: string }) => void>(),
  );
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingLogRequests = useRef(new Map<string, string>());
  const logRequestTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const latestLogRequestBySource = useRef(new Map<string, string>());
  const proxyLogsRef = useRef(new Map<string, string>());
  const proxyLogStatesRef = useRef(new Map<string, string>());

  const [tab, setTab] = useState<TrayTab>('Apps');
  const [query, setQuery] = useState('');
  const [snapshot, setSnapshot] = useState<TraySnapshot | null>(null);
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [proxyLogs, setProxyLogs] = useState<Map<string, string>>(new Map());
  const [proxyLogStates, setProxyLogStates] = useState<Map<string, string>>(new Map());
  const [pendingLogSources, setPendingLogSources] = useState<Set<string>>(new Set());
  const [selectedLogSourceId, setSelectedLogSourceId] = useState<string | null>(null);
  const [form, setFormState] = useState<FormState | null>(null);
  const setForm = useCallback(
    (next: FormState | null | ((prev: FormState | null) => FormState | null)) => {
      setFormState(next);
    },
    [],
  );
  const [manageProvider, setManageProvider] = useState('all');
  const [routePicker, setRoutePicker] = useState<string | null>(null);
  const [overflowMenu, setOverflowMenu] = useState<string | null>(null);
  const [clientResetConfirmation, setClientResetConfirmation] = useState<{
    client: string;
    title: string;
  } | null>(null);
  const [routeQuery, setRouteQuery] = useState('');
  const [routeGroup, setRouteGroup] = useState<string | null>(null);
  const [hubAccountQuery, setHubAccountQuery] = useState('');
  const [hubAccountFilter, setHubAccountFilter] = useState('all');
  const [routingCandidateConflictId, setRoutingCandidateConflictId] = useState<string | null>(
    null,
  );
  const [routingCandidateQuery, setRoutingCandidateQuery] = useState('');
  const [modelEditorClientId, setModelEditorClientId] = useState<string | null>(null);
  const [modelDraftRoleActions, setModelDraftRoleActions] = useState<
    Record<string, string | null>
  >({});
  const [modelPickerRole, setModelPickerRole] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState('');
  const [modelGroup, setModelGroup] = useState<string | null>(null);

  // Keep maps in refs for consume() without stale closures, and mirror into state for render.
  const syncProxyLogs = useCallback(() => {
    setProxyLogs(new Map(proxyLogsRef.current));
    setProxyLogStates(new Map(proxyLogStatesRef.current));
    setPendingLogSources(new Set(pendingLogRequests.current.values()));
  }, []);

  const notify = useCallback((message: string, isError = false) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setNotice({
      message: message || (isError ? 'Action failed.' : 'Action completed.'),
      isError,
    });
    noticeTimerRef.current = setTimeout(() => setNotice(null), 10_000);
  }, []);

  const send = useCallback(
    async (command: string) => {
      try {
        await bridge.invoke('send_command', { command });
        return true;
      } catch {
        notify('The AnyPick supervisor is unavailable. Reopen AnyPick and try again.', true);
        return false;
      }
    },
    [bridge, notify],
  );

  const sendBusyCommand = useCallback(
    async (command: string, id: string) => {
      if (await send(command)) return;
      pendingRef.current.delete(id);
      setBusyRequestId((current) => (current === id ? null : current));
    },
    [send],
  );

  const runOpaqueAction = useCallback(
    (actionId: string | undefined, label: string) => {
      if (!snapshot || busyRequestId || !actionId) return;
      const id = requestId();
      setBusyRequestId(id);
      notify(`Working on ${label}…`);
      void sendBusyCommand(
        `invoke\t${encodePayload({
          version: 1,
          requestId: id,
          revision: snapshot.revision,
          actionId,
        })}`,
        id,
      );
    },
    [snapshot, busyRequestId, notify, sendBusyCommand],
  );

  const runAction = useCallback(
    (
      action:
        | TrayActionSnapshot
        | { id: string; label: string; enabled?: boolean }
        | undefined,
    ) => {
      if (!action?.enabled) return;
      runOpaqueAction(action.id, action.label);
    },
    [runOpaqueAction],
  );

  const mutate = useCallback(
    (
      operation: TrayMutationOperation | string,
      payload: Record<string, any>,
      label: string,
      onSuccess?: () => void,
    ) => {
      if (busyRequestId) return;
      const id = requestId();
      setBusyRequestId(id);
      if (onSuccess) pendingRef.current.set(id, onSuccess);
      notify(`Working on ${label}…`);
      void sendBusyCommand(
        `mutate\t${encodePayload({
          version: 1,
          requestId: id,
          operation,
          name: payload.name || 'all',
          ...payload,
        })}`,
        id,
      );
    },
    [busyRequestId, notify, sendBusyCommand],
  );

  const modelConfigs = useCallback((): TrayClientModelConfigSnapshot[] => {
    return Array.isArray(snapshot?.clientModelConfigs) ? snapshot.clientModelConfigs : [];
  }, [snapshot]);

  const modelConfigFor = useCallback(
    (clientId?: string | null, client?: string) => {
      return modelConfigs().find(
        (config) => config.clientId === clientId || (!clientId && config.client === client),
      );
    },
    [modelConfigs],
  );

  const closeModelEditor = useCallback(() => {
    setModelEditorClientId(null);
    setModelDraftRoleActions({});
    setModelPickerRole(null);
    setModelQuery('');
    setModelGroup(null);
    setTab('Apps');
  }, []);

  const openModelEditor = useCallback(
    (clientId: string) => {
      const config = modelConfigFor(clientId);
      if (!config) return;
      const draft: Record<string, string | null> = {};
      const defaultModel = config.defaultModel || config.modelRoles?.default;
      for (const role of orderedModelRoles(config)) {
        const explicit =
          role.id === 'default'
            ? config.defaultModel || config.modelRoles?.default
            : Object.hasOwn(config.modelRoles ?? {}, role.id)
              ? config.modelRoles[role.id]
              : undefined;
        draft[role.id] =
          role.id !== 'default' && explicit === defaultModel
            ? null
            : explicit
              ? (modelOptionForId(config, explicit)?.actionId ?? null)
              : null;
      }
      setModelEditorClientId(config.clientId);
      setModelDraftRoleActions(draft);
      setModelPickerRole(null);
      setModelQuery('');
      setModelGroup(null);
      setTab('Models');
    },
    [modelConfigFor],
  );

  const applyModelRoles = useCallback(
    (config: TrayClientModelConfigSnapshot | undefined) => {
      if (!snapshot || busyRequestId || !config) return;
      const defaultActionId = modelDraftRoleActions.default;
      const roleActionIds = Object.fromEntries(
        Object.entries(modelDraftRoleActions).filter(
          ([roleId, actionId]) =>
            Boolean(actionId) && (roleId === 'default' || actionId !== defaultActionId),
        ),
      );
      if (!roleActionIds.default) {
        notify('Choose a Default model before saving.', true);
        return;
      }
      const validActions = new Set((config.options ?? []).map((option) => option.actionId));
      if (
        Object.values(roleActionIds).some(
          (actionId) => typeof actionId !== 'string' || !validActions.has(actionId),
        )
      ) {
        notify('The available models changed. Reopen the editor and try again.', true);
        return;
      }
      const id = requestId();
      setBusyRequestId(id);
      pendingRef.current.set(id, () => closeModelEditor());
      notify(`Saving ${config.client} model roles…`);
      void sendBusyCommand(
        `model-roles\t${encodePayload({
          version: 1,
          requestId: id,
          revision: snapshot.revision,
          clientId: config.clientId,
          roleActionIds,
        })}`,
        id,
      );
    },
    [
      snapshot,
      busyRequestId,
      modelDraftRoleActions,
      notify,
      sendBusyCommand,
      closeModelEditor,
    ],
  );

  const logSources = useCallback((): TrayLogSourceSnapshot[] => {
    const listed = snapshot?.logSources ?? [];
    if (listed.length) return listed;
    return (snapshot?.proxies ?? [])
      .filter((proxy) => proxy.logsAvailable !== false)
      .map((proxy) => ({
        id: proxy.id,
        label: proxy.label,
        detail: proxy.detail,
        providerId: proxy.providerId,
        name: proxy.id.split('/').slice(1).join('/'),
      }));
  }, [snapshot]);

  const failLogRequest = useCallback(
    (id: string, sourceId: string) => {
      if (!pendingLogRequests.current.has(id)) return;
      pendingLogRequests.current.delete(id);
      const failTimer = logRequestTimers.current.get(id);
      if (failTimer) clearTimeout(failTimer);
      logRequestTimers.current.delete(id);
      if (latestLogRequestBySource.current.get(sourceId) !== id) return;
      proxyLogStatesRef.current.set(sourceId, 'error');
      proxyLogsRef.current.set(sourceId, 'The log request timed out. Refresh to try again.');
      syncProxyLogs();
    },
    [syncProxyLogs],
  );

  const requestLogs = useCallback(
    (source: TrayLogSourceSnapshot | undefined) => {
      if (!source) return;
      for (const [pendingId, sourceId] of pendingLogRequests.current) {
        if (sourceId !== source.id) continue;
        const pendingTimer = logRequestTimers.current.get(pendingId);
        if (pendingTimer) clearTimeout(pendingTimer);
        logRequestTimers.current.delete(pendingId);
        pendingLogRequests.current.delete(pendingId);
      }
      const id = requestId();
      setSelectedLogSourceId(source.id);
      pendingLogRequests.current.set(id, source.id);
      latestLogRequestBySource.current.set(source.id, id);
      logRequestTimers.current.set(
        id,
        setTimeout(() => failLogRequest(id, source.id), 10_000),
      );
      syncProxyLogs();
      void send(
        `logs\t${encodePayload({
          version: 1,
          requestId: id,
          providerId: source.providerId,
          name: source.name,
          lines: 120,
        })}`,
      ).then((delivered) => {
        if (!delivered) failLogRequest(id, source.id);
      });
    },
    [failLogRequest, send, syncProxyLogs],
  );

  const ensureMonitorLogs = useCallback(() => {
    if (tab !== 'Logs') return;
    const sources = logSources();
    const selected =
      sources.find((source) => source.id === selectedLogSourceId) ?? sources[0];
    if (!selected) return;
    setSelectedLogSourceId(selected.id);
    const loading = [...pendingLogRequests.current.values()].includes(selected.id);
    if (!loading && !proxyLogsRef.current.has(selected.id)) requestLogs(selected);
  }, [tab, logSources, selectedLogSourceId, requestLogs]);

  const statusLine = useCallback(
    (proxyCount: number = snapshot?.proxyCount ?? 0) => {
      const hub = (snapshot?.proxies ?? []).find((proxy) => proxy.providerId === 'proxy-hub');
      if (hub?.running) return `Proxy Hub running${busyRequestId ? ' · Updating…' : ''}`;
      if (proxyCount === 1) return `1 proxy running${busyRequestId ? ' · Updating…' : ''}`;
      if (proxyCount > 1)
        return `${proxyCount} proxies running${busyRequestId ? ' · Updating…' : ''}`;
      return busyRequestId ? 'Updating…' : 'Ready';
    },
    [snapshot, busyRequestId],
  );

  const matches = useCallback(
    (...values: unknown[]) => {
      const q = query.trim().toLocaleLowerCase();
      return (
        !q ||
        values.some((value) =>
          String(value ?? '')
            .toLocaleLowerCase()
            .includes(q),
        )
      );
    },
    [query],
  );

  const clearOverlays = useCallback(() => {
    setRoutePicker(null);
    setClientResetConfirmation(null);
    setRoutingCandidateConflictId(null);
    setRoutingCandidateQuery('');
    setRouteQuery('');
    setRouteGroup(null);
    setModelPickerRole(null);
    setModelQuery('');
    setModelGroup(null);
    setOverflowMenu(null);
  }, []);

  const selectTab = useCallback(
    (next: TrayTab) => {
      setTab(next);
      setForm(null);
      clearOverlays();
    },
    [clearOverlays],
  );

  const goBack = useCallback(() => {
    closeModelEditor();
    setForm(null);
    clearOverlays();
  }, [closeModelEditor, clearOverlays]);

  /**
   * Switch immediately. The snapshot action already carries provider/Hub soft
   * defaults for model roles — do not gate on a confirm dialog (tray popovers
   * lose focus easily and the extra step blocked auto-default apply).
   * Custom roles live in Configure Models; a source switch reseeds them.
   */
  const trySelectRoute = useCallback(
    (action: TrayActionSnapshot) => {
      setRoutePicker(null);
      setRouteQuery('');
      setRouteGroup(null);
      runAction(action);
    },
    [runAction],
  );

  const consume = useCallback(
    (line: string) => {
      const separator = line.indexOf('\t');
      if (separator < 0) return;
      const kind = line.slice(0, separator);
      try {
        if (kind === 'status') {
          // status line is derived from snapshot; ignore bare count ticks for React state
          return;
        }
        const payload = decodePayload(line.slice(separator + 1));
        if (kind === 'snapshot') {
          const next = payload as TraySnapshot;
          setSnapshot((prev) => {
            // Preserve in-progress form text / pickers: still accept snapshot,
            // but components keep local overlay state.
            return next;
          });
          if (!selectedLogSourceId && next.logSources?.length) {
            setSelectedLogSourceId(next.logSources[0].id);
          }
        } else if (kind === 'result') {
          const result = payload as PendingResult;
          setBusyRequestId((current) => {
            if (result.requestId !== current) return current;
            const callback = result.requestId
              ? pendingRef.current.get(result.requestId)
              : undefined;
            if (result.requestId) pendingRef.current.delete(result.requestId);
            notify(result.message ?? '', result.status === 'error');
            if (result.status === 'success') callback?.(result);
            return null;
          });
        } else if (kind === 'logs') {
          const logs = payload as TrayProxyLogsResult;
          const sourceId = pendingLogRequests.current.get(logs.requestId);
          if (!sourceId) return;
          pendingLogRequests.current.delete(logs.requestId);
          const timer = logRequestTimers.current.get(logs.requestId);
          if (timer) clearTimeout(timer);
          logRequestTimers.current.delete(logs.requestId);
          if (latestLogRequestBySource.current.get(sourceId) !== logs.requestId) return;
          proxyLogsRef.current.set(sourceId, logs.text);
          proxyLogStatesRef.current.set(
            sourceId,
            ['ready', 'empty', 'not-running', 'error'].includes(logs.state)
              ? logs.state
              : logs.text
                ? 'ready'
                : 'empty',
          );
          syncProxyLogs();
        }
      } catch {
        notify('AnyPick received an unreadable tray update. Click Refresh to retry.', true);
      }
    },
    [notify, selectedLogSourceId, syncProxyLogs],
  );

  useEffect(() => {
    if (bridge.isDemo) document.body.dataset.demo = 'true';
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      unlisten = await bridge.listen('supervisor-line', (event) =>
        consume(String(event.payload)),
      );
      if (cancelled) {
        unlisten?.();
        return;
      }
      const initial = await bridge.invoke('last_supervisor_line');
      if (cancelled) return;
      if (typeof initial === 'string' && initial) consume(initial);
      else void send('refresh');
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      for (const timer of logRequestTimers.current.values()) clearTimeout(timer);
    };
  }, [bridge, consume, send]);

  useEffect(() => {
    if (tab === 'Logs') ensureMonitorLogs();
  }, [tab, ensureMonitorLogs, snapshot]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (routingCandidateConflictId) {
        event.preventDefault();
        setRoutingCandidateConflictId(null);
        setRoutingCandidateQuery('');
        return;
      }
      if (clientResetConfirmation) {
        event.preventDefault();
        setClientResetConfirmation(null);
        return;
      }
      if (modelPickerRole) {
        event.preventDefault();
        setModelPickerRole(null);
        setModelQuery('');
        setModelGroup(null);
        return;
      }
      if (routePicker) {
        event.preventDefault();
        setRoutePicker(null);
        setRouteQuery('');
        setRouteGroup(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [
    routingCandidateConflictId,
    clientResetConfirmation,
    modelPickerRole,
    routePicker,
  ]);

  const headerStatus = snapshot ? statusLine(snapshot.proxyCount) : 'Connecting to supervisor…';
  const footerStatus = bridge.isDemo ? 'Demo data only · not persisted' : headerStatus;
  const isAuxiliary = [
    'Saved accounts',
    'Hub Sources',
    'Routing Issues',
    'Models',
    'Settings',
  ].includes(tab);
  const auxiliaryTitle =
    tab === 'Models'
      ? modelConfigFor(modelEditorClientId)?.client || 'Model Settings'
      : tab === 'Saved accounts'
        ? 'Accounts'
        : tab;

  return {
    bridge,
    primaryTabs: PRIMARY_TABS,
    tab,
    setTab: selectTab,
    goBack,
    query,
    setQuery,
    snapshot,
    busy: Boolean(busyRequestId),
    notice,
    proxyLogs,
    proxyLogStates,
    pendingLogSources,
    selectedLogSourceId,
    setSelectedLogSourceId,
    form,
    setForm,
    manageProvider,
    setManageProvider,
    routePicker,
    setRoutePicker,
    overflowMenu,
    setOverflowMenu,
    clientResetConfirmation,
    setClientResetConfirmation,
    routeQuery,
    setRouteQuery,
    routeGroup,
    setRouteGroup,
    hubAccountQuery,
    setHubAccountQuery,
    hubAccountFilter,
    setHubAccountFilter,
    routingCandidateConflictId,
    setRoutingCandidateConflictId,
    routingCandidateQuery,
    setRoutingCandidateQuery,
    modelEditorClientId,
    modelDraftRoleActions,
    setModelDraftRoleActions,
    modelPickerRole,
    setModelPickerRole,
    modelQuery,
    setModelQuery,
    modelGroup,
    setModelGroup,
    headerStatus,
    footerStatus,
    isAuxiliary,
    auxiliaryTitle,
    notify,
    send,
    mutate,
    runAction,
    runOpaqueAction,
    modelConfigFor,
    openModelEditor,
    closeModelEditor,
    applyModelRoles,
    logSources,
    requestLogs,
    matches,
    trySelectRoute,
    statusLine,
    clearOverlays,
  };
}

export type TrayController = ReturnType<typeof useTrayController>;
