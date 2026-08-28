# Peerstellation Web Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 実際に観測したIPFSピアを、訪問直後から表示される高品質な3D宇宙として可視化するWeb専用アプリを構築する。

**Architecture:** HTML/CSSの即時シェルとThree.js描画を先に起動し、Heliaを遅延ロードする。型付きpeer reducerがネットワークと表示を分離し、Zig WASMが座標更新、Rust WASMが集約解析を担当する。

**Tech Stack:** TypeScript、Three.js、Helia/libp2p、Zig WebAssembly、Rust WebAssembly、Vitest、Playwright、axe、Vite、Cloudflare Workers Static Assets、Pinata。

**Spec:** `docs/product-spec.md`

## Global Constraints

- 公開データは実測値または「未測定」だけにし、疑似ピアと乱数メトリクスを禁止する。
- リポジトリ所有の`.js`と`.jsx`は0件、`node_modules`と`dist`は追跡しない。
- WCAG 2.2 AAを必須、本文コントラストはAAAを目標とする。
- ZigとRustの両方を実際にWASMへビルドし、TypeScriptから呼び出す。
- Heliaは最初の3Dフレーム後に遅延ロードする。
- CSPでインラインscriptと`unsafe-eval`を許可しない。
- IPFS Desktopと`~/.ipfs`には変更を加えない。

---

### Task 1: 再現可能な基盤とリポジトリ方針

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Modify: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `tests/repository-policy.test.ts`
- Delete from tracking: `node_modules/**`, `dist/**`

**Interfaces:**
- Consumes: 現行npm manifestと追跡ファイル一覧。
- Produces: `npm run check`、`npm run test:unit`、`npm run build`の再現可能な入口。

- [ ] **Step 1: 方針違反を検出する失敗テストを書く**

```ts
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split('\n');

describe('repository policy', () => {
  it('does not track dependencies or generated output', () => {
    expect(tracked.filter((path) => /^(node_modules|dist)\//.test(path))).toEqual([]);
  });

  it('contains no hand-written JavaScript', () => {
    expect(tracked.filter((path) => /\.(?:js|jsx)$/.test(path))).toEqual([]);
  });
});
```

- [ ] **Step 2: テストが追跡node_modulesとworker JSで失敗することを確認する**

Run: `npm run test:unit -- tests/repository-policy.test.ts`

Expected: `node_modules/`と`worker/src/index.js`を列挙してFAIL。

- [ ] **Step 3: lockfileを再生成し、Vitestと品質コマンドを追加する**

```json
{
  "scripts": {
    "check": "npm run typecheck && npm run test:unit && npm run build",
    "typecheck": "tsc --noEmit",
    "test:unit": "vitest run"
  }
}
```

- [ ] **Step 4: 依存物と生成物をGit追跡から外す**

Run: `git rm -r --cached node_modules dist`

Expected: 実ファイルの有無に関係なく、Git indexからだけ除外される。

- [ ] **Step 5: Web専用化の対象ファイルを削除する**

Delete: `local/README.md`, `guide_page.json`, `spec_page.json`, `page_content.txt`, `.release-agent.md`, `.github/workflows/jaipilot-generate.yml`

- [ ] **Step 6: 方針テストを再実行する**

Run: `npm run test:unit -- tests/repository-policy.test.ts`

Expected: worker変換前は`.js`だけがFAILし、Task 6完了後に全PASS。

### Task 2: 真実性を守るピア状態モデル

**Files:**
- Create: `src/network/peer-types.ts`
- Create: `src/network/peer-reducer.ts`
- Create: `tests/peer-reducer.test.ts`
- Replace: `src/db/peer-history.ts`

**Interfaces:**
- Produces: `PeerObservation`, `PeerRecord`, `PeerState`, `reducePeerEvent(state, event)`。
- Consumes: Heliaイベント、Rust解析入力、3D表示入力。

- [ ] **Step 1: 発見と接続を混同すると失敗するテストを書く**

```ts
it('keeps discovered peers separate from connected peers', () => {
  const discovered = reducePeerEvent(emptyPeerState(), {
    type: 'discovered', peerId: '12D3KooWObserved', observedAt: 10
  });
  expect(discovered.connectedCount).toBe(0);
  expect(discovered.peers.get('12D3KooWObserved')?.status).toBe('discovered');
});
```

- [ ] **Step 2: 未実装によりREDになることを確認する**

Run: `npm run test:unit -- tests/peer-reducer.test.ts`

Expected: import先が存在せずFAIL。

- [ ] **Step 3: 判別可能unionと純粋reducerを実装する**

```ts
export type PeerObservation =
  | { type: 'discovered'; peerId: string; observedAt: number }
  | { type: 'connected'; peerId: string; observedAt: number; direction: 'inbound' | 'outbound'; transport: string }
  | { type: 'latency'; peerId: string; observedAt: number; latencyMs: number }
  | { type: 'disconnected'; peerId: string; observedAt: number };
```

- [ ] **Step 4: 重複、順不同、切断、未測定レイテンシのテストを通す**

Run: `npm run test:unit -- tests/peer-reducer.test.ts`

Expected: 全ケースPASS。

- [ ] **Step 5: IndexedDBへ保存する公開フィールドを型で限定する**

```ts
export type PersistedPeer = Pick<PeerRecord, 'peerId' | 'status' | 'firstSeenAt' | 'lastSeenAt' | 'latencyMs'>;
```

### Task 3: Zig物理WASMとRust解析WASM

**Files:**
- Replace: `wasm/particles.zig`
- Replace: `wasm/Cargo.toml`
- Replace: `wasm/src/lib.rs`
- Create: `scripts/build-wasm.ts`
- Create: `src/wasm/load-wasm.ts`
- Create: `tests/wasm-modules.test.ts`

**Interfaces:**
- Zig exports: `init_system(count: i32)`, `seed_node(index: i32, seed: i32)`, `step(delta: f32, count: i32, motionScale: f32)`, `positions_ptr(): i32`。
- Rust exports: `input_ptr(): i32`, `analyze(count: i32): void`, `result_ptr(): i32`。
- TypeScript produces: `loadPhysicsWasm(url)`, `loadAnalyticsWasm(url)`。

- [ ] **Step 1: 二つの成果物がWASM moduleであることを検査するテストを書く**

```ts
it.each(['public/physics.wasm', 'public/analytics.wasm'])('%s is an executable wasm module', async (path) => {
  const bytes = await readFile(path);
  expect(WebAssembly.validate(bytes)).toBe(true);
});
```

- [ ] **Step 2: 現行ar archiveと欠落Rust成果物でREDを確認する**

Run: `npm run test:unit -- tests/wasm-modules.test.ts`

Expected: `WebAssembly.validate`がfalse、RustファイルがENOENT。

- [ ] **Step 3: Zigを`build-exe -fno-entry`でWebAssembly moduleへビルドする**

Run: `zig build-exe wasm/particles.zig -target wasm32-freestanding -O ReleaseSmall -fno-entry -rdynamic -femit-bin=public/physics.wasm`

- [ ] **Step 4: Rustを生成JSなしのraw ABIへ変更してビルドする**

Run: `cargo build --manifest-path wasm/Cargo.toml --target wasm32-unknown-unknown --release`

Expected: `wasm/target/wasm32-unknown-unknown/release/ipfs_universe_analytics.wasm`が生成される。

- [ ] **Step 5: TypeScriptビルドスクリプトで二つの成果物を再現可能にする**

Run: `npx tsx scripts/build-wasm.ts`

Expected: `public/physics.wasm`と`public/analytics.wasm`が更新される。

- [ ] **Step 6: ABI境界値と決定性のテストを通す**

Run: `npm run test:unit -- tests/wasm-modules.test.ts`

Expected: 0件、最大件数、同じseedで同じ座標、p95固定fixtureがPASS。

### Task 4: 実Helia観測器

**Files:**
- Delete: `src/helia.worker.ts`
- Create: `src/network/helia-observer.ts`
- Create: `src/network/transport.ts`
- Create: `tests/helia-observer.test.ts`

**Interfaces:**
- Produces: `startHeliaObserver(options): Promise<HeliaObserver>`。
- `HeliaObserver.subscribe(listener): () => void`, `snapshot(): readonly PeerObservation[]`, `retry(): Promise<void>`, `stop(): Promise<void>`。
- Consumes: Task 2の`PeerObservation`。

- [ ] **Step 1: イベント名と初期connection snapshotを検証する失敗テストを書く**

```ts
it('emits connected only from actual connection records', async () => {
  const observations = normalizeConnections([fixtureOutboundConnection]);
  expect(observations).toEqual([{
    type: 'connected', peerId: '12D3KooWPeer', observedAt: 1000,
    direction: 'outbound', transport: 'webrtc'
  }]);
});
```

- [ ] **Step 2: REDを確認する**

Run: `npm run test:unit -- tests/helia-observer.test.ts`

Expected: normalizer未実装でFAIL。

- [ ] **Step 3: `createHelia()`を動的importし、Window側で起動する**

```ts
const [{ createHelia }] = await Promise.all([import('helia')]);
const helia = await createHelia({ start: true });
```

- [ ] **Step 4: discovery/connect/disconnectとpingを実値へ正規化する**

Run: `npm run test:unit -- tests/helia-observer.test.ts`

Expected: 状態混同、重複、タイムアウト、停止後イベントがすべてPASS。

- [ ] **Step 5: 公開環境と開発環境で同一コードパスを使う**

Run: `rg -n 'isLocal|startSimulation|fakePeer|Math.random.*latency' src`

Expected: 一致0件。

### Task 5: 3D宇宙とアクセシブルUI

**Files:**
- Replace: `index.html`
- Replace: `src/main.ts`
- Create: `src/styles.css`
- Create: `src/scene/universe.ts`
- Create: `src/ui/app-shell.ts`
- Create: `src/ui/peer-list.ts`
- Create: `tests/ui-state.test.ts`
- Create: `e2e/universe.spec.ts`
- Create: `playwright.config.ts`

**Interfaces:**
- `createUniverse(canvas, options): UniverseController`。
- `UniverseController.applyPeers(peers)`, `selectPeer(peerId)`, `setMotion(enabled)`, `dispose()`。
- `renderPeerList(container, peers, selectedPeerId)`。

- [ ] **Step 1: 初期3D、landmark、操作名、縮小動作のE2Eテストを書く**

```ts
test('shows the universe before network readiness and exposes an accessible fallback', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('button', { name: '動きを止める' })).toBeVisible();
  await expect(page.locator('canvas[aria-describedby="universe-description"]')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('観測装置を起動中');
});
```

- [ ] **Step 2: 現行HTMLでREDを確認する**

Run: `npm run test:e2e -- e2e/universe.spec.ts`

Expected: `<main>`、日本語操作名、代替説明がなくFAIL。

- [ ] **Step 3: HTMLシェルとCSS背景を実装する**

Expected: JavaScript無効でも製品名、説明、状態、代替表示が読める。

- [ ] **Step 4: 単一BufferGeometryとInstancedMeshで宇宙を実装する**

Expected: 接続数に比例してThree.js Object3Dを無制限生成しない。

- [ ] **Step 5: キーボード、詳細ドロワー、ピア一覧、動作停止を実装する**

Run: `npm run test:e2e -- e2e/universe.spec.ts`

Expected: Tab、Enter、Esc、200%拡大、320 px、reduced motionがPASS。

- [ ] **Step 6: axe検査を通す**

Run: `npm run test:a11y`

Expected: critical/serious 0件。

### Task 6: TypeScript配信とCI安全化

**Files:**
- Delete: `worker/src/index.js`
- Delete: `scripts/deploy.py`
- Delete: `scripts/update-dns.sh`
- Replace: `worker/wrangler.toml`
- Create: `scripts/pin-ipfs.ts`
- Create: `scripts/update-dnslink.ts`
- Create: `tests/deploy-scripts.test.ts`
- Replace: `.github/workflows/deploy-ipfs.yml`
- Move: `_headers` to `public/_headers`

**Interfaces:**
- `pinDirectory({ directory, jwt, fetchImpl }): Promise<string>`。
- `updateDnslink({ zoneId, token, cid, fetchImpl }): Promise<void>`。

- [ ] **Step 1: Pinata失敗、CID欠落、DNS API失敗を再現するテストを書く**

```ts
it('rejects a Pinata response without a CID', async () => {
  await expect(pinDirectory({
    directory: fixtureDirectory,
    jwt: 'test-token',
    fetchImpl: async () => new Response('{}', { status: 200 })
  })).rejects.toThrow('Pinata response did not include a CID');
});
```

- [ ] **Step 2: REDを確認する**

Run: `npm run test:unit -- tests/deploy-scripts.test.ts`

Expected: TypeScript配信関数が存在せずFAIL。

- [ ] **Step 3: Node標準APIでPinataとDNSLink処理を実装する**

Run: `npm run test:unit -- tests/deploy-scripts.test.ts`

Expected: エラー本文を秘密なしで制限長表示し、全fixtureがPASS。

- [ ] **Step 4: Worker proxyを静的アセット配信へ置換する**

```toml
name = "peerstellation-gateway"
compatibility_date = "2026-08-26"
routes = [{ pattern = "*ipfsuniverse.xyz/*", zone_name = "ipfsuniverse.xyz" }]

[assets]
directory = "../dist"
not_found_handling = "404-page"
```

- [ ] **Step 5: CIを検査、ビルド、Cloudflare配信、Pinataピン、DNSLink更新の順にする**

Expected: PRはread-only検査、main pushだけがproduction環境の秘密へアクセスする。

- [ ] **Step 6: 第三者Actionを完全SHAへ固定し、JAIPilot workflowがないことを確認する**

Run: `rg -n 'uses: (?!actions/|github/|\./)[^@]+@(?![0-9a-f]{40})' .github/workflows --pcre2`

Expected: 一致0件。

### Task 7: README、証拠、最終審査

**Files:**
- Replace: `README.md`
- Replace: `CHANGELOG.md`
- Create: `docs/architecture.md`
- Create: `docs/accessibility.md`
- Create: `docs/quality/design-review.md`

**Interfaces:**
- Consumes: 実装済みコマンド、実測bundle、実ブラウザ結果、Claude Code査定。
- Produces: 誇張のない公開ドキュメントと再現可能な検証手順。

- [ ] **Step 1: READMEから未実装・虚偽の機能説明を除く**

Expected: 「全IPFS網」「架空所在地」「MetaMask」「SharedArrayBuffer」の実装済み表現がない。

- [ ] **Step 2: アーキテクチャ、状態意味、WASM境界、CLI利用法を記載する**

```bash
/Applications/IPFS\ Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/kubo/kubo/ipfs \
  --api /ip4/127.0.0.1/tcp/5001 swarm peers
```

- [ ] **Step 3: 全静的検査を実行する**

Run: `npm ci && npm run typecheck && npm run test:unit && npm run build`

Expected: exit 0、失敗0件、WASM二つが有効。

- [ ] **Step 4: ブラウザ検査を実行する**

Run: `npm run test:e2e && npm run test:a11y`

Expected: Chromium/WebKit/モバイルviewportで失敗0件、axe重大0件。

- [ ] **Step 5: 成果物と供給網を検査する**

Run: `npm audit --omit=dev && npm run check:repo && npm run check:bundle`

Expected: production high/critical 0件、方針違反0件、性能予算超過0件。

- [ ] **Step 6: Claude Codeへ最辛口再審査を依頼し、指摘を反映する**

Expected: 致命傷0件、総合80/100以上。点数と未解決理由を`docs/quality/design-review.md`へ記録する。

- [ ] **Step 7: 公開URLを実測する**

Expected: 3D初回表示、実ピア1件以上、セキュリティヘッダー、モバイル表示を公開URLから再確認する。
