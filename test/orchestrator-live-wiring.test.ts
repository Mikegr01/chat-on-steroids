import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('Phase 3 live ORCH wiring', () => {
  it('routes the independent composer ORCH control through preload into a main-process start handler', async () => {
    const [chat, preload, ipc] = await Promise.all([
      readFile('src/renderer/chat.ts', 'utf8'),
      readFile('src/preload/index.ts', 'utf8'),
      readFile('src/main/ipc.ts', 'utf8')
    ]);

    expect(chat).toContain('api.startOrchestratorRun');
    expect(preload).toContain('startOrchestratorRun:');
    expect(ipc).toContain("handle('orchestrator:start'");
  });

  it('keeps a new-chat ORCH start pending until the accepted input has a real session binding', async () => {
    const chat = await readFile('src/renderer/chat.ts', 'utf8');

    expect(chat).toContain('pendingOrchestratorStarts');
    expect(chat).toContain('startPendingOrchestrator(entry)');
    expect(chat).toContain('await startPendingOrchestrator(result)');
    expect(chat).not.toContain('ORCH could not start because the ChatGPT conversation was not bound yet.');
  });
});
