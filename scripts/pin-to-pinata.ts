import { appendFile, lstat, readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  formatFailure,
  requireEnvironment,
  validateCid,
} from './deployment-shared.ts';

const pinataEndpoint =
  'https://api.pinata.cloud/pinning/pinFileToIPFS';

export interface DeploymentFile {
  absolutePath: string;
  relativePath: string;
}

interface PinDirectoryOptions {
  directory: string;
  fetcher?: typeof fetch;
  token: string;
}

const contentTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

function toPortablePath(path: string): string {
  return path.split(sep).join('/');
}

export async function collectDeploymentFiles(
  directory: string,
): Promise<DeploymentFile[]> {
  const root = resolve(directory);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) {
    throw new Error(`Deployment path is not a directory: ${root}`);
  }

  const files: DeploymentFile[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Refusing symbolic link in deployment directory: ${absolutePath}`,
        );
      }
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported deployment entry: ${absolutePath}`);
      }

      const relativePath = toPortablePath(relative(root, absolutePath));
      if (!relativePath || relativePath.startsWith('../')) {
        throw new Error(`Deployment entry escaped its root: ${absolutePath}`);
      }
      files.push({ absolutePath, relativePath });
    }
  }

  await walk(root);
  if (files.length === 0) {
    throw new Error(`Deployment directory is empty: ${root}`);
  }
  return files;
}

function contentType(path: string): string {
  return contentTypes[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

async function parsePinataResponse(response: Response): Promise<string> {
  if (!response.ok) {
    throw new Error(`Pinata upload failed with HTTP ${response.status}.`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Pinata returned a non-JSON response.');
  }

  const cid =
    typeof body === 'object' && body !== null && 'IpfsHash' in body
      ? body.IpfsHash
      : undefined;
  return validateCid(cid);
}

export async function pinDirectoryToPinata({
  directory,
  fetcher = fetch,
  token,
}: PinDirectoryOptions): Promise<string> {
  const files = await collectDeploymentFiles(directory);
  const form = new FormData();

  for (const file of files) {
    const bytes = await readFile(file.absolutePath);
    const upload = new File([new Uint8Array(bytes)], file.relativePath, {
      type: contentType(file.relativePath),
    });
    form.append('file', upload);
  }

  form.append(
    'pinataMetadata',
    JSON.stringify({
      keyvalues: { channel: 'production', source: 'github-actions' },
      name: 'peerstellation',
    }),
  );
  form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

  const response = await fetcher(pinataEndpoint, {
    body: form,
    headers: { Authorization: `Bearer ${token}` },
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
  });
  return parsePinataResponse(response);
}

async function main(): Promise<void> {
  const token = requireEnvironment(process.env, 'PINATA_JWT');
  const cid = await pinDirectoryToPinata({
    directory: resolve(process.cwd(), 'dist'),
    token,
  });

  const output = process.env.GITHUB_OUTPUT?.trim();
  if (output) {
    await appendFile(output, `cid=${cid}\n`, 'utf8');
  }
  console.log(`Pinned immutable release: ipfs://${cid}`);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  main().catch((error: unknown) => {
    console.error(formatFailure(error));
    process.exitCode = 1;
  });
}
