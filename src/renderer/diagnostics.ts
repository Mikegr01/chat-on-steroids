import type { AppApi } from '../preload/index.js';
import type { HealthAction, HealthEvidence, HealthState, PluginChainStage, PluginHealthDetail, SystemHealthSnapshot } from '../shared/diagnostics.js';
import { $, run, toast } from './dom.js';

/** Small navigation seam used by the app and renderer acceptance tests. */
export function bindDiagnosticsNavigation(show: (name: string) => void): void {
  $('sidebarDiagnostics').addEventListener('click', () => show('diagnostics'));
}

function clear(node: HTMLElement): void {
  node.replaceChildren();
}

function text(tag: keyof HTMLElementTagNameMap, value: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function stateLabel(state: HealthState): string {
  return state.replaceAll('_', ' ');
}

function paintEvidence(target: HTMLElement, summary: string, state: HealthState, evidence: HealthEvidence[]): void {
  clear(target);
  const head = text('div', '', 'diagnostics-row');
  head.append(text('strong', summary), text('span', stateLabel(state), `diagnostics-state diagnostics-state--${state.toLowerCase()}`));
  target.append(head);
  for (const item of evidence) {
    const row = text('div', '', 'diagnostics-evidence');
    row.append(text('span', item.label), text('span', item.value));
    if (item.detail) row.append(text('small', item.detail));
    target.append(row);
  }
}

function stageToken(stage: PluginChainStage): string {
  if (stage.status === 'pass') return '✓';
  if (stage.status === 'fail') return '×';
  if (stage.status === 'warn') return '!';
  if (stage.status === 'skipped') return '—';
  return '?';
}

function pluginAction(action: HealthAction, plugin: PluginHealthDetail, api: AppApi, refresh: () => Promise<void>): HTMLButtonElement | null {
  const button = text('button', action.label, 'btn') as HTMLButtonElement;
  button.type = 'button';
  if (action.actionType === 'open_chatgpt_plugins' || action.actionType === 'refresh_tools') {
    button.addEventListener('click', () => void run(api.openLink('https://chatgpt.com/plugins')));
    return button;
  }
  if (action.actionType !== 'restart_mcp' && action.actionType !== 'enable_addon') return null;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = action.actionType === 'restart_mcp'
        ? await run(api.pluginsRestart(action.pluginId ?? plugin.id))
        : await run(api.pluginsSetEnabled(action.pluginId ?? plugin.id, true));
      if (result !== null) await refresh();
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function paintPlugins(target: HTMLElement, plugins: PluginHealthDetail[], api: AppApi, refresh: () => Promise<void>): void {
  clear(target);
  if (plugins.length === 0) {
    target.append(text('p', 'No plugins are currently known.', 'muted'));
    return;
  }
  for (const plugin of plugins) {
    const row = text('div', '', 'diagnostics-plugin');
    const copy = text('div', '');
    copy.append(text('strong', plugin.name), text('small', `${stateLabel(plugin.state)} · ${plugin.toolCount} tools · ${plugin.connectorRefreshState.replaceAll('_', ' ')}`));
    if (plugin.failureReason) copy.append(text('small', plugin.failureReason));
    if (plugin.dependencyChain?.length) {
      const chain = text('div', '', 'diagnostics-chain');
      for (const stage of plugin.dependencyChain) {
        const value = `${stage.name} ${stageToken(stage)}`;
        chain.append(text('span', stage.detail ? `${value} · ${stage.detail}` : value, `diagnostics-chain-stage diagnostics-chain-stage--${stage.status}`));
      }
      copy.append(chain);
    }
    if (plugin.catalogId === 'blender' && plugin.specificMetrics) {
      const version = plugin.specificMetrics.blenderVersion;
      const protocol = plugin.specificMetrics.addonProtocol;
      const port = plugin.specificMetrics.serverPort;
      const listening = plugin.specificMetrics.serverListening;
      const metrics = [
        typeof version === 'string' ? `Blender ${version}` : undefined,
        typeof protocol === 'number' ? `Protocol ${protocol}` : undefined,
        typeof port === 'number' ? `Port ${port}${listening === true ? ' READY' : ''}` : undefined,
      ].filter((value): value is string => value !== undefined);
      if (metrics.length) copy.append(text('small', metrics.join(' · '), 'diagnostics-metrics'));
    }
    row.append(copy);
    for (const action of plugin.actions ?? []) {
      const button = pluginAction(action, plugin, api, refresh);
      if (button) row.append(button);
    }
    target.append(row);
  }
}

function paint(snapshot: SystemHealthSnapshot, api: AppApi, refresh: () => Promise<void>): void {
  $('diagnosticsOverallTitle').textContent = stateLabel(snapshot.overallState);
  $('diagnosticsOverallSummary').textContent = snapshot.overallSummary;
  const overall = $('diagnosticsOverallState');
  overall.textContent = snapshot.overallState;
  overall.className = `diagnostics-state diagnostics-state--${snapshot.overallState.toLowerCase()}`;

  paintEvidence($('diagnosticsApplication'), snapshot.application.summary, snapshot.application.state, snapshot.application.evidence);

  const connections = $('diagnosticsConnections');
  clear(connections);
  for (const surface of snapshot.connectivity.surfaces) {
    const row = text('div', '', 'diagnostics-evidence');
    row.append(text('span', surface.name), text('span', `${stateLabel(surface.state)} · ${surface.toolCount} tools · ${surface.refreshState.replaceAll('_', ' ')}`));
    connections.append(row);
  }

  paintEvidence($('diagnosticsAutomation'), snapshot.automation.summary, snapshot.automation.state, snapshot.automation.evidence);
  paintPlugins($('diagnosticsPlugins'), snapshot.plugins.items, api, refresh);
  paintEvidence($('diagnosticsEnvironment'), snapshot.environment.summary, snapshot.environment.state, snapshot.environment.evidence);

  const recent = $('diagnosticsRecent');
  clear(recent);
  const results = snapshot.recentProbes.slice(0, 10);
  if (results.length === 0) recent.append(text('p', 'No active health checks have been run yet.', 'muted'));
  for (const result of results) {
    const row = text('div', '', 'diagnostics-evidence');
    row.append(text('span', result.name), text('span', `${stateLabel(result.state)} · ${result.durationMs} ms`));
    recent.append(row);
  }
}

export function initDiagnostics(api: AppApi): () => Promise<void> {
  let loading = false;
  const error = $('diagnosticsError');

  const refresh = async (): Promise<void> => {
    if (loading) return;
    loading = true;
    error.hidden = true;
    try {
      const snapshot = await run(api.diagnosticsSnapshot(false));
      if (snapshot) paint(snapshot, api, refresh);
    } catch (cause: unknown) {
      error.textContent = cause instanceof Error ? cause.message : 'Diagnostics are unavailable.';
      error.hidden = false;
    } finally {
      loading = false;
    }
  };

  $('diagnosticsRecheck').addEventListener('click', () => void refresh());
  $('diagnosticsRun').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('diagnosticsRun');
    button.disabled = true;
    try {
      const snapshot = await run(api.diagnosticsRunHealthCheck());
      if (snapshot) paint(snapshot, api, refresh);
    } finally {
      button.disabled = false;
    }
  });
  $('diagnosticsOpenChatGPT').addEventListener('click', () => void run(api.openLink('https://chatgpt.com/plugins')));
  $('diagnosticsCopy').addEventListener('click', async () => {
    const report = await run(api.diagnosticsCopyReport());
    if (report !== null) toast('Diagnostics copied');
  });
  $('diagnosticsLogs').addEventListener('click', () => void run(api.diagnosticsOpenLogs()));

  return refresh;
}
