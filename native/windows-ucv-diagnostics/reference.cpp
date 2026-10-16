// Standalone, availability-only standard C++/WinRT reference. No production includes.
#include <windows.h>
#include <winternl.h>
#include <roapi.h>
#include <wtsapi32.h>
#include <webauthn.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Security.Credentials.UI.h>
#include <winrt/Windows.Security.Credentials.h>
#include <cstdio>
#include <type_traits>
#include <vector>

using namespace winrt::Windows::Foundation;
using namespace winrt::Windows::Security::Credentials::UI;
static_assert(std::is_same_v<std::underlying_type_t<UserConsentVerifierAvailability>, int32_t>);
static_assert(std::is_same_v<std::underlying_type_t<UserConsentVerificationResult>, int32_t>);
static_assert(sizeof(UserConsentVerifierAvailability) == 4 && sizeof(UserConsentVerificationResult) == 4);
static_assert(static_cast<int32_t>(UserConsentVerifierAvailability::Available) == 0);
static_assert(static_cast<int32_t>(UserConsentVerifierAvailability::DeviceNotPresent) == 1);
static_assert(static_cast<int32_t>(UserConsentVerifierAvailability::NotConfiguredForUser) == 2);
static_assert(static_cast<int32_t>(UserConsentVerifierAvailability::DisabledByPolicy) == 3);
static_assert(static_cast<int32_t>(UserConsentVerifierAvailability::DeviceBusy) == 4);
static_assert(static_cast<int32_t>(UserConsentVerificationResult::Verified) == 0);
static_assert(static_cast<int32_t>(UserConsentVerificationResult::DeviceNotPresent) == 1);
static_assert(static_cast<int32_t>(UserConsentVerificationResult::NotConfiguredForUser) == 2);
static_assert(static_cast<int32_t>(UserConsentVerificationResult::DisabledByPolicy) == 3);
static_assert(static_cast<int32_t>(UserConsentVerificationResult::DeviceBusy) == 4);
static_assert(static_cast<int32_t>(UserConsentVerificationResult::RetriesExhausted) == 5);
static_assert(static_cast<int32_t>(UserConsentVerificationResult::Canceled) == 6);

const char* name(UserConsentVerifierAvailability value) {
  switch (value) {
    case UserConsentVerifierAvailability::Available: return "Available";
    case UserConsentVerifierAvailability::DeviceNotPresent: return "DeviceNotPresent";
    case UserConsentVerifierAvailability::NotConfiguredForUser: return "NotConfiguredForUser";
    case UserConsentVerifierAvailability::DisabledByPolicy: return "DisabledByPolicy";
    case UserConsentVerifierAvailability::DeviceBusy: return "DeviceBusy";
    default: return "Unknown";
  }
}
void metadata() {
  DWORD session = 0;
  if (ProcessIdToSessionId(GetCurrentProcessId(), &session)) std::printf("SESSION_ID=%lu\n", session);
  else std::printf("SESSION_ID=UNKNOWN\n");
  LPWSTR buffer = nullptr; DWORD bytes = 0;
  if (WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, session, WTSClientProtocolType, &buffer, &bytes)) {
    if (bytes >= sizeof(USHORT)) {
      const auto protocol = *reinterpret_cast<USHORT*>(buffer);
      std::printf("SESSION_TYPE=%s\n", protocol == 0 ? "CONSOLE" : protocol == 2 ? "RDP" : "OTHER");
    }
    WTSFreeMemory(buffer);
  } else std::printf("SESSION_TYPE=UNKNOWN\n");
  USEROBJECTFLAGS flags{}; DWORD needed = 0;
  const bool visible = GetUserObjectInformationW(GetProcessWindowStation(), UOI_FLAGS, &flags, sizeof(flags), &needed) != 0;
  std::printf("WINDOW_STATION_VISIBLE=%s\n", visible ? ((flags.dwFlags & WSF_VISIBLE) ? "YES" : "NO") : "UNKNOWN");
  wchar_t desktop[256]{};
  const bool desktopRead = GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()), UOI_NAME, desktop, sizeof(desktop), &needed) != 0;
  std::printf("DEFAULT_DESKTOP=%s\n", desktopRead ? (wcscmp(desktop, L"Default") == 0 ? "YES" : "NO") : "UNKNOWN");
  std::printf("PROCESS_IN_ACTIVE_CONSOLE_SESSION=%s\n", session == WTSGetActiveConsoleSessionId() ? "YES" : "NO");
  HANDLE token = nullptr;
  if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    TOKEN_ELEVATION elevation{};
    const bool elevationRead = GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &needed) != 0;
    std::printf("PROCESS_ELEVATED=%s\n", elevationRead ? (elevation.TokenIsElevated ? "YES" : "NO") : "UNKNOWN");
    GetTokenInformation(token, TokenIntegrityLevel, nullptr, 0, &needed);
    std::vector<BYTE> data(needed);
    if (needed && GetTokenInformation(token, TokenIntegrityLevel, data.data(), needed, &needed)) {
      const auto sid = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(data.data())->Label.Sid;
      const DWORD rid = *GetSidSubAuthority(sid, *GetSidSubAuthorityCount(sid) - 1);
      std::printf("PROCESS_INTEGRITY=%s\n", rid >= SECURITY_MANDATORY_SYSTEM_RID ? "SYSTEM" :
        rid >= SECURITY_MANDATORY_HIGH_RID ? "HIGH" : rid >= SECURITY_MANDATORY_MEDIUM_RID ? "MEDIUM" : "LOW");
    } else std::printf("PROCESS_INTEGRITY=UNKNOWN\n");
    CloseHandle(token);
  }
  auto rtl = reinterpret_cast<LONG (WINAPI*)(PRTL_OSVERSIONINFOW)>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"));
  RTL_OSVERSIONINFOW version{}; version.dwOSVersionInfoSize = sizeof(version);
  if (rtl && rtl(&version) == 0) std::printf("WINDOWS_BUILD=%lu\n", version.dwBuildNumber);
}
int main() {
  metadata();
  // Independent, noninteractive secondary platform-authenticator signal; no ceremony.
  BOOL platformAvailable = FALSE;
  const HRESULT platformStatus = WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable(&platformAvailable);
  std::printf("WEBAUTHN_PLATFORM_HRESULT=0x%08X\nWEBAUTHN_PLATFORM_AVAILABLE=%s\n", static_cast<unsigned>(platformStatus),
    FAILED(platformStatus) ? "UNKNOWN" : platformAvailable ? "YES" : "NO");
  const HRESULT initialized = RoInitialize(RO_INIT_MULTITHREADED);
  std::printf("WINRT_INITIALIZATION=0x%08X\n", static_cast<unsigned>(initialized));
  if (FAILED(initialized)) return 2;
  struct Apartment { ~Apartment() { RoUninitialize(); } } apartment;
  int result = 0;
  try {
    auto factory = winrt::get_activation_factory<UserConsentVerifier, IUserConsentVerifierStatics>();
    std::printf("ACTIVATION_FACTORY=SUCCESS\n");
    // Static-only runtime class: successful statics factory is its activation contract.
    auto operation = UserConsentVerifier::CheckAvailabilityAsync();
    static_assert(std::is_same_v<decltype(operation), IAsyncOperation<UserConsentVerifierAvailability>>);
    std::printf("ASYNC_OPERATION_CREATED=YES\n");
    const auto value = operation.get();
    std::printf("ASYNC_OPERATION_COMPLETED=%s\n", operation.Status() == AsyncStatus::Completed ? "YES" : "NO");
    std::printf("ASYNC_HRESULT=0x%08X\n", static_cast<unsigned>(operation.ErrorCode().value));
    std::printf("RAW_AVAILABILITY_VALUE=%d\nREFERENCE_WINRT_AVAILABILITY=%s\n", static_cast<int32_t>(value), name(value));
  } catch (winrt::hresult_error const& error) {
    std::printf("ASYNC_HRESULT=0x%08X\nREFERENCE_WINRT_AVAILABILITY=ERROR\n", static_cast<unsigned>(error.code().value));
    result = 2;
  } catch (...) { std::printf("REFERENCE_WINRT_AVAILABILITY=ERROR\n"); result = 2; }
  try {
    const bool supported = winrt::Windows::Security::Credentials::KeyCredentialManager::IsSupportedAsync().get();
    std::printf("KEYCREDENTIAL_SUPPORTED=%s\n", supported ? "YES" : "NO");
  } catch (winrt::hresult_error const& error) { std::printf("KEYCREDENTIAL_SUPPORTED=ERROR\nKEYCREDENTIAL_HRESULT=0x%08X\n", static_cast<unsigned>(error.code().value)); }
  return result;
}
