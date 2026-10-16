import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit diagnostic entry. Writes only ignored outputs, never loads the application.
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 SDK host required');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/windows11-ucv-availability');
mkdirSync(output, { recursive: true });
const source = readFileSync(path.join(root, 'native/windows-ucv/ucv.cpp'), 'utf8');
const expression = 'return availabilityName(UserConsentVerifier::CheckAvailabilityAsync().get());';
if (source.split(expression).length !== 2) throw new Error('Production availability boundary changed');
// A diagnostic twin preserves the exact production path except observing its result before mapping.
// No production source or payload is edited. Never call its verification export.
writeFileSync(path.join(output, 'instrumented.cpp'), '#include <cstdio>\nstatic bool diagnosticFailure = false;\n' + source.replace(expression,
  'if (diagnosticFailure) winrt::check_hresult(E_FAIL); const auto raw = UserConsentVerifier::CheckAvailabilityAsync().get(); std::printf("PRODUCTION_RAW_AVAILABILITY_VALUE=%d\\n", static_cast<int32_t>(raw)); return availabilityName(raw);') + `
int main() {
  bool valid = true;
  const char* expectedA[] = {"Available", "DeviceNotPresent", "NotConfiguredForUser", "DisabledByPolicy", "DeviceBusy"};
  const char* expectedR[] = {"Verified", "DeviceNotPresent", "NotConfiguredForUser", "DisabledByPolicy", "DeviceBusy", "RetriesExhausted", "Canceled"};
  for (int i=0;i<5;++i) valid = valid && strcmp(availabilityName(static_cast<UserConsentVerifierAvailability>(i)),expectedA[i]) == 0;
  for (int i=0;i<7;++i) valid = valid && strcmp(resultName(static_cast<UserConsentVerificationResult>(i)),expectedR[i]) == 0;
  valid = valid && strcmp(availabilityName(static_cast<UserConsentVerifierAvailability>(-1)),"Unknown") == 0;
  valid = valid && strcmp(resultName(static_cast<UserConsentVerificationResult>(99)),"Unknown") == 0;
  std::printf("PRODUCTION_SWITCH_MAPPING_VALID=%s\\n",valid ? "YES" : "NO");
  std::printf("RAW_UNKNOWN_AVAILABILITY_VALUE=%d\\n", static_cast<int32_t>(static_cast<UserConsentVerifierAvailability>(-1)));
  diagnosticFailure = true;
  std::printf("SYNTHETIC_HRESULT_FAILURE=%s\\n", CosUcvAvailability());
  diagnosticFailure = false;
  std::printf("PRODUCTION_INSTRUMENTED_AVAILABILITY=%s\\n", CosUcvAvailability());
  return valid ? 0 : 2;
}
`);
const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio/Installer/vswhere.exe');
const vs = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }).trim();
const quote = value => { if (/["%\r\n]/.test(value)) throw new Error('Unsafe path'); return `"${value}"`; };
const setup = path.join(vs, 'VC/Auxiliary/Build/vcvarsall.bat');
const compile = filename => {
  const stem = path.parse(filename).name;
  const batch = `@echo off\r\ncall ${quote(setup)} amd64 >nul\r\nif errorlevel 1 exit /b %errorlevel%\r\necho SDK=%WindowsSDKVersion%\r\necho SDK_DIRECTORY=%WindowsSdkDir%\r\ncl /nologo /std:c++17 /EHsc /W4 /WX /O2 /MT /showIncludes ${quote(filename)} /Fe:${stem}.exe /link windowsapp.lib user32.lib advapi32.lib wtsapi32.lib OneCoreUAP.lib /DYNAMICBASE /NXCOMPAT\r\nexit /b %errorlevel%\r\n`;
  writeFileSync(path.join(output, 'compile.cmd'), batch);
  const log = execFileSync('cmd.exe', ['/d', '/s', '/c', 'compile.cmd'], { cwd: output, windowsHide: true, encoding: 'utf8', timeout: 120000 });
  writeFileSync(path.join(output, `${stem}-compile.log`), log);
  const result = execFileSync(path.join(output, `${stem}.exe`), [], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  writeFileSync(path.join(output, `${stem}-runtime.txt`), result);
  return result;
};
const reference = compile(path.join(root, 'native/windows-ucv-diagnostics/reference.cpp'));
const instrumented = compile(path.join(output, 'instrumented.cpp'));
const require = createRequire(import.meta.url);
const koffi = require('koffi');
const dll = path.join(root, 'out/native/windows-ucv/x64/cos-windows-ucv.dll');
const lib = koffi.load(dll), availability = lib.func('const char * __cdecl CosUcvAvailability()');
const production = await new Promise((resolve, reject) => availability.async((error, value) => error ? reject(error) : resolve(value)));
const evidence = { production, reference, instrumented,
  productionSourceSha256: createHash('sha256').update(source).digest('hex'),
  productionDllSha256: createHash('sha256').update(readFileSync(dll)).digest('hex'), liveVerificationRuns: 0 };
writeFileSync(path.join(output, 'runtime.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
