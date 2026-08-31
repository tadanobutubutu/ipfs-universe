import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const isolationHeaders = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const securityHeaders = {
  ...isolationHeaders,
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https: wss: http://127.0.0.1:5001 http://localhost:5001; worker-src 'self' blob:; child-src 'self' blob:; manifest-src 'self'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Origin-Agent-Cluster': '?1',
  'Permissions-Policy':
    'accelerometer=(), ambient-light-sensor=(), autoplay=(), bluetooth=(), browsing-topics=(), camera=(), clipboard-read=(), clipboard-write=(), compute-pressure=(), display-capture=(), fullscreen=(), gamepad=(), geolocation=(), gyroscope=(), hid=(), identity-credentials-get=(), idle-detection=(), local-fonts=(), magnetometer=(), microphone=(), midi=(), otp-credentials=(), payment=(), publickey-credentials-create=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), speaker-selection=(), storage-access=(), usb=(), web-share=(), xr-spatial-tracking=()',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Permitted-Cross-Domain-Policies': 'none',
};

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    headers: isolationHeaders,
  },
  preview: {
    headers: securityHeaders,
  },
  build: {
    target: 'es2022',
    // Keep source maps out of the static deployment: the public repository is
    // the source of truth, and production should not ship several extra MB.
    sourcemap: false,
    // The WebGPU entry intentionally carries both the WebGPU and WebGL2
    // backends for runtime fallback. It is lazy and cacheable, so keep the
    // warning budget honest while splitting the network graph into cacheable
    // transport/runtime chunks instead of hiding one oversized asset.
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      output: {
        // Keep the render and network graphs out of the first shell chunk.
        // They are imported after the first paint, so independent cacheable
        // assets can be fetched in parallel without making Helia's large
        // transport graph one monolithic warning-sized file.
        manualChunks: (id) => {
          if (id.includes('/node_modules/three/')) return 'three-vendor';
          if (
            id.includes('/node_modules/helia/') ||
            id.includes('/node_modules/@helia/')
          ) {
            return 'helia-vendor';
          }
          if (
            id.includes('/node_modules/@libp2p/') ||
            id.includes('/node_modules/@chainsafe/') ||
            id.includes('/node_modules/multiformats/')
          ) {
            return 'libp2p-vendor';
          }
          return null;
        },
      },
    },
  },
});
