// Three.js addon module declarations (not included in @types/three)
declare module 'three/addons/controls/OrbitControls.js' {
  export { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
}
declare module 'three/addons/postprocessing/EffectComposer.js' {
  export { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
}
declare module 'three/addons/postprocessing/RenderPass.js' {
  export { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
}
declare module 'three/addons/postprocessing/UnrealBloomPass.js' {
  export { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
}
declare module 'three/addons/postprocessing/OutputPass.js' {
  export { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
}

// WebGPU Navigator extension
interface Navigator {
  gpu?: GPU;
}
