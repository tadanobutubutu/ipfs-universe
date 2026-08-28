import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  formatFailure,
  requireEnvironment,
  validateCid,
} from './deployment-shared.ts';

interface DnslinkOptions {
  cid: string;
  domain: string;
  fetcher?: typeof fetch;
  token: string;
  zoneId: string;
}

interface CloudflareRecord {
  id: string;
  name: string;
  type: string;
}

interface CloudflareEnvelope {
  errors?: Array<{ code?: number; message?: string }>;
  result?: unknown;
  success?: boolean;
}

function validateIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
  return value;
}

function validateDomain(value: string): string {
  const domain = value.trim().toLowerCase();
  if (
    domain.length > 253 ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(
      domain,
    )
  ) {
    throw new Error('DNSLink domain is invalid.');
  }
  return domain;
}

async function readCloudflareResult(response: Response): Promise<unknown> {
  let envelope: CloudflareEnvelope;
  try {
    envelope = (await response.json()) as CloudflareEnvelope;
  } catch {
    throw new Error('Cloudflare returned a non-JSON response.');
  }

  if (!response.ok || envelope.success !== true) {
    const code = envelope.errors?.[0]?.code;
    const suffix = typeof code === 'number' ? ` (code ${code})` : '';
    throw new Error(
      `Cloudflare DNS request failed with HTTP ${response.status}${suffix}.`,
    );
  }
  return envelope.result;
}

function parseRecords(result: unknown): CloudflareRecord[] {
  if (!Array.isArray(result)) {
    throw new Error('Cloudflare returned an invalid DNS record list.');
  }

  return result.map((record: unknown) => {
    if (
      typeof record !== 'object' ||
      record === null ||
      !('id' in record) ||
      !('name' in record) ||
      !('type' in record) ||
      typeof record.id !== 'string' ||
      typeof record.name !== 'string' ||
      typeof record.type !== 'string'
    ) {
      throw new Error('Cloudflare returned a malformed DNS record.');
    }
    return { id: record.id, name: record.name, type: record.type };
  });
}

export async function updateDnslink({
  cid: cidInput,
  domain: domainInput,
  fetcher = fetch,
  token,
  zoneId: zoneIdInput,
}: DnslinkOptions): Promise<void> {
  const cid = validateCid(cidInput);
  const domain = validateDomain(domainInput);
  const zoneId = validateIdentifier(zoneIdInput, 'Cloudflare zone ID');
  const recordName = `_dnslink.${domain}`;
  const collectionUrl = new URL(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
  );
  collectionUrl.searchParams.set('type', 'TXT');
  collectionUrl.searchParams.set('name', recordName);

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  const listResponse = await fetcher(collectionUrl, {
    headers,
    method: 'GET',
    signal: AbortSignal.timeout(30_000),
  });
  const records = parseRecords(await readCloudflareResult(listResponse));
  const exactRecords = records.filter(
    (record) => record.name === recordName && record.type === 'TXT',
  );
  if (exactRecords.length > 1) {
    throw new Error('Expected exactly zero or one DNSLink TXT record.');
  }

  const body = JSON.stringify({
    comment: 'Peerstellation release pointer; managed by GitHub Actions',
    content: `dnslink=/ipfs/${cid}`,
    name: recordName,
    proxied: false,
    ttl: 1,
    type: 'TXT',
  });
  const record = exactRecords[0];
  const updateUrl = record
    ? new URL(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${validateIdentifier(record.id, 'DNS record ID')}`,
      )
    : new URL(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
      );

  const updateResponse = await fetcher(updateUrl, {
    body,
    headers,
    method: record ? 'PATCH' : 'POST',
    signal: AbortSignal.timeout(30_000),
  });
  await readCloudflareResult(updateResponse);
}

async function main(): Promise<void> {
  await updateDnslink({
    cid: requireEnvironment(process.env, 'CID'),
    domain: process.env.DNSLINK_DOMAIN?.trim() || 'ipfsuniverse.xyz',
    token: requireEnvironment(process.env, 'CLOUDFLARE_DNS_API_TOKEN'),
    zoneId: requireEnvironment(process.env, 'CLOUDFLARE_ZONE_ID'),
  });
  console.log('Updated only the _dnslink TXT record.');
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  main().catch((error: unknown) => {
    console.error(formatFailure(error));
    process.exitCode = 1;
  });
}
