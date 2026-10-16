// Narrow in-process bridge. Microsoft SDK types own all IIDs, enum values and lifetimes.
// No Node/Electron/ledger/S7/Resolve APIs, credential structures, logging or COM dispatcher.
#include <windows.h>
#include <winternl.h>
#include <UserConsentVerifierInterop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Security.Credentials.UI.h>
#include <atomic>

using namespace winrt::Windows::Foundation;
using namespace winrt::Windows::Security::Credentials::UI;

namespace {
struct Apartment {
  Apartment() { winrt::init_apartment(winrt::apartment_type::multi_threaded); }
  ~Apartment() { winrt::uninit_apartment(); }
};
bool supportedBuild() {
  auto rtl = reinterpret_cast<LONG (WINAPI*)(PRTL_OSVERSIONINFOW)>(
    GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"));
  RTL_OSVERSIONINFOW version{}; version.dwOSVersionInfoSize = sizeof(version);
  return rtl && rtl(&version) == 0 && version.dwMajorVersion == 10 && version.dwBuildNumber >= 22000;
}
bool ownsWindow(HWND hwnd, bool active) {
  DWORD pid = 0;
  return hwnd && IsWindow(hwnd) && GetWindowThreadProcessId(hwnd, &pid) &&
    pid == GetCurrentProcessId() && GetAncestor(hwnd, GA_ROOT) == hwnd &&
    (!active || (IsWindowVisible(hwnd) && GetForegroundWindow() == hwnd));
}
const char* availabilityName(UserConsentVerifierAvailability value) {
  switch (value) {
    case UserConsentVerifierAvailability::Available: return "Available";
    case UserConsentVerifierAvailability::DeviceNotPresent: return "DeviceNotPresent";
    case UserConsentVerifierAvailability::NotConfiguredForUser: return "NotConfiguredForUser";
    case UserConsentVerifierAvailability::DisabledByPolicy: return "DisabledByPolicy";
    case UserConsentVerifierAvailability::DeviceBusy: return "DeviceBusy";
    default: return "Unknown";
  }
}
const char* resultName(UserConsentVerificationResult value) {
  switch (value) {
    case UserConsentVerificationResult::Verified: return "Verified";
    case UserConsentVerificationResult::DeviceNotPresent: return "DeviceNotPresent";
    case UserConsentVerificationResult::NotConfiguredForUser: return "NotConfiguredForUser";
    case UserConsentVerificationResult::DisabledByPolicy: return "DisabledByPolicy";
    case UserConsentVerificationResult::DeviceBusy: return "DeviceBusy";
    case UserConsentVerificationResult::RetriesExhausted: return "RetriesExhausted";
    case UserConsentVerificationResult::Canceled: return "Canceled";
    default: return "Unknown";
  }
}
std::atomic_flag verifying = ATOMIC_FLAG_INIT;
struct Reservation { ~Reservation() { verifying.clear(); } };
}

extern "C" __declspec(dllexport) const char* __cdecl CosUcvAvailability() noexcept {
  if (!supportedBuild()) return "UnsupportedBuild";
  try {
    Apartment apartment;
    try { auto interop = winrt::get_activation_factory<UserConsentVerifier, IUserConsentVerifierInterop>(); }
    catch (...) { return "InteropMissing"; }
    // Availability never requests verification and never opens authentication UI.
    return availabilityName(UserConsentVerifier::CheckAvailabilityAsync().get());
  } catch (...) { return "NativeFailure"; }
}

extern "C" __declspec(dllexport) const char* __cdecl CosUcvVerify(uint64_t handle, const wchar_t* message) noexcept {
  if (verifying.test_and_set()) return "DeviceBusy";
  Reservation reservation;
  if (!supportedBuild()) return "UnsupportedBuild";
  const auto hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(handle));
  if (static_cast<uint64_t>(reinterpret_cast<uintptr_t>(hwnd)) != handle || !message || !ownsWindow(hwnd, true))
    return "InvalidWindow";
  try {
    Apartment apartment;
    auto interop = winrt::get_activation_factory<UserConsentVerifier, IUserConsentVerifierInterop>();
    if (UserConsentVerifier::CheckAvailabilityAsync().get() != UserConsentVerifierAvailability::Available)
      return "Unavailable";
    if (!ownsWindow(hwnd, true)) return "InvalidWindow";
    winrt::hstring text(message);
    IAsyncOperation<UserConsentVerificationResult> operation{ nullptr };
    winrt::check_hresult(interop->RequestVerificationForWindowAsync(hwnd,
      static_cast<HSTRING>(winrt::get_abi(text)), winrt::guid_of<decltype(operation)>(), winrt::put_abi(operation)));
    const auto result = operation.get(); // Koffi worker MTA; never block Electron's UI thread.
    if (!ownsWindow(hwnd, false)) return "InvalidWindow";
    return resultName(result);
  } catch (...) { return "NativeFailure"; }
}
