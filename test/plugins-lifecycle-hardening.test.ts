import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './helpers.js';

const secrets = vi.hoisted(() => new Map<string, string>());
vi.mock('../src/main/secrets.js', () => ({
  getSecret: vi.fn(async (k: string) => secrets.get(k) ?? null),
  setSecret: vi.fn(async (k: string, v: string) => { secrets.set(k, v); }),
  clearSecret: vi.fn(async (k: string) => { secrets.delete(k); }),
}));

import { initDurableStore, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import { PluginManager } from '../src/main/plugins/manager.js';
import * as pluginInstaller from '../src/main/plugins/installer.js';

describe('Plugin Runtime Lifecycle & Failure-Mode Hardening', () => {
  let dir: string;
  let manager: PluginManager;
  let mockServerScript: string;

  beforeEach(async () => {
    dir = await makeTempDir('plugins-hardening-');
    initDurableStore(dir);
    manager = new PluginManager();
    await manager.initialize(dir);
    secrets.clear();

    // Deterministic offline mock stdio MCP server fixture
    mockServerScript = path.join(dir, 'mock-mcp-server.cjs');
    await fs.writeFile(
      mockServerScript,
      `const readline = require('node:readline');
let gpuCount = 1;
if (process.env.MOCK_GPU_COUNT !== undefined) gpuCount = parseInt(process.env.MOCK_GPU_COUNT, 10);
const tools = [
  { name: 'gpu_stats', description: 'GPU stats', inputSchema: { type: 'object' } },
  { name: 'gpu_info', description: 'GPU info', inputSchema: { type: 'object' } }
];
readline.createInterface({ input: process.stdin }).on('line', line => {
  try {
    const m = JSON.parse(line);
    if (m.id === undefined) return;
    if (m.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-gpu', version: '1.0' } } }) + '\\n');
    } else if (m.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools } }) + '\\n');
    } else if (m.method === 'tools/call') {
      if (m.params.name === 'gpu_stats') {
        const result = gpuCount > 0
          ? { content: [{ type: 'text', text: JSON.stringify({ count: gpuCount, gpus: [{ index: 0, name: 'Mock RTX 3090', temp_c: 45, vram: { total_mib: 24576, used_mib: 2000, free_mib: 22576 } }] }) }] }
          : { content: [{ type: 'text', text: JSON.stringify({ count: 0, gpus: [], error: 'No NVIDIA GPU or nvidia-smi not found' }) }] };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
      } else {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ok' }] } }) + '\\n');
      }
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\\n');
    }
  } catch (e) {}
});`
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await manager.close();
    await flushDurable();
    resetDurableForTests();
    await removeTempDir(dir);
  });

  // Failure Mode 1: missing executable/runtime
  it('case 1: missing executable marks plugin as error with clear message', async () => {
    const nonExistentCommand = path.join(dir, 'does-not-exist-binary.exe');
    const snapshot = await manager.install({
      name: 'Missing Binary Plugin',
      source: { kind: 'command', command: nonExistentCommand, args: [] },
    });
    expect(snapshot.plugins).toHaveLength(1);
    const plugin = snapshot.plugins[0]!;
    expect(plugin.status).toBe('error');
    expect(plugin.error).toBeTruthy();
    expect(plugin.tools).toHaveLength(0);
  });

  // Failure Mode 2: setup process exits non-zero (offline deterministic)
  it('case 2: setup process exiting non-zero rolls back and cleans up', async () => {
    vi.spyOn(pluginInstaller, 'installSource').mockRejectedValueOnce(
      new Error('Installation failed (exit 1). Check the package, version and network connection.')
    );
    await expect(
      manager.install({
        name: 'Failing Setup Plugin',
        source: { kind: 'npm', package: 'failing-package', version: '1.0.0' },
      })
    ).rejects.toThrow('Installation failed');
    // Verify no record or generation directory was left behind
    expect(manager.snapshot().plugins).toHaveLength(0);
  });

  // Failure Mode 3: MCP server crashes before handshake
  it('case 3: server crashing before handshake transitions to error', async () => {
    const crashScript = path.join(dir, 'crash.cjs');
    await fs.writeFile(crashScript, 'process.exit(1);');
    const snapshot = await manager.install({
      name: 'Crashing Server',
      source: { kind: 'command', command: process.execPath, args: [crashScript] },
    });
    expect(snapshot.plugins[0]?.status).toBe('error');
    expect(snapshot.plugins[0]?.error).toBeTruthy();
  });

  // Failure Mode 4: handshake fails with protocol error response
  it('case 4: server with protocol error during handshake fails closed', async () => {
    const errorScript = path.join(dir, 'handshake-error.cjs');
    await fs.writeFile(
      errorScript,
      `const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32002, message: 'Server handshake rejected' } }) + '\\n');
  }
});`
    );
    const snapshot = await manager.install({
      name: 'Handshake Error Server',
      source: { kind: 'command', command: process.execPath, args: [errorScript] },
    });
    expect(snapshot.plugins[0]?.status).toBe('error');
    expect(snapshot.plugins[0]?.error).toContain('Server handshake rejected');
  });

  // Failure Mode 5: wrong / incompatible package version rejected
  it('case 5: floating version or invalid package string rejected before setup', async () => {
    await expect(
      pluginInstaller.installSource({ kind: 'npm', package: 'sample', version: '>=1.0.0' }, path.join(dir, 'test-pkg'))
    ).rejects.toThrow('Specify a package name and an explicit version');
    await expect(
      pluginInstaller.installSource({ kind: 'npm', package: 'sample', version: 'latest' }, path.join(dir, 'test-pkg'))
    ).rejects.toThrow('Specify a package name and an explicit version');
  });

  // Failure Mode 6: dependency resolution failure
  it('case 6: conflicting or invalid Python dependency pins rejected', async () => {
    await expect(
      pluginInstaller.installSource(
        {
          kind: 'python',
          package: 'sample-server',
          version: '1.0.0',
          dependencies: [{ package: 'sample-server', version: '2.0.0' }],
        },
        path.join(dir, 'test-python')
      )
    ).rejects.toThrow('Dependency pins must not repeat or replace the server package');
  });

  // Failure Mode 7: duplicate catalog plugin installation rejected
  it('case 7: duplicate catalog installation rejected authoritatively', async () => {
    // Install a command mock as 'memory' catalogId
    await manager.install({
      catalogId: 'memory',
      name: 'Memory 1',
      source: { kind: 'command', command: process.execPath, args: [mockServerScript] },
    });
    expect(manager.snapshot().plugins).toHaveLength(1);

    // Attempting to install 'memory' again must reject
    await expect(
      manager.install({
        catalogId: 'memory',
        name: 'Memory 2',
        source: { kind: 'command', command: process.execPath, args: [mockServerScript] },
      })
    ).rejects.toThrow('This catalog plugin is already installed');
    expect(manager.snapshot().plugins).toHaveLength(1);
  });

  // Failure Mode 8: health check fails after prior success
  it('case 8: server process termination after success transitions plugin to error', async () => {
    const terminableScript = path.join(dir, 'terminable.cjs');
    await fs.writeFile(
      terminableScript,
      `const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } } }) + '\\n');
  } else if (m.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] } }) + '\\n');
  } else if (m.method === 'tools/call') {
    process.exit(0);
  }
});`
    );
    const snapshot = await manager.install({
      name: 'Terminable Server',
      source: { kind: 'command', command: process.execPath, args: [terminableScript] },
    });
    expect(snapshot.plugins[0]?.status).toBe('ready');

    // Trigger call that makes it exit
    await manager.call('ping', {});
    await vi.waitFor(() => {
      const updated = manager.snapshot().plugins[0]!;
      expect(updated.status).toBe('error');
      expect(updated.error).toContain('Server disconnected');
    }, { timeout: 3000 });
  });

  // Failure Mode 9: plugin disabled while process is active
  it('case 9: disabling an active plugin stops the server process and clears exposure', async () => {
    const snapshot = await manager.install({
      name: 'Active Server',
      source: { kind: 'command', command: process.execPath, args: [mockServerScript] },
    });
    const pluginId = snapshot.plugins[0]!.id;
    expect(snapshot.plugins[0]!.status).toBe('ready');
    expect(manager.tools().length).toBeGreaterThan(0);

    // Disable the plugin
    const disabledSnapshot = await manager.setEnabled(pluginId, false);
    expect(disabledSnapshot.plugins[0]!.enabled).toBe(false);
    expect(disabledSnapshot.plugins[0]!.status).toBe('disabled');
    // Tools are immediately removed from exposure
    expect(manager.tools()).toHaveLength(0);

    // Re-enabling reconnects cleanly
    const reenabledSnapshot = await manager.setEnabled(pluginId, true);
    expect(reenabledSnapshot.plugins[0]!.enabled).toBe(true);
    expect(reenabledSnapshot.plugins[0]!.status).toBe('ready');
    expect(manager.tools().length).toBeGreaterThan(0);
  });

  // Failure Mode 10: app restart with previously configured plugin
  it('case 10: app restart restores configured plugins without trusting stale state', async () => {
    const snapshot = await manager.install({
      name: 'Persistent Server',
      source: { kind: 'command', command: process.execPath, args: [mockServerScript] },
    });
    const pluginId = snapshot.plugins[0]!.id;
    expect(snapshot.plugins[0]!.status).toBe('ready');

    // Close manager simulating app shutdown
    await manager.close();

    // Re-initialize a fresh manager instance against the same data directory
    const freshManager = new PluginManager();
    await freshManager.initialize(dir);

    // Wait for the background connect to finish
    await vi.waitFor(() => {
      const restored = freshManager.snapshot().plugins[0];
      expect(restored?.id).toBe(pluginId);
      expect(restored?.status).toBe('ready');
    }, { timeout: 3000 });

    expect(freshManager.tools().length).toBeGreaterThan(0);
    await freshManager.close();
  });

  // Failure Mode 11: invalid or incomplete plugin recipe rejected
  it('case 11: incomplete or invalid recipe is rejected before writing to records', async () => {
    await expect(
      manager.install({
        name: 'Incomplete Plugin',
        source: { kind: 'command', command: '' },
      })
    ).rejects.toThrow('An executable is required');

    await expect(
      manager.install({
        name: 'Invalid URL Plugin',
        source: { kind: 'remote', url: 'ftp://insecure-ftp.com' },
      })
    ).rejects.toThrow();

    expect(manager.snapshot().plugins).toHaveLength(0);
  });

  // Failure Mode 12: unsupported hardware for conditional plugin (NVIDIA GPU Monitor)
  it('case 12: NVIDIA GPU Monitor fails closed as error when NVIDIA hardware/NVML is missing', async () => {
    // When MOCK_GPU_COUNT=0, the mock returns count=0 and error
    const noGpuManager = new PluginManager();
    const noGpuDir = await makeTempDir('plugins-nogpu-');
    initDurableStore(noGpuDir);
    await noGpuManager.initialize(noGpuDir);

    try {
      const snapshot = await noGpuManager.install({
        catalogId: 'nvidia-gpu',
        name: 'NVIDIA GPU Monitor',
        source: { kind: 'command', command: process.execPath, args: [mockServerScript] },
        config: { MOCK_GPU_COUNT: '0' },
      });

      expect(snapshot.plugins).toHaveLength(1);
      const plugin = snapshot.plugins[0]!;
      expect(plugin.status).toBe('error');
      expect(plugin.error).toContain('NVIDIA GPU or driver unavailable on this machine');
      // Tools must not be published/callable when hardware probe fails
      expect(noGpuManager.tools()).toHaveLength(0);
    } finally {
      await noGpuManager.close();
      await removeTempDir(noGpuDir);
    }
  });

  it('case 12b: NVIDIA GPU Monitor becomes ready when compatible GPU hardware is detected', async () => {
    // When MOCK_GPU_COUNT=1, probe succeeds and plugin is ready
    const gpuManager = new PluginManager();
    const gpuDir = await makeTempDir('plugins-hasgpu-');
    initDurableStore(gpuDir);
    await gpuManager.initialize(gpuDir);

    try {
      const snapshot = await gpuManager.install({
        catalogId: 'nvidia-gpu',
        name: 'NVIDIA GPU Monitor',
        source: { kind: 'command', command: process.execPath, args: [mockServerScript] },
        config: { MOCK_GPU_COUNT: '1' },
      });

      expect(snapshot.plugins).toHaveLength(1);
      const plugin = snapshot.plugins[0]!;
      expect(plugin.status).toBe('ready');
      expect(plugin.error).toBeUndefined();
      expect(gpuManager.tools().map((t) => t.name)).toContain('gpu_stats');
      expect(gpuManager.tools().map((t) => t.name)).toContain('gpu_info');
    } finally {
      await gpuManager.close();
      await removeTempDir(gpuDir);
    }
  });
});
