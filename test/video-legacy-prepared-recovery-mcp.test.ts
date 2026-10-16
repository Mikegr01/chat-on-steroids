import { expect, it } from 'vitest';
import { buildServer, type ToolContext } from '../src/main/mcp/tools.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';
import type { PluginToolSchema } from '../src/shared/plugin-refresh.js';
import { videoActionSchema } from '../src/main/video-editing/service.js';

it('publishes the narrow recovery intent fields within Core discovery limits and rejects forged predicates in the service', async () => {
  const ctx: ToolContext = { roots: [], caps: { ...DEFAULT_CAPABILITIES, read: true }, readOnly: false,
    sessionTools: false, agentTools: false, exposedFinishTool: false };
  let tools: PluginToolSchema[] = [];
  const server = buildServer(ctx, 'core', (_name, _version, _instructions, published) => { tools = published; });
  await server.close();
  const tool = tools.find(row => row.name === 'video_editing')!;
  const schema: any = tool.inputSchema;
  expect(schema.properties.action.enum).toContain('recover-legacy-prepared');
  expect(schema.properties.preparedHash.pattern).toBe('^[a-f0-9]{64}$');
  expect(schema.properties.operationId.format).toBe('uuid');
  expect(schema.additionalProperties).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(tool))).toBeLessThan(3000);
  const action = { action: 'recover-legacy-prepared', jobId: 'synthetic-job', expectedRevision: 16,
    preparedHash: 'a'.repeat(64), operationId: '00000000-0000-4000-8000-000000000016' };
  expect(videoActionSchema.parse(action)).toEqual(action);
  for (const field of ['legacy', 'noExecution', 'confirmation', 'sourceEnd', 'capabilityReceipt', 'authority', 'snapshot'])
    expect(videoActionSchema.safeParse({ ...action, [field]: true }).success).toBe(false);
});
