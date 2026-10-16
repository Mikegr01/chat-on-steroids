# Mandatory Windows UCV native verification

Before repair, removing the staged DLL and running the native suite returned exit 0 with both
native boundary tests skipped. Compilation existed in electron-vite's build hook and packaging,
but canonical verify:ci reached Vitest without either of those steps. Direct Koffi tests also
did not exercise the production Electron bridge loader.

verify:ci now invokes verify:windows-native first. On Windows that gate compiles the production
source for the host architecture into its existing out/native/windows-ucv location and runs the
real native suite. Compiler, loader, ABI/export and availability failures stop verification.
PR and release workflows already call verify:ci, so both inherit the same mandatory boundary.
Other hosts do not compile Windows code; only their platform-specific native cases skip.

The native suite no longer conditions Windows execution on DLL existence. It loads the compiled
artifact in Node and stages those real bytes in an isolated Electron app, where the bundled
production loadWindowsUcvBridge selects its normal fixed development location. Real Koffi's ESM
entry is resolved by URL in the isolated harness. Both exports are bound and availability is
checked; verification is invoked only with HWND zero, which cannot open authentication UI.
Windows 11 requires a normal availability state; Windows 10 requires UnsupportedBuild.

Negative cases use that same production loader with no artifact, invalid bytes, and a genuine
Windows DLL lacking the required exports. They require native-load/export errors, not arbitrary
fixture failures. --load-only audits the staged artifact without rebuilding it first.

Validation before commit:

- Native build and real Node/Electron boundary: 6/6 passed, no Windows skips.
- Staged DLL temporarily absent: verify:windows-native -- --load-only exited 1, no skips.
- Staged DLL temporarily replaced by a genuine wrong-export DLL: the same gate exited 1 at
  CosUcvAvailability binding. The original artifact was restored in a finally block each time.
- Native, SDK availability diagnostics, resource mapping, package smoke and isolated fixture
  set: 7 files and 74 tests passed, no skips.
- Installer ACL and packaging set: 4 files and 49 tests passed.
- Typecheck, build and diff check passed. Build retained existing Vite warnings.

No native production source, S7/video authorization, frame or one-shot execution behavior changed.
No generated native artifact is committed. This is source/native verification evidence, not
installed payload acceptance or a live user verification. Canonical verification follows the new
commits and is recorded in the task's final verification report. Push, PR update and merge remain NO.
