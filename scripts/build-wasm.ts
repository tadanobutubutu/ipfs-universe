import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDirectory = resolve(repositoryRoot, 'public');
const physicsOutput = resolve(publicDirectory, 'physics.wasm');
const analyticsOutput = resolve(publicDirectory, 'analytics.wasm');
const rustManifest = resolve(repositoryRoot, 'wasm/Cargo.toml');
const rustArtifact = resolve(
  repositoryRoot,
  'wasm/target/wasm32-unknown-unknown/release/ipfs_universe_analytics.wasm',
);

await mkdir(publicDirectory, { recursive: true });

execFileSync(
  'zig',
  [
    'build-exe',
    'wasm/particles.zig',
    '-target',
    'wasm32-freestanding',
    '-O',
    'ReleaseSmall',
    '-fno-entry',
    '-rdynamic',
    `-femit-bin=${physicsOutput}`,
  ],
  { cwd: repositoryRoot, stdio: 'inherit' },
);

const rustCompiler = rustupToolPath('rustc');
const rustCargo = rustupToolPath('cargo');
execFileSync(
  rustCargo,
  [
    'build',
    '--manifest-path',
    rustManifest,
    '--target',
    'wasm32-unknown-unknown',
    '--release',
  ],
  {
    cwd: repositoryRoot,
    env: { ...process.env, RUSTC: rustCompiler },
    stdio: 'inherit',
  },
);

await copyFile(rustArtifact, analyticsOutput);
await Promise.all([
  assertWebAssembly(physicsOutput),
  assertWebAssembly(analyticsOutput),
]);

console.log('Zig物理WASMとRust解析WASMを検証して生成しました。');

function rustupToolPath(tool: 'cargo' | 'rustc'): string {
  try {
    const resolved = execFileSync('rustup', ['which', tool], {
      encoding: 'utf8',
    }).trim();
    return resolved.length > 0 ? resolved : tool;
  } catch {
    return tool;
  }
}

async function assertWebAssembly(path: string): Promise<void> {
  const bytes = await readFile(path);
  if (!WebAssembly.validate(bytes)) {
    throw new Error(`${path} は有効なWebAssembly moduleではありません。`);
  }
}
