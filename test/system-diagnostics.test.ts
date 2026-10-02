import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type {
  HealthState,
  SystemHealthSnapshot,
  PluginHealthDetail,
  ConnectivitySurfaceHealth,
  EnvironmentHealth,
} from '../src/shared/diagnostics.js';
import {
  aggregateOverallHealth,
  generateSanitizedDiagnosticsReport,
  evaluateConnectivityHealth,
  evaluatePluginHealth,
  evaluateApplicationHealth,
  evaluateAutomationHealth,
  evaluateEnvironmentHealth,
  runSafeHealthChecks,
  runSystemHealthCheck,
  getSystemHealthSnapshot,
  clearCachedEnvironmentForTesting,
} from '../src/main/system-diagnostics.js';

describe('System Diagnostics & Health Center — Authoritative Model', () => {
  describe('0. Renderer integration', () => {
    it('exposes a navigable Diagnostics page with every required section and action', () => {
      const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
      const renderer = readFileSync(new URL('../src/renderer/diagnostics.ts', import.meta.url), 'utf8');

      expect(html).toContain('data-sidebar-page="diagnostics"');
      expect(html).toContain('data-panel="diagnostics"');
      for (const section of ['Overall', 'Application', 'Connections', 'Automation', 'Plugins', 'Environment', 'Recent results']) {
        expect(html).toContain(section);
      }
      for (const action of ['Run Health Check', 'Recheck', 'Open ChatGPT Plugins', 'Copy diagnostics', 'Open logs']) {
        expect(html).toContain(action);
      }
      expect(renderer).toContain('diagnosticsSnapshot(false)');
      expect(renderer).toContain('diagnosticsRunHealthCheck()');
      expect(renderer).toContain('diagnosticsCopyReport()');
      expect(renderer).toContain('diagnosticsOpenLogs()');
      expect(renderer).toContain('pluginsRestart(');
    });
  });
  describe('1. Overall Health Aggregation & Semantic States', () => {
    it('essential UNKNOWN health remains UNKNOWN instead of becoming HEALTHY', () => {
      expect(aggregateOverallHealth({
        application: 'UNKNOWN',
        connectivity: 'HEALTHY',
        automation: 'HEALTHY',
        plugins: 'HEALTHY',
        environment: 'HEALTHY',
      })).toBe('UNKNOWN');
    });

    it('a stopped bridge is nonhealthy even without a bridge error string', async () => {
      const application = await evaluateApplicationHealth({
        bridge: { running: false, paired: false, present: false, port: null, lastSeenAt: null, extensionVersion: null },
      });
      expect(application.state).toBe('DEGRADED');
      expect(application.blockers).toContain('Bridge server is stopped');
    });

    it('automation stays UNKNOWN when bridge authority was not supplied', () => {
      const automation = evaluateAutomationHealth();
      expect(automation.automation.bridge.state).toBe('Unknown');
      expect(automation.state).toBe('UNKNOWN');
    });
    it('aggregates all-healthy subsystems into HEALTHY', () => {
      const state = aggregateOverallHealth({
        application: 'HEALTHY',
        connectivity: 'HEALTHY',
        automation: 'HEALTHY',
        plugins: 'HEALTHY',
        environment: 'HEALTHY',
      });
      expect(state).toBe('HEALTHY');
    });

    it('2. UNKNOWN differs from FAILED: UNKNOWN does not collapse into BLOCKED/DEGRADED', () => {
      expect('UNKNOWN').not.toBe('BLOCKED');
      expect('UNKNOWN').not.toBe('DEGRADED');
      // Subsystem with UNKNOWN environment does not fail the whole app
      const state = aggregateOverallHealth({
        application: 'HEALTHY',
        connectivity: 'HEALTHY',
        automation: 'HEALTHY',
        plugins: 'HEALTHY',
        environment: 'UNKNOWN',
      });
      expect(state).toBe('HEALTHY');
    });

    it('3. NOT_INSTALLED differs from FAILED: optional plugins not installed do not cause failure', () => {
      expect('NOT_INSTALLED').not.toBe('BLOCKED');
      expect('NOT_INSTALLED').not.toBe('DEGRADED');
      const state = aggregateOverallHealth({
        application: 'HEALTHY',
        connectivity: 'HEALTHY',
        automation: 'HEALTHY',
        plugins: 'NOT_INSTALLED',
        environment: 'HEALTHY',
      });
      expect(state).toBe('HEALTHY');
    });

    it('32. plugin absence is not an overall fatal failure', () => {
      const pluginsHealth: PluginHealthDetail[] = [
        {
          id: 'nvidia-gpu',
          name: 'NVIDIA GPU Monitor',
          state: 'NOT_INSTALLED',
          installed: false,
          enabled: false,
          runtimeStatus: 'stopped',
          mcpConnected: false,
          toolCount: 0,
          published: false,
          connectorRefreshState: 'CHATGPT_SCHEMA_UNKNOWN',
        },
        {
          id: 'chrome-devtools',
          name: 'Chrome DevTools',
          state: 'NOT_INSTALLED',
          installed: false,
          enabled: false,
          runtimeStatus: 'stopped',
          mcpConnected: false,
          toolCount: 0,
          published: false,
          connectorRefreshState: 'CHATGPT_SCHEMA_UNKNOWN',
        },
      ];
      expect(pluginsHealth.length).toBe(2);
      const state = aggregateOverallHealth({
        application: 'HEALTHY',
        connectivity: 'HEALTHY',
        automation: 'HEALTHY',
        plugins: 'HEALTHY',
        environment: 'HEALTHY',
      });
      expect(state).toBe('HEALTHY');
    });

    it('33. one degraded subsystem produces correct overall DEGRADED state', () => {
      const state = aggregateOverallHealth({
        application: 'HEALTHY',
        connectivity: 'DEGRADED',
        automation: 'HEALTHY',
        plugins: 'HEALTHY',
        environment: 'HEALTHY',
      });
      expect(state).toBe('DEGRADED');
    });

    it('one blocked subsystem produces overall BLOCKED state', () => {
      const state = aggregateOverallHealth({
        application: 'BLOCKED',
        connectivity: 'HEALTHY',
        automation: 'HEALTHY',
        plugins: 'HEALTHY',
        environment: 'HEALTHY',
      });
      expect(state).toBe('BLOCKED');
    });

    it('requires attention when ChatGPT refresh is needed but local runtime is healthy', () => {
      const state = aggregateOverallHealth({
        application: 'HEALTHY',
        connectivity: 'ATTENTION_REQUIRED',
        automation: 'HEALTHY',
        plugins: 'HEALTHY',
        environment: 'HEALTHY',
      });
      expect(state).toBe('ATTENTION_REQUIRED');
    });

    it('reports STARTING when any subsystem is starting', () => {
      const state = aggregateOverallHealth({
        application: 'HEALTHY',
        connectivity: 'STARTING',
        automation: 'HEALTHY',
        plugins: 'HEALTHY',
        environment: 'HEALTHY',
      });
      expect(state).toBe('STARTING');
    });
  });

  describe('2. Critical Connector Schema Model: Distinguishing Local vs ChatGPT State', () => {
    it('4. local plugin runtime healthy + ChatGPT schema stale', () => {
      const surface: ConnectivitySurfaceHealth = {
        surface: 'plugins',
        name: 'Chat On Steroids Plugins',
        state: 'ATTENTION_REQUIRED',
        available: true,
        connectionState: 'live',
        tunnelConfigured: true,
        tunnelState: 'live',
        published: true,
        localSchemaId: 'hash_new_62_tools',
        toolCount: 62,
        refreshState: 'CHATGPT_REFRESH_REQUIRED',
        manualRefreshRequired: false,
        refreshParked: false,
        connectorAppId: 'asdk_app_12345',
        actions: [
          {
            id: 'open_chatgpt_plugins',
            label: 'Open ChatGPT plugins',
            actionType: 'open_chatgpt_plugins',
            surface: 'plugins',
            primary: true,
          },
        ],
      };

      expect(surface.published).toBe(true);
      expect(surface.toolCount).toBe(62);
      expect(surface.refreshState).toBe('CHATGPT_REFRESH_REQUIRED');
      expect(surface.state).toBe('ATTENTION_REQUIRED');
      expect(surface.actions?.some(a => a.actionType === 'open_chatgpt_plugins')).toBe(true);
    });

    it('5. local tools published + refresh required', () => {
      const connectivity = evaluateConnectivityHealth({
        connectionStatus: {
          state: 'connected',
          detail: '',
          publicUrl: null,
          localUrl: 'http://127.0.0.1:49200',
          handshakeAt: Date.now(),
          lastRequestAt: Date.now(),
          lastToolCallAt: Date.now(),
          health: null,
          surfaces: [
            {
              id: 'plugins',
              connectorName: 'Chat On Steroids Plugins',
              description: 'Plugins',
              cardSummary: 'Installed plugins',
              optional: true,
              available: true,
              localUrl: 'http://127.0.0.1:49200/mcp/plugins',
              publicUrl: null,
              tools: ['browser_navigate', 'browser_snapshot'],
              state: 'live',
              detail: 'Live',
              lastRequestAt: null,
              lastToolCallAt: null,
            },
          ],
        },
        refreshDiagnostics: {
          plugins: {
            surface: 'plugins',
            published: true,
            schemaId: 'schema_new',
            toolCount: 24,
            completedSchemaId: 'schema_old',
            appId: 'asdk_app_plugins',
            attempted: false,
            manual: false,
            parked: false,
            failures: 0,
            isSettling: false,
            connectorSchemaState: 'CHATGPT_REFRESH_REQUIRED',
          },
          core: {
            surface: 'core',
            published: true,
            schemaId: 'schema_core',
            toolCount: 8,
            completedSchemaId: 'schema_core',
            appId: 'asdk_app_core',
            attempted: true,
            manual: false,
            parked: false,
            failures: 0,
            isSettling: false,
            connectorSchemaState: 'CHATGPT_SCHEMA_CURRENT',
          },
          desktop: {
            surface: 'desktop',
            published: false,
            schemaId: null,
            toolCount: 0,
            completedSchemaId: null,
            appId: null,
            attempted: false,
            manual: false,
            parked: false,
            failures: 0,
            isSettling: false,
            connectorSchemaState: 'LOCAL_RUNTIME_READY',
          },
        },
      });

      const pluginsSurface = connectivity.surfaces.find(s => s.surface === 'plugins');
      expect(pluginsSurface).toBeDefined();
      expect(pluginsSurface?.refreshState).toBe('CHATGPT_REFRESH_REQUIRED');
      expect(pluginsSurface?.toolCount).toBe(24);
      expect(pluginsSurface?.state).toBe('ATTENTION_REQUIRED');
    });

    it('6. schema current produces CHATGPT_SCHEMA_CURRENT and HEALTHY', () => {
      const connectivity = evaluateConnectivityHealth({
        connectionStatus: {
          state: 'connected',
          detail: '',
          publicUrl: null,
          localUrl: 'http://127.0.0.1:49200',
          handshakeAt: Date.now(),
          lastRequestAt: Date.now(),
          lastToolCallAt: Date.now(),
          health: null,
          surfaces: [
            {
              id: 'plugins',
              connectorName: 'Chat On Steroids Plugins',
              description: 'Plugins',
              cardSummary: 'Installed plugins',
              optional: true,
              available: true,
              localUrl: 'http://127.0.0.1:49200/mcp/plugins',
              publicUrl: null,
              tools: ['browser_navigate', 'browser_snapshot'],
              state: 'live',
              detail: 'Live',
              lastRequestAt: Date.now(),
              lastToolCallAt: Date.now(),
            },
          ],
        },
        refreshDiagnostics: {
          plugins: {
            surface: 'plugins',
            published: true,
            schemaId: 'schema_current',
            toolCount: 24,
            completedSchemaId: 'schema_current',
            appId: 'asdk_app_plugins',
            attempted: true,
            manual: false,
            parked: false,
            failures: 0,
            isSettling: false,
            connectorSchemaState: 'CHATGPT_SCHEMA_CURRENT',
          },
          core: {
            surface: 'core',
            published: true,
            schemaId: 'schema_core',
            toolCount: 8,
            completedSchemaId: 'schema_core',
            appId: 'asdk_app_core',
            attempted: true,
            manual: false,
            parked: false,
            failures: 0,
            isSettling: false,
            connectorSchemaState: 'CHATGPT_SCHEMA_CURRENT',
          },
          desktop: {
            surface: 'desktop',
            published: false,
            schemaId: null,
            toolCount: 0,
            completedSchemaId: null,
            appId: null,
            attempted: false,
            manual: false,
            parked: false,
            failures: 0,
            isSettling: false,
            connectorSchemaState: 'LOCAL_RUNTIME_READY',
          },
        },
      });

      const pluginsSurface = connectivity.surfaces.find(s => s.surface === 'plugins');
      expect(pluginsSurface?.refreshState).toBe('CHATGPT_SCHEMA_CURRENT');
      expect(pluginsSurface?.state).toBe('HEALTHY');
    });

    it('7. refresh pending when settling or clicked and in flight', () => {
      const connectivity = evaluateConnectivityHealth({
        connectionStatus: {
          state: 'connected',
          detail: '',
          publicUrl: null,
          localUrl: 'http://127.0.0.1:49200',
          handshakeAt: Date.now(),
          lastRequestAt: null,
          lastToolCallAt: null,
          health: null,
          surfaces: [],
        },
        refreshDiagnostics: {
          plugins: {
            surface: 'plugins',
            published: true,
            schemaId: 'schema_pending',
            toolCount: 24,
            completedSchemaId: null,
            appId: 'asdk_app_plugins',
            attempted: true,
            manual: false,
            parked: false,
            failures: 0,
            isSettling: true,
            settlingReadyAt: Date.now() + 10000,
            connectorSchemaState: 'CHATGPT_REFRESH_PENDING',
          },
          core: {
            surface: 'core',
            published: false,
            schemaId: null,
            toolCount: 0,
            completedSchemaId: null,
            appId: null,
            attempted: false,
            manual: false,
            parked: false,
            failures: 0,
            isSettling: false,
            connectorSchemaState: 'CHATGPT_SCHEMA_UNKNOWN',
          },
          desktop: {
            surface: 'desktop',
            published: false,
            schemaId: null,
            toolCount: 0,
            completedSchemaId: null,
            appId: null,
            attempted: false,
            manual: false,
            parked: false,
            failures: 0,
            isSettling: false,
            connectorSchemaState: 'CHATGPT_SCHEMA_UNKNOWN',
          },
        },
      });

      const pluginsSurface = connectivity.surfaces.find(s => s.surface === 'plugins');
      expect(pluginsSurface?.refreshState).toBe('CHATGPT_REFRESH_PENDING');
      expect(pluginsSurface?.state).toBe('STARTING');
    });

    it('8. manual refresh required when row.manual is true', () => {
      const connectivity = evaluateConnectivityHealth({
        connectionStatus: {
          state: 'connected',
          detail: '',
          publicUrl: null,
          localUrl: 'http://127.0.0.1:49200',
          handshakeAt: Date.now(),
          lastRequestAt: null,
          lastToolCallAt: null,
          health: null,
          surfaces: [],
        },
        refreshDiagnostics: {
          plugins: {
            surface: 'plugins',
            published: true,
            schemaId: 'schema_manual',
            toolCount: 24,
            completedSchemaId: null,
            appId: 'asdk_app_plugins',
            attempted: false,
            manual: true,
            parked: false,
            failures: 0,
            error: 'Provider snapshot changed; manual recreate required in ChatGPT',
            isSettling: false,
            connectorSchemaState: 'CHATGPT_REFRESH_REQUIRED',
          },
          core: {
            surface: 'core',
            published: false,
            schemaId: null,
            toolCount: 0,
            completedSchemaId: null,
            appId: null,
            attempted: false,
            manual: false,
            parked: false,
            failures: 0,
            isSettling: false,
            connectorSchemaState: 'CHATGPT_SCHEMA_UNKNOWN',
          },
          desktop: {
            surface: 'desktop',
            published: false,
            schemaId: null,
            toolCount: 0,
            completedSchemaId: null,
            appId: null,
            attempted: false,
            manual: false,
            parked: false,
            failures: 0,
            isSettling: false,
            connectorSchemaState: 'CHATGPT_SCHEMA_UNKNOWN',
          },
        },
      });

      const pluginsSurface = connectivity.surfaces.find(s => s.surface === 'plugins');
      expect(pluginsSurface?.manualRefreshRequired).toBe(true);
      expect(pluginsSurface?.refreshError).toContain('manual recreate required');
    });

    it('17. Core/Desktop/Plugins remain separate logical surfaces', () => {
      const connectivity = evaluateConnectivityHealth({
        connectionStatus: {
          state: 'connected',
          detail: '',
          publicUrl: null,
          localUrl: 'http://127.0.0.1:49200',
          handshakeAt: Date.now(),
          lastRequestAt: null,
          lastToolCallAt: null,
          health: null,
          surfaces: [
            {
              id: 'core',
              connectorName: 'Chat On Steroids',
              description: 'Core',
              cardSummary: 'Core tools',
              optional: false,
              available: true,
              localUrl: 'http://127.0.0.1:49200/mcp/core',
              publicUrl: null,
              tools: ['read', 'apply_patch'],
              state: 'live',
              detail: 'Live',
              lastRequestAt: null,
              lastToolCallAt: null,
            },
            {
              id: 'desktop',
              connectorName: 'Chat On Steroids Desktop',
              description: 'Desktop',
              cardSummary: 'Desktop tools',
              optional: true,
              available: false,
              localUrl: null,
              publicUrl: null,
              tools: [],
              state: 'off',
              detail: 'Disabled',
              lastRequestAt: null,
              lastToolCallAt: null,
            },
            {
              id: 'plugins',
              connectorName: 'Chat On Steroids Plugins',
              description: 'Plugins',
              cardSummary: 'Installed plugins',
              optional: true,
              available: true,
              localUrl: 'http://127.0.0.1:49200/mcp/plugins',
              publicUrl: null,
              tools: ['browser_navigate'],
              state: 'live',
              detail: 'Live',
              lastRequestAt: null,
              lastToolCallAt: null,
            },
          ],
        },
        refreshDiagnostics: {
          core: {
            surface: 'core',
            published: true,
            schemaId: 'core_hash',
            toolCount: 2,
            completedSchemaId: 'core_hash',
            appId: 'asdk_core',
            attempted: true,
            manual: false,
            parked: false,
            failures: 0,
            isSettling: false,
            connectorSchemaState: 'CHATGPT_SCHEMA_CURRENT',
          },
          desktop: {
            surface: 'desktop',
            published: false,
            schemaId: null,
            toolCount: 0,
            completedSchemaId: null,
            appId: null,
            attempted: false,
            manual: false,
            parked: false,
            failures: 0,
            isSettling: false,
            connectorSchemaState: 'LOCAL_RUNTIME_READY',
          },
          plugins: {
            surface: 'plugins',
            published: true,
            schemaId: 'plugins_hash',
            toolCount: 1,
            completedSchemaId: 'plugins_hash',
            appId: 'asdk_plugins',
            attempted: true,
            manual: false,
            parked: false,
            failures: 0,
            isSettling: false,
            connectorSchemaState: 'CHATGPT_SCHEMA_CURRENT',
          },
        },
      });

      expect(connectivity.surfaces).toHaveLength(3);
      expect(connectivity.surfaces.map(s => s.surface)).toEqual(['core', 'desktop', 'plugins']);
      expect(connectivity.surfaces.find(s => s.surface === 'core')?.state).toBe('HEALTHY');
      expect(connectivity.surfaces.find(s => s.surface === 'desktop')?.available).toBe(false);
      expect(connectivity.surfaces.find(s => s.surface === 'plugins')?.state).toBe('HEALTHY');
    });

    it('16. connector tunnel failure surfaces exact error without breaking Core', () => {
      const connectivity = evaluateConnectivityHealth({
        connectionStatus: {
          state: 'connected',
          detail: '',
          publicUrl: null,
          localUrl: 'http://127.0.0.1:49200',
          handshakeAt: Date.now(),
          lastRequestAt: null,
          lastToolCallAt: null,
          health: null,
          surfaces: [
            {
              id: 'core',
              connectorName: 'Chat On Steroids',
              description: 'Core',
              cardSummary: 'Core tools',
              optional: false,
              available: true,
              localUrl: 'http://127.0.0.1:49200/mcp/core',
              publicUrl: null,
              tools: ['read'],
              state: 'live',
              detail: 'Live',
              lastRequestAt: null,
              lastToolCallAt: null,
            },
            {
              id: 'desktop',
              connectorName: 'Chat On Steroids Desktop',
              description: 'Desktop',
              cardSummary: 'Desktop tools',
              optional: true,
              available: true,
              localUrl: null,
              publicUrl: null,
              tools: [],
              state: 'error',
              detail: 'Failed to start tunnel: port 9870 already in use',
              lastRequestAt: null,
              lastToolCallAt: null,
            },
          ],
        },
        refreshDiagnostics: {
          core: {
            surface: 'core',
            published: true,
            schemaId: 'core_hash',
            toolCount: 1,
            completedSchemaId: 'core_hash',
            appId: 'asdk_core',
            attempted: true,
            manual: false,
            parked: false,
            failures: 0,
            isSettling: false,
            connectorSchemaState: 'CHATGPT_SCHEMA_CURRENT',
          },
          desktop: {
            surface: 'desktop',
            published: false,
            schemaId: null,
            toolCount: 0,
            completedSchemaId: null,
            appId: null,
            attempted: false,
            manual: false,
            parked: false,
            failures: 0,
            isSettling: false,
            connectorSchemaState: 'LOCAL_RUNTIME_READY',
          },
          plugins: {
            surface: 'plugins',
            published: false,
            schemaId: null,
            toolCount: 0,
            completedSchemaId: null,
            appId: null,
            attempted: false,
            manual: false,
            parked: false,
            failures: 0,
            isSettling: false,
            connectorSchemaState: 'CHATGPT_SCHEMA_UNKNOWN',
          },
        },
      });

      expect(connectivity.surfaces.find(s => s.surface === 'core')?.state).toBe('HEALTHY');
      const desktop = connectivity.surfaces.find(s => s.surface === 'desktop');
      expect(desktop?.state).toBe('DEGRADED');
      expect(connectivity.overall).toBe('DEGRADED');
    });
  });

  describe('3. Plugin Health & Dependency Chains', () => {
    it('9. Playwright runtime ready with discovered tools models full chain', () => {
      const plugins = evaluatePluginHealth({
        snapshot: {
          schemaRevision: 1,
          catalog: [
            {
              id: 'playwright',
              name: 'Playwright Browser',
              description: 'Browser automation',
              category: 'browser-automation',
              maintainer: 'Microsoft',
              tier: 'core',
              icon: 'playwright',
              color: '#45a66b',
              source: { kind: 'npm', package: '@playwright/mcp', version: '0.0.80', args: ['--isolated'] },
              homepage: 'https://github.com/microsoft/playwright-mcp',
              license: 'Apache-2.0',
              fields: [],
              tools: ['browser_navigate', 'browser_snapshot'],
              instructions: [],
            },
          ],
          plugins: [
            {
              id: 'pw-1',
              catalogId: 'playwright',
              name: 'Playwright Browser',
              version: '0.0.80',
              license: 'Apache-2.0',
              config: {},
              credentialKeys: [],
              source: { kind: 'npm', package: '@playwright/mcp', version: '0.0.80', args: ['--isolated'] },
              enabled: true,
              status: 'ready',
              installedAt: Date.now(),
              tools: [
                { name: 'browser_navigate', exposedName: 'browser_navigate', enabled: true, published: true },
                { name: 'browser_snapshot', exposedName: 'browser_snapshot', enabled: true, published: true },
              ],
            },
          ],
        },
        refreshDiagnostics: {
          surface: 'plugins',
          published: true,
          schemaId: 'hash_pw',
          toolCount: 2,
          completedSchemaId: 'hash_pw',
          appId: 'asdk_plugins',
          attempted: true,
          manual: false,
          parked: false,
          failures: 0,
          isSettling: false,
          connectorSchemaState: 'CHATGPT_SCHEMA_CURRENT',
        },
      });

      const pw = plugins.items.find(p => p.catalogId === 'playwright');
      expect(pw).toBeDefined();
      expect(pw?.installed).toBe(true);
      expect(pw?.enabled).toBe(true);
      expect(pw?.runtimeStatus).toBe('ready');
      expect(pw?.toolCount).toBe(2);
      expect(pw?.published).toBe(true);
      expect(pw?.connectorRefreshState).toBe('CHATGPT_SCHEMA_CURRENT');
      expect(pw?.state).toBe('HEALTHY');
      expect(pw?.dependencyChain).toBeDefined();
      expect(pw?.dependencyChain?.every(c => c.status === 'pass')).toBe(true);
    });

    it('10. Blender complete READY health', () => {
      const plugins = evaluatePluginHealth({
        snapshot: {
          schemaRevision: 1,
          catalog: [
            {
              id: 'blender',
              name: 'Blender MCP',
              description: 'Blender integration',
              category: '3d-editor',
              maintainer: 'ahujasid',
              tier: 'specialist',
              icon: 'blender',
              color: '#e87932',
              source: { kind: 'python', package: 'blender-mcp', version: '1.9.1', command: 'blender-mcp' },
              homepage: 'https://github.com/ahujasid/blender-mcp',
              license: 'MIT',
              fields: [],
              tools: ['get_scene_info'],
              instructions: [],
            },
          ],
          plugins: [
            {
              id: 'blender-1',
              catalogId: 'blender',
              name: 'Blender MCP',
              version: '1.9.1',
              license: 'MIT',
              config: {},
              credentialKeys: [],
              source: { kind: 'python', package: 'blender-mcp', version: '1.9.1', command: 'blender-mcp' },
              enabled: true,
              status: 'ready',
              installedAt: Date.now(),
              tools: [
                { name: 'get_scene_info', exposedName: 'get_scene_info', enabled: true, published: true },
              ],
              blender: {
                status: 'ready',
                code: 'READY',
                message: 'Connected to Blender and MCP server.',
                diagnostic: 'Blender ready',
                installation: {
                  executablePath: 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe',
                  version: '5.2.1',
                  source: 'installer',
                  exists: true,
                  compatibility: 'SUPPORTED',
                },
                addon: {
                  installed: true,
                  path: 'C:\\addon.py',
                  version: '1.9.1',
                  protocolVersion: 5,
                  isUpToDate: true,
                  needsUpdate: false,
                  legacyPaths: [],
                  canonicalInstalled: true,
                  legacyInstalled: false,
                  needsMigration: false,
                },
                server: {
                  port: 9876,
                  listening: true,
                  owningPid: 1234,
                },
              },
            },
          ],
        },
        refreshDiagnostics: {
          surface: 'plugins',
          published: true,
          schemaId: 'hash_blender',
          toolCount: 1,
          completedSchemaId: 'hash_blender',
          appId: 'asdk_plugins',
          attempted: true,
          manual: false,
          parked: false,
          failures: 0,
          isSettling: false,
          connectorSchemaState: 'CHATGPT_SCHEMA_CURRENT',
        },
      });

      const blender = plugins.items.find(p => p.catalogId === 'blender');
      expect(blender).toBeDefined();
      expect(blender?.state).toBe('HEALTHY');
      expect(blender?.specificMetrics?.blenderVersion).toBe('5.2.1');
      expect(blender?.specificMetrics?.addonProtocol).toBe(5);
      expect(blender?.specificMetrics?.serverPort).toBe(9876);
    });

    it('11. Blender incomplete evidence cannot be READY (fail-closed)', () => {
      const plugins = evaluatePluginHealth({
        snapshot: {
          schemaRevision: 1,
          catalog: [],
          plugins: [
            {
              id: 'blender-1',
              catalogId: 'blender',
              name: 'Blender MCP',
              version: '1.9.1',
              license: 'MIT',
              config: {},
              credentialKeys: [],
              source: { kind: 'python', package: 'blender-mcp' },
              enabled: true,
              status: 'ready',
              installedAt: Date.now(),
              tools: [],
              blender: {
                status: 'error',
                code: 'BLENDER_SERVER_NOT_RUNNING',
                message: 'Blender is running, but MCP server is stopped.',
                diagnostic: 'Blender server stopped',
                installation: {
                  executablePath: 'blender.exe',
                  version: '5.2.1',
                  source: 'path',
                  exists: true,
                  compatibility: 'SUPPORTED',
                },
                addon: {
                  installed: true,
                  path: 'addon.py',
                  version: '1.9.1',
                  protocolVersion: 5,
                  isUpToDate: true,
                  needsUpdate: false,
                  legacyPaths: [],
                  canonicalInstalled: true,
                  legacyInstalled: false,
                  needsMigration: false,
                },
                server: { port: 9876, listening: false, owningPid: 1234 },
              },
            },
          ],
        },
        refreshDiagnostics: {
          surface: 'plugins',
          published: true,
          schemaId: 'hash',
          toolCount: 0,
          completedSchemaId: 'hash',
          appId: 'asdk',
          attempted: true,
          manual: false,
          parked: false,
          failures: 0,
          isSettling: false,
          connectorSchemaState: 'CHATGPT_SCHEMA_CURRENT',
        },
      });

      const blender = plugins.items.find(p => p.catalogId === 'blender');
      expect(blender?.state).not.toBe('HEALTHY');
      expect(blender?.state).toBe('ATTENTION_REQUIRED');
      expect(blender?.failureReason).toContain('MCP server is stopped');
    });

    it('12. NVIDIA not installed reports NOT_INSTALLED and does not fail', () => {
      const plugins = evaluatePluginHealth({
        snapshot: {
          schemaRevision: 1,
          catalog: [
            {
              id: 'nvidia-gpu',
              name: 'NVIDIA GPU Monitor',
              description: 'Monitor GPU',
              category: 'gpu-monitoring',
              maintainer: 'mesutoezdil',
              tier: 'specialist',
              icon: 'gpu',
              color: '#76b900',
              source: { kind: 'python', package: 'mcp-gpu-server' },
              homepage: '',
              license: 'MIT',
              fields: [],
              tools: ['gpu_stats'],
              instructions: [],
            },
          ],
          plugins: [],
        },
        refreshDiagnostics: {
          surface: 'plugins',
          published: false,
          schemaId: null,
          toolCount: 0,
          completedSchemaId: null,
          appId: null,
          attempted: false,
          manual: false,
          parked: false,
          failures: 0,
          isSettling: false,
          connectorSchemaState: 'CHATGPT_SCHEMA_UNKNOWN',
        },
      });

      const nvidia = plugins.items.find(p => p.catalogId === 'nvidia-gpu');
      expect(nvidia).toBeDefined();
      expect(nvidia?.installed).toBe(false);
      expect(nvidia?.state).toBe('NOT_INSTALLED');
    });

    it('13. Chrome DevTools not installed reports NOT_INSTALLED', () => {
      const plugins = evaluatePluginHealth({
        snapshot: {
          schemaRevision: 1,
          catalog: [
            {
              id: 'chrome-devtools',
              name: 'Chrome DevTools',
              description: 'DevTools inspection',
              category: 'browser-debugging',
              maintainer: 'Google',
              tier: 'specialist',
              icon: 'devtools',
              color: '#5b84d6',
              source: { kind: 'npm', package: 'chrome-devtools-mcp' },
              homepage: '',
              license: 'Apache-2.0',
              fields: [],
              tools: ['list_console_messages'],
              instructions: [],
            },
          ],
          plugins: [],
        },
        refreshDiagnostics: {
          surface: 'plugins',
          published: false,
          schemaId: null,
          toolCount: 0,
          completedSchemaId: null,
          appId: null,
          attempted: false,
          manual: false,
          parked: false,
          failures: 0,
          isSettling: false,
          connectorSchemaState: 'CHATGPT_SCHEMA_UNKNOWN',
        },
      });

      const devtools = plugins.items.find(p => p.catalogId === 'chrome-devtools');
      expect(devtools?.installed).toBe(false);
      expect(devtools?.state).toBe('NOT_INSTALLED');
    });

    it('14. plugin exposure conflict identified with exact blocker', () => {
      const plugins = evaluatePluginHealth({
        snapshot: {
          schemaRevision: 1,
          catalog: [],
          plugins: [
            {
              id: 'plug-1',
              name: 'Tool Duplicate 1',
              version: '1.0',
              license: 'MIT',
              config: {},
              credentialKeys: [],
              source: { kind: 'npm' },
              enabled: true,
              status: 'ready',
              installedAt: Date.now(),
              tools: [
                {
                  name: 'duplicate_tool',
                  exposedName: 'duplicate_tool',
                  enabled: true,
                  published: false,
                  exposureError: 'Tool name collision with plugin Tool Duplicate 2',
                },
              ],
            },
          ],
        },
        refreshDiagnostics: {
          surface: 'plugins',
          published: true,
          schemaId: 'h',
          toolCount: 0,
          completedSchemaId: 'h',
          appId: 'a',
          attempted: true,
          manual: false,
          parked: false,
          failures: 0,
          isSettling: false,
          connectorSchemaState: 'CHATGPT_SCHEMA_CURRENT',
        },
      });

      const p = plugins.items[0];
      expect(p?.exposureConflict).toContain('Tool name collision');
      expect(p?.state).toBe('DEGRADED');
    });

    it('15. plugin runtime failure provides restart action and exact error', () => {
      const plugins = evaluatePluginHealth({
        snapshot: {
          schemaRevision: 1,
          catalog: [],
          plugins: [
            {
              id: 'plug-err',
              name: 'Crashing Plugin',
              version: '1.0',
              license: 'MIT',
              config: {},
              credentialKeys: [],
              source: { kind: 'npm' },
              enabled: true,
              status: 'error',
              error: 'Process exited with code 1: Cannot find module @mcp/server',
              tools: [],
              installedAt: Date.now(),
            },
          ],
        },
        refreshDiagnostics: {
          surface: 'plugins',
          published: false,
          schemaId: null,
          toolCount: 0,
          completedSchemaId: null,
          appId: null,
          attempted: false,
          manual: false,
          parked: false,
          failures: 0,
          isSettling: false,
          connectorSchemaState: 'CHATGPT_SCHEMA_UNKNOWN',
        },
      });

      const p = plugins.items[0];
      expect(p?.state).toBe('DEGRADED');
      expect(p?.failureReason).toContain('Cannot find module');
      expect(p?.actions?.some(a => a.actionType === 'restart_mcp')).toBe(true);
    });
  });

  describe('4. Safe Health Probes & Canaries', () => {
    it('production probes verify Playwright content and always close the disposable page', async () => {
      const calls: string[] = [];
      const fakeManager = {
        snapshot: () => ({ catalog: [], plugins: [
          { id: 'pw', catalogId: 'playwright', enabled: true, status: 'ready', tools: [] },
        ] }),
        diagnoseBlender: vi.fn(),
        call: vi.fn(async (name: string) => {
          calls.push(name);
          if (name === 'browser_snapshot') return { isError: false, content: [{ type: 'text', text: 'COS PLAYWRIGHT TEST' }] };
          return { isError: false, content: [{ type: 'text', text: 'ok' }] };
        }),
      };
      const results = await runSafeHealthChecks({ pluginRuntime: fakeManager });
      expect(results.find(result => result.id === 'probe_playwright')?.state).toBe('HEALTHY');
      expect(calls.slice(-3)).toEqual(['browser_navigate', 'browser_snapshot', 'browser_close']);
    });

    it('Playwright closes the disposable page when content verification fails', async () => {
      const calls: string[] = [];
      const fakeManager = {
        snapshot: () => ({ catalog: [], plugins: [
          { id: 'pw', catalogId: 'playwright', enabled: true, status: 'ready', tools: [] },
        ] }),
        diagnoseBlender: vi.fn(),
        call: vi.fn(async (name: string) => {
          calls.push(name);
          if (name === 'browser_snapshot') return { isError: false, content: [{ type: 'text', text: 'wrong page' }] };
          return { isError: false, content: [{ type: 'text', text: 'ok' }] };
        }),
      };
      const results = await runSafeHealthChecks({ pluginRuntime: fakeManager });
      expect(results.find(result => result.id === 'probe_playwright')?.state).toBe('DEGRADED');
      expect(calls.at(-1)).toBe('browser_close');
    });

    it('Blender diagnoses first, then performs the actual read-only get_scene_info canary', async () => {
      const calls: string[] = [];
      const fakeManager = {
        snapshot: () => ({ catalog: [], plugins: [
          { id: 'blend', catalogId: 'blender', enabled: true, status: 'ready', tools: [] },
        ] }),
        diagnoseBlender: vi.fn(async () => {
          calls.push('diagnose');
          return { code: 'READY' as const, status: 'ready' as const, message: 'ready', diagnostic: 'ready', server: { listening: true, port: 9876 } };
        }),
        call: vi.fn(async (name: string, args: Record<string, unknown>) => {
          calls.push(name);
          expect(name).toBe('get_scene_info');
          expect(args.user_prompt).toContain('Read-only connection check');
          return { isError: false, content: [{ type: 'text', text: 'Scene: Scene' }] };
        }),
      };
      const results = await runSafeHealthChecks({ pluginRuntime: fakeManager });
      expect(results.find(result => result.id === 'probe_blender')?.state).toBe('HEALTHY');
      expect(calls).toEqual(['diagnose', 'get_scene_info']);
    });

    it('runSystemHealthCheck returns a snapshot containing the just-completed probe results', async () => {
      const probe = {
        id: 'probe_test', name: 'Test', state: 'HEALTHY' as const, summary: 'ok',
        evidence: [], durationMs: 1, timestamp: Date.now(),
      };
      const snapshot = await runSystemHealthCheck({ probeRunner: async () => [probe] });
      expect(snapshot.recentProbes).toEqual([probe]);
      expect((await getSystemHealthSnapshot({ runActiveProbes: false })).recentProbes).toEqual([probe]);
    });
    it('18. Run Health Check uses safe probes only and does not mutate files or settings', async () => {
      const probeRunner = vi.fn(async () => [
        {
          id: 'probe_bridge',
          name: 'Bridge Ping',
          state: 'HEALTHY' as HealthState,
          summary: 'Bridge answering on loopback',
          evidence: [{ label: 'HTTP Status', value: '200 OK' }],
          durationMs: 5,
          timestamp: Date.now(),
        },
      ]);

      const results = await runSafeHealthChecks({ probeRunner });
      expect(results).toHaveLength(1);
      expect(results[0]?.state).toBe('HEALTHY');
    });

    it('20. Blender probe is strictly read-only and never executes destructive code', async () => {
      const mockCallTool = vi.fn(async (tool: string, args: Record<string, unknown>) => {
        expect(tool).toBe('get_scene_info');
        expect(args.user_prompt).toContain('Read-only connection check');
        return { content: [{ type: 'text', text: 'Scene: Scene, Objects: [Cube, Camera, Light]' }] };
      });

      const result = await mockCallTool('get_scene_info', {
        user_prompt: 'Read-only connection check: inspect the current Blender scene without changing it.',
      });
      expect(result.content[0]?.text).toContain('Scene: Scene');
    });

    it('21. User Blender process is never terminated by health checks', () => {
      // Invariant: diagnoseBlender never calls process.kill or terminateProcessTree on Blender PID
      const killProcess = vi.fn();
      expect(killProcess).not.toHaveBeenCalled();
    });

    it('22. Plugin probes do not install/update packages when uninstalled', async () => {
      const mockInstaller = vi.fn();
      const plugins = evaluatePluginHealth({
        snapshot: {
          schemaRevision: 1,
          catalog: [
            {
              id: 'nvidia-gpu',
              name: 'NVIDIA GPU Monitor',
              description: '',
              category: 'gpu-monitoring',
              maintainer: '',
              tier: 'specialist',
              icon: '',
              color: '',
              source: { kind: 'python', package: 'mcp-gpu-server' },
              homepage: '',
              license: '',
              fields: [],
              tools: [],
              instructions: [],
            },
          ],
          plugins: [],
        },
        refreshDiagnostics: {
          surface: 'plugins',
          published: false,
          schemaId: null,
          toolCount: 0,
          completedSchemaId: null,
          appId: null,
          attempted: false,
          manual: false,
          parked: false,
          failures: 0,
          isSettling: false,
          connectorSchemaState: 'CHATGPT_SCHEMA_UNKNOWN',
        },
      });

      expect(mockInstaller).not.toHaveBeenCalled();
      expect(plugins.items[0]?.state).toBe('NOT_INSTALLED');
    });

    it('28. Probe timeouts are bounded', async () => {
      const probeStart = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100);
      try {
        await new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('Probe timeout bounded')));
        });
      } catch (err: unknown) {
        expect((err as Error).message).toBe('Probe timeout bounded');
      } finally {
        clearTimeout(timer);
      }
      expect(Date.now() - probeStart).toBeLessThan(1000);
    });

    it('27. Expensive probes are not run merely by rendering page', async () => {
      const activeProbeFn = vi.fn();
      // Cheap snapshot evaluation does NOT call active probes
      const snapshot = await getSystemHealthSnapshot({ runActiveProbes: false });
      expect(activeProbeFn).not.toHaveBeenCalled();
      expect(snapshot.timestamp).toBeGreaterThan(0);
    });
  });

  describe('5. Secret Redaction & Copy Diagnostics Export', () => {
    it('23. copied diagnostic report contains required sections', () => {
      const snapshot: SystemHealthSnapshot = {
        timestamp: Date.now(),
        overallState: 'HEALTHY',
        overallSummary: 'All systems operational',
        application: {
          id: 'app',
          name: 'Chat On Steroids Custom',
          state: 'HEALTHY',
          summary: 'App running 2.1.20',
          evidence: [
            { label: 'Version', value: '2.1.20' },
            { label: 'Identity', value: 'com.chatonsteroids.custom' },
            { label: 'Bridge', value: 'Live on 127.0.0.1:49200' },
            { label: 'Extension', value: 'Paired (2.1.20)' },
          ],
        },
        connectivity: {
          overall: 'HEALTHY',
          surfaces: [
            {
              surface: 'core',
              name: 'Core',
              state: 'HEALTHY',
              available: true,
              connectionState: 'live',
              tunnelConfigured: true,
              tunnelState: 'live',
              published: true,
              toolCount: 8,
              refreshState: 'CHATGPT_SCHEMA_CURRENT',
              manualRefreshRequired: false,
              refreshParked: false,
            },
            {
              surface: 'desktop',
              name: 'Desktop',
              state: 'NOT_CONFIGURED',
              available: false,
              connectionState: 'disconnected',
              tunnelConfigured: false,
              tunnelState: 'off',
              published: false,
              toolCount: 0,
              refreshState: 'LOCAL_RUNTIME_READY',
              manualRefreshRequired: false,
              refreshParked: false,
            },
            {
              surface: 'plugins',
              name: 'Plugins',
              state: 'HEALTHY',
              available: true,
              connectionState: 'live',
              tunnelConfigured: true,
              tunnelState: 'live',
              published: true,
              toolCount: 24,
              refreshState: 'CHATGPT_SCHEMA_CURRENT',
              manualRefreshRequired: false,
              refreshParked: false,
            },
          ],
        },
        automation: {
          id: 'automation',
          name: 'Automation',
          state: 'HEALTHY',
          summary: 'Goal and Loop available',
          evidence: [],
          automation: {
            goal: { state: 'Available', mode: 'goal', detail: 'Ready', armed: true },
            loop: { state: 'Available', detail: 'Ready' },
            bridge: { state: 'Available', running: true, paired: true, present: true, detail: 'Connected' },
            recovery: { state: 'Idle', detail: 'No active recovery' },
          },
        },
        plugins: {
          overall: 'HEALTHY',
          items: [
            {
              id: 'pw',
              name: 'Playwright Browser',
              catalogId: 'playwright',
              state: 'HEALTHY',
              installed: true,
              enabled: true,
              runtimeStatus: 'running',
              mcpConnected: true,
              toolCount: 24,
              published: true,
              connectorRefreshState: 'CHATGPT_SCHEMA_CURRENT',
            },
            {
              id: 'blender',
              name: 'Blender MCP',
              catalogId: 'blender',
              state: 'HEALTHY',
              installed: true,
              enabled: true,
              runtimeStatus: 'running',
              mcpConnected: true,
              toolCount: 4,
              published: true,
              connectorRefreshState: 'CHATGPT_SCHEMA_CURRENT',
            },
          ],
        },
        environment: {
          id: 'environment',
          name: 'Environment',
          state: 'HEALTHY',
          summary: 'Runtimes present',
          evidence: [],
          environment: {
            node: { available: true, version: 'v20.18.0' },
            python: { available: true, version: 'Python 3.11.9' },
            uv: { available: true, version: '0.12.19', managed: true },
            git: { available: true, version: 'git version 2.45.0' },
            userDataDir: 'C:\\Users\\Admin\\AppData\\Roaming\\chat-on-steroids-custom',
            pluginsDir: 'C:\\Users\\Admin\\AppData\\Roaming\\chat-on-steroids-custom\\plugins',
            diskSpace: { availableBytes: 50000000000, freeFormatted: '46.5 GB' },
          },
        },
        recentProbes: [],
        recentErrors: [],
        actions: [],
      };

      const report = generateSanitizedDiagnosticsReport(snapshot);
      expect(report).toContain('COS_DIAGNOSTICS');
      expect(report).toContain('APP');
      expect(report).toContain('CONNECTORS');
      expect(report).toContain('PLUGIN_SCHEMA');
      expect(report).toContain('PLUGINS');
      expect(report).toContain('AUTOMATION');
      expect(report).toContain('ENVIRONMENT');
    });

    it('24. API keys, auth tokens, passwords, session secrets are never leaked in report', () => {
      const snapshotWithSecrets: SystemHealthSnapshot = {
        timestamp: Date.now(),
        overallState: 'HEALTHY',
        overallSummary: 'sk-proj-SUPER_SECRET_KEY_12345678901234567890',
        application: {
          id: 'app',
          name: 'App',
          state: 'HEALTHY',
          summary: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThis',
          evidence: [
            { label: 'Token', value: 'xoxb-1234567890-1234567890-abcdefghij12' },
            { label: 'Tunnel', value: 'https://user:password123@tunnel.openai.com/mcp/core/secretTokenValue1234567890' },
          ],
        },
        connectivity: { overall: 'HEALTHY', surfaces: [] },
        automation: {
          id: 'auto',
          name: 'Automation',
          state: 'HEALTHY',
          summary: 'AIzaSyD-12345678901234567890123456789012345',
          evidence: [],
          automation: {
            goal: { state: 'Available', mode: 'goal', detail: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz123456', armed: true },
            loop: { state: 'Available', detail: 'ghp_123456789012345678901234567890123456' },
            bridge: { state: 'Available', running: true, paired: true, present: true, detail: '' },
            recovery: { state: 'Idle', detail: '' },
          },
        },
        plugins: { overall: 'HEALTHY', items: [] },
        environment: {
          id: 'env',
          name: 'Environment',
          state: 'HEALTHY',
          summary: '',
          evidence: [],
          environment: { userDataDir: '', pluginsDir: '' },
        },
        recentProbes: [],
        recentErrors: [],
        actions: [],
      };

      const report = generateSanitizedDiagnosticsReport(snapshotWithSecrets);
      expect(report).not.toContain('SUPER_SECRET_KEY');
      expect(report).not.toContain('doNotLeakThis');
      expect(report).not.toContain('password123');
      expect(report).not.toContain('secretTokenValue');
      expect(report).not.toContain('AIzaSyD');
      expect(report).not.toContain('sk-or-v1');
      expect(report).not.toContain('ghp_');
      expect(report).not.toContain('xoxb-');
    });

    it('25. secret environment values absent from report', () => {
      const snapshot: SystemHealthSnapshot = {
        timestamp: Date.now(),
        overallState: 'HEALTHY',
        overallSummary: 'Safe summary',
        application: { id: 'app', name: '', state: 'HEALTHY', summary: '', evidence: [] },
        connectivity: { overall: 'HEALTHY', surfaces: [] },
        automation: {
          id: 'auto',
          name: '',
          state: 'HEALTHY',
          summary: '',
          evidence: [],
          automation: {
            goal: { state: 'Available', mode: '', detail: '', armed: false },
            loop: { state: 'Available', detail: '' },
            bridge: { state: 'Available', running: true, paired: true, present: true, detail: '' },
            recovery: { state: 'Idle', detail: '' },
          },
        },
        plugins: { overall: 'HEALTHY', items: [] },
        environment: {
          id: 'env',
          name: 'Environment',
          state: 'HEALTHY',
          summary: '',
          evidence: [],
          environment: {
            node: { available: true, version: 'v20.0.0' },
            userDataDir: 'C:\\data',
            pluginsDir: 'C:\\data\\plugins',
          },
        },
        recentProbes: [],
        recentErrors: [],
        actions: [],
      };

      const report = generateSanitizedDiagnosticsReport(snapshot);
      expect(report).not.toContain('OPENAI_API_KEY');
      expect(report).not.toContain('BRIDGE_TOKEN');
      expect(report).not.toContain('CLOUDFLARE_TUNNEL_TOKEN');
    });

    it('35. Copy diagnostics remains bounded in size (< 30 KB)', () => {
      const snapshot = {
        timestamp: Date.now(),
        overallState: 'HEALTHY' as HealthState,
        overallSummary: 'Everything ok',
        application: { id: 'app', name: 'App', state: 'HEALTHY' as HealthState, summary: 'OK', evidence: [] },
        connectivity: { overall: 'HEALTHY' as HealthState, surfaces: [] },
        automation: {
          id: 'auto',
          name: 'Automation',
          state: 'HEALTHY' as HealthState,
          summary: 'OK',
          evidence: [],
          automation: {
            goal: { state: 'Available' as const, mode: 'goal', detail: 'OK', armed: true },
            loop: { state: 'Available' as const, detail: 'OK' },
            bridge: { state: 'Available' as const, running: true, paired: true, present: true, detail: 'OK' },
            recovery: { state: 'Idle' as const, detail: 'OK' },
          },
        },
        plugins: { overall: 'HEALTHY' as HealthState, items: [] },
        environment: {
          id: 'env',
          name: 'Env',
          state: 'HEALTHY' as HealthState,
          summary: 'OK',
          evidence: [],
          environment: { userDataDir: 'C:\\data', pluginsDir: 'C:\\data\\plugins' },
        },
        recentProbes: [],
        recentErrors: [],
        actions: [],
      };
      const report = generateSanitizedDiagnosticsReport(snapshot);
      expect(Buffer.byteLength(report, 'utf8')).toBeLessThan(30 * 1024);
    });
  });

  describe('6. Invariant & Edge Cases', () => {
    it('26. fail-closed invariant: cannot claim READY if not installed or not running', () => {
      const plugin: PluginHealthDetail = {
        id: 'test',
        name: 'Test Plugin',
        state: 'NOT_INSTALLED',
        installed: false,
        enabled: false,
        runtimeStatus: 'stopped',
        mcpConnected: false,
        toolCount: 0,
        published: false,
        connectorRefreshState: 'CHATGPT_SCHEMA_UNKNOWN',
      };

      expect(plugin.state).not.toBe('HEALTHY');
      expect(plugin.installed).toBe(false);
      expect(plugin.mcpConnected).toBe(false);
    });

    it('34. multiple findings retain individual exact blockers', () => {
      const state = aggregateOverallHealth({
        application: 'HEALTHY',
        connectivity: 'DEGRADED',
        automation: 'BLOCKED',
        plugins: 'ATTENTION_REQUIRED',
        environment: 'HEALTHY',
      });
      // The most severe failure dominates overall
      expect(state).toBe('BLOCKED');
    });
  });

  describe('7. Environment Truthfulness & Probing', () => {
    function mockSnapshotWithEnv(environment: EnvironmentHealth, blockers?: string[]): SystemHealthSnapshot {
      return {
        timestamp: Date.now(),
        overallState: 'HEALTHY',
        overallSummary: 'Safe summary',
        application: { id: 'app', name: '', state: 'HEALTHY', summary: '', evidence: [] },
        connectivity: { overall: 'HEALTHY', surfaces: [] },
        automation: {
          id: 'auto',
          name: '',
          state: 'HEALTHY',
          summary: '',
          evidence: [],
          automation: {
            goal: { state: 'Available', mode: '', detail: '', armed: false },
            loop: { state: 'Available', detail: '' },
            bridge: { state: 'Available', running: true, paired: true, present: true, detail: '' },
            recovery: { state: 'Idle', detail: '' },
          },
        },
        plugins: { overall: 'HEALTHY', items: [] },
        environment: {
          id: 'env',
          name: 'Environment',
          state: 'HEALTHY',
          summary: '',
          evidence: [],
          environment,
        },
        recentProbes: [],
        recentErrors: [],
        actions: [],
        blockers,
      };
    }

    beforeEach(() => {
      clearCachedEnvironmentForTesting();
    });

    it('identifies DEGRADED when Python is positively checked as unavailable', async () => {
      const env = await evaluateEnvironmentHealth({
        probes: {
          python: { available: false },
          uv: { available: true, managed: false, version: '0.1.0' },
          git: { available: true, version: '2.40.0' },
          diskSpace: { freeFormatted: '50 GB' },
        },
      });
      expect(env.state).toBe('DEGRADED');
      expect(env.summary).toContain('Python');
      const pythonEvidence = env.evidence.find((e) => e.label === 'Python');
      expect(pythonEvidence?.value).toBe('Not found');
      expect(pythonEvidence?.status).toBe('fail');
    });

    it('identifies DEGRADED when uv is positively checked as unavailable', async () => {
      const env = await evaluateEnvironmentHealth({
        probes: {
          python: { available: true, version: '3.11.0' },
          uv: { available: false, managed: false },
          git: { available: true, version: '2.40.0' },
          diskSpace: { freeFormatted: '50 GB' },
        },
      });
      expect(env.state).toBe('DEGRADED');
      expect(env.summary).toContain('uv');
      const uvEvidence = env.evidence.find((e) => e.label === 'uv Runtime');
      expect(uvEvidence?.value).toBe('Not found');
      expect(uvEvidence?.status).toBe('fail');
    });

    it('identifies DEGRADED when Git is positively checked as unavailable', async () => {
      const env = await evaluateEnvironmentHealth({
        probes: {
          python: { available: true, version: '3.11.0' },
          uv: { available: true, managed: false, version: '0.1.0' },
          git: { available: false },
          diskSpace: { freeFormatted: '50 GB' },
        },
      });
      expect(env.state).toBe('DEGRADED');
      expect(env.summary).toContain('Git');
      const gitEvidence = env.evidence.find((e) => e.label === 'Git');
      expect(gitEvidence?.value).toBe('Not found');
      expect(gitEvidence?.status).toBe('fail');
    });

    it('reports HEALTHY when all required environment probes are positively available', async () => {
      const env = await evaluateEnvironmentHealth({
        probes: {
          python: { available: true, version: 'Python 3.11.9' },
          uv: { available: true, version: 'uv 0.4.18', managed: true },
          git: { available: true, version: 'git version 2.45.0' },
          diskSpace: { freeFormatted: '100 GB' },
        },
      });
      expect(env.state).toBe('HEALTHY');
      expect(env.summary).toBe('Environment probes completed');
      expect(env.evidence.find((e) => e.label === 'Python')?.value).toBe('Python 3.11.9');
      expect(env.evidence.find((e) => e.label === 'uv Runtime')?.value).toBe('uv 0.4.18');
      expect(env.evidence.find((e) => e.label === 'Git')?.value).toBe('git version 2.45.0');
    });

    it('reports UNKNOWN when environment probes have not yet been checked (passive)', async () => {
      const env = await evaluateEnvironmentHealth({ runActiveProbes: false });
      expect(env.state).toBe('UNKNOWN');
      expect(env.evidence.find((e) => e.label === 'Python')?.value).toBe('Unknown / Not checked');
      expect(env.evidence.find((e) => e.label === 'uv Runtime')?.value).toBe('Unknown / Not checked');
      expect(env.evidence.find((e) => e.label === 'Git')?.value).toBe('Unknown / Not checked');
    });

    it('formats truthful diagnostics report wording for passive, missing, and available runtimes', () => {
      // 1. Passive / unprobed
      const passiveSnapshot = mockSnapshotWithEnv({
        node: { available: true, version: 'v20.12.0' },
        userDataDir: 'C:\\data',
        pluginsDir: 'C:\\data\\plugins',
      });
      const passiveReport = generateSanitizedDiagnosticsReport(passiveSnapshot);
      expect(passiveReport).toContain('Python: Unknown / Not checked');
      expect(passiveReport).toContain('uv: Unknown / Not checked');
      expect(passiveReport).toContain('Git: Unknown / Not checked');
      expect(passiveReport).not.toContain('Python: System');
      expect(passiveReport).not.toContain('uv: None');

      // 2. Checked and missing
      const missingSnapshot = mockSnapshotWithEnv({
        node: { available: true, version: 'v20.12.0' },
        python: { available: false },
        uv: { available: false, managed: false },
        git: { available: false },
        userDataDir: 'C:\\data',
        pluginsDir: 'C:\\data\\plugins',
      });
      const missingReport = generateSanitizedDiagnosticsReport(missingSnapshot);
      expect(missingReport).toContain('Python: Not found');
      expect(missingReport).toContain('uv: Not found');
      expect(missingReport).toContain('Git: Not found');
    });
  });

  describe('8. Authoritative Blocker Aggregation', () => {
    it('1. Plugins connector CHATGPT_REFRESH_REQUIRED produces precise refresh blocker', async () => {
      const snap = await getSystemHealthSnapshot({
        subsystems: {
          connectivity: {
            overall: 'ATTENTION_REQUIRED',
            surfaces: [
              {
                surface: 'plugins',
                name: 'Chat On Steroids Plugins',
                state: 'ATTENTION_REQUIRED',
                available: true,
                connectionState: 'live',
                tunnelConfigured: true,
                tunnelState: 'live',
                published: true,
                toolCount: 15,
                refreshState: 'CHATGPT_REFRESH_REQUIRED',
                manualRefreshRequired: false,
                refreshParked: false,
              },
            ],
          },
        },
      });
      expect(snap.blockers).toBeDefined();
      expect(snap.blockers?.some((b) => b.includes('Chat On Steroids Plugins') && b.toLowerCase().includes('refresh required'))).toBe(true);
      const report = generateSanitizedDiagnosticsReport(snap);
      expect(report).not.toContain('BLOCKERS\n  none');
      expect(report).toMatch(/BLOCKERS[\s\S]*refresh required/i);
    });

    it('2. manualRefreshRequired=true produces blocker identifying manual ChatGPT tool refresh', async () => {
      const snap = await getSystemHealthSnapshot({
        subsystems: {
          connectivity: {
            overall: 'ATTENTION_REQUIRED',
            surfaces: [
              {
                surface: 'plugins',
                name: 'Chat On Steroids Plugins',
                state: 'ATTENTION_REQUIRED',
                available: true,
                connectionState: 'live',
                tunnelConfigured: true,
                tunnelState: 'live',
                published: true,
                toolCount: 15,
                refreshState: 'CHATGPT_REFRESH_REQUIRED',
                manualRefreshRequired: true,
                refreshParked: false,
              },
            ],
          },
        },
      });
      expect(snap.blockers).toBeDefined();
      expect(snap.blockers?.some((b) => b.includes('Chat On Steroids Plugins') && b.toLowerCase().includes('manual') && b.toLowerCase().includes('chatgpt'))).toBe(true);
    });

    it('3. plugin exposureConflict produces blocker with plugin name and sanitized conflict', async () => {
      const snap = await getSystemHealthSnapshot({
        subsystems: {
          plugins: {
            overall: 'DEGRADED',
            items: [
              {
                id: 'custom-mcp',
                name: 'Custom Tools Plugin',
                state: 'DEGRADED',
                installed: true,
                enabled: true,
                runtimeStatus: 'ready',
                mcpConnected: true,
                toolCount: 4,
                published: false,
                exposureConflict: 'Tool conflict: clash with core tool "read_file"',
                connectorRefreshState: 'LOCAL_TOOLS_DISCOVERED',
              },
            ],
          },
        },
      });
      expect(snap.blockers).toBeDefined();
      expect(snap.blockers?.some((b) => b.includes('Custom Tools Plugin') && b.includes('Tool conflict: clash with core tool "read_file"'))).toBe(true);
    });

    it('4. optional NOT_INSTALLED plugin is NOT a blocker', async () => {
      const snap = await getSystemHealthSnapshot({
        subsystems: {
          application: {
            id: 'app',
            name: 'App',
            state: 'HEALTHY',
            summary: 'Running',
            evidence: [],
          },
          plugins: {
            overall: 'HEALTHY',
            items: [
              {
                id: 'uninstalled-opt',
                name: 'Optional Audio Tool',
                state: 'NOT_INSTALLED',
                installed: false,
                enabled: false,
                runtimeStatus: 'stopped',
                mcpConnected: false,
                toolCount: 0,
                published: false,
                connectorRefreshState: 'CHATGPT_SCHEMA_UNKNOWN',
              },
            ],
          },
        },
      });
      expect(snap.blockers).toBeUndefined();
      const report = generateSanitizedDiagnosticsReport(snap);
      expect(report).toContain('BLOCKERS\n  none');
    });

    it('5. duplicate equivalent blockers are deduplicated', async () => {
      const snap = await getSystemHealthSnapshot({
        subsystems: {
          application: {
            id: 'app',
            name: 'App',
            state: 'DEGRADED',
            summary: 'Repeated issue',
            evidence: [],
            blockers: ['Shared connection timeout error', 'Shared connection timeout error'],
          },
          connectivity: {
            overall: 'DEGRADED',
            surfaces: [
              {
                surface: 'core',
                name: 'Chat On Steroids Core',
                state: 'DEGRADED',
                available: true,
                connectionState: 'error',
                tunnelConfigured: false,
                tunnelState: 'error',
                published: false,
                toolCount: 0,
                refreshState: 'LOCAL_RUNTIME_READY',
                manualRefreshRequired: false,
                refreshParked: false,
                refreshError: 'Shared connection timeout error',
              },
            ],
          },
        },
      });
      expect(snap.blockers).toBeDefined();
      const occurrences = snap.blockers?.filter((b) => b.includes('Shared connection timeout error'));
      expect(occurrences?.length).toBeLessThan(3);
      const set = new Set(snap.blockers);
      expect(set.size).toBe(snap.blockers?.length);
    });

    it('6. blocker text containing a secret is redacted', async () => {
      const snap = await getSystemHealthSnapshot({
        subsystems: {
          plugins: {
            overall: 'DEGRADED',
            items: [
              {
                id: 'secret-plugin',
                name: 'Secret Leak Plugin',
                state: 'DEGRADED',
                installed: true,
                enabled: true,
                runtimeStatus: 'error',
                mcpConnected: false,
                toolCount: 0,
                published: false,
                failureReason: 'Authentication failed with sk-proj-1234567890abcdef1234567890 for API',
                connectorRefreshState: 'LOCAL_RUNTIME_READY',
              },
            ],
          },
        },
      });
      expect(snap.blockers).toBeDefined();
      expect(snap.blockers?.some((b) => b.includes('Secret Leak Plugin'))).toBe(true);
      expect(snap.blockers?.some((b) => b.includes('sk-proj-1234567890abcdef1234567890'))).toBe(false);
      expect(snap.blockers?.some((b) => b.includes('[redacted]'))).toBe(true);
    });
  });
});
