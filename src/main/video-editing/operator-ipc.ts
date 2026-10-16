import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { videoIdSchema, nativeVideoExecutionInputSchema } from '../../shared/video-editing.js';
import { authenticateCapabilityOperator, type CapabilityOperatorReview } from './capability-operator-proof.js';
import { runUcvValidation } from './ucv-validation.js';
import { authenticateNativeExecution, type NativeExecutionReview } from './native-execution-principal.js';
export interface VideoOperatorPorts {
  lifecycle?: Pick<import('electron').App, 'on' | 'removeListener'>;
  admit(paths:unknown,confirm:(detail:string)=>Promise<boolean>,assertOwner:()=>Promise<void>):Promise<unknown>;
  pick(tool:'ffprobe'|'ffmpeg'):Promise<string|null>;
  diagnostics():Promise<unknown>;
  confirm(detail:string):Promise<boolean>;
  inspect(jobId:string):Promise<unknown>;
  authorize(jobId:string,preparedHash:string,confirm:(detail:string)=>Promise<boolean>):Promise<unknown>;
  authenticateCapability?(window:BrowserWindow,detail:string,assertCurrent:()=>Promise<void>):Promise<'windows-user-consent-verifier'|null>;
  confirmCapabilityAdmission?(jobId:string,expectedFingerprint:string,review:CapabilityOperatorReview,assertOwner:()=>void):Promise<unknown>;
  execute?(input: z.infer<typeof nativeVideoExecutionInputSchema>, review: NativeExecutionReview,
    confirm: (detail: string) => Promise<boolean>, assertOwner: () => void): Promise<unknown>;
}
/** Fixed native operator routes; execution authority issuance remains renderer-only. */
export function registerVideoOperatorIpc(
  handle:(name:string,fn:(payload:unknown,event:IpcMainInvokeEvent)=>Promise<unknown>)=>void,
  getWindow:()=>BrowserWindow|null, ports:VideoOperatorPorts
) {
  let stopping = false;
  ports.lifecycle?.on('before-quit', () => { stopping = true; });
  const trusted=(event:IpcMainInvokeEvent)=>{
    const window=getWindow();
    if(!window||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame) throw new Error('Trusted main renderer required');
  };
  // Native admission and verification share the exact sender/window/lifecycle fence.
  async function withVerificationOwner<T>(event: IpcMainInvokeEvent,
    work: (window: BrowserWindow, assertOwner: () => void) => Promise<T>): Promise<T> {
    if (stopping) throw new Error('Operator verification unavailable during shutdown');
    trusted(event);
    const window = getWindow()!, contents = window.webContents;
    let valid = true;
    const invalidate = () => { valid = false; };
    const assertOwner = () => {
      trusted(event);
      if (!valid || getWindow() !== window || window.isDestroyed() || contents.isDestroyed())
        throw new Error('Operator renderer lifecycle changed');
    };
    // Object identity alone cannot detect navigation A → B → A in one webContents.
    contents.on('did-start-navigation', invalidate);
    contents.on('render-process-gone', invalidate);
    contents.on('destroyed', invalidate);
    window.on('close', invalidate);
    window.on('closed', invalidate);
    ports.lifecycle?.on('before-quit', invalidate);
    try { assertOwner(); return await work(window, assertOwner); }
    finally {
      valid = false;
      contents.removeListener('did-start-navigation', invalidate);
      contents.removeListener('render-process-gone', invalidate);
      contents.removeListener('destroyed', invalidate);
      window.removeListener('close', invalidate);
      window.removeListener('closed', invalidate);
      ports.lifecycle?.removeListener('before-quit', invalidate);
    }
  }
  let validationPending = false;
  handle('video:validate-ucv', async (payload, event) => {
    trusted(event); z.undefined().parse(payload);
    if (validationPending) throw new Error('UCV validation already pending');
    if (!ports.authenticateCapability) throw new Error('Independent operator authentication unavailable');
    validationPending = true;
    try {
      return await withVerificationOwner(event, (window, assertOwner) => runUcvValidation({
        confirm: detail => ports.confirm(detail), assertOwner,
        authenticate: (message, assertCurrent) => ports.authenticateCapability!(window, message,
          async () => { assertOwner(); assertCurrent(); assertOwner(); }),
      }));
    } finally { validationPending = false; }
  });
  handle('video:runtime-status',async(payload,event)=>{trusted(event);z.undefined().parse(payload);return ports.diagnostics();});
  handle('video:runtime-pick',async(payload,event)=>{
    trusted(event);const tool=z.enum(['ffprobe','ffmpeg']).parse(payload);
    const selected=await ports.pick(tool);trusted(event);return selected;
  });
  handle('video:runtime-admit',async(payload,event)=>{
    trusted(event);
    return ports.admit(payload, async detail=>{trusted(event);const answer=await ports.confirm(detail);trusted(event);return answer;},async()=>{trusted(event);});
  });
  handle('video:inspect',async(payload,event)=>{trusted(event);const input=z.object({jobId:videoIdSchema}).strict().parse(payload);return ports.inspect(input.jobId);});
  handle('video:authorize',async(payload,event)=>{
    trusted(event);const input=z.object({jobId:videoIdSchema,preparedHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(payload);
    return ports.authorize(input.jobId,input.preparedHash,async detail=>{trusted(event);const answer=await ports.confirm(detail);trusted(event);return answer;});
  });
  let executionPending = false;
  handle('video:execute', async (payload, event) => {
    trusted(event); const input = nativeVideoExecutionInputSchema.parse(payload);
    if (!ports.lifecycle || stopping) throw new Error('Native execution unavailable without active application lifecycle or during shutdown');
    if (!ports.execute || !ports.authenticateCapability) throw new Error('Native execution verification unavailable');
    if (executionPending) throw new Error('Native execution already pending');
    executionPending = true;
    try {
      return await withVerificationOwner(event, (window, assertOwner) => ports.execute!(input, async (detail, scope, assertCurrent) => {
        const assertVerificationOwner = async () => { assertOwner(); await assertCurrent(); assertOwner(); };
        await assertVerificationOwner();
        return authenticateNativeExecution(scope, detail,
          message => ports.authenticateCapability!(window, message, assertVerificationOwner), assertOwner);
      }, async detail => { assertOwner(); const answer = await ports.confirm(detail); assertOwner(); return answer; }, assertOwner));
    } finally { executionPending = false; }
  });
  handle('video:confirm-capability-admission',async(payload,event)=>{
    if (stopping) throw new Error('Operator verification unavailable during shutdown');
    trusted(event);
    const input=z.object({jobId:videoIdSchema,expectedFingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(payload);
    if(!ports.confirmCapabilityAdmission) throw new Error('Capability confirmation route unavailable');
    return withVerificationOwner(event, async (window, assertOwner) =>
      ports.confirmCapabilityAdmission!(input.jobId,input.expectedFingerprint,async (detail,context,assertCurrent)=>{
        assertOwner();
        const answer = await ports.confirm(`${detail}\n\nConfirmation also requires fresh Windows verification within one minute.`);
        assertOwner();
        if (!answer) return null;
        if (!ports.authenticateCapability) throw new Error('Independent operator authentication unavailable');
        const assertVerificationOwner = async () => { assertOwner(); await assertCurrent(); assertOwner(); };
        return authenticateCapabilityOperator(context,detail,message=>ports.authenticateCapability!(window,message,assertVerificationOwner),assertOwner);
      },assertOwner));
  });
}
