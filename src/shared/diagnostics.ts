/**
 * Shared types and contracts for System Diagnostics / Health Center.
 * The Main process owns health truth; renderer is presentation only.
 */

export type HealthState =
  | 'HEALTHY'
  | 'STARTING'
  | 'ATTENTION_REQUIRED'
  | 'DEGRADED'
  | 'BLOCKED'
  | 'NOT_CONFIGURED'
  | 'NOT_INSTALLED'
  | 'UNKNOWN';

export type ConnectorSchemaState =
  | 'LOCAL_RUNTIME_READY'
  | 'LOCAL_TOOLS_DISCOVERED'
  | 'LOCAL_SCHEMA_PUBLISHED'
  | 'CHATGPT_REFRESH_REQUIRED'
  | 'CHATGPT_REFRESH_PENDING'
  | 'CHATGPT_SCHEMA_CURRENT'
  | 'CHATGPT_SCHEMA_UNKNOWN';

export type AutomationState =
  | 'Available'
  | 'Running'
  | 'Waiting'
  | 'Blocked'
  | 'Idle'
  | 'Unknown';

export interface HealthEvidence {
  label: string;
  value: string;
  status?: 'pass' | 'fail' | 'warn' | 'info' | 'unknown' | 'skipped';
  detail?: string;
}

export type HealthActionType =
  | 'recheck'
  | 'run_probe'
  | 'restart_mcp'
  | 'enable_addon'
  | 'install_addon'
  | 'open_blender'
  | 'refresh_tools'
  | 'open_chatgpt_plugins'
  | 'restart_connector'
  | 'open_logs'
  | 'copy_diagnostics';

export interface HealthAction {
  id: string;
  label: string;
  actionType: HealthActionType;
  surface?: 'core' | 'desktop' | 'plugins';
  pluginId?: string;
  primary?: boolean;
  description?: string;
}

export interface SubsystemHealth {
  id: string;
  name: string;
  state: HealthState;
  summary: string;
  evidence: HealthEvidence[];
  actions?: HealthAction[];
  blockers?: string[];
  details?: Record<string, unknown>;
}

export interface PluginChainStage {
  id: string;
  name: string;
  status: 'pass' | 'fail' | 'warn' | 'unknown' | 'skipped';
  detail?: string;
}

export interface PluginHealthDetail {
  id: string;
  name: string;
  catalogId?: string;
  state: HealthState;
  installed: boolean;
  enabled: boolean;
  runtimeStatus: string;
  mcpConnected: boolean;
  toolCount: number;
  published: boolean;
  exposureConflict?: string;
  connectorRefreshState: ConnectorSchemaState;
  lastProbeResult?: HealthCheckResult;
  failureReason?: string;
  dependencyChain?: PluginChainStage[];
  actions?: HealthAction[];
  specificMetrics?: Record<string, unknown>;
}

export interface ConnectivitySurfaceHealth {
  surface: 'core' | 'desktop' | 'plugins';
  name: string;
  state: HealthState;
  available: boolean;
  connectionState: string;
  tunnelConfigured: boolean;
  tunnelState: string;
  published: boolean;
  localSchemaId?: string;
  toolCount: number;
  refreshState: ConnectorSchemaState;
  manualRefreshRequired: boolean;
  refreshParked: boolean;
  refreshError?: string;
  error?: string;
  connectorAppId?: string | null;
  actions?: HealthAction[];
}

export interface AutomationHealth {
  goal: {
    state: AutomationState;
    mode: string;
    detail: string;
    armed: boolean;
  };
  loop: {
    state: AutomationState;
    detail: string;
  };
  bridge: {
    state: AutomationState;
    running: boolean;
    paired: boolean;
    present: boolean;
    detail: string;
  };
  recovery: {
    state: AutomationState;
    detail: string;
  };
}

export interface EnvironmentHealth {
  node?: { available: boolean; version?: string };
  python?: { available: boolean; version?: string; path?: string };
  uv?: { available: boolean; version?: string; managed: boolean; path?: string };
  git?: { available: boolean; version?: string };
  userDataDir: string;
  pluginsDir: string;
  diskSpace?: { availableBytes?: number; freeFormatted?: string };
}

export interface HealthCheckResult {
  id: string;
  name: string;
  state: HealthState;
  summary: string;
  evidence: HealthEvidence[];
  durationMs: number;
  timestamp: number;
  action?: HealthAction;
}

export interface SystemHealthSnapshot {
  timestamp: number;
  overallState: HealthState;
  overallSummary: string;
  application: SubsystemHealth;
  connectivity: {
    overall: HealthState;
    surfaces: ConnectivitySurfaceHealth[];
  };
  automation: SubsystemHealth & { automation: AutomationHealth };
  plugins: {
    overall: HealthState;
    items: PluginHealthDetail[];
  };
  environment: SubsystemHealth & { environment: EnvironmentHealth };
  recentProbes: HealthCheckResult[];
  recentErrors: Array<{
    time: number;
    level: string;
    message: string;
    subsystem?: string;
  }>;
  blockers?: string[];
  actions: HealthAction[];
}
