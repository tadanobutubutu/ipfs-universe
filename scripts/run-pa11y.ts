import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

interface Pa11yIssue {
  readonly code?: string;
  readonly type?: string;
  readonly message?: string;
  readonly selector?: string;
  readonly context?: string;
}

interface Pa11yResult {
  readonly issues: readonly Pa11yIssue[];
}

interface Pa11yOptions {
  readonly browser: Awaited<ReturnType<typeof puppeteer.launch>>;
  readonly runners: readonly ('axe' | 'htmlcs')[];
  readonly standard: 'WCAG2AA' | 'WCAG2A' | 'WCAG2AAA';
  readonly timeout: number;
  readonly wait: number;
}

type Pa11y = (url: string, options: Pa11yOptions) => Promise<Pa11yResult>;

const target = process.env.A11Y_URL?.trim() || 'http://127.0.0.1:4178/';
const executablePath = findChrome();
if (executablePath === undefined) {
  throw new Error(
    'Chrome executable not found. Set PUPPETEER_EXECUTABLE_PATH or install Chromium/Chrome.',
  );
}

const pa11yModule = (await import('pa11y')) as unknown as {
  readonly default?: Pa11y;
};
const pa11y = pa11yModule.default;
if (pa11y === undefined) {
  throw new Error('Pa11y module did not expose its runner.');
}

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const result = await pa11y(target, {
    browser,
    runners: ['axe', 'htmlcs'],
    standard: 'WCAG2AA',
    timeout: 30_000,
    wait: 1_500,
  });
  if (result.issues.length > 0) {
    console.error(JSON.stringify(result.issues, null, 2));
    process.exitCode = 1;
    throw new Error(`Pa11y found ${result.issues.length} accessibility issues.`);
  }
  console.log(`Pa11y axe + HTML CodeSniffer: 0 issues (${target})`);
} finally {
  await browser.close();
}

function findChrome(): string | undefined {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && existsSync(candidate)) return candidate;
  }

  const cacheRoot = join(process.env.HOME ?? '', '.cache', 'ms-playwright');
  return findExecutable(cacheRoot, new Set(['chrome', 'chrome-headless-shell']));
}

function findExecutable(root: string, names: ReadonlySet<string>): string | undefined {
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && names.has(entry.name)) return path;
    if (entry.isDirectory()) {
      const nested = findExecutable(path, names);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}
