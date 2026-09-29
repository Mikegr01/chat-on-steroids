import { afterEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  type Listener = { fn: (...args: any[]) => void; once: boolean };
  class Emitter {
    private readonly listeners = new Map<string, Listener[]>();
    on(event: string, fn: (...args: any[]) => void) {
      const list = this.listeners.get(event) ?? [];
      list.push({ fn, once: false });
      this.listeners.set(event, list);
      return this;
    }
    once(event: string, fn: (...args: any[]) => void) {
      const list = this.listeners.get(event) ?? [];
      list.push({ fn, once: true });
      this.listeners.set(event, list);
      return this;
    }
    emit(event: string, ...args: any[]) {
      const list = [...(this.listeners.get(event) ?? [])];
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((entry) => !entry.once)
      );
      for (const entry of list) entry.fn(...args);
    }
  }

  const children: any[] = [];
  let currentChild: any = null;
  let writeHandler: ((child: any, line: string) => void) | null = null;

  const spawn = vi.fn(() => {
    const index = children.length;
    const child = new Emitter() as any;
    child.pid = 9100 + index;
    child.exitCode = null;
    child.writes = [] as string[];
    child.stdout = new Emitter();
    child.stderr = new Emitter();
    child.stdin = {
      write(line: string, _encoding: string, callback: (error?: Error | null) => void) {
        child.writes.push(line);
        callback(null);
        if (writeHandler) {
          writeHandler(child, line);
        } else {
          queueMicrotask(() =>
            child.stdout.emit(
              'data',
              Buffer.from(
                `${JSON.stringify({ ok: 'not-a-boolean', windows: [], screen: { x: 0, y: 0, width: 100, height: 100 } })}\n`
              )
            )
          );
        }
        return true;
      },
      end() {}
    };
    children.push(child);
    currentChild = child;
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });

  const terminateProcessTree = vi.fn(async (pid?: number) => {
    const child = (pid !== undefined ? children.find((c) => c.pid === pid) : null) ?? currentChild;
    if (child) {
      child.exitCode = 0;
      child.emit('close');
    }
  });

  return {
    children,
    spawn,
    terminateProcessTree,
    setWriteHandler: (fn: ((child: any, line: string) => void) | null) => {
      writeHandler = fn;
    },
    reset: () => {
      writeHandler = null;
      if (currentChild && currentChild.exitCode === null) {
        currentChild.exitCode = 0;
        currentChild.emit('close');
      }
      currentChild = null;
      children.length = 0;
      spawn.mockClear();
      terminateProcessTree.mockClear();
    }
  };
});

vi.mock('node:child_process', () => ({ spawn: fake.spawn }));
vi.mock('../src/main/env.js', () => ({
  ensureUsablePath: vi.fn(),
  normalizeEnvironment: (env: NodeJS.ProcessEnv) => ({ ...env }),
  setEnvValue: (env: NodeJS.ProcessEnv, key: string, value: string) => {
    env[key] = value;
  }
}));
vi.mock('../src/main/exec.js', () => ({
  findWindowsPowerShell: () => 'powershell.exe',
  terminateProcessTree: fake.terminateProcessTree
}));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));

// The child process is mocked, but Darwin still resolves the native host before spawn.
// Point that resolver at a real executable so this test remains about protocol handling.
vi.stubEnv('COS_MACOS_DESKTOP_HELPER', process.execPath);

import { act, helperTimeoutMs, listWindows } from '../src/main/computer/index.js';

afterEach(() => {
  fake.reset();
});

describe('desktop helper protocol validation', () => {
  it('budgets a macOS act request for cumulative focus polling', () => {
    const actions = Array.from({ length: 20 }, (_, index) => ({ type: 'focus', window: index + 1 }));
    expect(helperTimeoutMs({ op: 'act', actions }, 'darwin')).toBe(57_000);
    expect(helperTimeoutMs({ op: 'act', actions }, 'win32')).toBe(15_000);
  });

  it('rejects syntactically valid JSON that is not a protocol response', async () => {
    await expect(listWindows()).rejects.toThrow(/malformed protocol response/i);
    expect(fake.terminateProcessTree).toHaveBeenCalledTimes(1);
  });

  it('ignores unsolicited banner output before any request and answers subsequent request', async () => {
    fake.setWriteHandler((child) => {
      queueMicrotask(() => {
        child.stdout.emit(
          'data',
          Buffer.from(`${JSON.stringify({ ok: true, windows: [], screen: { x: 0, y: 0, width: 100, height: 100 } })}\n`)
        );
      });
    });

    const first = await listWindows();
    expect(first).toEqual({ windows: [], screen: { x: 0, y: 0, width: 100, height: 100 } });

    const child = fake.children[0]!;
    // When idle, unsolicited banner arrives
    child.stdout.emit('data', Buffer.from('Windows PowerShell\r\nCopyright (C) Microsoft Corporation. All rights reserved.\r\n'));

    // Subsequent request still succeeds on the same helper
    const second = await listWindows();
    expect(second).toEqual({ windows: [], screen: { x: 0, y: 0, width: 100, height: 100 } });
    expect(fake.terminateProcessTree).not.toHaveBeenCalled();
  });

  it('fails closed when noise arrives while a read-only request is pending and retires helper', async () => {
    fake.setWriteHandler((child) => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('Windows PowerShell\r\n'));
      });
    });

    await expect(listWindows()).rejects.toThrow(/malformed JSON/i);
    expect(fake.terminateProcessTree).toHaveBeenCalledTimes(1);
  });

  it('fails closed when prompt text prefixes an otherwise-valid JSON reply on one line', async () => {
    fake.setWriteHandler((child) => {
      queueMicrotask(() => {
        child.stdout.emit(
          'data',
          Buffer.from(
            `C:\\Windows\\System32>${JSON.stringify({ ok: true, windows: [], screen: { x: 0, y: 0, width: 100, height: 100 } })}\n`
          )
        );
      });
    });

    await expect(listWindows()).rejects.toThrow(/malformed JSON/i);
    expect(fake.terminateProcessTree).toHaveBeenCalledTimes(1);
  });

  it('treats syntactically valid protocol JSON as unsolicited when no request is pending and requires fresh reply for next request', async () => {
    let requestsReceived = 0;
    fake.setWriteHandler((child) => {
      requestsReceived++;
      queueMicrotask(() => {
        child.stdout.emit(
          'data',
          Buffer.from(`${JSON.stringify({ ok: true, windows: [{ id: requestsReceived }], screen: { x: 0, y: 0, width: 100, height: 100 } })}\n`)
        );
      });
    });

    const first = await listWindows();
    expect(first.windows).toEqual([{ id: 1 }]);

    const child = fake.children[0]!;
    // Emit unsolicited protocol-looking JSON while idle
    child.stdout.emit(
      'data',
      Buffer.from(`${JSON.stringify({ ok: true, windows: [{ id: 999 }], screen: { x: 0, y: 0, width: 100, height: 100 } })}\n`)
    );

    // Next request must receive its own response (id: 2), not the unsolicited id: 999
    const second = await listWindows();
    expect(second.windows).toEqual([{ id: 2 }]);
    expect(requestsReceived).toBe(2);
  });

  it('spawns a replacement helper after retirement and successfully answers subsequent request', async () => {
    let callCount = 0;
    fake.setWriteHandler((child) => {
      callCount++;
      if (callCount === 1) {
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('corrupt_non_json_line\n'));
        });
      } else {
        queueMicrotask(() => {
          child.stdout.emit(
            'data',
            Buffer.from(`${JSON.stringify({ ok: true, windows: [], screen: { x: 0, y: 0, width: 100, height: 100 } })}\n`)
          );
        });
      }
    });

    await expect(listWindows()).rejects.toThrow(/malformed JSON/i);
    expect(fake.terminateProcessTree).toHaveBeenCalledTimes(1);

    const second = await listWindows();
    expect(second).toEqual({ windows: [], screen: { x: 0, y: 0, width: 100, height: 100 } });
    expect(fake.spawn).toHaveBeenCalledTimes(2);
  });

  it('never replays a mutating action that failed with malformed JSON', async () => {
    fake.setWriteHandler((child) => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('corrupt output\n'));
      });
    });

    await expect(act([{ type: 'launch_app', app: 'notepad.exe' }])).rejects.toThrow(/malformed JSON/i);
    expect(fake.terminateProcessTree).toHaveBeenCalledTimes(1);

    // Ensure the helper only received 1 write; no automatic silent replay occurred
    expect(fake.children[0]!.writes).toHaveLength(1);
    expect(fake.spawn).toHaveBeenCalledTimes(1);
  });
});
