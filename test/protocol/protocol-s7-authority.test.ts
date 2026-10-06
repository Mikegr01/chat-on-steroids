import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

async function fixture() {
  const mod = await import('../../src/main/browser-transport/s7-authority.js');
  let disk: any = { version: 1, records: [] };
  let fail = false;
  const options = { read: async () => ({ kind: 'valid' as const, value: structuredClone(disk) }),
    write: async (value: unknown) => { if (fail) throw new Error('rejected'); disk = structuredClone(value); },
    gate: () => ({ enabled: true, initialized: true }) };
  const authority = new mod.S7Authority(options); await authority.recover();
  const id = randomUUID(), target = randomUUID(), sessionId = randomUUID();
  const row: any = { id, sessionId, conversationId: target, text: 'Private raw authored text', deliveryText: 'Private raw authored text',
    provenance: { kind: 'ordinary-composer', orchestratorRequested: false, modelChoice: 'current' },
    mode: 'auto', transportIntent: 'browser', dueAt: 0, model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 1 };
  const election: any = { commandId: `cmd_s7_${id}`, targetConversationId: target, tabId: 7, documentId: 'document_original',
    navigationEpoch: 3, connectionEpoch: 'connection_original', backgroundEmitterEpoch: 'background_original' };
  const context: any = { session: { id: sessionId, conversationId: target, origin: { kind: 'desktop' } }, uniqueSession: true,
    idle: true, automationOff: true, conflict: false, companion: false, current: () => true, election, ready: true, uniqueDocuments: 1 };
  const selected = await authority.select(row, context);
  if (selected.kind !== 'PROTOCOL_AUTHORITY') throw new Error('Missing S7 handoff');
  return { ...mod, authority, row, election, options, selected, disk: () => disk, setDisk: (value: any) => { disk = value; }, fail: () => { fail = true; } };
}

describe('S7 exact document and durable mutation boundaries', () => {
  it('typed handoff retains the original complete Chrome-derived tuple', async () => {
    const f = await fixture(); expect(f.selected.handoff.election).toEqual(f.election);
  });
  it('second election/document cannot claim or verify', async () => {
    const f = await fixture(); const replacement = { ...f.election, documentId: 'replacement' };
    expect((await f.authority.action('claim', replacement)).ok).toBe(false);
    expect((await f.authority.action('verify', replacement)).ok).toBe(false);
  });
  it('durable claim/start must precede insertion authority', async () => {
    const f = await fixture(); expect((await f.authority.action('start', f.election, { beforeNativeIds: [] })).ok).toBe(false);
    expect((await f.authority.action('claim', f.election)).ok).toBe(true);
    expect(f.disk().records[0].state).toBe('CLAIMED');
    expect((await f.authority.action('start', f.election, { beforeNativeIds: [] })).ok).toBe(true);
    expect(f.disk().records[0].state).toBe('EXECUTING');
    expect((await f.authority.action('start', f.election, { beforeNativeIds: [] })).ok).toBe(false);
  });
  it('failed start never publishes execution permission', async () => {
    const f = await fixture(); await f.authority.action('claim', f.election); f.fail();
    expect((await f.authority.action('start', f.election, { beforeNativeIds: [] })).ok).toBe(false);
    expect(f.disk().records[0].state).toBe('CLAIMED');
  });
  it.each([{ canonical: false }, { candidateCount: 2 }, { conversationId: 'wrong' }, { sourceText: 'display fallback' },
    { attachmentCount: 1 }, { nativeMessageId: '' }])('weak or foreign native evidence %j cannot commit', async patch => {
    const f = await fixture(); await f.authority.action('claim', f.election); await f.authority.action('start', f.election, { beforeNativeIds: [] });
    const proof = { canonical: true, candidateCount: 1, conversationId: f.row.conversationId,
      sourceText: f.row.text, attachmentCount: 0, nativeMessageId: 'native_new', ...patch };
    expect((await f.authority.action('commit', f.election, proof)).ok).toBe(false);
    expect(f.disk().records[0].state).toBe('EXECUTING');
  });
  it('canonical source commits durably and retires prompt bytes from tombstone', async () => {
    const f = await fixture(); await f.authority.action('claim', f.election); await f.authority.action('start', f.election, { beforeNativeIds: [] });
    expect((await f.authority.action('commit', f.election, { canonical: true, candidateCount: 1,
      conversationId: f.row.conversationId, sourceText: f.row.text, attachmentCount: 0, nativeMessageId: 'native_new' })).ok).toBe(true);
    expect(f.disk().records[0]).toMatchObject({ state: 'COMMITTED', proofLevel: 'STRONG_COMMIT', nativeMessageId: 'native_new' });
    expect(JSON.stringify(f.disk())).not.toContain(f.row.text);
  });
  it.each(['DISPATCHED', 'CLAIMED', 'EXECUTING', 'AMBIGUOUS'])('restart %s quarantines with no replay', async state => {
    const f = await fixture(); f.disk().records[0].state = state;
    const restarted = new f.S7Authority(f.options); await restarted.recover();
    expect(f.disk().records[0].state).toBe('AMBIGUOUS');
    expect((await restarted.action('claim', f.election)).ok).toBe(false);
    expect(restarted.blocks(f.row)).toBe(true);
  });
  it('initialized corrupt ledger fails closed instead of becoming empty', async () => {
    const f = await fixture(); f.setDisk({ version: 1, records: 'corrupt' });
    const restarted = new f.S7Authority(f.options); await restarted.recover();
    expect(restarted.blocks(f.row)).toBe(true);
    expect(f.disk().records).toBe('corrupt');
  });
  it('baseline native identity cannot become a new receipt', async () => {
    const f = await fixture(); await f.authority.action('claim', f.election);
    await f.authority.action('start', f.election, { beforeNativeIds: ['already_seen'] });
    expect((await f.authority.action('commit', f.election, { canonical: true, candidateCount: 1,
      conversationId: f.row.conversationId, sourceText: f.row.text, attachmentCount: 0, nativeMessageId: 'already_seen' })).ok).toBe(false);
  });
  it('rejected commit retains execution custody and exposes no receipt', async () => {
    const f = await fixture(); await f.authority.action('claim', f.election);
    await f.authority.action('start', f.election, { beforeNativeIds: [] }); f.fail();
    expect((await f.authority.action('commit', f.election, { canonical: true, candidateCount: 1,
      conversationId: f.row.conversationId, sourceText: f.row.text, attachmentCount: 0, nativeMessageId: 'native' })).ok).toBe(false);
    expect(f.authority.records()[0]?.state).toBe('EXECUTING');
    expect(f.disk().records[0].nativeMessageId).toBeUndefined();
  });
  it.each(['PERSISTED', 'BLOCKED'])('coherent unpublished %s cancels and consumes UUID', async state => {
    const f = await fixture(); f.disk().records[0].state = state; f.disk().records[0].published = false;
    const restarted = new f.S7Authority(f.options); await restarted.recover();
    expect(f.disk().records[0].state).toBe('CANCELED');
    expect(JSON.stringify(f.disk())).not.toContain(f.row.text);
    expect(restarted.blocks(f.row)).toBe(true);
  });
});

async function contentFixture(options: { failEvent?: string; canonical?: boolean; multiple?: boolean; replaceAt?: string; draft?: boolean } = {}) {
  const source = await fs.readFile(path.join(process.cwd(), 'extension/content.js'), 'utf8');
  const start = source.indexOf('  // S7 continues inside acceptDesktopInput'), end = source.indexOf('  // End S7 same-invocation document mutation.', start);
  const calls: string[] = [], rows: any[] = [];
  const composer = { textContent: options.draft ? 'User draft' : '' };
  const id = randomUUID(), target = randomUUID();
  const nativeNode = { getAttribute: () => 'native_new', querySelectorAll: () => [] };
  const sandbox = vm.createContext({ Date, Set, TextEncoder, alive: true, epoch: 3, desktopInputBusy: true,
    generating: false, pendingTools: 0, goalBusy: false, job: null,
    documentReady: Promise.resolve({ documentId: 'doc_original', navigationEpoch: 3 }),
    CLF_DOM: { conversationId: () => target, composerVisible: () => true, composerWritable: () => true,
      composer: () => composer, hasComposerAttachments: () => false, generating: () => false, securityOrAuthRequired: () => false,
      messages: () => rows, insertPrompt: (text: string) => { calls.push('insert'); composer.textContent = text; return true; },
      sendButton: () => ({ isConnected: true, disabled: false, getAttribute: () => null, getClientRects: () => [1],
        click: () => { calls.push('click'); rows.push({ role: 'user', id: 'native_new', node: nativeNode });
          if (options.multiple) rows.push({ role: 'user', id: 'other', node: nativeNode }); } }) },
    userMessageSource: () => ({ canonical: options.canonical !== false, text: 'Exact raw text', attachments: [] }),
    askFiber: async () => {}, waitPageView: async (read: () => unknown) => await read(),
    ask: async (message: any) => { const action = message.eventType || message.action; calls.push(action);
      if (options.replaceAt === action) sandbox.epoch = 4;
      if (options.failEvent === action) return { ok: false, accepted: false };
      return { ok: true, accepted: true, claimLeaseUntil: Date.now() + 5000 }; } });
  vm.runInContext(source.slice(start, end), sandbox);
  sandbox.handoff = { kind: 'S7_PROTOCOL_HANDOFF', command: { commandId: `cmd_s7_${id}`, commandType: 'SEND_MESSAGE',
    idempotencyKey: `s7_send:${id}`, conversationId: target, payload: { text: 'Exact raw text' } },
    election: { commandId: `cmd_s7_${id}`, targetConversationId: target, documentId: 'doc_original', navigationEpoch: 3 }, expiresAt: Date.now() + 5000 };
  return { sandbox, calls, execute: () => vm.runInContext('executeS7Handoff(handoff, () => true)', sandbox) };
}
describe('shipped S7 content executor', () => {
  it('uses the existing busy owner, durable start before insertion, and one physical click', async () => {
    const f = await contentFixture(); expect(await f.execute()).toBe(true); expect(await f.execute()).toBe(false);
    expect(f.calls).toEqual(['claim', 'COMMAND_CLAIMED', 'MESSAGE_SUBMIT_STARTED', 'insert', 'verify', 'click', 'MESSAGE_COMMITTED']);
    expect(vm.runInContext('desktopInputBusy', f.sandbox)).toBe(true);
  });
  it.each(['claim', 'COMMAND_CLAIMED', 'MESSAGE_SUBMIT_STARTED'])('rejected %s prevents insertion and click', async failEvent => {
    const f = await contentFixture({ failEvent }); expect(await f.execute()).toBe(false);
    expect(f.calls).not.toContain('insert'); expect(f.calls).not.toContain('click');
  });
  it.each(['COMMAND_CLAIMED', 'MESSAGE_SUBMIT_STARTED', 'verify'])('document replacement during %s grants no click or commit', async replaceAt => {
    const f = await contentFixture({ replaceAt }); expect(await f.execute()).toBe(false);
    expect(f.calls).not.toContain('click'); expect(f.calls).not.toContain('MESSAGE_COMMITTED');
  });
  it.each([{ canonical: false }, { multiple: true }])('weak native evidence %j cannot commit after a click', async options => {
    const f = await contentFixture(options); expect(await f.execute()).toBe(false);
    expect(f.calls.filter(call => call === 'click')).toHaveLength(1); expect(f.calls).not.toContain('MESSAGE_COMMITTED');
  });
  it('preserves an existing user draft without mutation', async () => {
    const f = await contentFixture({ draft: true }); expect(await f.execute()).toBe(false); expect(f.calls).toEqual(['abort']);
  });
});

async function backgroundFixture(secondAfterReady = false) {
  const source = await fs.readFile(path.join(process.cwd(), 'extension/background.js'), 'utf8');
  const start = source.indexOf('// S7 preflights the original desktop_input claim.'), end = source.indexOf('// MV3 service workers require static imports;', start);
  const target = randomUUID(), id = randomUUID(), calls: any[] = [];
  const socket = {}, tab = { id: 7 }, original = { tab: 7, documentId: 'doc_original', navigationEpoch: 3 };
  let second = false;
  const sandbox = vm.createContext({ Date, crypto: { randomUUID }, wakeSocket: socket, token: 'test-only', disconnected: false,
    protocolEmitterEpoch: 'emitter_original', CHATGPT_TAB_URLS: ['fixture'], tabDocuments: { 7: 'doc_original', 8: 'second' }, tabEpochs: { 7: 3, 8: 3 },
    ownsDocument: () => true, s6TabCurrent: () => true,
    chrome: { runtime: { getManifest: () => ({ version: '2.1.20' }) }, tabs: { get: async () => tab,
      query: async () => second ? [tab, { id: 8 }] : [tab] } },
    protocolCanaryCall: async (route: string, body: any) => { calls.push({ route, body });
      if (route === '/s7/hello') return { type: 'WELCOME', acceptedProtocolVersion: 1, negotiatedCapabilities: ['SEND_MESSAGE'], connectionGeneration: 0, connectionEpoch: 'connection_original' };
      if (route === '/s7/ready') { second = secondAfterReady; return { ready: true }; }
      return { accepted: true, ok: true }; } });
  vm.runInContext(source.slice(start, end), sandbox);
  sandbox.id = id; sandbox.target = target; sandbox.original = original;
  return { sandbox, target, calls, preflight: () => vm.runInContext('s7FirstClaim(id, original, target)', sandbox) };
}
describe('shipped S7 background preflight and evidence', () => {
  it('a second suitable document appearing during readiness rejects S7 before selection', async () => {
    const f = await backgroundFixture(true); expect(await f.preflight()).toBeNull();
  });
  it('same Chrome document tuple is frozen and actual source text is forwarded', async () => {
    const f = await backgroundFixture(); const flight = await f.preflight(); expect(flight.election.documentId).toBe('doc_original');
    vm.runInContext("s7Flight.command = { sessionId: 'session_original', payload: { text: 'authored command' } }", f.sandbox);
    f.sandbox.message = { commandId: flight.election.commandId, navigationEpoch: 3, action: 'event', eventType: 'MESSAGE_COMMITTED',
      payload: { canonical: true, candidateCount: 1, attachmentCount: 0, conversationId: f.target, sourceText: 'ACTUAL native bytes', nativeMessageId: 'native_new' } };
    await vm.runInContext("s7ContentRequest(message, { frameId: 0, tab: { id: 7 }, documentId: 'doc_original' }, original)", f.sandbox);
    expect(f.calls.at(-1).body.event.payload.matchedText).toBe('ACTUAL native bytes');
    expect(f.calls.at(-1).body.sourceProof.sourceText).toBe('ACTUAL native bytes');
    expect(f.calls.map(c => c.route)).toEqual(['/s7/hello', '/s7/ready', '/s7/action']);
  });
});
