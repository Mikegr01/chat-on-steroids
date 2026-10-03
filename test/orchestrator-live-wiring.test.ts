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
});
