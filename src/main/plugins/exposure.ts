import type { Tool } from '@modelcontextprotocol/client';

// Schema bytes are the normal publication bound. Keep the manager's existing
// catalog ceiling only as an emergency guard against pathological catalogs.
export const PLUGIN_MAX_TOOLS = 256;
export const PLUGIN_MAX_SCHEMA_BYTES = 250000;
/**
 * The emergency guard on what one server may declare. It is far above the publication bound: a
 * server with more tools than ChatGPT gets is installed, publishes what fits, and the user switches
 * tools off to choose the rest (#1313). It only stops a catalog no one could manage.
 */
export const PLUGIN_DISCOVERY_MAX_TOOLS = 2048;
export const PLUGIN_DISCOVERY_MAX_BYTES = 8 * 1024 * 1024;

export interface PluginExposureSource {
  id: string;
  name: string;
  enabled: boolean;
  tools: readonly Tool[];
  disabledTools: readonly string[];
}

/** UI identifiers are opaque routing keys, never file paths or fetch targets. */
function advertisedUiUris(tool: Tool): string[] {
  const meta = tool._meta;
  const ui = meta?.ui;
  const candidates = [meta?.['openai/outputTemplate'],
    ui && typeof ui === 'object' && !Array.isArray(ui) ? (ui as Record<string, unknown>).resourceUri : undefined];
  return [...new Set(candidates.filter((value): value is string => {
    if (typeof value !== 'string' || value.length > 8192 || !/^ui:\/\/[^\s\\]+$/.test(value)) return false;
    try {
      const uri = new URL(value);
      return !!uri.hostname && !uri.username && !uri.password && uri.href === value;
    } catch { return false; }
  }))];
}

/** One projection for discovery, UI and call ownership. Upstream names never change. */
export function pluginExposure(sources: readonly PluginExposureSource[]): {
  tools: Tool[];
  owners: Map<string, string>;
  issues: Map<string, Map<string, string>>;
  resourceOwners: Map<string, string>;
  resourceConflicts: Set<string>;
} {
  const claims = new Map<string, PluginExposureSource[]>();
  const issues = new Map<string, Map<string, string>>();
  const issue = (id: string, name: string, reason: string) => {
    let row = issues.get(id);
    if (!row) issues.set(id, row = new Map());
    row.set(name, reason);
  };
  // Disabled integrations still own their retained names: toggling one off must
  // not route a cached call to another integration with the same upstream name.
  // Deliberate uninstall removes its catalog and releases that reservation.
  for (const source of sources) for (const tool of source.tools) {
    const owners = claims.get(tool.name) ?? [];
    owners.push(source);
    claims.set(tool.name, owners);
  }
  for (const [name, owners] of claims) if (owners.length > 1) {
    const names = [...new Set(owners.map(owner => owner.name))].join(', ');
    for (const owner of owners)
      issue(owner.id, name, `Tool "${name}" has conflicting declarations in ${names}; it is not exposed. Remove the duplicate integration to resolve the conflict.`);
  }

  const tools: Tool[] = [];
  const owners = new Map<string, string>();
  let bytes = 0;
  for (const source of sources) {
    if (!source.enabled) continue;
    const disabled = new Set(source.disabledTools);
    for (const tool of source.tools) {
      if (disabled.has(tool.name) || claims.get(tool.name)!.length !== 1) continue;
      const size = Buffer.byteLength(JSON.stringify(tool));
      if (tools.length >= PLUGIN_MAX_TOOLS || bytes + size > PLUGIN_MAX_SCHEMA_BYTES) {
        issue(source.id, tool.name, 'Not exposed because the Plugins connector has reached its tool or schema size limit.');
        continue;
      }
      tools.push(tool);
      owners.set(tool.name, source.id);
      bytes += size;
    }
  }
  // Retained declarations reserve URI claims just as they reserve tool names.
  // Disable/error cannot silently retarget a cached URI to another installation.
  const resourceClaims = new Map<string, Set<string>>();
  for (const source of sources) for (const tool of source.tools) for (const uri of advertisedUiUris(tool)) {
    const claimants = resourceClaims.get(uri) ?? new Set<string>();
    claimants.add(source.id);
    resourceClaims.set(uri, claimants);
  }
  const resourceConflicts = new Set([...resourceClaims].filter(([, claimants]) => claimants.size > 1).map(([uri]) => uri));
  const resourceOwners = new Map<string, string>();
  for (const tool of tools) for (const uri of advertisedUiUris(tool)) {
    if (!resourceConflicts.has(uri)) resourceOwners.set(uri, owners.get(tool.name)!);
  }
  return { tools, owners, issues, resourceOwners, resourceConflicts };
}
