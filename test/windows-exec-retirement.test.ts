import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempDir, removeTempDir } from './helpers.js';
import { initConfigPath, saveConfig, defaultConfig } from '../src/main/config.js';
import { createSession, deleteSession, getSession, initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { unifiedExecManager } from '../src/main/codex/manager.js';
import { execOwner, execOwnershipFailure, noteExecOwner, resetExecOwnershipForTests } from '../src/main/codex/ownership.js';

// Fault only the OS tree-kill helper. The managed leader, child and grandchild are real
// processes; session deletion, the process manager and ownership registry are unmocked.
const fault = vi.hoisted(() => ({ mode: 'none' as 'none' | 'refused' | 'leader-only', calls: 0 }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    if (path.basename(args[0]).toLowerCase() !== 'taskkill.exe' || fault.mode === 'none') return actual.spawn(...args);
    fault.calls++;
    const pid = Number((args[1] as string[])[1]);
    return actual.spawn(process.execPath, ['-e', fault.mode === 'leader-only'
      ? `try { process.kill(${pid}); } catch {} process.exit(1);`
      : 'process.exit(1);'], { windowsHide: true, stdio: 'ignore' });
  } };
});

let root: string | undefined;
const pids: number[] = [];
afterEach(async () => {
  fault.mode = 'none';
  fault.calls = 0;
  // Independent OS cleanup also runs after RED: never leave the demonstrated orphan behind.
  for (const pid of pids.reverse()) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  pids.length = 0;
  await unifiedExecManager.terminateAllProcesses().catch(() => undefined);
  resetExecOwnershipForTests();
  resetSessionStoreForTests();
  if (root) await removeTempDir(root);
  root = undefined;
});

it.runIf(process.platform === 'win32').each(['none', 'refused', 'leader-only'] as const)(
  'releases Windows descendant custody only after confirmed tree termination (fault=%s)', async mode => {
    root = await makeTempDir('cos-tree-retirement-');
    initConfigPath(root); initSessionStore(root);
    await saveConfig(defaultConfig());
    const session = await createSession({ title: 'owned process tree' });
    const ready = path.join(root, 'tree.json');
    const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, JSON.stringify({child:process.ppid,grandchild:process.pid})); setInterval(()=>{},1000);`;
    // Independent helpers must not inherit Node's own incidental child-lifetime job.
    const child = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,windowsHide:true,stdio:'ignore'}); setInterval(()=>{},1000);`;
    const leader = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,windowsHide:true,stdio:'ignore'}); setInterval(()=>{},1000);`;
    const id = unifiedExecManager.allocateProcessId();
    const result = await unifiedExecManager.execCommand({ processId: id, command: [process.execPath, '-e', leader],
      shellType: 'powershell', hookCommand: 'owned Windows tree', cwd: root, displayCwd: root,
      env: process.env, tty: false, yieldTimeMs: 250, maxOutputTokens: undefined,
      truncationPolicy: { kind: 'tokens', tokens: 1000 } });
    expect(result.processId).toBe(id);
    noteExecOwner(id, session.id);
    const leaderPid = unifiedExecManager.listProcesses().find(row => row.processId === id)!.pid;
    pids.push(leaderPid);
    let tree!: { child: number; grandchild: number };
    await vi.waitFor(async () => { tree = JSON.parse(await fs.readFile(ready, 'utf8')); }, { timeout: 10_000 });
    pids.push(tree.child, tree.grandchild);
    expect(() => process.kill(tree.grandchild, 0)).not.toThrow();

    fault.mode = mode;
    const deletion = await deleteSession(session.id).then(() => 'completed', () => 'unresolved');
    if (mode === 'none') {
      expect(deletion).toBe('completed');
      expect(() => process.kill(tree.child, 0)).toThrow();
      expect(() => process.kill(tree.grandchild, 0)).toThrow();
      expect(execOwner(id)).toBeNull();
      expect(await getSession(session.id)).toBeNull();
      return;
    }
    expect(fault.calls).toBeGreaterThan(0);
    // This independently observable PID must still exist under the injected fault. RED
    // previously showed deletion=completed, no manager row and no owner with this PID live.
    expect(() => process.kill(tree.grandchild, 0)).not.toThrow();
    expect({ deletion, represented: unifiedExecManager.listProcesses().some(row => row.processId === id),
      owner: execOwner(id) }).toEqual({ deletion: 'unresolved', represented: true, owner: session.id });
    expect(await getSession(session.id)).not.toBeNull();
    expect(execOwnershipFailure(id, 'different-session')).toBe('unavailable');
    if (mode === 'leader-only') {
      expect(() => process.kill(leaderPid, 0)).toThrow();
      // Real taskkill now reports a missing leader. That cannot discharge custody
      // while this independently observed grandchild is still alive.
      fault.mode = 'none';
    }
    // Polling, direct release and app cleanup must not turn leader exit into tree proof.
    unifiedExecManager.releaseProcessId(id);
    await unifiedExecManager.writeStdin({ processId: id, input: '', yieldTimeMs: 1,
      maxOutputTokens: undefined, truncationPolicy: { kind: 'tokens', tokens: 1000 } }).catch(() => undefined);
    await expect(unifiedExecManager.terminateAllProcesses()).rejects.toThrow('Process-tree retirement unresolved');
    expect(execOwner(id)).toBe(session.id);
    expect(unifiedExecManager.listProcesses()).toContainEqual(expect.objectContaining({ processId: id, retirementPending: true }));
    expect(() => process.kill(tree.grandchild, 0)).not.toThrow();
  });
