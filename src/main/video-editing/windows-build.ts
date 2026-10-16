/** RtlGetVersion reports the kernel version without renderer input or manifest virtualization.
 * Load only on demand: general Windows 10 application startup remains unchanged. */
export async function readWindowsBuild(): Promise<number | null> {
  if (process.platform !== 'win32') return null;
  try {
    const k = await import('koffi');
    const rtl = k.load('ntdll.dll').func('int32_t __stdcall RtlGetVersion(void *version)');
    // RTL_OSVERSIONINFOW from winnt.h: five DWORDs followed by 128 WCHARs.
    const version = Buffer.alloc(284); version.writeUInt32LE(version.length, 0);
    if (rtl(version) !== 0 || version.readUInt32LE(4) !== 10) return null;
    const build = version.readUInt32LE(12);
    return build > 0 ? build : null;
  } catch { return null; }
}
