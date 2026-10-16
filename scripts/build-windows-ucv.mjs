import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit source compilation only. Does not load the DLL or invoke verification.
if (process.platform !== 'win32') throw new Error('Windows SDK host required');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arch = process.argv[2] ?? process.arch;
if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported Windows UCV architecture');
const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
const vs = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }).trim();
if (!vs) throw new Error('MSVC and Windows SDK required');
const directory = path.join(root, 'out', 'native', 'windows-ucv', arch);
mkdirSync(directory, { recursive: true });
const quote = value => { if (/["%\r\n]/.test(value)) throw new Error('Unsafe compiler path'); return `"${value}"`; };
const setup = path.join(vs, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
const command = `call ${quote(setup)} ${arch === 'x64' ? 'amd64' : 'amd64_arm64'} >nul && cl /nologo /std:c++17 /EHsc /W4 /WX /O2 /MT /LD ${quote(path.join(root, 'native/windows-ucv/ucv.cpp'))} /link /OUT:cos-windows-ucv.dll windowsapp.lib user32.lib /DYNAMICBASE /NXCOMPAT`;
const batch = path.join(directory, 'compile.cmd');
writeFileSync(batch, `@echo off\r\n${command}\r\nexit /b %errorlevel%\r\n`);
execFileSync('cmd.exe', ['/d', '/s', '/c', 'compile.cmd'], {
  cwd: directory, windowsHide: true, windowsVerbatimArguments: true, stdio: 'inherit',
});
