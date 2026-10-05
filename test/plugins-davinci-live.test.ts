import { expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { pluginCatalog } from '../src/main/plugins/catalog.js';
import { installSource, pluginEnvironment } from '../src/main/plugins/installer.js';
import { initUvRuntime } from '../src/main/plugins/uv-runtime.js';
import { DAVINCI_PUBLIC_TOOLS, davinciRuntimeEnvironment } from '../src/main/plugins/davinci.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const execFile = promisify(execFileCallback);

it('keeps the live DaVinci canary opt-in and pinned to the reviewed recipe', () => {
  const recipe = pluginCatalog.find(entry => entry.id === 'davinci-resolve');
  expect(recipe?.source).toMatchObject({ kind: 'python', package: 'dvr', version: '1.7.0' });
  // The destructive portion of the real canary is intentionally not an ordinary CI test:
  // the acceptance worker performs it only after re-reading the user's live project state.
  expect(process.env.COS_DAVINCI_LIVE_TEST === '1' || process.env.COS_DAVINCI_LIVE_TEST === undefined).toBe(true);
});

it.runIf(process.env.COS_DAVINCI_LIVE_TEST === '1')('installs and exercises the isolated Resolve adapter with mutation gated by fresh project state', async () => {
  const temporary = await makeTempDir('cos-davinci-live-');
  const installDir = path.join(temporary, 'plugin');
  const dataDir = path.join(temporary, 'data');
  initUvRuntime(temporary);
  await fs.mkdir(dataDir, { recursive: true });
  const source = pluginCatalog.find(recipe => recipe.id === 'davinci-resolve')!.source;
  const launch = await installSource(source, installDir);
  const report: Record<string, unknown> = { mutation_attempted: false };

  const connect = async () => {
    const client = new Client({ name: 'CoS DaVinci V1 live canary', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: launch.command,
      args: launch.args,
      cwd: dataDir,
      env: { ...pluginEnvironment(), ...davinciRuntimeEnvironment() },
      stderr: 'pipe',
      maxBufferSize: 16 * 1024 * 1024,
    });
    await client.connect(transport, { timeout: 20_000 });
    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toEqual([...DAVINCI_PUBLIC_TOOLS]);
    return { client, transport };
  };
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content.find(block => block.type === 'text');
    if (!text || text.type !== 'text') throw new Error(`${name} returned no text payload`);
    const payload = JSON.parse(text.text) as Record<string, any>;
    if (result.isError) throw new Error(`${name}: ${JSON.stringify(payload)}`);
    return payload;
  };

  let first: Awaited<ReturnType<typeof connect>> | undefined;
  let second: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    first = await connect();
    const health = await call(first.client, 'resolve_health');
    report.connection = health.code;
    report.version = health.resolve?.version;
    report.product = health.resolve?.product;
    if (health.code !== 'READY') {
      expect(['RESOLVE_NOT_RUNNING', 'SCRIPTING_API_MISSING', 'PYTHON_INCOMPATIBLE', 'CONNECTION_FAILED', 'VERSION_OR_CAPABILITY_UNSUPPORTED']).toContain(health.code);
      report.blocked = `LIVE_MUTATION_BLOCKED_${health.code}=YES`;
      report.health = health;
      const firstPid = first.transport.pid;
      await first.client.close();
      first = undefined;
      second = await connect();
      const restartedHealth = await call(second.client, 'resolve_health');
      report.restart = { first_adapter_pid: firstPid ?? null, health: restartedHealth.code, ready: restartedHealth.ready };
      expect(restartedHealth.code).toBe(health.code);
      console.log(`DAVINCI_LIVE_CANARY=${JSON.stringify(report)}`);
      return;
    }

    const project = await call(first.client, 'resolve_inspect', { selector: 'project' });
    const timelines = await call(first.client, 'resolve_inspect', { selector: 'timelines', limit: 100 });
    const media = await call(first.client, 'resolve_inspect', { selector: 'media', limit: 100 });
    report.project = project;
    report.timeline_total = timelines.total;
    report.media_total = media.total;

    const safeEmptyState = project.name === 'Untitled Project 2' && project.timeline_count === 0 && timelines.total === 0 && media.total === 0;
    if (!safeEmptyState) {
      report.blocked = 'LIVE_MUTATION_BLOCKED_PROJECT_STATE_CHANGED=YES';
      console.log(`DAVINCI_LIVE_CANARY=${JSON.stringify(report)}`);
      return;
    }

    report.mutation_attempted = true;
    const operationId = `cos-canary-${randomUUID()}`;
    const prepared = await call(first.client, 'resolve_prepare_ai_timeline', { operation_id: operationId, name: 'source_v1_canary' });
    expect(prepared.executed, JSON.stringify(prepared)).toBe(true);
    expect(prepared.verified, JSON.stringify(prepared)).toBe(true);
    const timelineId = String(prepared.after?.unique_id ?? '');
    expect(timelineId).not.toBe('');
    report.timeline_unique_id = timelineId;
    report.prepare = { executed: prepared.executed, verified: prepared.verified };

    const inspected = await call(first.client, 'resolve_inspect', { selector: 'timeline', timeline_unique_id: timelineId, limit: 50 });
    report.timeline_name = inspected.name;
    report.timeline_state = inspected.state;
    const marker = await call(first.client, 'resolve_set_marker', {
      timeline_unique_id: timelineId,
      operation_id: `${operationId}-marker`,
      frame: 0,
      name: 'CoS V1 canary',
      note: 'Harmless source-acceptance marker',
    });
    report.marker = { executed: marker.executed, verified: marker.verified, error: marker.error ?? null };

    const saveScript = [
      'import json,sys',
      'from dvr import Resolve',
      'r=Resolve(auto_launch=False, timeout=5.0, discover_remote=False)',
      'p=r.project.current',
      'assert p is not None and p.unique_id == sys.argv[1], "project identity changed before save"',
      'p.save()',
      'print(json.dumps({"saved":True,"project":p.name,"project_unique_id":p.unique_id}))',
      'r.close()',
    ].join(';');
    const saved = await execFile(launch.command, ['-c', saveScript, String(project.unique_id)], {
      cwd: dataDir,
      env: { ...pluginEnvironment(), ...davinciRuntimeEnvironment() },
      timeout: 15_000,
      windowsHide: true,
    });
    report.save = JSON.parse(saved.stdout.trim());

    const firstPid = first.transport.pid;
    await first.client.close();
    first = undefined;
    report.first_adapter_pid = firstPid ?? null;

    second = await connect();
    const restartedHealth = await call(second.client, 'resolve_health');
    expect(restartedHealth.code, JSON.stringify(restartedHealth)).toBe('READY');
    const replay = await call(second.client, 'resolve_prepare_ai_timeline', { operation_id: operationId, name: 'source_v1_canary' });
    expect(replay.executed, JSON.stringify(replay)).toBe(false);
    expect(replay.verified, JSON.stringify(replay)).toBe(true);
    expect(replay.after?.unique_id).toBe(timelineId);
    const afterTimelines = await call(second.client, 'resolve_inspect', { selector: 'timelines', limit: 100 });
    report.restart = { health: restartedHealth.code, same_owned_id: replay.after?.unique_id === timelineId, timeline_total: afterTimelines.total };
    report.review_artifact = 'BLOCKED_NO_SAFE_MEDIA_FIXTURE';
    console.log(`DAVINCI_LIVE_CANARY=${JSON.stringify(report)}`);
  } finally {
    if (first) await first.client.close().catch(() => undefined);
    if (second) await second.client.close().catch(() => undefined);
    await removeTempDir(temporary);
  }
}, 180_000);
