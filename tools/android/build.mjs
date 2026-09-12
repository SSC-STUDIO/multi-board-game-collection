/** Build a signed, offline APK. Signing material is kept outside the repository. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const win = process.platform === 'win32';
const cache = path.join(os.homedir(), '.cache/zenith-android');
const javaCache = path.join(cache, 'java');
const env = { ...process.env };
if (!env.JAVA_HOME && existsSync(javaCache)) env.JAVA_HOME = path.join(javaCache, readdirSync(javaCache).find(name => name.startsWith('jdk-')) ?? '');
if (!env.ANDROID_HOME && existsSync(path.join(cache, 'sdk'))) env.ANDROID_HOME = path.join(cache, 'sdk');
if (!env.JAVA_HOME || !env.ANDROID_HOME) throw Error('Install JDK 21 and Android SDK 36, then set JAVA_HOME and ANDROID_HOME. See docs/ANDROID.md.');

const run = (tool, args, cwd = root) => execFileSync(tool, args, { cwd, env, stdio: 'inherit' });
const npm = args => win ? run('cmd.exe', ['/d', '/c', 'npm', ...args]) : run('npm', args);

if (!env.ZENITH_STORE_FILE) {
  const signing = path.join(os.homedir(), '.local/share/zenith-tabletop-3d/signing');
  mkdirSync(signing, { recursive: true, mode: 0o700 });
  const config = path.join(signing, 'release.json');
  const store = path.join(signing, 'release.p12');
  if (!existsSync(config)) {
    if (existsSync(store)) throw Error('Signing keystore exists without release.json; restore its credentials instead of replacing the key.');
    writeFileSync(config, JSON.stringify({ password: randomBytes(32).toString('hex'), alias: 'zenith' }), { mode: 0o600 });
  }
  const credentials = JSON.parse(readFileSync(config, 'utf8'));
  env.ZENITH_STORE_FILE = store;
  env.ZENITH_STORE_PASSWORD = credentials.password;
  env.ZENITH_KEY_PASSWORD = credentials.password;
  env.ZENITH_KEY_ALIAS = credentials.alias;
  if (!existsSync(store)) {
    run(path.join(env.JAVA_HOME, 'bin', win ? 'keytool.exe' : 'keytool'), [
      '-genkeypair', '-keystore', store, '-storetype', 'PKCS12',
      '-storepass:env', 'ZENITH_STORE_PASSWORD', '-keypass:env', 'ZENITH_KEY_PASSWORD',
      '-alias', credentials.alias, '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000',
      '-dname', 'CN=Zenith Tabletop 3D, O=SSC-STUDIO',
    ]);
  }
  console.log(`Signing key backup location: ${signing}`);
}

npm(['run', 'android:sync']);
const gradleArgs = [':app:assembleRelease', ':app:lintRelease', '--no-daemon', '--console=plain'];
if (win) run('cmd.exe', ['/d', '/c', 'gradlew.bat', ...gradleArgs], path.join(root, 'android'));
else run('./gradlew', gradleArgs, path.join(root, 'android'));

const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const out = path.join(root, 'artifacts/android');
mkdirSync(out, { recursive: true });
const name = `Zenith-Tabletop-3D-${version}.apk`;
const apk = path.join(out, name);
copyFileSync(path.join(root, 'android/app/build/outputs/apk/release/app-release.apk'), apk);
const tools = path.join(env.ANDROID_HOME, 'build-tools/36.0.0');
if (win) run('cmd.exe', ['/d', '/c', path.join(tools, 'apksigner.bat'), 'verify', '--verbose', '--print-certs', apk]);
else run(path.join(tools, 'apksigner'), ['verify', '--verbose', '--print-certs', apk]);
const aapt = path.join(tools, win ? 'aapt.exe' : 'aapt');
const badging = execFileSync(aapt, ['dump', 'badging', apk], { env, encoding: 'utf8' });
assert(badging.includes("package: name='com.sscstudio.zenithtabletop3d'"));
assert(badging.includes(`versionName='${version}'`));
assert(!badging.includes('application-debuggable'), 'release must disable debugging');
const packaged = new Set(execFileSync(aapt, ['list', apk], { env, encoding: 'utf8' }).split(/\r?\n/));
let assets = 0;
function verifyAssets(dir, relative = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    const key = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) verifyAssets(file, key);
    else { assert(packaged.has(`assets/public/${key}`), `APK missing offline asset: ${key}`); assets++; }
  }
}
verifyAssets(path.join(root, 'dist'));
const hash = createHash('sha256').update(readFileSync(apk)).digest('hex');
writeFileSync(path.join(out, `${name}.sha256`), `${hash}  ${name}\n`);
writeFileSync(path.join(out, 'release-verification.json'), JSON.stringify({
  verifiedAt: new Date().toISOString(), name, version, sha256: hash,
  signatureVerified: true, debuggable: false, bundledFiles: assets,
}, null, 2));
console.log(`Verified APK: ${apk}`);
