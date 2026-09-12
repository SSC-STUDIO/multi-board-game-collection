/**
 * Tiny diagnostics readout, only mounted with `?debug=1`: frame rate, frame
 * time, draw calls / triangles of the last frame, drawing-buffer size, pixel
 * ratio, the dynamic resolution scale with the loop's smoothed frame time, the
 * idle flag of the frame cap, and the GPU the browser is actually using
 * (laptops frequently run the page on the integrated GPU). Development aid;
 * not part of the diegetic UI.
 */
export class DebugStats {
  /**
   * @param {import('../spatial/World.js').World} world
   * @param {{ intervalMs?: number, parent?: HTMLElement }} [options]
   */
  constructor(world, { intervalMs = 500, parent = document.body } = {}) {
    this.world = world;
    this.intervalMs = intervalMs;
    this._frames = 0;
    this._accum = 0;
    this._worst = 0;
    this._gpu = safeGpuName(world);

    this.root = document.createElement('pre');
    this.root.className = 'zt-debug';
    this.root.setAttribute('aria-hidden', 'true');
    Object.assign(this.root.style, {
      position: 'fixed',
      left: '8px',
      top: '8px',
      zIndex: '20',
      margin: '0',
      padding: '6px 9px',
      font: '11px/1.5 Consolas, "Courier New", monospace',
      color: '#f1e6cf',
      background: 'rgba(10, 7, 5, 0.66)',
      border: '1px solid rgba(255, 220, 170, 0.25)',
      borderRadius: '4px',
      pointerEvents: 'none',
      whiteSpace: 'pre',
    });
    parent.appendChild(this.root);
  }

  /** @param {number} dt seconds since last frame (unclamped wall time preferred) */
  update(dt) {
    this._frames++;
    this._accum += dt;
    this._worst = Math.max(this._worst, dt);
    if (this._accum < this.intervalMs / 1000) return;

    const avgMs = (this._accum / this._frames) * 1000;
    const fps = this._frames / this._accum;
    const info = this.world.renderInfo;
    const world = this.world;
    const smoothed = world.frameTimeMs > 0 ? `${world.frameTimeMs.toFixed(1)} ms smoothed` : 'warming up';
    const scaler = world.adaptiveResolution ? 'adaptive' : 'fixed';
    const idle = world.idle ? `  idle${world.idleFpsCap > 0 ? ` (cap ${world.idleFpsCap} fps)` : ''}` : '';
    this.root.textContent = [
      `${fps.toFixed(0).padStart(3)} fps  ${avgMs.toFixed(1)} ms avg  ${(this._worst * 1000).toFixed(1)} ms worst`,
      `${info.calls} draw calls  ${(info.triangles / 1000).toFixed(1)}k tris  ${info.points} pts`,
      `${info.width}×${info.height} @${info.pixelRatio.toFixed(2)}  ${world.renderer.shadowMap.enabled ? 'shadows' : 'no shadows'}`,
      `scale ${world.resolutionScale.toFixed(2)} (${scaler})  ${smoothed}${idle}`,
      this._gpu,
    ].join('\n');

    this._frames = 0;
    this._accum = 0;
    this._worst = 0;
  }

  dispose() {
    this.root.remove();
  }
}

function safeGpuName(world) {
  try {
    return world.gpuName;
  } catch {
    return 'GPU: unknown';
  }
}
