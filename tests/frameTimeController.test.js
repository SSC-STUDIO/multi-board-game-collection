import { describe, expect, it } from 'vitest';
import { FrameTimeController, IGNORED_FRAME_MS } from '../src/utils/FrameTimeController.js';

/** Feed `count` frames of `ms` each; returns every scale change that happened, in order. */
function feed(controller, ms, count) {
  const changes = [];
  for (let i = 0; i < count; i++) {
    const next = controller.update(ms);
    if (next !== null) changes.push(next);
  }
  return changes;
}

/** Skip the warm-up (and any post-change settle) with unremarkable frames. */
function warmUp(controller, ms = 10) {
  while (controller.warmingUp) controller.update(ms);
}

describe('FrameTimeController budget', () => {
  it('derives a 17.5 ms budget from 60 fps with the default slack', () => {
    const c = new FrameTimeController();
    expect(c.budgetMs).toBeCloseTo(17.5, 9);
    expect(c.scale).toBe(1);
    expect(c.averageMs).toBe(0);
  });

  it('follows targetFps changes immediately', () => {
    const c = new FrameTimeController();
    c.targetFps = 30;
    expect(c.budgetMs).toBeCloseTo(35, 9);
  });
});

describe('FrameTimeController sampling', () => {
  it('ignores the warm-up frames even when they are all over budget', () => {
    const c = new FrameTimeController({ warmupFrames: 60 });
    expect(feed(c, 50, 60)).toEqual([]);
    expect(c.averageMs).toBe(0);
    expect(c.warmingUp).toBe(false);
  });

  it('ignores stalls longer than 100 ms and non-positive deltas', () => {
    const c = new FrameTimeController({ warmupFrames: 0 });
    feed(c, 10, 20);
    const before = c.averageMs;
    expect(c.update(IGNORED_FRAME_MS + 1)).toBeNull();
    expect(c.update(0)).toBeNull();
    expect(c.update(-5)).toBeNull();
    expect(c.update(Number.NaN)).toBeNull();
    expect(c.averageMs).toBe(before);
    // Even a long run of stalls never lowers the scale.
    expect(feed(c, 500, 200)).toEqual([]);
    expect(c.scale).toBe(1);
  });

  it('smooths towards the sampled frame time', () => {
    const c = new FrameTimeController({ warmupFrames: 0, smoothing: 0.1 });
    c.update(20);
    expect(c.averageMs).toBe(20);
    c.update(10);
    expect(c.averageMs).toBeCloseTo(19, 9);
  });
});

describe('FrameTimeController stepping down', () => {
  it('lowers the scale by 0.1 once the average has been over budget for 750 ms, not before', () => {
    const c = new FrameTimeController();
    warmUp(c);
    // 25 ms frames: 29 of them are 725 ms, the 30th crosses 750 ms.
    expect(feed(c, 25, 29)).toEqual([]);
    expect(c.scale).toBe(1);
    expect(c.update(25)).toBe(0.9);
    expect(c.scale).toBe(0.9);
  });

  it('keeps the triggering average readable through the settle, then re-seeds from the new resolution', () => {
    const c = new FrameTimeController({ settleFrames: 10 });
    warmUp(c);
    feed(c, 25, 30);
    expect(c.scale).toBe(0.9);
    expect(c.averageMs).toBeCloseTo(25, 9);
    expect(c.warmingUp).toBe(true);
    // Settle frames are discarded; the first real sample replaces the stale average outright.
    feed(c, 40, 10);
    expect(c.averageMs).toBeCloseTo(25, 9);
    c.update(12);
    expect(c.averageMs).toBe(12);
  });

  it('walks down to the minimum in 0.1 steps and never below', () => {
    const c = new FrameTimeController();
    warmUp(c);
    const changes = feed(c, 50, 400);
    expect(changes).toEqual([0.9, 0.8, 0.7, 0.6]);
    expect(c.scale).toBe(0.6);
    expect(feed(c, 50, 400)).toEqual([]);
    expect(c.scale).toBe(0.6);
  });

  it('is not tripped by an isolated spike', () => {
    const c = new FrameTimeController();
    warmUp(c, 14);
    feed(c, 14, 120);
    // One 90 ms hitch (not long enough to be ignored) followed by normal frames.
    expect(c.update(90)).toBeNull();
    expect(c.averageMs).toBeGreaterThan(c.budgetMs);
    expect(feed(c, 14, 300)).toEqual([]);
    expect(c.scale).toBe(1);
  });

  it('requires the over-budget run to be continuous', () => {
    const c = new FrameTimeController({ warmupFrames: 0, smoothing: 1 });
    // 700 ms over budget, a dip into the dead band, another 700 ms over budget.
    expect(feed(c, 20, 35)).toEqual([]);
    expect(c.update(15)).toBeNull();
    expect(feed(c, 20, 35)).toEqual([]);
    expect(c.scale).toBe(1);
  });
});

describe('FrameTimeController stepping up and hysteresis', () => {
  it('raises the scale after 3 s comfortably under budget', () => {
    const c = new FrameTimeController();
    c.setScale(0.8);
    warmUp(c, 8);
    // 8 ms frames are under 70 % of 17.5 ms; 3000 / 8 = 375 frames to trigger.
    expect(feed(c, 8, 374)).toEqual([]);
    expect(c.update(8)).toBe(0.9);
    expect(c.scale).toBe(0.9);
  });

  it('holds the scale while the frame time sits in the dead band', () => {
    const c = new FrameTimeController();
    c.setScale(0.8);
    warmUp(c, 15);
    // 15 ms is under budget but above 70 % of it: neither rule fires, even after 30 s.
    expect(feed(c, 15, 2000)).toEqual([]);
    expect(c.scale).toBe(0.8);
  });

  it('never oscillates when the next step up would land over budget', () => {
    const c = new FrameTimeController();
    warmUp(c, 10);
    // Synthetic GPU: fill cost scales with the pixel count, 18 ms at full resolution.
    const frameMs = () => 18 * c.scale * c.scale;
    const changes = [];
    for (let i = 0; i < 6000; i++) {
      const next = c.update(frameMs());
      if (next !== null) changes.push(next);
    }
    // 18 → 0.9: 14.6 ms lands in the dead band and stays there for the remaining ~90 s.
    expect(changes).toEqual([0.9]);
    expect(c.scale).toBe(0.9);
  });

  it('recovers one step after the load lightens and then settles', () => {
    const c = new FrameTimeController();
    warmUp(c, 10);
    const changes = [];
    const run = (fullResMs, frames) => {
      for (let i = 0; i < frames; i++) {
        const next = c.update(fullResMs * c.scale * c.scale);
        if (next !== null) changes.push(next);
      }
    };
    // Heavy phase: 60 ms at full resolution is still 21.6 ms at the 0.6 floor.
    run(60, 2000);
    expect(changes).toEqual([0.9, 0.8, 0.7, 0.6]);
    // Lighter phase: 30 ms at full → 10.8 ms at 0.6 (under 70 %), 14.7 ms at 0.7 (dead band).
    run(30, 6000);
    expect(changes).toEqual([0.9, 0.8, 0.7, 0.6, 0.7]);
    expect(c.scale).toBe(0.7);
  });
});

describe('FrameTimeController reset and overrides', () => {
  it('reset() restores the maximum scale, clears the average and restarts the warm-up', () => {
    const c = new FrameTimeController();
    warmUp(c);
    feed(c, 50, 200);
    expect(c.scale).toBeLessThan(1);
    c.reset();
    expect(c.scale).toBe(1);
    expect(c.averageMs).toBe(0);
    expect(c.warmingUp).toBe(true);
    expect(feed(c, 50, 60)).toEqual([]);
  });

  it('setScale clamps into [min, max] and snaps to two decimals', () => {
    const c = new FrameTimeController();
    expect(c.setScale(0.2)).toBe(0.6);
    expect(c.setScale(1.7)).toBe(1);
    expect(c.setScale(0.7999999)).toBe(0.8);
    expect(c.scale).toBe(0.8);
  });

  it('keeps stepping from a manually set scale', () => {
    const c = new FrameTimeController();
    c.setScale(0.75);
    warmUp(c);
    expect(feed(c, 50, 400)).toEqual([0.65, 0.6]);
  });
});
