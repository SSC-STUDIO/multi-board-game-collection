/** Android integration stays lazy so the same sources also run in a browser. */
export const isNativeApp = () => globalThis.Capacitor?.isNativePlatform?.() === true;

export async function bindNativeLifecycle(app, nativeApp) {
  const listeners = [];
  try {
    listeners.push(await nativeApp.addListener('backButton', () => {
      if (app.startScreen.visible && app.startScreen.mode === 'title') {
        app.persistSession(true);
        nativeApp.exitApp().catch(console.error);
      } else {
        // Reuse the same menu / importer / tutorial / replay transitions as Esc.
        app.onKeyDown({ key: 'Escape', preventDefault() {} });
      }
    }));
    listeners.push(await nativeApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) {
        if (app.seated && !app.tutorial.active) app.openMenu();
        app.persistSession(true);
        app.world.stop();
        app.audio.context?.suspend().catch(console.error);
      } else {
        app.world.start();
        // Resume rendering, but leave the game paused until the player continues.
        app.audio.unlock().catch(console.error);
      }
    }));
  } catch (error) {
    await Promise.all(listeners.map(listener => listener.remove()));
    throw error;
  }
  return () => Promise.all(listeners.map(listener => listener.remove()));
}

export async function setupNativePlatform(app) {
  if (!isNativeApp()) return () => {};
  const { App } = await import('@capacitor/app');
  return bindNativeLifecycle(app, App);
}

export async function shareNativeRecord(record) {
  const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'), import('@capacitor/share'),
  ]);
  // A single private cache file avoids accumulating a copy on every export.
  const { uri } = await Filesystem.writeFile({
    path: 'zenith-game.json', directory: Directory.Cache,
    data: JSON.stringify(record, null, 2), encoding: Encoding.UTF8,
  });
  await Share.share({ title: 'Zenith Tabletop 3D 棋谱', files: [uri], dialogTitle: '保存或分享棋谱' });
}
