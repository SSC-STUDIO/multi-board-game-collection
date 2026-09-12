/** Exercise the installed Debug APK on a dedicated Android emulator, offline. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Cdp, ROOT, sleep } from '../lib/browser.mjs';

const serial = process.env.ZENITH_ANDROID_SERIAL ?? 'emulator-5556';
if (!serial.startsWith('emulator-')) throw Error('Use a dedicated emulator: this test clears the Debug app data.');
const sdk = process.env.ANDROID_HOME ?? path.join(os.homedir(), '.cache/zenith-android/sdk');
const adbFile = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const adb = (...args) => execFileSync(adbFile, ['-s', serial, ...args], { encoding: 'utf8', timeout: 90_000 }).trim();
const pkg = 'com.sscstudio.zenithtabletop3d.debug';
const activity = `${pkg}/com.sscstudio.zenithtabletop3d.MainActivity`;
const out = path.join(ROOT, 'artifacts/android');
await fs.mkdir(out, { recursive: true });
const screenshot = async name => fs.writeFile(path.join(out, `${name}.png`), execFileSync(adbFile, ['-s', serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 16 * 1024 * 1024 }));
const until = async (check, description, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(250);
  }
  throw Error(`Timed out: ${description}`);
};
const connect = async () => {
  await until(() => !!adb('shell', 'pidof', pkg), 'Android process');
  const pid = adb('shell', 'pidof', pkg);
  adb('forward', 'tcp:9344', `localabstract:webview_devtools_remote_${pid}`);
  const connection = await Cdp.connect(9344);
  await until(() => connection.eval('!!globalThis.zenith?.disposeNative'), 'offline app boot');
  return connection;
};

let cdp;
const problems = [];
const checks = [];
const consoleReads = [];
async function collectNativeProblems(connection) {
  await connection.send('Runtime.enable');
  connection.on('Runtime.exceptionThrown', event => problems.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text));
  connection.on('Runtime.consoleAPICalled', event => {
    if (event.type !== 'error') return;
    consoleReads.push((async () => {
      const values = await Promise.all(event.args.map(async arg => {
        if (!arg.objectId) return arg.value ?? arg.description;
        const result = await connection.send('Runtime.callFunctionOn', {
          objectId: arg.objectId, functionDeclaration: 'function() { return JSON.stringify(this); }', returnByValue: true,
        });
        return JSON.parse(result.result.value ?? 'null');
      }));
      // Capacitor's debug bridge logs rejected plugin calls. Dismissing the chooser is expected.
      if (values.length === 1 && values[0]?.message === 'Share canceled') return;
      problems.push(JSON.stringify(values));
    })());
  });
}
const originalAirplane = adb('shell', 'settings', 'get', 'global', 'airplane_mode_on');
const originalRotation = adb('shell', 'settings', 'get', 'system', 'user_rotation');
const originalAutoRotate = adb('shell', 'settings', 'get', 'system', 'accelerometer_rotation');
try {
  adb('install', '-r', path.join(ROOT, 'android/app/build/outputs/apk/debug/app-debug.apk'));
  adb('shell', 'pm', 'clear', pkg);
  adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'enable');
  adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
  adb('shell', 'settings', 'put', 'system', 'user_rotation', '0');
  adb('shell', 'am', 'start', '-W', '-n', activity);
  cdp = await connect();
  await collectNativeProblems(cdp);
  await until(() => cdp.eval('!!zenith.player.avatar && !!zenith.opponent.avatar'), 'bundled character models');
  assert(await cdp.eval('!!zenith.world.scene.getObjectByName("chinese_armchair") && !!zenith.assets.fonts.kai && zenith.ai.offThread'));
  assert.equal(await cdp.eval('location.origin'), 'https://localhost');
  assert(await cdp.eval('Capacitor.isNativePlatform()'));
  await screenshot('android-title');
  checks.push('offline cold start: bundled models, fonts, AI Worker and native bridge');

  const tap = async point => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const button = async selector => {
    const point = await cdp.eval(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw Error('Missing button'); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await tap(point);
  };
  const consoleAction = async id => {
    const point = await cdp.eval(`(() => {
      zenith.syncTableConsole();
      const c=zenith.tableConsole, i=c.actions.findIndex(a=>a.id===${JSON.stringify(id)} && a.enabled);
      if(i<0) throw Error('Unavailable desk action');
      c.face.updateWorldMatrix(true,false);
      const v=c.face.localToWorld(zenith.world.camera.position.clone().set(((i+.5)/c.actions.length-.5)*10.25,-.16*1.19,0));
      v.project(zenith.world.camera); const r=zenith.world.canvas.getBoundingClientRect();
      return {x:r.x+(v.x+1)*r.width/2,y:r.y+(1-v.y)*r.height/2};
    })()`);
    await tap(point);
  };
  await cdp.eval('zenith.pendingTutorial=false; zenith.settings.aiDepth=2; true');
  await button('[data-action=start]');
  await until(() => cdp.eval('zenith.seated && !zenith.startScreen.visible'), 'seat animation');
  await sleep(1600);
  await consoleAction('black');
  await until(() => cdp.eval('zenith.engine.status === "PLAYING"'), 'touch colour selection');
  await sleep(1600);
  const cell = await cdp.eval(`(() => {
    const p=zenith.board.getStoneWorldPosition(7,7); p.y-=.085; p.project(zenith.world.camera);
    const r=zenith.world.canvas.getBoundingClientRect(); return {x:r.x+(p.x+1)*r.width/2,y:r.y+(1-p.y)*r.height/2};
  })()`);
  await tap(cell);
  await until(() => cdp.eval('zenith.engine.moves.length===2 && zenith.carrying.size===0'), 'touch move and actual AI response');
  await screenshot('android-play-portrait');
  checks.push('real touch selects black and places H8; actual worker AI replies');

  adb('shell', 'input', 'keyevent', '4');
  await until(() => cdp.eval('zenith.menuOpen && zenith.engine.status === "PAUSED"'), 'Android Back pauses and opens menu');
  await screenshot('android-menu');
  await button('[data-action=save]');
  await until(() => /ChooserActivity/.test(adb('shell', 'dumpsys', 'activity', 'activities')), 'native share chooser');
  const cachedRecord = JSON.parse(adb('shell', 'run-as', pkg, 'cat', 'cache/zenith-game.json'));
  assert.equal(cachedRecord.moves.length, 2);
  await screenshot('android-share');
  adb('shell', 'input', 'keyevent', '4');
  await sleep(1000);
  await button('[data-action=resume]');
  await until(() => cdp.eval('zenith.engine.status === "PLAYING"'), 'resume after share');
  checks.push('Android Back pauses; system shares a valid two-move JSON record');

  adb('shell', 'input', 'keyevent', '3');
  await sleep(1800);
  adb('shell', 'am', 'start', '-W', '-n', activity);
  await until(() => cdp.eval('zenith.menuOpen && zenith.engine.status === "PAUSED"'), 'background pause');
  const clock = await cdp.eval('zenith.engine.getState().clock.black');
  await sleep(1200);
  assert.equal(await cdp.eval('zenith.engine.getState().clock.black'), clock);
  checks.push('background auto-save and pause; returning does not consume clock time');

  await button('[data-action=resume]');
  adb('shell', 'settings', 'put', 'system', 'user_rotation', '1');
  await until(() => cdp.eval('innerWidth > innerHeight'), 'landscape rotation');
  await sleep(1500);
  assert.equal(await cdp.eval('zenith.engine.moves.length'), 2);
  await screenshot('android-play-landscape');
  adb('shell', 'settings', 'put', 'system', 'user_rotation', '0');
  await until(() => cdp.eval('innerHeight > innerWidth'), 'portrait rotation');
  adb('shell', 'input', 'keyevent', '4');
  await until(() => cdp.eval('zenith.menuOpen'), 'persist before relaunch');
  cdp.close(); cdp = null;
  adb('shell', 'am', 'force-stop', pkg);
  adb('shell', 'am', 'start', '-W', '-n', activity);
  cdp = await connect();
  await collectNativeProblems(cdp);
  await button('[data-action=continue-saved]');
  await until(() => cdp.eval('zenith.seated && zenith.engine.moves.length===2'), 'resume saved game after process restart');
  await sleep(1500);
  await screenshot('android-continued');
  checks.push('landscape/portrait preserve the game; process restart restores the saved game');
  await Promise.all(consoleReads);
  assert.deepEqual(problems, []);
  await fs.writeFile(path.join(out, 'device-verification.json'), JSON.stringify({
    verifiedAt: new Date().toISOString(), serial,
    android: adb('shell', 'getprop', 'ro.build.version.release'),
    webView: adb('shell', 'dumpsys', 'webviewupdate').split('\n').find(line => line.includes('Current WebView package'))?.trim(),
    checks, problems,
  }, null, 2));
  console.log(`✓ Android APK: ${checks.join('; ')}`);
} finally {
  cdp?.close();
  adb('forward', '--remove', 'tcp:9344');
  adb('shell', 'cmd', 'connectivity', 'airplane-mode', originalAirplane === '1' ? 'enable' : 'disable');
  adb('shell', 'settings', 'put', 'system', 'user_rotation', originalRotation);
  adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', originalAutoRotate);
}
