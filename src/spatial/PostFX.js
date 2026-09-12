/**
 * Post-processing chain: scene → multisampled HDR target → soft half-res bloom
 * (lantern and window glow) → tone-mapped output with vignette → SMAA.
 *
 * MSAA only smooths geometry edges; specular shimmer on the wood grain and the
 * painted board grid need an image-space pass, so both are used together.
 * SMAA runs after the OutputPass on display-referred colour, as intended.
 * Measured on an Intel UHD iGPU at 1578×802 every full-screen pass costs ≈5 ms
 * and 8× MSAA ≈29 ms, hence 4× samples and as few passes as possible.
 *
 * Browser only at runtime.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

/**
 * OutputPass (tone mapping + sRGB) with a vignette folded into the same
 * full-screen pass — every extra pass costs a full frame of fill rate, which
 * is exactly what integrated GPUs are short of.
 */
class OutputVignettePass extends OutputPass {
  constructor(strength = 0.28, softness = 0.55) {
    super();
    this.uniforms.vignetteStrength = { value: strength };
    this.uniforms.vignetteSoftness = { value: softness };
    this.material.fragmentShader = this.material.fragmentShader
      .replace('uniform sampler2D tDiffuse;', 'uniform sampler2D tDiffuse;\n\t\tuniform float vignetteStrength;\n\t\tuniform float vignetteSoftness;')
      .replace('// color space', `float vignetteD = length( vUv - 0.5 ) * 1.41421356;
			gl_FragColor.rgb *= 1.0 - vignetteStrength * smoothstep( vignetteSoftness, 1.15, vignetteD );

			// color space`);
    this.material.needsUpdate = true;
  }
}

/**
 * @typedef {object} PostFXOptions
 * @property {number} [samples]   MSAA samples for the HDR target (0 = off)
 * @property {boolean} [bloom]
 * @property {boolean} [smaa]
 * @property {number} [vignette]  0..1 strength, 0 = off
 */

export class PostFX {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {PostFXOptions} [options]
   */
  constructor(renderer, scene, camera, { samples = 4, bloom = true, smaa = true, vignette = 0.28 } = {}) {
    this.renderer = renderer;
    this.options = { samples, bloom, smaa, vignette };

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const maxSamples = renderer.capabilities.maxSamples ?? 0;
    // Scene target. No pass reads depth, so the multisampled depth attachment is never resolved
    // (three.js would otherwise blit it alongside the colour every frame).
    this.target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: Math.min(samples, maxSamples),
      resolveDepthBuffer: false,
    });
    // Ping-pong partner. RenderPass draws the scene into the composer's *read* buffer, so this one
    // only ever receives the tone-mapped full-screen quad: multisampling and a depth attachment
    // would just add a second MSAA resolve per frame.
    const quadTarget = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, depthBuffer: false });
    this.composer = new EffectComposer(renderer, quadTarget);
    this.composer.renderTarget2.dispose();
    this.composer.renderTarget2 = this.target;
    this.composer.readBuffer = this.target;
    this.composer.setPixelRatio(renderer.getPixelRatio());

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.bloomPass = null;
    if (bloom) {
      // Half-resolution input (the mip chain then starts at quarter res): a glow is soft by
      // nature and this halves the cost. Threshold above the tone-mapped white point keeps the
      // board and paper from glowing; only the lanterns, the window and specular peaks bloom.
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.32, 0.55, 0.92);
      // Full-screen quads only: the pass allocates its 11 targets with depth buffers it never uses.
      for (const rt of [this.bloomPass.renderTargetBright, ...this.bloomPass.renderTargetsHorizontal, ...this.bloomPass.renderTargetsVertical]) {
        rt.depthBuffer = false;
      }
      this.composer.addPass(this.bloomPass);
    }

    this.outputPass = vignette > 0 ? new OutputVignettePass(vignette) : new OutputPass();
    this.composer.addPass(this.outputPass);

    this.smaaPass = null;
    if (smaa) {
      this.smaaPass = new SMAAPass(size.x, size.y);
      this.composer.addPass(this.smaaPass);
    }
  }

  /**
   * @param {number} cssWidth
   * @param {number} cssHeight
   * @param {number} pixelRatio
   */
  setSize(cssWidth, cssHeight, pixelRatio) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(cssWidth, cssHeight);
    this.bloomPass?.setSize((cssWidth * pixelRatio) / 2, (cssHeight * pixelRatio) / 2);
  }

  /** @param {number} dt seconds */
  render(dt) {
    this.composer.render(dt);
  }

  dispose() {
    this.bloomPass?.dispose();
    this.smaaPass?.dispose?.();
    this.outputPass.dispose?.();
    this.composer.dispose();
    this.target.dispose();
  }
}
