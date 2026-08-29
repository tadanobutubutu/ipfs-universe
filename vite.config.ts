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
    // The only larger assets are lazy, cacheable Three.js and Helia vendor
    // chunks; neither blocks the first shell paint.
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        // Keep the WebGL renderer out of the first shell chunk. The scene is
        // imported after the first paint, so this cacheable vendor asset can
        // be fetched in parallel with the initial shell.
        manualChunks: (id) => id.includes('/node_modules/three/') ? 'three-vendor' : null,
      },
    },
  },
});
