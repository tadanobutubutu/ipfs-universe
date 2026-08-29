import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const ACCESSIBILITY_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

async function expectNoAutomatedAccessibilityViolations(
  page: Page,
): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(ACCESSIBILITY_TAGS)
    .analyze();
  expect(results.violations).toEqual([]);
}

test('shows the 3D observatory immediately with semantic structure', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');

  await expect(page.locator('main#universe-main')).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: /live browser observatory/i }),
  ).toHaveCount(1);
  const canvas = page.getByRole('application', { name: /3D.*peer universe/i });
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute(
    'aria-describedby',
    /\bscene-description\b/u,
  );
  await expect(page.locator('#node-tooltip')).toHaveAttribute('role', 'status');
  await expect(page.locator('#node-tooltip')).toHaveAttribute(
    'aria-live',
    'polite',
  );
  await expect(page.locator('#kubo-probe')).toBeVisible();
  expect(
    await page
      .locator('#kubo-probe')
      .evaluate((element) => element.closest('dialog')),
  ).toBeNull();
  await expect(page.locator('html')).toHaveAttribute('data-scene', 'ready', {
    timeout: 3_000,
  });
  await expect(canvas).toHaveAttribute('data-renderer', /^(WebGPU|WebGL 2)$/u);

  const canvasSize = await canvas.evaluate((element) => {
    const canvasElement = element as HTMLCanvasElement;
    return { width: canvasElement.width, height: canvasElement.height };
  });
  expect(canvasSize.width).toBeGreaterThan(300);
  expect(canvasSize.height).toBeGreaterThan(300);
  expect(pageErrors).toEqual([]);
});

test('falls back to WebGL2 when WebGPU is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto('/');

  await expect(page.locator('html')).toHaveAttribute('data-scene', 'ready', {
    timeout: 3_000,
  });
  await expect(page.locator('#universe-canvas')).toHaveAttribute(
    'data-renderer',
    'WebGL 2',
  );
});

test('supports keyboard navigation, motion pause, and peer details', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-scene', 'ready', {
    timeout: 3_000,
  });
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();

  const motionButton = page.locator('#motion-toggle');
  await expect(motionButton).toHaveAccessibleName(/pause motion/i);
  await motionButton.click();
  await expect(motionButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'paused');

  const canvas = page.locator('#universe-canvas');
  await expect(canvas).toHaveAttribute('data-camera-distance', /\d/u);
  await canvas.focus();
  const distanceBefore = Number(
    await canvas.getAttribute('data-camera-distance'),
  );
  await page.keyboard.press('+');
  const distanceAfter = Number(
    await canvas.getAttribute('data-camera-distance'),
  );
  expect(distanceAfter).toBeLessThan(distanceBefore);

  await page.getByRole('button', { name: /peer explorer|peers/i }).click();
  const dialog = page.getByRole('dialog', { name: /peer explorer/i });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('honors reduced motion before the first rendered frame', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  await expect(page.locator('html')).toHaveAttribute('data-motion', 'paused');
  await expect(
    page.getByRole('button', { name: /resume motion/i }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#universe-canvas')).toHaveAttribute(
    'data-pulse',
    'static',
  );
});

test('reflows at 320 CSS pixels and 200 percent text size', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto('/');
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  const headerControls = await page
    .locator('.brand, #motion-toggle, #peer-explorer-button')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rectangle = element.getBoundingClientRect();
        return {
          id: element.id || element.className,
          left: rectangle.left,
          right: rectangle.right,
          width: rectangle.width,
          height: rectangle.height,
        };
      }),
    );
  expect(
    headerControls.filter(
      ({ left, right, width, height }) =>
        left < 0 || right > 320 || width < 44 || height < 44,
    ),
  ).toEqual([]);

  const firstViewport = await page
    .locator('.scene-legend, .metric-deck')
    .evaluateAll((elements) =>
      elements
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => ({
          selector: element.className,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        })),
    );
  expect(firstViewport).toEqual([]);
  const canvasBounds = await page.locator('#universe-canvas').boundingBox();
  expect(canvasBounds).not.toBeNull();
  if (canvasBounds === null) {
    throw new Error('The 3D canvas has no layout box at the narrow viewport');
  }
  expect(canvasBounds.y).toBeLessThan(80);
  expect(canvasBounds.height).toBeGreaterThan(250);
  expect(canvasBounds.y + canvasBounds.height).toBeLessThanOrEqual(780);

  await page.getByRole('button', { name: /peer explorer|peers/i }).click();
  const dialog = page.getByRole('dialog', { name: /peer explorer/i });
  await expect(dialog).toBeVisible();
  const closeButton = page.getByRole('button', {
    name: /close peer explorer/i,
  });
  const closeBounds = await closeButton.boundingBox();
  expect(closeBounds).not.toBeNull();
  if (closeBounds === null) {
    throw new Error('The peer dialog close button has no layout box');
  }
  expect(closeBounds.x).toBeGreaterThanOrEqual(0);
  expect(closeBounds.x + closeBounds.width).toBeLessThanOrEqual(320);
  const surfaceOverflow = await dialog
    .locator('.peer-dialog__surface')
    .evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
  expect(surfaceOverflow.scrollWidth).toBeLessThanOrEqual(
    surfaceOverflow.clientWidth,
  );
  // `output` exposes an implicit status role; target it directly so a future
  // fallback/live region cannot make the assertion ambiguous.
  await expect(page.locator('#peer-result-count')).toBeVisible();
  await expectNoAutomatedAccessibilityViolations(page);
});

test('keeps every observatory layer separated across the responsive matrix', async ({
  page,
}) => {
  await page.goto('/');
  const matrix = [
    { width: 320, height: 780, fontSize: '200%' },
    { width: 390, height: 844, fontSize: '100%' },
    { width: 544, height: 800, fontSize: '100%' },
    { width: 768, height: 600, fontSize: '100%' },
    { width: 1024, height: 600, fontSize: '100%' },
    { width: 1280, height: 600, fontSize: '100%' },
    { width: 1440, height: 900, fontSize: '100%' },
  ];

  for (const viewport of matrix) {
    await page.setViewportSize(viewport);
    await page.evaluate((fontSize) => {
      document.documentElement.style.fontSize = fontSize;
    }, viewport.fontSize);
    const result = await page.evaluate(() => {
      const selectors = [
        '.hero-copy',
        '.scene-legend',
        '.scene-guide',
        '.node-status',
        '.metric-deck',
        '.scope-note',
      ];
      const rectangles = selectors.map((selector) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (element === null) {
          throw new Error(`Missing responsive layer ${selector}`);
        }
        const rectangle = element.getBoundingClientRect();
        return {
          selector,
          top: rectangle.top,
          bottom: rectangle.bottom,
          left: rectangle.left,
          right: rectangle.right,
        };
      });
      const overlaps = rectangles.flatMap((rectangle, index) =>
        rectangles.slice(index + 1).flatMap((other) => {
          const horizontal =
            rectangle.left < other.right && other.left < rectangle.right;
          const vertical =
            rectangle.top < other.bottom && other.top < rectangle.bottom;
          return horizontal && vertical
            ? [`${rectangle.selector} overlaps ${other.selector}`]
            : [];
        }),
      );
      return { rectangles, overlaps };
    });
    expect(
      result.overlaps,
      `${viewport.width}x${viewport.height} ${viewport.fontSize}`,
    ).toEqual([]);
  }
});

test('preserves the focused peer and its expanded state across live updates', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /open peer explorer/i }).click();

  const result = await page.evaluate(async () => {
    const moduleUrl = new URL('/src/ui/peer-list.ts', window.location.origin)
      .href;
    const { renderPeerList } = (await import(
      /* @vite-ignore */ moduleUrl
    )) as typeof import('../../src/ui/peer-list.ts');
    const list = document.querySelector<HTMLOListElement>('#peer-list');
    const empty = document.querySelector<HTMLElement>('#peer-empty');
    if (list === null || empty === null) {
      throw new Error('Peer explorer fixture is missing');
    }

    const firstPeer = {
      peerId: '12D3KooWFocusStable',
      status: 'connected' as const,
      statusObservedAt: 10,
      firstSeenAt: 10,
      lastSeenAt: 10,
      direction: 'inbound' as const,
      transport: 'webtransport',
    };
    renderPeerList(list, empty, [firstPeer], 10);
    const firstButton = list.querySelector<HTMLButtonElement>('button');
    firstButton?.click();
    firstButton?.focus();
    renderPeerList(
      list,
      empty,
      [
        {
          ...firstPeer,
          status: 'discovered',
          lastSeenAt: 20,
          latencyMs: undefined,
        },
        {
          ...firstPeer,
          peerId: '12D3KooWSecondPeer',
          status: 'connected',
          lastSeenAt: 20,
          latencyMs: 42,
        },
      ],
      20,
    );

    // Move the focused row itself to the top. This catches focus loss that a
    // newly inserted row before the focused row would not expose.
    renderPeerList(
      list,
      empty,
      [
        {
          ...firstPeer,
          status: 'connected',
          lastSeenAt: 30,
          latencyMs: 31,
        },
        {
          ...firstPeer,
          peerId: '12D3KooWSecondPeer',
          status: 'discovered',
          lastSeenAt: 20,
          latencyMs: undefined,
        },
      ],
      30,
    );

    const focused = document.activeElement as HTMLElement | null;
    const lastObserved = list.querySelector<HTMLTimeElement>(
      '[data-field="last-seen"]',
    );
    return {
      expanded: focused?.getAttribute('aria-expanded'),
      focusedPeerId: focused?.closest('li')?.dataset.peerId,
      itemCount: list.children.length,
      orderedPeerIds: [...list.children].map(
        (item) => (item as HTMLElement).dataset.peerId,
      ),
      lastObservedText: lastObserved?.textContent,
      lastObservedMachineValue: lastObserved?.dateTime,
    };
  });

  expect(result).toMatchObject({
    expanded: 'true',
    focusedPeerId: '12D3KooWFocusStable',
    itemCount: 2,
    orderedPeerIds: ['12D3KooWFocusStable', '12D3KooWSecondPeer'],
  });
  expect(result.lastObservedText).not.toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  expect(result.lastObservedMachineValue).toMatch(/^1970-01-01T/u);
  await expectNoAutomatedAccessibilityViolations(page);
});

test('keeps text access visible when GPU initialization fails', async ({
  page,
}) => {
  await page.addInitScript(() => {
    type CanvasPrototype = {
      getContext(contextId: string, ...arguments_: unknown[]): unknown;
    };
    const prototype = HTMLCanvasElement.prototype as unknown as CanvasPrototype;
    const original = prototype.getContext;
    prototype.getContext = function getContext(
      contextId: string,
      ...arguments_: unknown[]
    ): unknown {
      if (contextId === 'webgl' || contextId === 'webgl2') {
        return null;
      }
      return Reflect.apply(original, this, [contextId, ...arguments_]);
    };
    // WebGPURenderer prefers navigator.gpu and only then falls back to
    // WebGL2. Disable both backends so the accessible DOM fallback is tested
    // independently of the browser's native WebGPU availability.
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto('/');

  await expect(page.locator('html')).toHaveAttribute(
    'data-scene',
    'unavailable',
  );
  await expect(
    page.getByRole('region', { name: /3D view unavailable/i }),
  ).toBeVisible();
  await page.getByRole('button', { name: /open peer explorer/i }).click();
  await expect(
    page.getByRole('dialog', { name: /peer explorer/i }),
  ).toBeVisible();
  await expectNoAutomatedAccessibilityViolations(page);
});

test('stops requesting continuous frames while motion is paused', async ({
  page,
}) => {
  await page.goto('/');
  const canvas = page.locator('#universe-canvas');
  await expect(canvas).toHaveAttribute('data-animation-frames', /\d+/u);
  await page.getByRole('button', { name: /pause motion/i }).click();
  await page.waitForTimeout(100);
  const pausedAt = Number(await canvas.getAttribute('data-animation-frames'));
  await page.waitForTimeout(500);
  const stillPausedAt = Number(
    await canvas.getAttribute('data-animation-frames'),
  );

  expect(stillPausedAt).toBe(pausedAt);
});

test('has no automated WCAG A or AA violations in the initial state', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-scene', 'ready');
  await expect(page.locator('[aria-live]')).toHaveCount(2);
  await expectNoAutomatedAccessibilityViolations(page);
});

test('keeps the live scene inside the fixed draw-call budget', async ({
  page,
}) => {
  await page.goto('/');
  const canvas = page.locator('#universe-canvas');
  await expect(canvas).toHaveAttribute('data-draw-calls', /\d+/u, {
    timeout: 8_000,
  });
  const initialObjects = Number(
    await canvas.getAttribute('data-scene-objects'),
  );
  const drawCalls = Number(await canvas.getAttribute('data-draw-calls'));
  await page.waitForTimeout(3_000);
  const laterObjects = Number(await canvas.getAttribute('data-scene-objects'));

  expect(drawCalls).toBeLessThanOrEqual(12);
  expect(laterObjects).toBe(initialObjects);
});

test('draws relay edges only when both relay endpoints are observed', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-scene', 'ready');
  const result = await page.evaluate(() => {
    type FixturePeer = {
      peerId: string;
      status: 'connected';
      statusObservedAt: number;
      firstSeenAt: number;
      lastSeenAt: number;
      direction: 'inbound' | 'outbound';
      transport: string;
      relayPeerId?: string;
    };
    const setPeers = (
      window as Window & {
        __peerstellationSetPeers?: (peers: readonly FixturePeer[]) => void;
      }
    ).__peerstellationSetPeers;
    if (setPeers === undefined)
      throw new Error('development relay fixture is unavailable');
    const relay: FixturePeer = {
      peerId: '12D3KooWRelayEvidence',
      status: 'connected',
      statusObservedAt: 1,
      firstSeenAt: 1,
      lastSeenAt: 1,
      direction: 'outbound',
      transport: 'websocket',
    };
    const target: FixturePeer = {
      peerId: '12D3KooWTargetEvidence',
      status: 'connected',
      statusObservedAt: 1,
      firstSeenAt: 1,
      lastSeenAt: 1,
      direction: 'inbound',
      transport: 'webtransport',
      relayPeerId: relay.peerId,
    };
    setPeers([relay, target]);
    const withRelay =
      document.querySelector<HTMLCanvasElement>('#universe-canvas')?.dataset
        .edgeSegments;
    setPeers([target]);
    const withoutRelay =
      document.querySelector<HTMLCanvasElement>('#universe-canvas')?.dataset
        .edgeSegments;
    return { withRelay, withoutRelay };
  });
  expect(result).toEqual({ withRelay: '3', withoutRelay: '1' });
});

test('keeps the measured latency-to-radius signal visible in the live renderer', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-scene', 'ready');
  const result = await page.evaluate(() => {
    type FixturePeer = {
      peerId: string;
      status: 'connected';
      statusObservedAt: number;
      firstSeenAt: number;
      lastSeenAt: number;
      direction: 'inbound' | 'outbound';
      transport: string;
      latencyMs: number;
    };
    const setPeers = (
      window as Window & {
        __peerstellationSetPeers?: (peers: readonly FixturePeer[]) => void;
      }
    ).__peerstellationSetPeers;
    if (setPeers === undefined)
      throw new Error('development latency fixture is unavailable');
    setPeers([
      {
        peerId: '12D3KooWFastLatency',
        status: 'connected',
        statusObservedAt: 1,
        firstSeenAt: 1,
        lastSeenAt: 1,
        direction: 'outbound',
        transport: 'websocket',
        latencyMs: 10,
      },
      {
        peerId: '12D3KooWSlowLatency',
        status: 'connected',
        statusObservedAt: 1,
        firstSeenAt: 1,
        lastSeenAt: 1,
        direction: 'inbound',
        transport: 'webtransport',
        latencyMs: 1_000,
      },
    ]);
    const radii = (
      document.querySelector<HTMLCanvasElement>('#universe-canvas')?.dataset
        .peerRadii ?? ''
    )
      .split(',')
      .map(Number);
    return { radii, ratio: (radii[1] ?? 0) / (radii[0] ?? 1) };
  });
  expect(result.radii).toHaveLength(2);
  expect(result.radii[1]).toBeGreaterThan(result.radii[0]);
  expect(result.ratio).toBeGreaterThan(4);
});

test('starts a real Helia browser identity without a simulation fallback', async ({
  page,
}) => {
  await page.goto('/');
  const identity = page.locator('#local-peer-id');
  await expect(identity).not.toHaveText('Identity pending', {
    timeout: 25_000,
  });
  await expect(page.locator('.node-status__beacon')).toHaveAttribute(
    'data-tone',
    'online',
  );
  await expect(page.locator('#network-status')).not.toContainText(
    /simulat|fake/iu,
  );
});
