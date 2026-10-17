import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

const execute = promisify(execFile);
const psLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const launcherSource = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class IsolatedDesktopProcess {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
    public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr attributes);
  [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int Run(string name, string commandLine, string currentDirectory) {
    const uint GENERIC_ALL = 0x10000000;
    IntPtr desktop = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
    if (desktop == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateDesktop failed");
    PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
    try {
      STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO)); si.lpDesktop = "WinSta0\\" + name;
      StringBuilder command = new StringBuilder(commandLine);
      if (!CreateProcess(null, command, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, currentDirectory, ref si, out pi))
        throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess failed");
      if (WaitForSingleObject(pi.hProcess, 30000) == 0x102) throw new TimeoutException("isolated desktop child timed out");
      uint code; if (!GetExitCodeProcess(pi.hProcess, out code)) throw new Win32Exception(Marshal.GetLastWin32Error(), "GetExitCodeProcess failed");
      return unchecked((int)code);
    } finally {
      if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
      if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
      CloseDesktop(desktop);
    }
  }
}`;

describe.runIf(process.platform === 'win32')('Windows input desktop capture', () => {
  it('captures the interactive desktop even when the helper process starts on a non-input desktop', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cos-input-desktop-'));
    try {
      const child = path.join(directory, 'child.ps1');
      const marker = path.join(directory, 'result.txt');
      const image = path.join(directory, 'capture.png');
      const helper = HELPER_SCRIPT.slice(0, HELPER_SCRIPT.indexOf('while (($line = [Console]::In.ReadLine())'));
      await writeFile(child, `$ErrorActionPreference='Stop'\n${helper}\ntry {\n  $value=[Clf]::Capture(0,0,32,32,32,${psLiteral(image)})\n  if (!(Test-Path -LiteralPath ${psLiteral(image)})) { throw 'capture file missing' }\n  [IO.File]::WriteAllText(${psLiteral(marker)},'INPUT_DESKTOP_CAPTURE_OK')\n  exit 0\n} catch {\n  [IO.File]::WriteAllText(${psLiteral(marker)},'ERROR: '+$_.Exception.GetBaseException().Message)\n  exit 23\n}\n`, 'utf8');
      const harness = path.join(directory, 'harness.ps1');
      const desktop = `cos-isolated-${process.pid}-${Date.now()}`;
      const command = `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${child}"`;
      await writeFile(harness, `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${launcherSource}\n'@\n$code=[IsolatedDesktopProcess]::Run(${psLiteral(desktop)},${psLiteral(command)},${psLiteral(directory)})\nWrite-Output $code\n`, 'utf8');
      const { stdout } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], { windowsHide: true, timeout: 90_000, maxBuffer: 64_000 });
      const markerText = await readFile(marker, 'utf8');
      expect(stdout.trim(), markerText).toBe('0');
      expect(markerText).toBe('INPUT_DESKTOP_CAPTURE_OK');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 100_000);
});
