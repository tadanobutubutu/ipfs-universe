import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

interface LighthouseCategory {
  readonly score: number | null;
}

interface LighthouseAudit {
  readonly displayValue?: string;
}

interface LighthouseReport {
  readonly categories?: Record<string, LighthouseCategory>;
  readonly audits?: Record<string, LighthouseAudit>;
}

const execFileAsync = promisify(execFile);
const target = process.env.LIGHTHOUSE_URL?.trim() || 'http://127.0.0.1:4181/';
const lighthouseBin = join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'lighthouse.cmd' : 'lighthouse',
);
const temporaryRoot = await mkdtemp(
  join(tmpdir(), 'peerstellation-lighthouse-'),
);
const sharedArgs = [
  '--only-categories=performance,accessibility,best-practices,seo,agentic-browsing',
  '--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage',
  '--output=json',
  '--quiet',
];

async function audit(
  label: string,
  preset: 'mobile' | 'desktop',
): Promise<void> {
  const reportPath = join(temporaryRoot, `${preset}.json`);
  await execFileAsync(lighthouseBin, [
    target,
    ...(preset === 'desktop' ? ['--preset=desktop'] : []),
    ...sharedArgs,
    `--output-path=${reportPath}`,
  ]);
  const report = JSON.parse(
    await readFile(reportPath, 'utf8'),
  ) as LighthouseReport;
  const scores = Object.fromEntries(
    Object.entries(report.categories ?? {}).map(([name, category]) => [
      name,
      category.score === null ? 'n/a' : Math.round(category.score * 100),
    ]),
  );
  const audits = report.audits ?? {};
  console.log(`Lighthouse ${label} ${target}`);
  console.log(JSON.stringify(scores));
  console.log(
    `FCP ${audits['first-contentful-paint']?.displayValue ?? 'n/a'} · ` +
      `LCP ${audits['largest-contentful-paint']?.displayValue ?? 'n/a'} · ` +
      `TBT ${audits['total-blocking-time']?.displayValue ?? 'n/a'} · ` +
      `CLS ${audits['cumulative-layout-shift']?.displayValue ?? 'n/a'}`,
  );
}

try {
  await audit('mobile', 'mobile');
  await audit('desktop', 'desktop');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
