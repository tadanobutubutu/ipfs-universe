import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectDeploymentFiles,
  pinDirectoryToPinata,
} from '../scripts/pin-to-pinata.ts';
import { updateDnslink } from '../scripts/update-dnslink.ts';

const temporaryDirectories: string[] = [];
const validCid =
  'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3fod4bu6vkp7jynbnqvistfva';

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function makeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ipfs-universe-deploy-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<!doctype html>');
  await writeFile(join(root, 'assets', 'app.css'), ':root{}');
  return root;
}

describe('Pinata deployment', () => {
  it('collects regular files in a deterministic order', async () => {
    const root = await makeFixture();

    await expect(collectDeploymentFiles(root)).resolves.toEqual([
      {
        absolutePath: join(root, 'assets', 'app.css'),
        relativePath: 'assets/app.css',
      },
      {
        absolutePath: join(root, 'index.html'),
        relativePath: 'index.html',
      },
    ]);
  });

  it('refuses symbolic links instead of uploading outside the build', async () => {
    const root = await makeFixture();
    await symlink('/etc/hosts', join(root, 'escaped-file'));

    await expect(collectDeploymentFiles(root)).rejects.toThrow(
      /symbolic link/iu,
    );
  });

  it('uploads the complete directory and returns a validated CID', async () => {
    const root = await makeFixture();
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({ Authorization: 'Bearer test-token' });
      expect(init?.body).toBeInstanceOf(FormData);

      const body = init?.body as FormData;
      const names = body.getAll('file').map((entry) => {
        expect(entry).toBeInstanceOf(File);
        return (entry as File).name;
      });
      expect(names).toEqual(['assets/app.css', 'index.html']);
      expect(body.get('pinataOptions')).toBe('{"cidVersion":1}');

      return Response.json({ IpfsHash: validCid });
    });

    await expect(
      pinDirectoryToPinata({
        directory: root,
        fetcher,
        token: 'test-token',
      }),
    ).resolves.toBe(validCid);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://api.pinata.cloud/pinning/pinFileToIPFS',
    );
  });

  it('fails closed when Pinata returns an invalid CID', async () => {
    const root = await makeFixture();
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ IpfsHash: 'not-a-cid' }),
    );

    await expect(
      pinDirectoryToPinata({
        directory: root,
        fetcher,
        token: 'test-token',
      }),
    ).rejects.toThrow(/valid CID/iu);
  });
});

describe('DNSLink deployment', () => {
  it('updates only the exact existing DNSLink TXT record', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          errors: [],
          result: [
            {
              id: 'dnslink-record',
              name: '_dnslink.ipfsuniverse.xyz',
              type: 'TXT',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ success: true, errors: [], result: {} }),
      );

    await updateDnslink({
      cid: validCid,
      domain: 'ipfsuniverse.xyz',
      fetcher,
      token: 'dns-token',
      zoneId: 'zone-id',
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const listUrl = String(fetcher.mock.calls[0]?.[0]);
    expect(listUrl).toContain('type=TXT');
    expect(listUrl).toContain('name=_dnslink.ipfsuniverse.xyz');

    const [updateUrl, updateInit] = fetcher.mock.calls[1] ?? [];
    expect(String(updateUrl)).toMatch(/\/dns_records\/dnslink-record$/u);
    expect(updateInit?.method).toBe('PATCH');
    expect(JSON.parse(String(updateInit?.body))).toEqual({
              comment: 'Peerstellation release pointer; managed by GitHub Actions',
      content: `dnslink=/ipfs/${validCid}`,
      name: '_dnslink.ipfsuniverse.xyz',
      proxied: false,
      ttl: 1,
      type: 'TXT',
    });
  });

  it('creates the DNSLink TXT record without touching apex records', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ success: true, errors: [], result: [] }),
      )
      .mockResolvedValueOnce(
        Response.json({ success: true, errors: [], result: {} }),
      );

    await updateDnslink({
      cid: validCid,
      domain: 'ipfsuniverse.xyz',
      fetcher,
      token: 'dns-token',
      zoneId: 'zone-id',
    });

    const [createUrl, createInit] = fetcher.mock.calls[1] ?? [];
    expect(String(createUrl)).toMatch(/\/dns_records$/u);
    expect(createInit?.method).toBe('POST');
    expect(fetcher.mock.calls.flat().join(' ')).not.toContain(
      'cloudflare-ipfs.com',
    );
  });

  it('stops on ambiguous DNSLink records', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        success: true,
        errors: [],
        result: [
          { id: 'one', name: '_dnslink.ipfsuniverse.xyz', type: 'TXT' },
          { id: 'two', name: '_dnslink.ipfsuniverse.xyz', type: 'TXT' },
        ],
      }),
    );

    await expect(
      updateDnslink({
        cid: validCid,
        domain: 'ipfsuniverse.xyz',
        fetcher,
        token: 'dns-token',
        zoneId: 'zone-id',
      }),
    ).rejects.toThrow(/exactly zero or one/iu);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('static deployment configuration', () => {
  it('uses an asset-only Worker with exact production routes', async () => {
    const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8')) as {
      assets?: { directory?: string };
      main?: string;
      routes?: Array<{ pattern?: string; zone_name?: string }>;
    };

    expect(config.main).toBeUndefined();
    expect(config.assets?.directory).toBe('./dist');
    expect(config.routes).toEqual([
      {
        pattern: 'ipfsuniverse.xyz/*',
        zone_name: 'ipfsuniverse.xyz',
      },
      {
        pattern: 'www.ipfsuniverse.xyz/*',
        zone_name: 'ipfsuniverse.xyz',
      },
    ]);
  });

  it('ships a strict CSP compatible with WebAssembly and Helia', async () => {
    const headers = await readFile('public/_headers', 'utf8');

    expect(headers).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(headers).not.toContain("'unsafe-inline'");
    expect(headers).not.toMatch(/(?<!wasm-)'unsafe-eval'/u);
    expect(headers).toContain('Cross-Origin-Opener-Policy: same-origin');
    expect(headers).toContain(
      'Cross-Origin-Embedder-Policy: require-corp',
    );
    expect(headers).toContain("frame-ancestors 'none'");
  });
});
