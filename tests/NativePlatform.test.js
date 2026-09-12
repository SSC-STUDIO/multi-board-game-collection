import { describe, it, expect, vi } from 'vitest';
import { bindNativeLifecycle, setupNativePlatform } from '../src/services/NativePlatform.js';
import { GameEngine, GameStatus, BLACK } from '../src/core/index.js';

describe('Android lifecycle', () => {
  it('pauses a timed game in the background and requires explicit resume', async () => {
    const handlers = {};
    const engine = new GameEngine({ initialMs: 60_000 });
    engine.selectColor(BLACK, 1000);
    const app = {
      seated: true, tutorial: { active: false },
      openMenu() { if (engine.status === GameStatus.PLAYING) engine.togglePause(2000); },
      persistSession: vi.fn(), world: { stop: vi.fn(), start: vi.fn() },
      audio: { context: { suspend: vi.fn().mockResolvedValue() }, unlock: vi.fn().mockResolvedValue() },
    };
    const remove = vi.fn();
    const dispose = await bindNativeLifecycle(app, { addListener: async (name, fn) => { handlers[name] = fn; return { remove }; } });
    handlers.appStateChange({ isActive: false });
    const remaining = engine.getState().clock.black;
    expect(remaining).toBe(59_000);
    expect(engine.status).toBe(GameStatus.PAUSED);
    expect(app.persistSession).toHaveBeenCalledWith(true);
    handlers.appStateChange({ isActive: true });
    engine.tick(500000);
    expect(engine.status).toBe(GameStatus.PAUSED);
    expect(engine.getState().clock.black).toEqual(remaining);
    expect(app.world.start).toHaveBeenCalledOnce();
    await dispose();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('only exits at the title screen and routes other Back presses through game navigation', async () => {
    const handlers = {};
    const native = { addListener: async (name, fn) => { handlers[name] = fn; return { remove() {} }; }, exitApp: vi.fn().mockResolvedValue() };
    const app = { startScreen: { visible: true, mode: 'title' }, persistSession: vi.fn(), onKeyDown: vi.fn() };
    await bindNativeLifecycle(app, native);
    handlers.backButton();
    expect(native.exitApp).toHaveBeenCalledOnce();
    for (const mode of ['menu', 'import']) {
      app.startScreen.mode = mode;
      handlers.backButton();
    }
    app.startScreen.visible = false;
    handlers.backButton();
    expect(native.exitApp).toHaveBeenCalledOnce();
    expect(app.onKeyDown).toHaveBeenCalledTimes(3);
    expect(app.onKeyDown.mock.calls[0][0].key).toBe('Escape');
  });

  it('does not load native plugins on the web', async () => {
    expect(typeof await setupNativePlatform({})).toBe('function');
  });
});
