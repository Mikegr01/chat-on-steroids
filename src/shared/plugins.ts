export type PluginSource = {
  kind: 'npm' | 'python' | 'command' | 'remote' | 'mcpb' | 'github';
  package?: string;
  version?: string;
  /** Reviewed exact Python dependency pins, resolved together with the server package. */
  dependencies?: { package: string; version: string }[];
  command?: string;
  args?: string[];
  url?: string;
  /** Remote OAuth is explicit; omitted sources keep their existing static headers. */
  auth?: 'oauth';
  path?: string;
};
export interface PluginConfigPatch {
  config?: Record<string, string>;
  credentials?: Record<string, string>;
  source?: PluginSource;
  name?: string;
}
export interface PluginInstallRequest extends PluginConfigPatch {
  catalogId?: string;
}
export interface PluginField {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
}
export interface PluginCatalogEntry {
  id: string;
  name: string;
  description: string;
  /** Curated capability class used to keep Explore intentional rather than directory-like. */
  category?: string;
  /** Upstream project/vendor responsible for the reviewed integration. */
  maintainer?: string;
  /** Specialist integrations stay opt-in and should not expand the default tool surface. */
  tier?: 'core' | 'specialist';
  icon: string;
  color: string;
  source: PluginSource;
  homepage: string;
  license: string;
  instructions: string[];
  fields: PluginField[];
  /** Representative tool names or documented action labels; live discovery determines actual tools. */
  tools?: string[];
}
export interface PluginToolView {
  name: string;
  exposedName: string;
  description?: string;
  enabled: boolean;
  published?: boolean;
  exposureError?: string;
}

export type BlenderCompatibility = 'SUPPORTED' | 'UNKNOWN' | 'INCOMPATIBLE';

export type BlenderHealthCode =
  | 'BLENDER_NOT_FOUND'
  | 'BLENDER_INCOMPATIBLE'
  | 'ADDON_NOT_INSTALLED'
  | 'ADDON_VERSION_MISMATCH'
  | 'ADDON_DISABLED'
  | 'BLENDER_NOT_RUNNING'
  | 'BLENDER_SERVER_NOT_RUNNING'
  | 'MULTIPLE_INSTANCES_AMBIGUOUS'
  | 'PORT_COLLISION'
  | 'CONNECTING'
  | 'READY'
  | 'ERROR';

export interface DiscoveredBlenderInstallation {
  executablePath: string;
  version: string;
  source: 'installer' | 'steam' | 'registry' | 'path' | 'user' | 'portable';
  exists: boolean;
  compatibility: BlenderCompatibility;
}

export interface BlenderAddonStatus {
  installed: boolean;
  path: string | null;
  version: string | null;
  protocolVersion: number | null;
  isUpToDate: boolean;
  needsUpdate: boolean;
  legacyPaths: string[];
  canonicalInstalled: boolean;
  legacyInstalled: boolean;
  needsMigration: boolean;
}

export interface BlenderHealthReport {
  code: BlenderHealthCode;
  status: 'ready' | 'connecting' | 'error' | 'installed';
  message: string;
  diagnostic: string;
  actionRequired?: string;
  installation?: DiscoveredBlenderInstallation;
  addon?: BlenderAddonStatus;
  server?: {
    port: number;
    listening: boolean;
    owningPid?: number;
    targetInstancePid?: number;
    allBlenderPids?: number[];
  };
}

export interface BlenderAddonInstallResult {
  success: boolean;
  message: string;
  targetPath?: string;
  addonsDir?: string;
  backupPath?: string;
  error?: string;
}

export interface BlenderAddonEnableResult {
  success: boolean;
  message: string;
  enabled: boolean;
}

export interface PluginView {
  id: string;
  name: string;
  catalogId?: string;
  source: PluginSource;
  config: Record<string, string>;
  credentialKeys: string[];
  fields?: PluginField[];
  version: string;
  license: string;
  homepage?: string;
  enabled: boolean;
  status: 'installed' | 'connecting' | 'ready' | 'disabled' | 'error' | 'needs-auth' | 'authenticating';
  error?: string;
  tools: PluginToolView[];
  installedAt: number;
  blender?: BlenderHealthReport;
}
export interface PluginSnapshot {
  plugins: PluginView[];
  catalog: PluginCatalogEntry[];
  schemaRevision: number;
}
