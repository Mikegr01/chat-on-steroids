import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Client, UnauthorizedError } from '@modelcontextprotocol/client';
import { initConfigPath, loadConfig, getConfig, updateConfig, effectiveCapabilities } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore } from '../src/main/session/store.js';
import { flushRecorder } from '../src/main/session/recorder.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { pluginManager as manager } from '../src/main/plugins/manager.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const secrets = vi.hoisted(() => new Map<string, string>());
vi.mock('../src/main/secrets.js', () => ({
  getSecret: async (key: string) => secrets.get(key) ?? null,
  setSecret: async (key: string, value: string) => { secrets.set(key, value); },
  clearSecret: async (key: string) => { secrets.delete(key); },
}));

let directory: string, endpoint: McpEndpoint, sequence = 0;
beforeEach(async () => {
  directory = await makeTempDir('plugins-resources-');
  initConfigPath(directory); await loadConfig(); initDurableStore(directory); initSessionStore(directory);
  await updateConfig(config => ({ ...config, multiAgent: { ...config.multiAgent, enabled: false } }));
  await manager.initialize(directory);
  endpoint = await startMcpServer(() => ({ roots: [], caps: effectiveCapabilities(getConfig()), readOnly: getConfig().readOnly }));
  secrets.clear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await endpoint?.stop(); await manager.close(); await flushRecorder(); resetDurableForTests();
  await removeTempDir(directory);
});
async function rpc(method: string, params: Record<string, unknown> = {}, surface: 'plugins' | 'core' | 'desktop' = 'plugins'): Promise<any> {
  const response = await fetch(endpoint.urls[surface], {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }),
  });
  const raw = await response.text();
  return JSON.parse(raw.startsWith('{') ? raw : [...raw.matchAll(/^data: (.+)$/gm)].at(-1)![1]!);
}
const list = () => rpc('resources/list');
const read = (uri: string) => rpc('resources/read', { uri });
const missing = (response: any) => expect(response.error).toMatchObject({ code: -32602 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function install(name: string, meta: unknown, behavior = 'normal', toolName = name) {
  const file = path.join(directory, `${name}.json`);
  const tools = [{ name: toolName, inputSchema: { type: 'object' }, _meta: meta }];
  await fs.writeFile(file, JSON.stringify(tools));
  const script = path.join(directory, `${name}.cjs`);
  await fs.writeFile(script, `const fs=require('node:fs'), readline=require('node:readline');
const toolsFile=${JSON.stringify(file)}, behavior=${JSON.stringify(behavior)}, owner=${JSON.stringify(name)};
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(m.id===undefined)return;
 let result;
 if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{listChanged:true},resources:{}},serverInfo:{name:owner,version:'1'}};
 else if(m.method==='tools/list')result={tools:JSON.parse(fs.readFileSync(toolsFile,'utf8'))};
 else if(m.method==='tools/call'){
   result={content:[{type:'text',text:owner}]};
   if(m.params.arguments?.refresh)send({jsonrpc:'2.0',method:'notifications/tools/list_changed'});
 } else if(m.method==='resources/read'){
   if(behavior==='error'){send({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'fixture upstream error Bearer fixture-credential-value',data:{private:'fixture-credential-value'}}});return;}
   if(behavior==='disconnect'){process.exit(1);return;}
   const uri=behavior==='foreign'?'ui://another-owner/view':m.params.uri;
   result=behavior==='malformed'?{contents:[{uri,text:4}]}:
     {contents:[{uri,mimeType:'text/html;profile=mcp-app',text:behavior==='oversized'?'x'.repeat(17*1024*1024):'<main>'+owner+' '+(process.env.TEST_SECRET||'safe')+'</main>',_meta:{ui:{prefersBorder:true}}}],_meta:{fixture:owner}};
 }
 send({jsonrpc:'2.0',id:m.id,result:result||{}});
});`);
  const snapshot = await manager.install({ name, source: { kind: 'command', command: process.execPath, args: [script] },
    credentials: { TEST_SECRET: 'fixture-credential-value' } });
  const row = snapshot.plugins.at(-1)!;
  expect(row.status).toBe(meta === null || Array.isArray(meta) ? 'error' : 'ready');
  return { id: row.id, file, tools };
}

it.each(['openai', 'nested'])('lists and reads %s UI metadata through only the Plugins protocol surface', async shape => {
  const uri = 'ui://fixture/view';
  await install('viewer', shape === 'openai' ? { 'openai/outputTemplate': uri } : { ui: { resourceUri: uri } });
  expect((await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })).result.capabilities.resources).toEqual({});
  expect((await list()).result).toEqual({ resources: [{ uri, name: uri }] });
  const result = (await read(uri)).result;
  expect(result).toEqual({ contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<main>viewer [redacted]</main>', _meta: { ui: { prefersBorder: true } } }], _meta: { fixture: 'viewer' } });
  for (const surface of ['core', 'desktop'] as const) {
    expect((await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } }, surface)).result.capabilities.resources).toBeUndefined();
    expect((await rpc('resources/read', { uri }, surface)).error).toBeDefined();
  }
});

it('lists an empty resource catalog and refuses unknown UI, file, network and filesystem identifiers without dispatch', async () => {
  expect((await list()).result).toEqual({ resources: [] });
  const upstream = vi.spyOn(Client.prototype, 'readResource');
  for (const uri of ['ui://unknown/view', 'file:///private.txt', 'https://example.com/private', 'http://127.0.0.1/private', '/private.txt', 'C:\\private.txt']) missing(await read(uri));
  expect(upstream).not.toHaveBeenCalled();
});

it('deduplicates and sorts exact URIs without inventing resource metadata or changing tool-call ownership', async () => {
  await install('zulu', { 'openai/outputTemplate': 'ui://z/view', ui: { resourceUri: 'ui://z/view' } });
  await install('alpha', { ui: { resourceUri: 'ui://a/view' } });
  expect((await list()).result.resources).toEqual([{ uri: 'ui://a/view', name: 'ui://a/view' }, { uri: 'ui://z/view', name: 'ui://z/view' }]);
  expect(JSON.stringify((await read('ui://a/view')).result)).toContain('alpha');
  expect(JSON.stringify((await read('ui://z/view')).result)).toContain('zulu');
  expect((await manager.call('zulu')).content).toEqual([{ type: 'text', text: 'zulu' }]);
  expect((await manager.call('alpha')).content).toEqual([{ type: 'text', text: 'alpha' }]);
});

it('fails closed on shared URI claims, retains disabled claims and releases ownership only after uninstall', async () => {
  const uri = 'ui://same/view';
  const first = await install('first', { 'openai/outputTemplate': uri });
  await install('second', { ui: { resourceUri: uri } });
  const upstream = vi.spyOn(Client.prototype, 'readResource');
  expect((await list()).result.resources).toEqual([]);
  expect((await read(uri)).error.message).toContain('RESOURCE_COLLISION');
  await manager.setEnabled(first.id, false);
  expect((await list()).result.resources).toEqual([]);
  expect((await read(uri)).error.message).toContain('RESOURCE_COLLISION');
  expect(upstream).not.toHaveBeenCalled();
  await manager.uninstall(first.id);
  expect((await list()).result.resources).toEqual([{ uri, name: uri }]);
  expect(JSON.stringify((await read(uri)).result)).toContain('second');
});

it('does not let duplicate tool names establish resource authority', async () => {
  await install('first', { ui: { resourceUri: 'ui://first/view' } }, 'normal', 'shared_tool');
  await install('second', { ui: { resourceUri: 'ui://second/view' } }, 'normal', 'shared_tool');
  expect(manager.tools()).toEqual([]);
  expect((await list()).result.resources).toEqual([]);
  missing(await read('ui://first/view')); missing(await read('ui://second/view'));
});

it('retires resources on tool disable, plugin disable, reconnect with new metadata and uninstall', async () => {
  const uri = 'ui://lifecycle/old', next = 'ui://lifecycle/new';
  const owner = await install('owner', { ui: { resourceUri: uri } });
  await manager.setToolEnabled(owner.id, 'owner', false);
  expect((await list()).result.resources).toEqual([]); missing(await read(uri));
  await manager.setToolEnabled(owner.id, 'owner', true);
  expect((await read(uri)).result).toBeDefined();
  const disabling = manager.setEnabled(owner.id, false);
  expect((await list()).result.resources).toEqual([]); missing(await read(uri));
  await disabling; await manager.setEnabled(owner.id, true);
  owner.tools[0]!._meta = { ui: { resourceUri: next } };
  await fs.writeFile(owner.file, JSON.stringify(owner.tools)); await manager.restart(owner.id);
  missing(await read(uri)); expect((await read(next)).result).toBeDefined();
  const removal = manager.uninstall(owner.id);
  expect((await list()).result.resources).toEqual([]); missing(await read(next)); await removal;
});

it.each([null, [], { ui: [] }, { ui: { resourceUri: 7 } }, { 'ui/resourceUri': 'ui://legacy/view' },
  { ui: { resourceUri: 'file:///private' } }, { ui: { resourceUri: 'http://example.com/private' } },
  { ui: { resourceUri: 'ui://user:password@fixture/view' } }, { ui: { resourceUri: ' ui://fixture/view' } },
  { ui: { resourceUri: 'ui://fixture/' + 'x'.repeat(8192) } }].map((meta, index) => ({ meta, index })))('ignores malformed or unsupported metadata safely (case $index)', async ({ meta }) => {
  await install('invalid', meta);
  expect((await list()).result.resources).toEqual([]);
});

it('enforces the admitted tool/schema budget on resource discovery', async () => {
  const owner = await install('budget', {});
  const tools = Array.from({ length: 3 }, (_, index) => ({ name: `large_${index}`, description: 'x'.repeat(100000), inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: `ui://budget/${index}` } } }));
  await fs.writeFile(owner.file, JSON.stringify(tools)); await manager.restart(owner.id);
  expect((await list()).result.resources).toEqual([{ uri: 'ui://budget/0', name: 'ui://budget/0' }, { uri: 'ui://budget/1', name: 'ui://budget/1' }]);
  missing(await read('ui://budget/2'));
});

it.each(['malformed', 'foreign', 'oversized', 'disconnect'])('rejects %s resource responses and retires a broken owner', async behavior => {
  const uri = 'ui://broken/view';
  await install('broken', { ui: { resourceUri: uri } }, behavior);
  expect((await read(uri)).error).toMatchObject({ code: -32603 });
  expect((await list()).result.resources).toEqual([]);
});

it('keeps upstream protocol errors distinct, redacts credentials and private error data, and permits later reads', async () => {
  const uri = 'ui://failure/view';
  await install('failure', { ui: { resourceUri: uri } }, 'error');
  const response = await read(uri);
  expect(response.error).toMatchObject({ code: -32603, message: expect.stringContaining('fixture upstream error') });
  expect(JSON.stringify(response)).not.toContain('fixture-credential-value');
  expect(response.error.data).toBeUndefined();
  expect((await list()).result.resources).toEqual([{ uri, name: uri }]);
});

it('refuses resource reads in read-only mode before upstream dispatch', async () => {
  const uri = 'ui://readonly/view';
  await install('readonly', { ui: { resourceUri: uri } });
  const upstream = vi.spyOn(Client.prototype, 'readResource');
  await updateConfig(config => ({ ...config, readOnly: true }));
  expect((await list()).result.resources).toEqual([]);
  expect((await read(uri)).error.message).toContain('TOOL_DISABLED');
  expect(upstream).not.toHaveBeenCalled();
});

it('does not publish credential-bearing resource identifiers', async () => {
  const uri = 'ui://fixture/fixture-credential-value';
  await install('secret-uri', { ui: { resourceUri: uri } });
  const upstream = vi.spyOn(Client.prototype, 'readResource');
  expect((await list()).result.resources).toEqual([]);
  const result = await read(uri); missing(result);
  expect(JSON.stringify(result)).not.toContain('fixture-credential-value');
  expect(upstream).not.toHaveBeenCalled();
});

it('preserves opaque blobs while redacting resource text and metadata', async () => {
  const uri = 'ui://binary/view', blob = Buffer.from('opaque fixture bytes').toString('base64');
  const owner = await install('binary', { ui: { resourceUri: uri } });
  await manager.configure(owner.id, { credentials: { OPAQUE_BLOB: blob } });
  vi.spyOn(Client.prototype, 'readResource').mockResolvedValueOnce({
    contents: [{ uri, mimeType: 'application/octet-stream', blob, _meta: { secret: 'fixture-credential-value' } }],
    _meta: { secret: 'fixture-credential-value' },
  });
  expect((await read(uri)).result).toEqual({ contents: [{ uri, mimeType: 'application/octet-stream', blob, _meta: { secret: '[redacted]' } }], _meta: { secret: '[redacted]' } });
});

it('preserves protocol MIME values when a credential happens to match their text', async () => {
  const uri = 'ui://mime/view';
  const owner = await install('mime', { ui: { resourceUri: uri } });
  await manager.configure(owner.id, { credentials: { MIME_FRAGMENT: 'text/html' } });
  expect((await read(uri)).result.contents[0].mimeType).toBe('text/html;profile=mcp-app');
});

it('enforces the decoded response bound even when transport framing accepts the response', async () => {
  const uri = 'ui://size/view';
  await install('size', { ui: { resourceUri: uri } });
  vi.spyOn(Client.prototype, 'readResource').mockResolvedValueOnce({ contents: [{ uri, text: 'x'.repeat(16 * 1024 * 1024) }] });
  expect((await read(uri)).error).toMatchObject({ code: -32603 });
  expect((await list()).result.resources).toEqual([]);
});

it('retires resource access after authorization fails without automatic reconnect or sign-in', async () => {
  const uri = 'ui://auth/view';
  await install('auth', { ui: { resourceUri: uri } });
  const upstream = vi.spyOn(Client.prototype, 'readResource').mockRejectedValueOnce(new UnauthorizedError());
  expect((await read(uri)).error).toBeDefined();
  expect(manager.snapshot().plugins[0]?.status).toBe('needs-auth');
  expect((await list()).result.resources).toEqual([]); missing(await read(uri));
  expect(upstream).toHaveBeenCalledTimes(1);
});

it.each(['disable', 'uninstall', 'restart', 'tool-disable', 'collision', 'read-only', 'shutdown'])('rejects a delayed response after %s changes its authority', async action => {
  const uri = 'ui://race/view';
  const owner = await install('race', { ui: { resourceUri: uri } });
  const entered = deferred<void>(), resume = deferred<void>();
  const original = Client.prototype.readResource;
  const upstream = vi.spyOn(Client.prototype, 'readResource').mockImplementationOnce(async function (this: Client, params, options) {
    const result = await original.call(this, params, options);
    entered.resolve(); await resume.promise; return result;
  });
  const pending = read(uri); await entered.promise;
  try {
    if (action === 'disable') await manager.setEnabled(owner.id, false);
    else if (action === 'uninstall') await manager.uninstall(owner.id);
    else if (action === 'restart') await manager.restart(owner.id);
    else if (action === 'tool-disable') await manager.setToolEnabled(owner.id, 'race', false);
    else if (action === 'read-only') await updateConfig(config => ({ ...config, readOnly: true }));
    else if (action === 'shutdown') await manager.close();
    else await install('other', { ui: { resourceUri: uri } });
  } finally { resume.resolve(); }
  expect((await pending).error).toBeDefined();
  expect(upstream).toHaveBeenCalledWith({ uri }, expect.objectContaining({ cacheMode: 'bypass' }));
});

it.each(['same URI', 'new URI'])('withholds resources during refresh and rejects the previous catalog result after publication (%s)', async change => {
  const uri = 'ui://refresh/old', next = change === 'same URI' ? uri : 'ui://refresh/new';
  const owner = await install('refresh', { ui: { resourceUri: uri } });
  const readEntered = deferred<void>(), readResume = deferred<void>();
  const originalRead = Client.prototype.readResource;
  vi.spyOn(Client.prototype, 'readResource').mockImplementationOnce(async function (this: Client, params, options) {
    const result = await originalRead.call(this, params, options);
    readEntered.resolve(); await readResume.promise; return result;
  });
  const pending = read(uri); await readEntered.promise;
  const refreshEntered = deferred<void>(), refreshResume = deferred<void>();
  const originalRequest = Client.prototype.request;
  vi.spyOn(Client.prototype, 'request').mockImplementation((async function (this: Client, ...args: Parameters<Client['request']>) {
    if (args[0].method === 'tools/list') { refreshEntered.resolve(); await refreshResume.promise; }
    return originalRequest.apply(this, args);
  }) as Client['request']);
  owner.tools[0]!._meta = { ui: { resourceUri: next } };
  await fs.writeFile(owner.file, JSON.stringify(owner.tools));
  const refreshed = deferred<void>();
  const unsubscribe = manager.onChanged(() => { if (manager.snapshot().plugins[0]?.status === 'ready') refreshed.resolve(); });
  try {
    await manager.call('refresh', { refresh: true }); await refreshEntered.promise;
    expect((await list()).result.resources).toEqual([]);
    refreshResume.resolve(); await refreshed.promise;
    readResume.resolve(); expect((await pending).error).toBeDefined();
    expect((await list()).result.resources).toEqual([{ uri: next, name: next }]);
    if (next !== uri) missing(await read(uri));
    expect((await read(next)).result).toBeDefined();
  } finally { unsubscribe(); refreshResume.resolve(); readResume.resolve(); }
});
