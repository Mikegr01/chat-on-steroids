import { beforeAll, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const source = await fs.readFile('native/windows-ucv-diagnostics/reference.cpp', 'utf8');
const runner = await fs.readFile('scripts/windows-ucv-availability-diagnostic.mjs', 'utf8');
const sdk = 'C:/Program Files (x86)/Windows Kits/10/Include/10.0.26100.0';
const native = process.platform === 'win32' && await fs.stat(path.join(sdk, 'cppwinrt')).then(() => true, () => false)
  && await fs.stat('out/native/windows-ucv/x64/cos-windows-ucv.dll').then(() => true, () => false);
let evidence: { production: string; reference: string; instrumented: string; liveVerificationRuns: number };
beforeAll(async () => {
  if (native) {
    await promisify(execFile)(process.execPath, ['scripts/windows-ucv-availability-diagnostic.mjs'], { timeout: 120000, windowsHide: true });
    evidence = JSON.parse(await fs.readFile('outputs/windows11-ucv-availability/runtime.json', 'utf8'));
  }
}, 120000);
it.skipIf(!native)('ENUM_MAPPING_MATCHES_SDK', async () => {
  const projection = await fs.readFile(path.join(sdk, 'cppwinrt/winrt/impl/Windows.Security.Credentials.UI.0.h'), 'utf8');
  const abi = await fs.readFile(path.join(sdk, 'winrt/windows.security.credentials.ui.h'), 'utf8');
  for (const [type, members] of Object.entries({
    UserConsentVerifierAvailability: ['Available', 'DeviceNotPresent', 'NotConfiguredForUser', 'DisabledByPolicy', 'DeviceBusy'],
    UserConsentVerificationResult: ['Verified', 'DeviceNotPresent', 'NotConfiguredForUser', 'DisabledByPolicy', 'DeviceBusy', 'RetriesExhausted', 'Canceled'],
  })) {
    expect(projection).toContain(`enum class ${type} : int32_t`);
    const block = projection.match(new RegExp(`enum class ${type} : int32_t\\s*\\{([^}]+)\\}`))![1];
    members.forEach((name, value) => {
      expect(block).toMatch(new RegExp(`${name} = ${value}[,\\s]`));
      expect(abi).toContain(`${type}_${name} = ${value}`);
      expect(source).toContain(`static_cast<int32_t>(${type}::${name}) == ${value}`);
    });
  }
  expect(evidence.instrumented).toContain('PRODUCTION_SWITCH_MAPPING_VALID=YES');
});
it.skipIf(!native)('RAW_ENUM_VALUE_PRESERVED', () => {
  const raw = evidence.reference.match(/^RAW_AVAILABILITY_VALUE=(-?\d+)$/m)![1];
  expect(evidence.instrumented).toContain(`PRODUCTION_RAW_AVAILABILITY_VALUE=${raw}`);
  expect(evidence.reference).toContain(`REFERENCE_WINRT_AVAILABILITY=${evidence.production}`);
  expect(evidence.instrumented).toContain(`PRODUCTION_INSTRUMENTED_AVAILABILITY=${evidence.production}`);
});
it.skipIf(!native)('HRESULT_ERROR_NOT_MAPPED_TO_DEVICENOTPRESENT', () => {
  expect(evidence.instrumented).toContain('SYNTHETIC_HRESULT_FAILURE=NativeFailure');
  expect(evidence.reference).toContain('ASYNC_HRESULT=0x00000000');
});
it.skipIf(!native)('UNKNOWN_ENUM_REMAINS_UNKNOWN', () => {
  expect(evidence.instrumented).toContain('RAW_UNKNOWN_AVAILABILITY_VALUE=-1');
  expect(evidence.instrumented).toContain('PRODUCTION_SWITCH_MAPPING_VALID=YES');
});
it('REFERENCE_PROBE_DOES_NOT_REQUEST_VERIFICATION', () => {
  expect(source).not.toMatch(/RequestVerification|CosUcv|UserConsentVerifierInterop/);
  expect(runner).not.toMatch(/CosUcvVerify\s*\(/);
  expect(source).toContain('UserConsentVerifier::CheckAvailabilityAsync()');
});
it('REFERENCE_PROBE_NO_CREDENTIAL_CAPTURE', () => {
  expect(source).not.toMatch(/CredUI|LogonUser|WinBio|TokenUser|GetUserName|WTSUserName|RequestCreateAsync|OpenAsync|RequestSignAsync/);
});
it('SESSION_METADATA_CONTAINS_NO_USERNAME', () => {
  expect(source.match(/WTSQuerySessionInformationW\([^;]+/g)).toHaveLength(1);
  expect(source).toContain('WTSClientProtocolType');
  expect(source).not.toMatch(/UserName|TokenUser|LookupAccount|ComputerName|USERPROFILE/);
});
it('KEYCREDENTIAL_PROBE_NONINTERACTIVE', () => {
  expect(source.match(/KeyCredentialManager::\w+/g)).toEqual(['KeyCredentialManager::IsSupportedAsync']);
});
it('SECONDARY_PLATFORM_PROBE_NONINTERACTIVE', () => {
  expect(source.match(/WebAuthN\w+\(/g)).toEqual(['WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable(']);
  expect(source).toContain('FAILED(platformStatus) ? "UNKNOWN"');
});
it('DIAGNOSTICS_DO_NOT_CREATE_PROOF', () => {
  expect(source + runner).not.toMatch(/capability-operator-proof|issueCapability|randomBytes|operator-ipc/);
});
it('DIAGNOSTICS_DO_NOT_CREATE_RECEIPT', () => {
  expect(source + runner).not.toMatch(/confirmation-receipt|video-editing-jobs|userData|state\/|operator-execution/);
});
it('DIAGNOSTICS_DO_NOT_ACCESS_RESOLVE', () => {
  expect(source + runner).not.toMatch(/DaVinci|Resolve\(|plugins\/|video_editing|loadWindowsUcvBridge/);
  expect(source.match(/^#include .+$/gm)).toEqual([
    '#include <windows.h>', '#include <winternl.h>', '#include <roapi.h>', '#include <wtsapi32.h>', '#include <webauthn.h>',
    '#include <winrt/Windows.Foundation.h>', '#include <winrt/Windows.Security.Credentials.UI.h>',
    '#include <winrt/Windows.Security.Credentials.h>', '#include <cstdio>', '#include <type_traits>', '#include <vector>',
  ]);
});
