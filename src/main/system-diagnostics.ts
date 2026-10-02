/**
 * System Diagnostics / Health Center — Main Process Health Authority
 * Owns authoritative health truth; renderer is presentation only.
 */

import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { app } from 'electron';
import { APP_VERSION } from './version.js';
import { CUSTOM_APP_IDENTITY } from '../shared/app-identity.js';
import { resolveCustomUserData } from './app-identity.js';
import { getStatus as getConnectionStatus, isServerRunning } from './connection.js';
import { getSurfaceRefreshDiagnostics, type SurfaceRefreshDiagnostics } from './plugin-refresh.js';
import { pluginManager } from './plugins/manager.js';
import { bridgeStatus } from './bridge.js';
import { getConfig } from './config.js';
import { getLog } from './logger.js';
import { redactSecretText } from './redaction.js';
import { managedUvDirectory } from './plugins/uv-runtime.js';
import type { BlenderHealthReport } from './plugins/blender.js';
import type {
  HealthState,
  ConnectorSchemaState,
  HealthEvidence,
  HealthAction,
  SubsystemHealth,
  PluginChainStage,
  PluginHealthDetail,
  ConnectivitySurfaceHealth,
  AutomationHealth,
  EnvironmentHealth,
  HealthCheckResult,
  SystemHealthSnapshot,
} from '../shared/diagnostics.js';
import type { ConnectionStatus, SurfaceStatus } from '../shared/types.js';

let cachedSnapshot: SystemHealthSnapshot | null = null;
let lastSnapshotTime = 0;
let lastProbeResults: HealthCheckResult[] = [];
const SNAPSHOT_CACHE_TTL_MS = 2000;

let cachedEnvCheck: {
  node?: { available: boolean; version?: string };
  python?: { available: boolean; version?: string; path?: string };
  uv?: { available: boolean; version?: string; managed: boolean; path?: string };
  git?: { available: boolean; version?: string };
  timestamp: number;
} | null = null;
const ENV_CACHE_TTL_MS = 60_000;
const execFileAsync = promisify(execFile);

export function clearCachedEnvironmentForTesting(): void {
  cachedEnvCheck = null;
}

function tryResolveCustomUserData(): string | undefined {
  try {
    return resolveCustomUserData();
  } catch {
    return undefined;
  }
}

function textContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.flatMap((item): string[] => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    return record.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
  }).join('\n');
}

async function probeVersion(command: string, args: string[]): Promise<{ available: boolean; version?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: 1500,
      windowsHide: true,
      maxBuffer: 16 * 1024,
    });
    const version = `${stdout}${stderr}`.trim().split(/\r?\n/, 1)[0]?.slice(0, 160);
    return { available: true, version: version || undefined };
  } catch {
    return { available: false };
  }
}

/**
 * Aggregates subsystem states into an authoritative overall health state.
 *
 * Rules:
 * - If any critical subsystem is BLOCKED, overall is BLOCKED.
 * - Else if any subsystem is DEGRADED, overall is DEGRADED.
 * - Else if any subsystem requires attention, overall is ATTENTION_REQUIRED.
 * - Else if any subsystem is STARTING, overall is STARTING.
 * - Else if all essential systems are HEALTHY, overall is HEALTHY.
 * - NOT_INSTALLED, NOT_CONFIGURED, and UNKNOWN on optional subsystems do NOT cause overall failure.
 */
export function aggregateOverallHealth(subsystems: {
  application: HealthState;
  connectivity: HealthState;
  automation: HealthState;
  plugins: HealthState;
  environment: HealthState;
}): HealthState {
  const states = [
    subsystems.application,
    subsystems.connectivity,
    subsystems.automation,
    subsystems.plugins,
    subsystems.environment,
  ];

  if (states.includes('BLOCKED')) return 'BLOCKED';
  if (states.includes('DEGRADED')) return 'DEGRADED';
  if (states.includes('ATTENTION_REQUIRED')) return 'ATTENTION_REQUIRED';
  if (states.includes('STARTING')) return 'STARTING';

  // Optional plugin/environment uncertainty does not block healthy essentials.
  const coreStates = [subsystems.application, subsystems.connectivity, subsystems.automation];
  if (coreStates.includes('UNKNOWN')) return 'UNKNOWN';
  if (coreStates.every((s) => s === 'HEALTHY' || s === 'NOT_CONFIGURED')) {
    return 'HEALTHY';
  }

  return 'UNKNOWN';
}

/**
 * Evaluates Application Health with trustworthy evidence.
 */
export async function evaluateApplicationHealth(options?: {
  bridge?: Awaited<ReturnType<typeof bridgeStatus>>;
}): Promise<SubsystemHealth> {
  const bridge = options?.bridge ?? (await bridgeStatus());
  const userDataDir = tryResolveCustomUserData();
  const evidence: HealthEvidence[] = [
    { label: 'Application', value: CUSTOM_APP_IDENTITY.productName, status: 'pass' },
    { label: 'Version', value: APP_VERSION, status: 'pass' },
    {
      label: 'Build Source',
      value: process.env.GIT_COMMIT_SHA
        ? process.env.GIT_COMMIT_SHA.slice(0, 10)
        : app?.isPackaged
          ? 'Production build'
          : 'Development worktree',
      status: 'info',
    },
    {
      label: 'Bridge Server',
      value: bridge.running
        ? `Running on 127.0.0.1:${bridge.port ?? 49200}`
        : bridge.error
          ? `Error: ${bridge.error}`
          : 'Stopped',
      status: bridge.running ? 'pass' : 'fail',
      detail: bridge.error ?? undefined,
    },
    {
      label: 'Browser Extension',
      value: bridge.paired
        ? bridge.present
          ? `Connected · version ${bridge.extensionVersion ?? 'current'}`
          : 'Paired · waiting for browser tab'
        : 'Not paired · extension not connected',
      status: bridge.paired ? (bridge.present ? 'pass' : 'info') : 'warn',
    },
    {
      label: 'User Data Isolation',
      value: userDataDir && path.basename(userDataDir) === CUSTOM_APP_IDENTITY.userDataDir ? 'Isolated Custom' : 'Unknown',
      status: userDataDir && path.basename(userDataDir) === CUSTOM_APP_IDENTITY.userDataDir ? 'pass' : 'unknown',
      detail: userDataDir,
    },
  ];

  let state: HealthState = 'HEALTHY';
  let summary = 'Application running normally';
  const blockers: string[] = [];

  if (!bridge.running) {
    state = 'DEGRADED';
    summary = bridge.error ? `Bridge server failed: ${bridge.error}` : 'Bridge server is stopped';
    blockers.push(bridge.error ? `Bridge: ${bridge.error}` : 'Bridge server is stopped');
  }

  return {
    id: 'application',
    name: 'Application',
    state,
    summary,
    evidence,
    blockers: blockers.length > 0 ? blockers : undefined,
  };
}

/**
 * Evaluates Connectivity Health for CORE, DESKTOP, and PLUGINS surfaces.
 */
export function evaluateConnectivityHealth(options?: {
  connectionStatus?: ConnectionStatus;
  refreshDiagnostics?: Record<'core' | 'desktop' | 'plugins', SurfaceRefreshDiagnostics>;
}): { overall: HealthState; surfaces: ConnectivitySurfaceHealth[] } {
  const connection = options?.connectionStatus ?? getConnectionStatus();
  const refresh = options?.refreshDiagnostics;

  const surfaceNames: Record<'core' | 'desktop' | 'plugins', string> = {
    core: 'Chat On Steroids Core',
    desktop: 'Chat On Steroids Desktop',
    plugins: 'Chat On Steroids Plugins',
  };

  const surfaces: ConnectivitySurfaceHealth[] = (['core', 'desktop', 'plugins'] as const).map((surfaceId) => {
    const rawSurface: SurfaceStatus | undefined = connection.surfaces.find((s) => s.id === surfaceId);
    const refreshDiag: SurfaceRefreshDiagnostics | undefined = refresh?.[surfaceId];

    const available = rawSurface?.available ?? Boolean(refreshDiag?.published);
    const connState = rawSurface?.state ?? 'disconnected';
    const isPublished = refreshDiag?.published ?? (connState === 'live' && available);
    const toolCount = refreshDiag?.toolCount ?? (rawSurface?.tools.length ?? 0);
    const refreshState: ConnectorSchemaState = refreshDiag?.connectorSchemaState ?? (
      isPublished ? 'CHATGPT_SCHEMA_UNKNOWN' : 'LOCAL_RUNTIME_READY'
    );
    const manualRefreshRequired = refreshDiag?.manual ?? false;
    const refreshParked = refreshDiag?.parked ?? false;
    const refreshError = refreshDiag?.error;
    const surfaceError = (connState === 'error' && rawSurface?.detail && rawSurface.detail !== 'Live') ? rawSurface.detail : undefined;
    const connectorAppId = refreshDiag?.appId ?? null;

    let state: HealthState = 'HEALTHY';
    const actions: HealthAction[] = [];

    if (!available && !refreshDiag?.published) {
      state = surfaceId === 'core' ? 'UNKNOWN' : 'NOT_CONFIGURED';
    } else if (connState === 'starting') {
      state = 'STARTING';
    } else if (connState === 'off') {
      state = surfaceId === 'core' ? 'DEGRADED' : 'NOT_CONFIGURED';
    } else if (connState === 'error') {
      state = 'DEGRADED';
      actions.push({
        id: `restart_${surfaceId}`,
        label: `Restart ${surfaceNames[surfaceId]}`,
        actionType: 'restart_connector',
        surface: surfaceId,
      });
    } else if (refreshState === 'CHATGPT_REFRESH_PENDING') {
      state = 'STARTING';
    } else if (refreshState === 'CHATGPT_REFRESH_REQUIRED') {
      state = 'ATTENTION_REQUIRED';
      actions.push({
        id: `refresh_tools_${surfaceId}`,
        label: 'Open ChatGPT plugins',
        actionType: 'open_chatgpt_plugins',
        surface: surfaceId,
        primary: true,
        description: 'ChatGPT cached tool schema differs from published local tools.',
      });
    }

    return {
      surface: surfaceId,
      name: surfaceNames[surfaceId],
      state,
      available,
      connectionState: connState,
      tunnelConfigured: Boolean(rawSurface?.publicUrl),
      tunnelState: connState,
      published: isPublished,
      localSchemaId: refreshDiag?.schemaId ?? undefined,
      toolCount,
      refreshState,
      manualRefreshRequired,
      refreshParked,
      refreshError,
      error: surfaceError,
      connectorAppId,
      actions: actions.length > 0 ? actions : undefined,
    };
  });

  let overall: HealthState = 'HEALTHY';
  if (surfaces.some((s) => s.state === 'BLOCKED')) overall = 'BLOCKED';
  else if (surfaces.some((s) => s.surface === 'core' && s.state === 'DEGRADED')) overall = 'DEGRADED';
  else if (surfaces.some((s) => s.surface === 'core' && s.state === 'UNKNOWN')) overall = 'UNKNOWN';
  else if (surfaces.some((s) => s.state === 'DEGRADED')) overall = 'DEGRADED';
  else if (surfaces.some((s) => s.state === 'ATTENTION_REQUIRED')) overall = 'ATTENTION_REQUIRED';
  else if (surfaces.some((s) => s.state === 'STARTING')) overall = 'STARTING';

  return { overall, surfaces };
}

/**
 * Evaluates Automation Health: Goal, Loop, input bridge, recovery.
 */
export function evaluateAutomationHealth(options?: {
  config?: ReturnType<typeof getConfig>;
  bridge?: Awaited<ReturnType<typeof bridgeStatus>>;
}): SubsystemHealth & { automation: AutomationHealth } {
  const config = options?.config ?? getConfig();
  const bridge = options?.bridge;

  const goalMode = config.goal.mode;
  const goalConfigured = Boolean(config.goal.model);

  const automation: AutomationHealth = {
    goal: {
      state: goalConfigured ? 'Available' : 'Idle',
      mode: goalMode,
      detail: `Mode: ${goalMode} · Provider: ${config.goal.provider.kind} · Model: ${config.goal.model}`,
      armed: config.goal.enabled,
    },
    loop: {
      state: 'Unknown',
      detail: 'No live loop execution authority was checked',
    },
    bridge: {
      state: bridge === undefined ? 'Unknown' : bridge.running ? 'Available' : 'Blocked',
      running: bridge?.running ?? false,
      paired: bridge?.paired ?? false,
      present: bridge?.present ?? false,
      detail: bridge === undefined ? 'Bridge state has not been checked' : bridge.running ? 'Bridge live on 127.0.0.1' : 'Bridge server not running',
    },
    recovery: {
      state: 'Unknown',
      detail: 'No live recovery authority was checked',
    },
  };

  const evidence: HealthEvidence[] = [
    { label: 'Goal Engine', value: automation.goal.state, status: 'pass' },
    { label: 'Loop Automation', value: automation.loop.state, status: 'unknown' },
    { label: 'Composer Bridge', value: automation.bridge.state, status: bridge === undefined ? 'unknown' : bridge.running ? 'pass' : 'fail' },
    { label: 'Turn Recovery', value: automation.recovery.state, status: 'unknown' },
  ];

  return {
    id: 'automation',
    name: 'Automation',
    state: automation.bridge.state === 'Blocked' ? 'DEGRADED' : 'UNKNOWN',
    summary: automation.bridge.state === 'Blocked' ? 'Automation bridge is unavailable' : 'Some automation runtime state has not been checked',
    evidence,
    automation,
  };
}

/**
 * Evaluates Plugin Health and constructs explicit dependency chains.
 *
 * Dependency Chain:
 * INSTALLED -> ENABLED -> RUNTIME_STARTS -> MCP_HANDSHAKE -> TOOLS_DISCOVERED -> LOCAL_PUBLICATION -> CONNECTOR_SCHEMA_STATE
 */
export function evaluatePluginHealth(options?: {
  snapshot?: ReturnType<typeof pluginManager.snapshot>;
  refreshDiagnostics?: SurfaceRefreshDiagnostics;
}): { overall: HealthState; items: PluginHealthDetail[] } {
  const snapshot = options?.snapshot ?? pluginManager.snapshot();
  const refresh = options?.refreshDiagnostics;

  const items: PluginHealthDetail[] = [];
  const processedIds = new Set<string>();

  // Process installed plugins first
  for (const installed of snapshot.plugins) {
    processedIds.add(installed.id);
    if (installed.catalogId) processedIds.add(installed.catalogId);

    const enabled = installed.enabled;
    const runtimeStatus = installed.status;
    const mcpConnected = runtimeStatus === 'ready';
    const discoveredTools = installed.tools;
    const publishedTools = discoveredTools.filter((t) => t.published);
    const exposureConflict = discoveredTools.find((t) => t.exposureError)?.exposureError;

    const connectorRefreshState: ConnectorSchemaState = refresh?.connectorSchemaState ?? (
      publishedTools.length > 0 ? 'CHATGPT_SCHEMA_CURRENT' : 'LOCAL_RUNTIME_READY'
    );

    // Build dependency chain
    const dependencyChain: PluginChainStage[] = [
      { id: 'installed', name: 'Installed', status: 'pass' },
      { id: 'enabled', name: 'Enabled', status: enabled ? 'pass' : 'warn', detail: enabled ? undefined : 'Plugin is disabled' },
      {
        id: 'runtime',
        name: 'Runtime Starts',
        status: runtimeStatus === 'ready' ? 'pass' : runtimeStatus === 'error' ? 'fail' : 'warn',
        detail: installed.error ?? (runtimeStatus === 'ready' ? 'Process running' : `Status: ${runtimeStatus}`),
      },
      {
        id: 'mcp_handshake',
        name: 'MCP Handshake',
        status: mcpConnected ? 'pass' : runtimeStatus === 'error' ? 'fail' : 'unknown',
      },
      {
        id: 'tools_discovered',
        name: 'Tools Discovered',
        status: discoveredTools.length > 0 ? 'pass' : 'warn',
        detail: `${discoveredTools.length} tools discovered`,
      },
      {
        id: 'local_publication',
        name: 'Local Publication',
        status: exposureConflict ? 'fail' : publishedTools.length > 0 ? 'pass' : 'warn',
        detail: exposureConflict ?? `${publishedTools.length} published`,
      },
      {
        id: 'connector_schema',
        name: 'ChatGPT Connector Schema',
        status: connectorRefreshState === 'CHATGPT_SCHEMA_CURRENT'
          ? 'pass'
          : connectorRefreshState === 'CHATGPT_REFRESH_REQUIRED'
            ? 'warn'
            : 'unknown',
        detail: connectorRefreshState === 'CHATGPT_REFRESH_REQUIRED'
          ? 'Refresh required in ChatGPT'
          : connectorRefreshState === 'CHATGPT_SCHEMA_CURRENT'
            ? 'Schema current'
            : connectorRefreshState,
      },
    ];

    let state: HealthState = 'HEALTHY';
    const actions: HealthAction[] = [];

    if (!enabled) {
      state = 'ATTENTION_REQUIRED';
    } else if (runtimeStatus === 'error') {
      state = 'DEGRADED';
      actions.push({
        id: `restart_${installed.id}`,
        label: `Restart ${installed.name}`,
        actionType: 'restart_mcp',
        pluginId: installed.id,
      });
    } else if (exposureConflict) {
      state = 'DEGRADED';
    } else if (connectorRefreshState === 'CHATGPT_REFRESH_REQUIRED') {
      state = 'ATTENTION_REQUIRED';
      actions.push({
        id: `refresh_${installed.id}`,
        label: 'Refresh tools',
        actionType: 'open_chatgpt_plugins',
        primary: true,
      });
    }

    const specificMetrics: Record<string, unknown> = {};
    if (installed.catalogId === 'blender' && installed.blender) {
      const b = installed.blender;
      specificMetrics.blenderVersion = b.installation?.version;
      specificMetrics.blenderPath = b.installation?.executablePath;
      specificMetrics.addonProtocol = b.addon?.protocolVersion;
      specificMetrics.addonInstalled = b.addon?.canonicalInstalled;
      specificMetrics.serverPort = b.server?.port;
      specificMetrics.serverListening = b.server?.listening;

      if (b.status === 'ready' && b.code === 'READY') {
        // healthy
      } else {
        state = 'ATTENTION_REQUIRED';
        if (b.actionRequired === 'Enable the add-on in Blender Preferences' || b.code === 'ADDON_DISABLED') {
          actions.push({
            id: 'enable_blender_addon',
            label: 'Enable add-on',
            actionType: 'enable_addon',
            pluginId: installed.id,
          });
        }
      }
    }

    items.push({
      id: installed.id,
      name: installed.name,
      catalogId: installed.catalogId,
      state,
      installed: true,
      enabled,
      runtimeStatus,
      mcpConnected,
      toolCount: discoveredTools.length,
      published: publishedTools.length > 0,
      exposureConflict,
      connectorRefreshState,
      failureReason: installed.error ?? (installed.blender?.status === 'error' ? installed.blender.message : undefined),
      dependencyChain,
      actions: actions.length > 0 ? actions : undefined,
      specificMetrics: Object.keys(specificMetrics).length > 0 ? specificMetrics : undefined,
    });
  }

  // Process remaining uninstalled catalog entries
  for (const catalogEntry of snapshot.catalog) {
    if (processedIds.has(catalogEntry.id)) continue;
    items.push({
      id: catalogEntry.id,
      name: catalogEntry.name,
      catalogId: catalogEntry.id,
      state: 'NOT_INSTALLED',
      installed: false,
      enabled: false,
      runtimeStatus: 'stopped',
      mcpConnected: false,
      toolCount: 0,
      published: false,
      connectorRefreshState: 'CHATGPT_SCHEMA_UNKNOWN',
    });
  }

  let overall: HealthState = 'HEALTHY';
  if (items.some((i) => i.installed && i.state === 'BLOCKED')) overall = 'BLOCKED';
  else if (items.some((i) => i.installed && i.state === 'DEGRADED')) overall = 'DEGRADED';
  else if (items.some((i) => i.installed && i.state === 'ATTENTION_REQUIRED')) overall = 'ATTENTION_REQUIRED';

  return { overall, items };
}

/**
 * Evaluates bounded Environment Health useful to plugin operation.
 */
export async function evaluateEnvironmentHealth(options?: {
  runActiveProbes?: boolean;
  probes?: {
    node?: { available: boolean; version?: string };
    python?: { available: boolean; version?: string; path?: string };
    uv?: { available: boolean; version?: string; managed?: boolean; path?: string };
    git?: { available: boolean; version?: string };
    diskSpace?: { availableBytes?: number; freeFormatted?: string };
  };
}): Promise<SubsystemHealth & { environment: EnvironmentHealth }> {
  const userDataDir = tryResolveCustomUserData() ?? '';
  const pluginsDir = userDataDir ? path.join(userDataDir, 'plugins') : '';

  let diskSpace: { availableBytes?: number; freeFormatted?: string } | undefined = options?.probes?.diskSpace;
  if (!diskSpace) {
    try {
      if (!userDataDir) throw new Error('userData path unavailable');
      const stats = await fs.statfs(userDataDir);
      const freeBytes = stats.bavail * stats.bsize;
      const gb = freeBytes / (1024 * 1024 * 1024);
      diskSpace = {
        availableBytes: freeBytes,
        freeFormatted: `${gb.toFixed(1)} GB`,
      };
    } catch {
      // statfs fallback
    }
  }

  // Passive snapshots only report facts already known by this process. Explicit
  // health checks may run short, bounded version commands.
  if (options?.probes) {
    cachedEnvCheck = {
      node: options.probes.node ?? { available: true, version: process.version },
      python: options.probes.python,
      uv: options.probes.uv ? { ...options.probes.uv, managed: options.probes.uv.managed ?? false } : undefined,
      git: options.probes.git,
      timestamp: Date.now(),
    };
  } else if (options?.runActiveProbes && (!cachedEnvCheck || Date.now() - cachedEnvCheck.timestamp > ENV_CACHE_TTL_MS)) {
    const managedUv = managedUvDirectory();
    const [python, uv, git] = await Promise.all([
      probeVersion('python', ['--version']),
      probeVersion('uv', ['--version']),
      probeVersion('git', ['--version']),
    ]);

    cachedEnvCheck = {
      node: { available: true, version: process.version },
      python,
      uv: { ...uv, managed: Boolean(managedUv) },
      git,
      timestamp: Date.now(),
    };
  }

  const environment: EnvironmentHealth = {
    node: cachedEnvCheck?.node ?? { available: true, version: process.version },
    python: cachedEnvCheck?.python,
    uv: cachedEnvCheck?.uv,
    git: cachedEnvCheck?.git,
    userDataDir,
    pluginsDir,
    diskSpace,
  };

  const formatEvidenceValue = (item: { available: boolean; version?: string } | undefined): string => {
    if (!item) return 'Unknown / Not checked';
    if (!item.available) return 'Not found';
    return item.version ?? 'Available';
  };

  const evidence: HealthEvidence[] = [
    { label: 'Node.js', value: environment.node?.version ?? (environment.node?.available ? 'Available' : 'Unknown / Not checked'), status: environment.node?.available ? 'pass' : 'warn' },
    { label: 'Python', value: formatEvidenceValue(environment.python), status: environment.python ? (environment.python.available ? 'pass' : 'fail') : 'unknown' },
    { label: 'uv Runtime', value: formatEvidenceValue(environment.uv), status: environment.uv ? (environment.uv.available ? 'pass' : 'fail') : 'unknown' },
    { label: 'Git', value: formatEvidenceValue(environment.git), status: environment.git ? (environment.git.available ? 'pass' : 'fail') : 'unknown' },
    { label: 'Disk Space', value: diskSpace?.freeFormatted ?? 'Unknown', status: diskSpace ? 'pass' : 'unknown' },
    { label: 'Plugins Directory', value: pluginsDir, status: 'info' },
  ];

  const runtimes: Array<{ name: string; probe?: { available: boolean } }> = [
    { name: 'Python', probe: environment.python },
    { name: 'uv', probe: environment.uv },
    { name: 'Git', probe: environment.git },
  ];

  const unavailable = runtimes.filter((r) => r.probe !== undefined && !r.probe.available);
  const allAvailable = runtimes.every((r) => r.probe !== undefined && r.probe.available);

  let state: HealthState = 'UNKNOWN';
  let summary = 'Environment details are partially unknown';
  const blockers: string[] = [];

  if (unavailable.length > 0) {
    state = 'DEGRADED';
    summary = `Required environment runtime not found: ${unavailable.map((r) => r.name).join(', ')}`;
    for (const u of unavailable) {
      blockers.push(`${u.name}: Not found`);
    }
  } else if (allAvailable) {
    state = 'HEALTHY';
    summary = 'Environment probes completed';
  } else {
    state = 'UNKNOWN';
    summary = 'Environment details are partially unknown';
  }

  return {
    id: 'environment',
    name: 'Environment',
    state,
    summary,
    evidence,
    blockers: blockers.length > 0 ? blockers : undefined,
    environment,
  };
}

/**
 * Runs safe, bounded health check probes.
 * Probes are strictly read-only, non-destructive, and have deterministic timeouts.
 */
export async function runSafeHealthChecks(options?: {
  probeRunner?: () => Promise<HealthCheckResult[]>;
  pluginRuntime?: {
    snapshot(): { plugins: Array<{ id: string; catalogId?: string; enabled: boolean; status: string }> };
    diagnoseBlender(id?: string): Promise<BlenderHealthReport>;
    call(name: string, args?: Record<string, unknown>): Promise<{ isError?: boolean; content?: Array<{ type: string; text?: string }> }>;
  };
}): Promise<HealthCheckResult[]> {
  if (options?.probeRunner) {
    return options.probeRunner();
  }

  const results: HealthCheckResult[] = [];
  const runtime = options?.pluginRuntime ?? pluginManager;

  // Probe 1: Bridge Loopback Ping
  const bridgeStart = Date.now();
  try {
    const bridge = await bridgeStatus();
    if (bridge.running && bridge.port) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(`http://127.0.0.1:${bridge.port}/hello`, { signal: controller.signal });
        const text = await res.text();
        results.push({
          id: 'probe_bridge',
          name: 'Bridge Ping',
          state: res.status === 200 ? 'HEALTHY' : 'DEGRADED',
          summary: res.status === 200 ? 'Bridge answering on loopback' : `Bridge returned HTTP ${res.status}`,
          evidence: [
            { label: 'HTTP Status', value: String(res.status) },
            { label: 'Payload', value: text.slice(0, 80) },
          ],
          durationMs: Date.now() - bridgeStart,
          timestamp: Date.now(),
        });
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (err: unknown) {
    results.push({
      id: 'probe_bridge',
      name: 'Bridge Ping',
      state: 'DEGRADED',
      summary: 'Bridge ping timed out or failed',
      evidence: [{ label: 'Error', value: (err as Error).message }],
      durationMs: Date.now() - bridgeStart,
      timestamp: Date.now(),
    });
  }

  // Probe 2: Connector Local Server Status
  const connStart = Date.now();
  const conn = getConnectionStatus();
  results.push({
    id: 'probe_connector',
    name: 'Connector Server Status',
    state: isServerRunning() ? 'HEALTHY' : 'NOT_CONFIGURED',
    summary: isServerRunning() ? 'Local MCP server listening' : 'MCP server disconnected',
    evidence: [
      { label: 'Connection State', value: conn.state },
      { label: 'Local URL', value: conn.localUrl ? 'Configured' : 'None' },
    ],
    durationMs: Date.now() - connStart,
    timestamp: Date.now(),
  });

  // Probe 3: Blender Safe Read-Only Canary
  const snapshot = runtime.snapshot();
  const blenderPlugin = snapshot.plugins.find((p) => p.catalogId === 'blender');
  if (blenderPlugin && blenderPlugin.enabled) {
    const blenderStart = Date.now();
    try {
      const diag: BlenderHealthReport = await runtime.diagnoseBlender(blenderPlugin.id);
      let sceneVerified = false;
      let sceneSummary = 'Blender diagnostics did not reach READY';
      if (diag.code === 'READY') {
        const scene = await runtime.call('get_scene_info', {
          user_prompt: 'Read-only connection check: inspect the current Blender scene without changing it.',
        });
        const sceneText = textContent(scene.content);
        sceneVerified = !scene.isError && sceneText.trim().length > 0;
        sceneSummary = sceneVerified ? 'Blender scene read succeeded' : 'Blender scene read failed';
      }
      results.push({
        id: 'probe_blender',
        name: 'Blender Read-Only Scene Probe',
        state: diag.code === 'READY' && sceneVerified ? 'HEALTHY' : 'ATTENTION_REQUIRED',
        summary: diag.code === 'READY' ? sceneSummary : (diag.diagnostic ?? diag.message),
        evidence: [
          { label: 'Blender Version', value: diag.installation?.version ?? 'Unknown' },
          { label: 'Add-on Protocol', value: String(diag.addon?.protocolVersion ?? 'None') },
          { label: 'Server Port', value: String(diag.server?.port ?? 9876) },
          { label: 'Server Listening', value: diag.server?.listening ? 'PASS' : 'FAIL' },
        ],
        durationMs: Date.now() - blenderStart,
        timestamp: Date.now(),
      });
    } catch (err: unknown) {
      results.push({
        id: 'probe_blender',
        name: 'Blender Read-Only Scene Probe',
        state: 'DEGRADED',
        summary: (err as Error).message,
        evidence: [{ label: 'Error', value: (err as Error).message }],
        durationMs: Date.now() - blenderStart,
        timestamp: Date.now(),
      });
    }
  }

  // Probe 4: Playwright Safe Canary (isolated only, data page)
  const playwrightPlugin = snapshot.plugins.find((p) => p.catalogId === 'playwright');
  if (playwrightPlugin && playwrightPlugin.enabled && playwrightPlugin.status === 'ready') {
    const pwStart = Date.now();
    try {
      let closeError: string | undefined;
      try {
        const navRes = await runtime.call('browser_navigate', {
        url: 'data:text/html,<html><body>COS PLAYWRIGHT TEST</body></html>',
        });
        const verifyRes = navRes.isError ? undefined : await runtime.call('browser_snapshot', {});
        const verifiedText = textContent(verifyRes?.content);
        const verified = !navRes.isError && !verifyRes?.isError && verifiedText.includes('COS PLAYWRIGHT TEST');
        results.push({
          id: 'probe_playwright',
          name: 'Playwright Isolated Browser Canary',
          state: verified ? 'HEALTHY' : 'DEGRADED',
          summary: verified ? 'Isolated browser content verified with disposable page' : 'Canary content verification failed',
          evidence: [
            { label: 'Canary URL', value: 'data:text/html (disposable)' },
            { label: 'Content Verification', value: verified ? 'PASS' : 'FAIL' },
          ],
          durationMs: Date.now() - pwStart,
          timestamp: Date.now(),
        });
      } finally {
        try {
          await runtime.call('browser_close', {});
        } catch (err: unknown) {
          closeError = err instanceof Error ? err.message : String(err);
        }
      }
      if (closeError) {
        const result = results.find(item => item.id === 'probe_playwright');
        if (result) {
          result.state = 'DEGRADED';
          result.summary = `Canary cleanup failed: ${closeError}`;
        }
      }
    } catch (err: unknown) {
      results.push({
        id: 'probe_playwright',
        name: 'Playwright Isolated Browser Canary',
        state: 'DEGRADED',
        summary: (err as Error).message,
        evidence: [{ label: 'Error', value: (err as Error).message }],
        durationMs: Date.now() - pwStart,
        timestamp: Date.now(),
      });
    }
  }

  return results;
}

/**
 * Builds the authoritative SystemHealthSnapshot.
 */
export async function getSystemHealthSnapshot(options?: {
  runActiveProbes?: boolean;
  runEnvironmentProbes?: boolean;
  subsystems?: {
    application?: SubsystemHealth;
    connectivity?: { overall: HealthState; surfaces: ConnectivitySurfaceHealth[] };
    automation?: SubsystemHealth & { automation: AutomationHealth };
    plugins?: { overall: HealthState; items: PluginHealthDetail[] };
    environment?: SubsystemHealth & { environment: EnvironmentHealth };
    recentProbes?: HealthCheckResult[];
  };
}): Promise<SystemHealthSnapshot> {
  const now = Date.now();
  if (!options?.runActiveProbes && !options?.subsystems && cachedSnapshot && now - lastSnapshotTime < SNAPSHOT_CACHE_TTL_MS) {
    return structuredClone(cachedSnapshot);
  }

  const [bridge, refresh] = await Promise.all([
    bridgeStatus(),
    getSurfaceRefreshDiagnostics(),
  ]);

  const appHealth = options?.subsystems?.application ?? (await evaluateApplicationHealth({ bridge }));
  const connHealth = options?.subsystems?.connectivity ?? evaluateConnectivityHealth({ refreshDiagnostics: refresh });
  const autoHealth = options?.subsystems?.automation ?? evaluateAutomationHealth({ bridge });
  const pluginHealth = options?.subsystems?.plugins ?? evaluatePluginHealth({ refreshDiagnostics: refresh.plugins });
  const envHealth = options?.subsystems?.environment ?? (await evaluateEnvironmentHealth({ runActiveProbes: options?.runEnvironmentProbes ?? options?.runActiveProbes }));

  let recentProbes: HealthCheckResult[] = options?.subsystems?.recentProbes ?? lastProbeResults;
  if (!options?.subsystems?.recentProbes && options?.runActiveProbes) {
    recentProbes = await runSafeHealthChecks();
    lastProbeResults = structuredClone(recentProbes);
  }

  const overallState = aggregateOverallHealth({
    application: appHealth.state,
    connectivity: connHealth.overall,
    automation: autoHealth.state,
    plugins: pluginHealth.overall,
    environment: envHealth.state,
  });

  const overallSummary =
    overallState === 'HEALTHY'
      ? 'All systems operational and ready'
      : overallState === 'ATTENTION_REQUIRED'
        ? 'Action recommended: refresh connector schema or check plugin status'
        : overallState === 'DEGRADED'
          ? 'One or more subsystems degraded'
          : overallState === 'STARTING'
            ? 'Subsystems starting or settling'
            : overallState === 'UNKNOWN'
              ? 'Essential system health is unknown'
              : 'Operational blocker detected';

  const logs = getLog();
  const recentErrors = logs
    .filter((l) => l.level === 'error' || l.level === 'warn')
    .slice(-10)
    .map((l) => ({
      time: l.time,
      level: l.level,
      message: l.message,
      subsystem: l.agent ?? 'main',
    }));

  for (const plugin of pluginHealth.items) {
    const probeId = plugin.catalogId === 'blender' ? 'probe_blender' : plugin.catalogId === 'playwright' ? 'probe_playwright' : undefined;
    plugin.lastProbeResult = probeId ? recentProbes.find(result => result.id === probeId) : undefined;
  }

  const rawBlockers: string[] = [];

  if (appHealth.blockers) {
    rawBlockers.push(...appHealth.blockers);
  }

  for (const surface of connHealth.surfaces) {
    if (surface.manualRefreshRequired) {
      rawBlockers.push(`${surface.name}: Manual ChatGPT tool refresh required`);
    } else if (surface.refreshState === 'CHATGPT_REFRESH_REQUIRED') {
      rawBlockers.push(`${surface.name}: ChatGPT tool refresh required`);
    }

    if (surface.refreshError) {
      rawBlockers.push(`${surface.name}: ${surface.refreshError}`);
    }

    if (surface.state === 'DEGRADED' || surface.state === 'BLOCKED') {
      if (surface.error) {
        rawBlockers.push(`${surface.name}: ${surface.error}`);
      } else if (!surface.refreshError && surface.connectionState === 'error') {
        rawBlockers.push(`${surface.name}: Connection error`);
      }
    }
  }

  for (const plugin of pluginHealth.items) {
    if (!plugin.installed) continue;

    if (plugin.failureReason) {
      rawBlockers.push(`${plugin.name}: ${plugin.failureReason}`);
    }

    if (plugin.exposureConflict) {
      rawBlockers.push(`${plugin.name}: ${plugin.exposureConflict}`);
    }
  }

  for (const probe of recentProbes) {
    if (probe.state === 'DEGRADED' || probe.state === 'BLOCKED') {
      rawBlockers.push(`${probe.name}: ${probe.summary}`);
    }
  }

  if (envHealth.blockers && (envHealth.state === 'DEGRADED' || envHealth.state === 'BLOCKED')) {
    rawBlockers.push(...envHealth.blockers);
  }

  const seenBlockers = new Set<string>();
  const deduplicatedBlockers: string[] = [];
  for (const item of rawBlockers) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const sanitized = redactSecretText(trimmed).slice(0, 600);
    if (!seenBlockers.has(sanitized)) {
      seenBlockers.add(sanitized);
      deduplicatedBlockers.push(sanitized);
    }
  }
  const blockers = deduplicatedBlockers.slice(0, 20);

  const snapshot: SystemHealthSnapshot = {
    timestamp: now,
    overallState,
    overallSummary,
    application: appHealth,
    connectivity: connHealth,
    automation: autoHealth,
    plugins: pluginHealth,
    environment: envHealth,
    recentProbes,
    recentErrors,
    blockers: blockers.length > 0 ? blockers : undefined,
    actions: [
      ...(appHealth.actions ?? []),
      ...connHealth.surfaces.flatMap((s) => s.actions ?? []),
      ...pluginHealth.items.flatMap((p) => p.actions ?? []),
    ],
  };

  cachedSnapshot = snapshot;
  lastSnapshotTime = now;
  return structuredClone(snapshot);
}

export async function runSystemHealthCheck(options?: {
  probeRunner?: () => Promise<HealthCheckResult[]>;
}): Promise<SystemHealthSnapshot> {
  lastProbeResults = structuredClone(await runSafeHealthChecks({ probeRunner: options?.probeRunner }));
  cachedSnapshot = null;
  lastSnapshotTime = 0;
  return getSystemHealthSnapshot({ runActiveProbes: false, runEnvironmentProbes: true });
}

/**
 * Generates a concise, structured, sanitized diagnostics report for clipboard / export.
 * Strictly redacts all secrets, API keys, tunnel credentials, and conversation text.
 * Bounded to < 30 KB.
 */
export function generateSanitizedDiagnosticsReport(snapshot: SystemHealthSnapshot): string {
  const sanitize = (text: string): string => {
    let out = redactSecretText(text);
    // Extra guard against arbitrary keys, tokens, or paths
    out = out.replace(/\b(?:Bearer\s+|token=)[A-Za-z0-9_-]{16,}\b/gi, '[redacted]');
    out = out.replace(/\b[A-Za-z0-9_-]{32,}\b/g, (match) => {
      // Retain standard UUIDs or hashes in lower case if needed, redact others
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(match)) return match;
      if (/^[0-9a-f]{64}$/i.test(match)) return `${match.slice(0, 12)}...`;
      return '[redacted]';
    });
    return out;
  };

  const lines: string[] = [
    'COS_DIAGNOSTICS',
    `Timestamp: ${new Date(snapshot.timestamp).toISOString()}`,
    `Overall: ${snapshot.overallState} (${sanitize(snapshot.overallSummary)})`,
    '',
    'APP',
    `Product: ${CUSTOM_APP_IDENTITY.productName}`,
    `Version: ${APP_VERSION}`,
    `Isolation: ${path.basename(snapshot.environment.environment.userDataDir)}`,
    ...snapshot.application.evidence.map((e) => `  ${e.label}: ${sanitize(e.value)}`),
    '',
    'CONNECTORS',
    ...snapshot.connectivity.surfaces.map((s) =>
      `  ${s.name} [${s.surface}]: State=${s.connectionState}, Published=${s.published}, Tools=${s.toolCount}, SchemaState=${s.refreshState}`
    ),
    '',
    'PLUGIN_SCHEMA',
    ...snapshot.connectivity.surfaces.map((s) =>
      `  ${s.surface}: schemaId=${s.localSchemaId ? s.localSchemaId.slice(0, 12) : 'none'}, refreshState=${s.refreshState}${s.manualRefreshRequired ? ' [MANUAL_ACTION_REQUIRED]' : ''}`
    ),
    '',
    'PLUGINS',
    ...snapshot.plugins.items.map((p) => {
      let desc = `  ${p.name}: State=${p.state}, Runtime=${p.runtimeStatus}, Tools=${p.toolCount}, Published=${p.published}, SchemaState=${p.connectorRefreshState}`;
      if (p.failureReason) desc += `\n    Failure: ${sanitize(p.failureReason)}`;
      if (p.exposureConflict) desc += `\n    Conflict: ${sanitize(p.exposureConflict)}`;
      if (p.specificMetrics) desc += `\n    Metrics: ${sanitize(JSON.stringify(p.specificMetrics))}`;
      return desc;
    }),
    '',
    'AUTOMATION',
    `  Goal: State=${snapshot.automation.automation.goal.state}, Mode=${snapshot.automation.automation.goal.mode}, Detail=${sanitize(snapshot.automation.automation.goal.detail)}`,
    `  Loop: State=${snapshot.automation.automation.loop.state}, Detail=${sanitize(snapshot.automation.automation.loop.detail)}`,
    `  Bridge: State=${snapshot.automation.automation.bridge.state}, Paired=${snapshot.automation.automation.bridge.paired}, Present=${snapshot.automation.automation.bridge.present}`,
    '',
    'ENVIRONMENT',
    `  Node: ${snapshot.environment.environment.node?.version ?? 'Unknown'}`,
    `  Python: ${!snapshot.environment.environment.python ? 'Unknown / Not checked' : !snapshot.environment.environment.python.available ? 'Not found' : (snapshot.environment.environment.python.version ?? 'Available')}`,
    `  uv: ${!snapshot.environment.environment.uv ? 'Unknown / Not checked' : !snapshot.environment.environment.uv.available ? 'Not found' : `${snapshot.environment.environment.uv.version ?? 'Available'} (managed: ${snapshot.environment.environment.uv.managed ? 'YES' : 'NO'})`}`,
    `  Git: ${!snapshot.environment.environment.git ? 'Unknown / Not checked' : !snapshot.environment.environment.git.available ? 'Not found' : (snapshot.environment.environment.git.version ?? 'Available')}`,
    `  Disk: Free=${snapshot.environment.environment.diskSpace?.freeFormatted ?? 'Unknown'}`,
  ];

  if (snapshot.recentProbes.length > 0) {
    lines.push('', 'RECENT_PROBES');
    for (const probe of snapshot.recentProbes) {
      lines.push(`  ${probe.name}: ${probe.state} (${probe.durationMs}ms) — ${sanitize(probe.summary)}`);
    }
  }

  const blockers = snapshot.blockers ?? [];
  lines.push('', 'BLOCKERS');
  if (blockers.length > 0) {
    for (const b of blockers) lines.push(`  - ${sanitize(b)}`);
  } else {
    lines.push('  none');
  }

  const report = lines.join('\n');
  if (Buffer.byteLength(report, 'utf8') > 30 * 1024) {
    return report.slice(0, 28 * 1024) + '\n... [truncated]';
  }
  return report;
}
