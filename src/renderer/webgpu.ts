import * as THREE from 'three';
// @ts-ignore - WebGPURenderer is a named export from three/webgpu in r168
import { WebGPURenderer } from 'three/webgpu';

/**
 * Modern WebGPU Renderer
 */
export class WebGPURendererLayer {
  private renderer: any;

  constructor(canvas: HTMLCanvasElement) {
    console.log('[RENDERER] Initializing WebGPU (Next-gen Mode)...');
    this.renderer = new WebGPURenderer({
      canvas,
      antialias: true,
      alpha: false
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x080b14);
  }

  get api(): string { return 'WebGPU'; }
  get isLegacy(): boolean { return false; }

  async init(): Promise<void> {
    await this.renderer.init();
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.render(scene, camera);
  }

  setSize(width: number, height: number): void {
    this.renderer.setSize(width, height);
  }
}
