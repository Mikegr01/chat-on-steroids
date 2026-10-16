import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { extractFile, listPackage } from '@electron/asar';

/** Plain-Node package inspection. ASAR contents are read through the archive API. */
export function inspectPackagedWindowsUcv(resources, arch) {
  const filename = path.join(resources, 'windows-ucv', arch, 'cos-windows-ucv.dll');
  if (!statSync(filename).isFile()) throw new Error('Missing packaged Windows UCV DLL');
  const pe = readFileSync(filename);
  const offset = pe.length >= 64 ? pe.readUInt32LE(60) : -1;
  const machine = arch === 'x64' ? 0x8664 : arch === 'arm64' ? 0xaa64 : null;
  if (!machine || pe.toString('ascii', 0, 2) !== 'MZ' || offset < 64 || offset + 6 > pe.length ||
      pe.readUInt32LE(offset) !== 0x4550 || pe.readUInt16LE(offset + 4) !== machine)
    throw new Error('Wrong architecture or invalid packaged Windows UCV PE');
  const root = path.join(resources, 'windows-ucv');
  if (readdirSync(root).join(',') !== arch || readdirSync(path.dirname(filename)).join(',') !== 'cos-windows-ucv.dll')
    throw new Error('Unexpected Windows UCV resources');
  const archive = path.join(resources, 'app.asar');
  if (listPackage(archive).some(name => /[\\/]out[\\/]native(?:[\\/]|$)/.test(name) || /cos-windows-ucv\.dll$/i.test(name)))
    throw new Error('Native compiler output or duplicate UCV payload inside ASAR');
  const copies = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Unexpected packaged resource symlink');
      if (entry.isDirectory()) walk(file);
      else if (entry.name.toLowerCase() === 'cos-windows-ucv.dll') copies.push(file);
    }
  };
  walk(resources);
  if (copies.length !== 1 || copies[0] !== filename) throw new Error('Duplicate packaged Windows UCV DLL');
  const main = extractFile(archive, path.join('out', 'main', 'index.js')).toString('utf8');
  // Match the packaged branch of the deliberate loader, not an unrelated occurrence of its name.
  if (!/app\.isPackaged\s*\?\s*[\w.]+\.join\(process\.resourcesPath,\s*["']windows-ucv["'],\s*process\.arch,\s*["']cos-windows-ucv\.dll["']\)/.test(main))
    throw new Error('Packaged UCV loader target mismatch');
  for (const marker of ['loadWindowsUcvBridge', 'CosUcvAvailability', 'CosUcvVerify', 'RtlGetVersion', 'S7_STRONG_MUTATION_AUTH_SUPPORTED'])
    if (!main.includes(marker)) throw new Error(`Packaged UCV bridge/build detection absent: ${marker}`);
  if (!/knownBuild\s*>=\s*(?:22e3|22000)\b/.test(main)) throw new Error('Packaged Windows 11 build gate absent');
  return { filename, arch, bytes: pe.length };
}

/** Serializable for execution by the packaged Electron in its existing Node smoke path.
 * Bind availability only. Never bind or call CosUcvVerify, and never load application bootstrap. */
export async function probeWindowsUcv(koffi, resources, arch, join = require('node:path').join) {
  const filename = join(resources, 'windows-ucv', arch, 'cos-windows-ucv.dll');
  const library = koffi.load(filename);
  const available = library.func('const char * __cdecl CosUcvAvailability()');
  const availability = await new Promise((resolve, reject) => available.async((error, result) => error ? reject(error) : resolve(result)));
  const version = Buffer.alloc(284); version.writeUInt32LE(version.length, 0);
  const rtl = koffi.load('ntdll.dll').func('int32_t __stdcall RtlGetVersion(void *version)');
  if (rtl(version) !== 0 || version.readUInt32LE(4) !== 10 || !version.readUInt32LE(12))
    throw new Error('Packaged Windows build detection failed');
  const build = version.readUInt32LE(12);
  const states = ['Available', 'DeviceNotPresent', 'NotConfiguredForUser', 'DisabledByPolicy', 'DeviceBusy'];
  // Windows 10 remains a supported application host. Strong mutation has no weak fallback.
  if (build >= 22000 ? !states.includes(availability) : availability !== 'UnsupportedBuild')
    throw new Error('Packaged UCV availability failed: ' + availability);
  return { loaded: true, loadedFrom: filename, build, availability, liveVerificationRuns: 0 };
}
