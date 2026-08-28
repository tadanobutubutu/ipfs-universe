import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const trackedFiles = execFileSync('git', ['ls-files'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean);

describe('repository policy', () => {
  it('does not track dependencies or generated output', () => {
    expect(
      trackedFiles.filter((path) => /^(?:node_modules|dist)\//u.test(path)),
    ).toEqual([]);
  });

  it('contains no repository-owned JavaScript', () => {
    expect(
      trackedFiles.filter((path) => /\.(?:js|jsx)$/u.test(path)),
    ).toEqual([]);
  });

  it('contains no retired local-app artifacts', () => {
    const retiredArtifacts = [
      '.release-agent.md',
      'guide_page.json',
      'local/README.md',
      'page_content.txt',
      'spec_page.json',
    ];

    expect(
      trackedFiles.filter((path) => retiredArtifacts.includes(path)),
    ).toEqual([]);
  });

  it('contains no retired deployment runtimes or Worker shell', () => {
    const retiredArtifacts = [
      'scripts/deploy.py',
      'scripts/update-dns.sh',
      'worker/src/index.js',
      'worker/wrangler.toml',
    ];

    expect(
      trackedFiles.filter((path) => retiredArtifacts.includes(path)),
    ).toEqual([]);
  });

  it('pins every GitHub Action to a full commit SHA', () => {
    const workflowFiles = trackedFiles.filter(
      (path) => path.startsWith('.github/workflows/') && path.endsWith('.yml'),
    );
    const unpinnedUses = workflowFiles.flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => /\buses:/u.test(line))
        .filter((line) => !/@[0-9a-f]{40}(?:\s|$)/u.test(line))
        .map((line) => `${path}: ${line.trim()}`),
    );

    expect(unpinnedUses).toEqual([]);
  });

  it('contains no simulated peers or randomized network metrics', () => {
    const source = trackedFiles
      .filter((path) => path.startsWith('src/') && path.endsWith('.ts'))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');

    expect(source).not.toMatch(
      /startSimulation|fakePeer|Math\.random\(\)[^\n]*(?:latency|peer)/iu,
    );
    expect(source).not.toMatch(/\bsetInterval\s*\(/u);
    expect(source).not.toMatch(/\.innerHTML\s*=/u);
  });
});
