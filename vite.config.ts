import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

export default defineConfig({
  plugins: [
    wasm(),
    topLevelAwait()
  ],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    target: 'esnext'
  }
});

