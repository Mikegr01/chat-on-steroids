import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const acl = read('scripts/windows-installer-acl.nsh');
const templates = 'node_modules/app-builder-lib/templates/nsis/';
const macro = (name: string) => acl.match(new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`))?.[1] ?? '';

describe('Windows sandbox ACL privilege boundary', () => {
  it('does not grant access before native All Users elevation', () => {
    expect(macro('customInit')).not.toMatch(/ExecWait|grantSandboxReadAccess|FileExists|UAC_RunElevated/);
    expect(acl.match(/!insertmacro grantSandboxReadAccess/g)).toHaveLength(1);
  });

  it('checks All Users privilege at the post-copy install hook', () => {
    const install = macro('customInstall');
    expect(install).toContain('$installMode == "all"');
    expect(install).toContain('${IfNot} ${UAC_IsAdmin}');
    expect(install.indexOf('Abort')).toBeLessThan(install.indexOf('!insertmacro grantSandboxReadAccess'));
    const section = read(templates + 'installSection.nsh');
    expect(section.indexOf('!insertmacro uninstallOldVersion SHELL_CONTEXT'))
      .toBeLessThan(section.indexOf('!insertmacro installApplicationFiles'));
    expect(section.indexOf('!insertmacro installApplicationFiles'))
      .toBeLessThan(section.indexOf('!insertmacro customInstall'));
  });

  it('keeps the inheritable sandbox grant and user-visible failure', () => {
    const grant = macro('grantSandboxReadAccess');
    expect(grant).toContain('"$SYSDIR\\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)" /Q');
    expect(grant).toContain('${If} ${Errors}');
    expect(grant).toContain('${If} $0 != 0');
    expect(grant).toContain('SetErrorLevel 2');
    expect(grant).toContain('MessageBox');
    expect(grant).toContain('Push $0');
    expect(grant).toContain('Pop $0');
    expect(grant).toContain('Abort');
  });
});
