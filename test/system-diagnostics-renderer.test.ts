
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { bindDiagnosticsNavigation, initDiagnostics } from '../src/renderer/diagnostics.js';
import type { AppApi } from '../src/preload/index.js';
import type { PluginHealthDetail, SystemHealthSnapshot } from '../src/shared/diagnostics.js';

type Reply<T> = Promise<{ ok: true; data: T } | { ok: false; error: string }>;

const ok = <T>(data: T): Reply<T> => Promise.resolve({ ok: true, data });

function plugin(overrides: Partial<PluginHealthDetail> & Pick<PluginHealthDetail, 'id' | 'name'>): PluginHealthDetail {
  return {
    state: 'HEALTHY', installed: true, enabled: true, runtimeStatus: 'ready', mcpConnected: true,
    toolCount: 3, published: true, connectorRefreshState: 'CHATGPT_SCHEMA_CURRENT',
    dependencyChain: [
      { id: 'installed', name: 'Installed', status: 'pass' },
      { id: 'runtime', name: 'Runtime Starts', status: 'pass', detail: 'Process running' },
      { id: 'connector_schema', name: 'ChatGPT Connector Schema', status: 'pass', detail: 'Schema current' },
    ],
    ...overrides,
  };
}

function snapshot(overrides: Partial<SystemHealthSnapshot> = {}): SystemHealthSnapshot {
  return {
    timestamp: 100,
    overallState: 'HEALTHY',
    overallSummary: 'All checked systems are healthy.',
    application: { id: 'application', name: 'Application', state: 'HEALTHY', summary: 'App ready', evidence: [] },
    connectivity: { overall: 'HEALTHY', surfaces: [] },
    automation: {
      id: 'automation', name: 'Automation', state: 'UNKNOWN', summary: 'Not checked', evidence: [],
      automation: {
        goal: { state: 'Unknown', mode: 'off', detail: 'Not checked', armed: false },
        loop: { state: 'Unknown', detail: 'Not checked' },
        bridge: { state: 'Unknown', running: false, paired: false, present: false, detail: 'Not checked' },
        recovery: { state: 'Unknown', detail: 'Not checked' },
      },
    },
    plugins: { overall: 'HEALTHY', items: [] },
    environment: {
      id: 'environment', name: 'Environment', state: 'UNKNOWN', summary: 'Not checked', evidence: [],
      environment: { userDataDir: 'u', pluginsDir: 'p' },
    },
    recentProbes: [],
    recentErrors: [],
    actions: [],
    ...overrides,
  };
}

function apiFor(options: {
  passive: SystemHealthSnapshot[];
  run?: SystemHealthSnapshot;
}): { api: AppApi; snapshotCall: ReturnType<typeof vi.fn>; runCall: ReturnType<typeof vi.fn>; restartCall: ReturnType<typeof vi.fn>; openLinkCall: ReturnType<typeof vi.fn> } {
  const snapshotCall = vi.fn(() => ok(options.passive.shift() ?? snapshot()));
  const runCall = vi.fn(() => ok(options.run ?? snapshot()));
  const restartCall = vi.fn(() => ok({}));
  const openLinkCall = vi.fn(() => ok(true));
  const api = {
    diagnosticsSnapshot: snapshotCall,
    diagnosticsRunHealthCheck: runCall,
    diagnosticsCopyReport: vi.fn(() => ok('report')),
    diagnosticsOpenLogs: vi.fn(() => ok(undefined)),
    pluginsRestart: restartCall,
    pluginsSetEnabled: vi.fn(() => ok({})),
    openLink: openLinkCall,
  } as unknown as AppApi;
  return { api, snapshotCall, runCall, restartCall, openLinkCall };
}

const markup = `<!doctype html><body>
  <button id="diagnosticsRun"></button><button id="diagnosticsRecheck"></button>
  <button id="diagnosticsOpenChatGPT"></button><button id="diagnosticsCopy"></button><button id="diagnosticsLogs"></button>
  <div id="diagnosticsError" hidden></div>
  <h2 id="diagnosticsOverallTitle"></h2><p id="diagnosticsOverallSummary"></p><span id="diagnosticsOverallState"></span>
  <div id="diagnosticsApplication"></div><div id="diagnosticsConnections"></div><div id="diagnosticsAutomation"></div>
  <div id="diagnosticsPlugins"></div><div id="diagnosticsEnvironment"></div><div id="diagnosticsRecent"></div>
</body>`;

let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM(markup, { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  dom.window.close();
});

async function click(id: string): Promise<void> {
  document.getElementById(id)!.click();
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('System Diagnostics renderer', () => {
  it('opens the Diagnostics panel through the real sidebar navigation binding', () => {
    document.body.innerHTML = `<button id="sidebarDiagnostics" data-sidebar-page="diagnostics"></button>
      <section class="panel is-active" data-panel="chat"></section>
      <section class="panel" data-panel="diagnostics"></section>`;
    const show = (name: string): void => {
      for (const panel of document.querySelectorAll<HTMLElement>('.panel')) {
        panel.classList.toggle('is-active', panel.dataset.panel === name);
      }
    };
    bindDiagnosticsNavigation(show);
    document.getElementById('sidebarDiagnostics')!.click();

    expect(document.querySelector<HTMLElement>('[data-panel="chat"]')!.classList.contains('is-active')).toBe(false);
    expect(document.querySelector<HTMLElement>('[data-panel="diagnostics"]')!.classList.contains('is-active')).toBe(true);
  });

  it('paints the authoritative snapshot returned by Run Health Check without a second passive read', async () => {
    const passive = snapshot({ overallSummary: 'Before active checks', recentProbes: [] });
    const active = snapshot({
      overallState: 'DEGRADED',
      overallSummary: 'Active checks found a runtime failure.',
      recentProbes: [{ id: 'runtime', name: 'Runtime probe', state: 'DEGRADED', summary: 'failed', evidence: [], durationMs: 41, timestamp: 200 }],
    });
    const { api, snapshotCall, runCall } = apiFor({ passive: [passive], run: active });
    const refresh = initDiagnostics(api);
    await refresh();
    await click('diagnosticsRun');

    expect(runCall).toHaveBeenCalledTimes(1);
    expect(snapshotCall).toHaveBeenCalledTimes(1);
    expect(document.getElementById('diagnosticsOverallSummary')!.textContent).toBe('Active checks found a runtime failure.');
    expect(document.getElementById('diagnosticsRecent')!.textContent).toContain('Runtime probe');
  });

  it('trusts passive Recheck snapshot retention of recent results', async () => {
    const first = snapshot({
      recentProbes: [{ id: 'p1', name: 'Playwright probe', state: 'HEALTHY', summary: 'ok', evidence: [], durationMs: 12, timestamp: 100 }],
    });
    const retained = snapshot({
      timestamp: 300,
      overallSummary: 'Passive snapshot retained probe history.',
      recentProbes: first.recentProbes,
    });
    const { api, snapshotCall, runCall } = apiFor({ passive: [first, retained] });
    const refresh = initDiagnostics(api);
    await refresh();
    await click('diagnosticsRecheck');

    expect(snapshotCall).toHaveBeenCalledTimes(2);
    expect(snapshotCall).toHaveBeenNthCalledWith(2, false);
    expect(runCall).not.toHaveBeenCalled();
    expect(document.getElementById('diagnosticsRecent')!.textContent).toContain('Playwright probe');
    expect(document.getElementById('diagnosticsOverallSummary')!.textContent).toBe('Passive snapshot retained probe history.');
  });

  it('renders compact dependency chains, Blender READY metrics, failures, optional absence, and truthful unknown states', async () => {
    const plugins = [
      plugin({ id: 'playwright', name: 'Playwright', connectorRefreshState: 'CHATGPT_REFRESH_REQUIRED',
        state: 'ATTENTION_REQUIRED',
        dependencyChain: [
          { id: 'installed', name: 'Installed', status: 'pass' },
          { id: 'runtime', name: 'Runtime Starts', status: 'pass' },
          { id: 'connector_schema', name: 'ChatGPT Connector Schema', status: 'warn', detail: 'Refresh required in ChatGPT' },
        ],
        actions: [{ id: 'refresh_playwright', label: 'Refresh tools', actionType: 'open_chatgpt_plugins', primary: true }] }),
      plugin({ id: 'healthy-connector', name: 'Healthy Connector', connectorRefreshState: 'CHATGPT_SCHEMA_CURRENT',
        dependencyChain: [
          { id: 'connector_schema', name: 'ChatGPT Connector Schema', status: 'pass', detail: 'Schema current' },
        ] }),
      plugin({ id: 'blender', name: 'Blender', catalogId: 'blender',
        specificMetrics: { blenderVersion: '5.2.1', addonProtocol: 5, serverPort: 9876, serverListening: true } }),
      plugin({ id: 'broken', name: 'Broken Runtime', state: 'DEGRADED', runtimeStatus: 'error', mcpConnected: false,
        failureReason: 'Process exited 7',
        dependencyChain: [
          { id: 'runtime', name: 'Runtime Starts', status: 'fail', detail: 'Process exited 7' },
          { id: 'mcp', name: 'MCP Handshake', status: 'unknown' },
        ],
        actions: [{ id: 'restart_broken', label: 'Restart Broken Runtime', actionType: 'restart_mcp', pluginId: 'broken' }] }),
      plugin({ id: 'optional', name: 'Optional Tool', state: 'NOT_INSTALLED', installed: false, enabled: false,
        runtimeStatus: 'stopped', mcpConnected: false, toolCount: 0, published: false,
        connectorRefreshState: 'CHATGPT_SCHEMA_UNKNOWN',
        dependencyChain: [{ id: 'installed', name: 'Installed', status: 'skipped', detail: 'Optional plugin is not installed' }] }),
    ];
    const view = snapshot({
      plugins: { overall: 'DEGRADED', items: plugins },
      automation: { ...snapshot().automation, state: 'UNKNOWN', summary: 'Not checked' },
      environment: { ...snapshot().environment, state: 'UNKNOWN', summary: 'Not checked' },
    });
    const { api } = apiFor({ passive: [view] });
    await initDiagnostics(api)();

    const text = document.getElementById('diagnosticsPlugins')!.textContent!;
    expect(text).toContain('Playwright');
    expect(text).toContain('Installed ✓');
    expect(text).toContain('ChatGPT Connector Schema !');
    expect(text).toContain('Refresh required in ChatGPT');
    const playwrightRow = [...document.querySelectorAll<HTMLElement>('#diagnosticsPlugins .diagnostics-plugin')]
      .find(row => row.textContent?.includes('Playwright'));
    const healthyRow = [...document.querySelectorAll<HTMLElement>('#diagnosticsPlugins .diagnostics-plugin')]
      .find(row => row.textContent?.includes('Healthy Connector'));
    expect(playwrightRow?.querySelector('button')?.textContent).toBe('Refresh tools');
    expect(healthyRow?.textContent).toContain('Schema current');
    expect(healthyRow?.textContent).not.toContain('Refresh required');
    expect(healthyRow?.querySelector('button')).toBeNull();
    expect(text).toContain('Blender 5.2.1');
    expect(text).toContain('Protocol 5');
    expect(text).toContain('Port 9876 READY');
    expect(text).toContain('Process exited 7');
    expect(text).toContain('MCP Handshake ?');
    expect(text).toContain('Optional Tool');
    expect(text).toContain('not installed');
    expect(document.getElementById('diagnosticsAutomation')!.textContent).toContain('Not checked');
    expect(document.getElementById('diagnosticsAutomation')!.textContent).toContain('UNKNOWN');
  });

  it('wires plugin and page actions to their named APIs and repaints from the authoritative passive result', async () => {
    const withAction = snapshot({ plugins: { overall: 'DEGRADED', items: [
      plugin({ id: 'broken', name: 'Broken Runtime', state: 'DEGRADED',
        actions: [{ id: 'restart_broken', label: 'Restart Broken Runtime', actionType: 'restart_mcp', pluginId: 'broken' }] }),
    ] } });
    const afterRestart = snapshot({ overallSummary: 'Restart reflected by main.', plugins: { overall: 'HEALTHY', items: [] } });
    const { api, restartCall, openLinkCall } = apiFor({ passive: [withAction, afterRestart] });
    await initDiagnostics(api)();

    const restart = [...document.querySelectorAll<HTMLButtonElement>('#diagnosticsPlugins button')].find(button => button.textContent === 'Restart Broken Runtime');
    expect(restart).toBeDefined();
    restart!.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(restartCall).toHaveBeenCalledWith('broken');
    expect(document.getElementById('diagnosticsOverallSummary')!.textContent).toBe('Restart reflected by main.');

    await click('diagnosticsOpenChatGPT');
    expect(openLinkCall).toHaveBeenCalledWith('https://chatgpt.com/plugins');
  });
});
