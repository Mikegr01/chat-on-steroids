import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

// Import inside each test so HEAD's missing authority is a genuine RED assertion.
async function fixture() {
  const { S7Authority } = await import('../src/main/browser-transport/s7-authority.js');
  let disk: any = { version: 1, records: [] };
  let fail = false;
  const gate = { enabled: true, initialized: true };
  const options = { read: async () => ({ kind: 'valid' as const, value: structuredClone(disk) }),
    write: async (value: unknown) => { if (fail) throw new Error('disk rejected'); disk = structuredClone(value); },
    gate: () => gate };
  const authority = new S7Authority(options);
  await authority.recover();
  const id = randomUUID(), target = randomUUID();
  const row: any = { id, sessionId: randomUUID(), conversationId: target, text: 'Exact authored text', deliveryText: 'Exact authored text',
    provenance: { kind: 'ordinary-composer', orchestratorRequested: false, modelChoice: 'current' },
    mode: 'auto', transportIntent: 'browser', dueAt: 0, model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: Date.now() };
  const context: any = { session: { id: row.sessionId, conversationId: target, origin: { kind: 'desktop' } },
    uniqueSession: true, idle: true, automationOff: true, conflict: false, companion: false,
    current: () => true, election: { commandId: `cmd_s7_${id}`, targetConversationId: target, tabId: 7,
      documentId: 'document_original', navigationEpoch: 3, connectionEpoch: 'connection_original', backgroundEmitterEpoch: 'background_original' },
    ready: true, uniqueDocuments: 1 };
  return { S7Authority, options, authority, row, context, gate, disk: () => disk, setDisk: (value: any) => { disk = value; }, fail: () => { fail = true; } };
}

describe('S7 selective cross-transport ownership', () => {
  it('default OFF preserves legacy authority', async () => {
    const f = await fixture(); f.gate.enabled = false;
    expect((await f.authority.select(f.row, f.context)).kind).toBe('LEGACY_AUTHORITY');
    expect(f.disk().records).toHaveLength(0);
  });
  it('ordinary explicit composer provenance is required', async () => {
    const f = await fixture(); delete f.row.provenance;
    expect((await f.authority.select(f.row, f.context)).kind).toBe('LEGACY_AUTHORITY');
  });
  it('orchestrator intent excludes an ordinary-looking send', async () => {
    const f = await fixture(); f.row.provenance.orchestratorRequested = true;
    expect((await f.authority.select(f.row, f.context)).kind).toBe('LEGACY_AUTHORITY');
  });
  it('eligible UUID obtains its exact durable Protocol owner before publication', async () => {
    const f = await fixture(); const result = await f.authority.select(f.row, f.context);
    expect(result.kind).toBe('PROTOCOL_AUTHORITY');
    if (result.kind !== 'PROTOCOL_AUTHORITY') throw new Error('Missing S7 handoff');
    expect(result.handoff.command.commandId).toBe(`cmd_s7_${f.row.id}`);
    expect(result.handoff.command.idempotencyKey).toBe(`s7_send:${f.row.id}`);
    expect(f.disk().records[0].inputId).toBe(f.row.id);
    expect(f.authority.blocks(f.row)).toBe(true);
  });
  it.each(['images', 'attachments', 'toolImages', 'stages'])('%s excludes the send', async field => {
    const f = await fixture(); f.row[field] = [{}];
    expect((await f.authority.select(f.row, f.context)).kind).toBe('LEGACY_AUTHORITY');
  });
  it.each([{ model: 'override' }, { reasoningEffort: 'high' }, { mode: 'after-turn' }, { objective: 'goal' },
    { recovery: {} }, { directTurn: {} }, { queuedTurn: {} }, { finishOwner: {} }, { lifetime: 'temporary-planner' },
    { purpose: 'decision' }, { offeredAt: 1 }, { sendAuthorizedAt: 1 }, { text: 'two\nlines' }, { deliveryText: 'transformed' },
    { loopAfterTurn: true }, { delivery: 'tool' }, { requestedMode: 'after-turn' }, { afterTurn: true },
    { error: 'previous delivery failed' }, { text: 'x'.repeat(4097) }])(
    'excluded input %j stays legacy', async patch => {
      const f = await fixture(); Object.assign(f.row, patch);
      expect((await f.authority.select(f.row, f.context)).kind).toBe('LEGACY_AUTHORITY');
    });
  it('a second suitable document defers before selecting', async () => {
    const f = await fixture(); f.context.uniqueDocuments = 2;
    expect((await f.authority.select(f.row, f.context)).kind).toBe('DEFER');
    expect(f.disk().records).toHaveLength(0);
  });
  it('authority persistence failure grants no handoff', async () => {
    const f = await fixture(); f.fail();
    expect((await f.authority.select(f.row, f.context)).kind).toBe('DEFER');
    expect(f.disk().records).toHaveLength(0);
  });
  it('lost input projection and disable cannot expose an owned UUID to legacy', async () => {
    const f = await fixture(); await f.authority.select(f.row, f.context); f.gate.enabled = false;
    expect(f.authority.blocks({ ...f.row, provenance: undefined })).toBe(true);
    expect((await f.authority.select(f.row, f.context)).kind).toBe('DEFER');
  });
  it('same-target custody blocks while unrelated legacy target stays usable', async () => {
    const f = await fixture(); await f.authority.select(f.row, f.context);
    expect(f.authority.targetHeld(f.row.conversationId)).toBe(true);
    expect(f.authority.targetHeld(randomUUID())).toBe(false);
  });
  it('one global flight defers another eligible target', async () => {
    const f = await fixture(); await f.authority.select(f.row, f.context);
    f.row.id = randomUUID(); f.row.conversationId = randomUUID();
    f.context.session.conversationId = f.row.conversationId;
    f.context.election.commandId = `cmd_s7_${f.row.id}`; f.context.election.targetConversationId = f.row.conversationId;
    expect((await f.authority.select(f.row, f.context)).kind).toBe('DEFER');
  });
  it('stale tuple cannot select Protocol', async () => {
    const f = await fixture(); f.context.current = () => false;
    expect((await f.authority.select(f.row, f.context)).kind).toBe('DEFER');
  });
  it.each(['idle', 'ready', 'automationOff', 'uniqueSession'])('%s must remain proven', async field => {
    const f = await fixture(); f.context[field] = false;
    expect((await f.authority.select(f.row, f.context)).kind).toBe(field === 'automationOff' || field === 'uniqueSession' ? 'LEGACY_AUTHORITY' : 'DEFER');
  });
  it('200 retained tombstones defer without evicting a consumed UUID', async () => {
    const f = await fixture(); await f.authority.select(f.row, f.context); await f.authority.action('abort', f.context.election);
    const original = structuredClone(f.disk().records[0]);
    const records = [original, ...Array.from({ length: 199 }, () => {
      const id = randomUUID(); return { ...original, inputId: id, commandId: `cmd_s7_${id}`, idempotencyKey: `s7_send:${id}`,
        election: { ...original.election, commandId: `cmd_s7_${id}` } };
    })];
    f.setDisk({ version: 1, records }); await f.authority.recover();
    expect((await f.authority.select(f.row, f.context)).kind).toBe('DEFER');
    const id = randomUUID(); f.row.id = id; f.context.election.commandId = `cmd_s7_${id}`;
    expect((await f.authority.select(f.row, f.context)).kind).toBe('DEFER');
    expect(f.disk().records).toHaveLength(200); expect(f.disk().records[0]).toEqual(original);
    f.gate.enabled = false;
    expect((await f.authority.select(f.row, f.context)).kind).toBe('LEGACY_AUTHORITY');
  });
  it.each(['absent', 'malformed', 'unreadable', 'unavailable'] as const)('initialized %s ledger fails closed without a write', async kind => {
    const f = await fixture(); let writes = 0;
    const authority = new f.S7Authority({ gate: () => f.gate, read: async () => ({ kind }), write: async () => { writes++; } });
    await authority.recover(); expect(authority.blocks(f.row)).toBe(true);
    expect((await authority.select(f.row, f.context)).kind).toBe('DEFER'); expect(writes).toBe(0);
  });
  it('oversized serialized ledger fails closed', async () => {
    const f = await fixture(); await f.authority.select(f.row, f.context);
    f.disk().records[0].beforeNativeIds = Array.from({ length: 1000 }, () => 'x'.repeat(256));
    // Invalid oversized generations are rejected rather than truncated to fit.
    f.disk().padding = 'private'.repeat(160000);
    await f.authority.recover(); expect(f.authority.blocks({ id: randomUUID() })).toBe(true);
  });
  it('conservative OFF config cannot erase unreadable existing custody', async () => {
    const f = await fixture(); f.gate.enabled = false; f.gate.initialized = false;
    f.setDisk({ version: 1, records: 'broken retained custody' }); await f.authority.recover();
    expect(f.authority.blocks(f.row)).toBe(true);
    expect(f.authority.targetHeld(f.row.conversationId)).toBe(true);
    expect((await f.authority.select(f.row, f.context)).kind).toBe('DEFER');
  });
  it('warm malformed custody defers before publication and cannot be overwritten', async () => {
    const f = await fixture(); f.setDisk({ version: 1, records: 'corrupt after load' });
    expect((await f.authority.select(f.row, f.context)).kind).toBe('DEFER');
    expect(f.disk().records).toBe('corrupt after load'); expect(f.authority.blocks({ id: randomUUID() })).toBe(true);
  });
  it('warm malformed custody cannot grant a durable claim', async () => {
    const f = await fixture(); await f.authority.select(f.row, f.context); f.setDisk({ version: 1, records: 'corrupt after selection' });
    expect((await f.authority.action('claim', f.context.election)).ok).toBe(false);
    expect(f.disk().records).toBe('corrupt after selection');
  });
  it.each(['absent', 'malformed', 'unreadable', 'unavailable'] as const)('warm %s custody revokes the final physical mutation grant', async kind => {
    const f = await fixture(); await f.authority.select(f.row, f.context); await f.authority.action('claim', f.context.election);
    await f.authority.action('start', f.context.election, { beforeNativeIds: [] });
    const spy = vi.spyOn(f.options, 'read').mockResolvedValue({ kind } as any);
    expect((await f.authority.action('verify', f.context.election)).ok).toBe(false);
    expect(f.authority.records()[0]?.state).toBe('EXECUTING'); expect(f.authority.blocks({ id: randomUUID() })).toBe(true);
    spy.mockRestore();
  });
  it('a schema-valid external ledger replacement cannot discard consumed identities', async () => {
    const f = await fixture(); await f.authority.select(f.row, f.context); await f.authority.action('claim', f.context.election);
    await f.authority.action('start', f.context.election, { beforeNativeIds: [] }); f.setDisk({ version: 1, records: [] });
    expect((await f.authority.action('verify', f.context.election)).ok).toBe(false);
    expect(f.authority.blocks(f.row)).toBe(true); expect(f.disk().records).toEqual([]);
  });
  it('disable waits behind selection durability and preserves the selected custody', async () => {
    const f = await fixture(); let release!: () => void, enter!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
    const authority = new f.S7Authority({ ...f.options, write: async value => { enter(); await blocked; await f.options.write(value); } });
    await authority.recover(); const selected = authority.select(f.row, f.context); await entered;
    const disabled = authority.withSettings(async () => { f.gate.enabled = false; });
    expect(authority.targetHeld(f.row.conversationId)).toBe(true);
    release(); expect((await selected).kind).toBe('PROTOCOL_AUTHORITY'); await disabled;
    expect(authority.blocks(f.row)).toBe(true);
    expect((await authority.action('claim', f.context.election)).ok).toBe(true);
  });
  it('rejected delayed ownership never publishes a newer memory generation', async () => {
    const f = await fixture(); let reject!: (reason: Error) => void, enter!: () => void;
    const blocked = new Promise<void>((_, no) => { reject = no; }), entered = new Promise<void>(resolve => { enter = resolve; });
    const authority = new f.S7Authority({ ...f.options, write: async () => { enter(); await blocked; } });
    await authority.recover(); const selected = authority.select(f.row, f.context); await entered;
    expect(authority.blocks(f.row)).toBe(true); // synchronous reservation only
    reject(new Error('fixture rejected')); expect((await selected).kind).toBe('DEFER');
    expect(authority.blocks(f.row)).toBe(false); expect(authority.records()).toEqual([]); expect(f.disk().records).toEqual([]);
  });
});
