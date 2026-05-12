import * as THREE from 'three';

/**
 * WebGL 1.0 Fallback Renderer
 */
export class WebGL1Renderer {
  private renderer: THREE.WebGLRenderer;

  constructor(canvas: HTMLCanvasElement) {
    console.log('[RENDERER] Initializing WebGL 1.0 (Legacy Mode)...');
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x080b14);
  }

  get api(): string { return 'WebGL 1.0'; }
  get isLegacy(): boolean { return true; }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.render(scene, camera);
  }

  setSize(width: number, height: number): void {
    this.renderer.setSize(width, height);
  }
}
