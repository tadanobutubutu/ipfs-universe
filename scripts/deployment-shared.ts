import { CID } from 'multiformats/cid';

export function requireEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set.`);
  }
  return value;
}

export function validateCid(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128) {
    throw new Error('The deployment service did not return a valid CID.');
  }

  try {
    return CID.parse(value).toString();
  } catch {
    throw new Error('The deployment service did not return a valid CID.');
  }
}

export function formatFailure(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown deployment failure.';
}
