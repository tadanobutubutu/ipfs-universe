# Peerstellation

![Peerstellation live peer observatory](./public/hero.png)

> **A browser's reachable neighbourhood, rendered as a living sky.**

Peerstellation is a web-only 3D observatory for real Helia/libp2p observations. The first viewport is intentionally quiet: the sky is the interface, and a node reveals its own details only when hovered, focused, or tapped. No peer, latency, or topology claim is invented.

[![Live site](https://img.shields.io/badge/live-ipfsuniverse.xyz-ccff66?style=for-the-badge)](https://ipfsuniverse.xyz)
[![TypeScript](https://img.shields.io/badge/TypeScript-only-3178c6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-ccff66?style=for-the-badge)](LICENSE)

## 体験

- ページ内で起動した Helia ブラウザノードの接続・発見・切断・ping・identify をリアルタイムに観測し、WebTransport、WebRTC、WebRTC Direct、WebSocket、リレーなど[Helia のブラウザ対応トランスポート](https://github.com/ipfs/helia/wiki/FAQ)と Amino Kad-DHT の bounded routing query で最大128件の追加候補も取得します。
- ノードをカーソルで指す、キーボードで選ぶ、スマホでタップする、とその場所にアンカーされたカードへ Peer ID、状態、遅延、方向、transport、protocols、agent/protocol version、アドレス件数を表示します。
- 接続線はこの観測ノードから実際に開いているブラウザ接続です。`/p2p-circuit` のアドレスから中継ピアIDまで取得でき、同じ中継ピアが観測集合にも存在する場合だけ、ブラウザまたはKuboの実ノード同士の中継線を追加します。裏付けのない近接線は描かず、見栄えのためにトポロジーを捏造しません。
- Zig WebAssembly は安定した全方位の配置と近遠の分布、Rust WebAssembly は接続数・遅延統計を担当し、軽い制御と表示は厳密な TypeScript で実装しています。ローカル Kubo の明示インポートは最大1,024件を3Dへ載せ、アプリ内の追跡上限は2,048件です。Kubo観測は無彩色の外周、ブラウザliveはライム、ブラウザ発見候補は紫で分けます。
- ピア数が増えても自動フレーミングはワールド距離180を上限（縦長は145）にし、中心のホスト星が小さく潰れないまま外周ピアを視認・選択できます。

## Helia と IPFS Desktop の数字が違う理由

IPFS Desktop の Kubo は TCP/QUIC の常駐ノードです。一方、ブラウザの Helia はブラウザが扱える WebSocket、WebRTC、リレー等だけで別の短命ノードを起動します。そのため Desktop に多数のピアがいても、ページの `connected` が 0〜数件になるのは正常です。ピア表は共有されません。

ヘッダーの **Kubo** ボタンを明示的に押した時だけ、`127.0.0.1:5001/api/v0/id` と詳細付き `swarm/peers` を読みます（仕様は [Kubo RPC リファレンス](https://docs.ipfs.tech/reference/kubo/rpc/)）。成功後は同じ利用者のオプトイン状態を保ったまま15秒周期で更新し、ページを離れるかエラーになると停止します。Kubo RPC は管理者権限相当なので、公開インターネットへ露出させてはいけません。現在の IPFS Desktop の既定設定は `https://webui.ipfs.io` だけを許可するため、Peerstellation のオリジンからは CORS で止まります。ローカル開発で試す場合だけ、実際に使う開発オリジンを列挙してから Desktop を再起動してください（`*` は使わない）。Kubo の数百件を読み込めても、それらはこのブラウザの live 接続ではないため、ヘッダーの live 数・ping 統計には混ぜません。

```bash
# 例: 開発時だけ許可する Origin。* は使わない
KUBO="/Applications/IPFS Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/kubo/kubo/ipfs"
"$KUBO" config --json API.HTTPHeaders.Access-Control-Allow-Origin \
  '["http://127.0.0.1:4178"]'
"$KUBO" swarm peers --verbose --latency --direction --identify --enc=json \
  > /tmp/peerstellation-kubo-peers.json
```

CLI の `swarm peers` は Kubo が長時間保持している接続を一覧化するため、ブラウザ Helia の一時的な接続より桁違いに多くなることがあります。JSON スナップショットは監査用に保存できますが、サイトがそれを自動的に読み込むことはありません。ローカル RPC の管理権限をブラウザへ渡したくない場合は、サイトの Helia 観測だけを使ってください。

本番ページから利用者のローカルデーモンを自動探索することはありません。WebTransport/WebRTC の公告アドレスがあり、ユーザーが明示的に接続を選んだ場合だけ、別途対応します。

## 開発

```bash
git clone https://github.com/tadanobutubutu/peerstellation.git
cd peerstellation
npm install
npm run dev
```

| コマンド | 用途 |
| --- | --- |
| `npm run dev` | Vite 開発サーバー |
| `npm run build` | Zig/Rust WASM と静的配布物を生成 |
| `npm run check` | 型検査・単体テスト・本番ビルド |
| `npm run quality` | Biome 2.5 のフォーマット・Lint・import整理を一括検査 |
| `npm run security:semgrep` | Semgrep の自動セキュリティ検査 |
| `npm run format` | Biomeでコードを整形 |
| `npm run lint` | BiomeのLintだけを実行 |
| `npm run test:e2e` | Playwright、axe、レスポンシブ、WebGPU → WebGL2 フォールバック |
| `npm run test:a11y` | html-validate と Pa11y（axe + HTML CodeSniffer）の WCAG 2 AA 監査 |
| `npm run lint:docs` | Vale の自作 AI-fluff 規則で README と docs を検査（vale-ai-tells を使う場合も同じ入口） |
| `npm run test:lighthouse` | 本番ビルドを Lighthouse CLI（性能・アクセシビリティ・ベストプラクティス・SEO・Agentic Browsing）で計測 |
| `npm run deploy:cloudflare` | Wrangler で静的配信を更新 |
| `npm run deploy:pinata` | `PINATA_JWT` がある時だけ CID をピン |

GitHub Actions は pull request の検証だけを自動実行します。本番のCloudflare、Pinata、DNSLink更新は `workflow_dispatch` を明示的に実行した場合だけです。`main` へのpushだけで本番配信は始まりません。

### 評価ツール

品質ゲートはブラウザ実機と静的検査を分けています。`test:a11y` は HTML の構文と、実際の Chromium での Pa11y axe／HTML CodeSniffer を連続実行します。Chrome DevTools MCP は Lighthouse（性能、アクセシビリティ、ベストプラクティス、SEO、Agentic Browsing）と Performance trace を確認するために使います。Agentic Browsing の WebMCP 検査対象が無い場合は Lighthouse が `n/a` と記録しますが、`llms.txt` の検査は必ず実行されます。

Codex で MCP を有効にする場合は、`~/.codex/config.toml` の `mcp_servers.chrome_devtools` に公式サーバーを登録し、Codex を再起動してください。OpenCode／mcporter にも同じサーバー設定を用意しています。認証情報や計測データはリポジトリへ保存しません。

CLI で同梱 Kubo を確認する場合（アプリを停止・変更しません）:

```bash
/Applications/IPFS\ Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/kubo/kubo/ipfs swarm peers --verbose
```

## 設計と安全境界

```text
Helia/libp2p ── typed observations ── PeerReducer (最大2,048)
       │                                  ├── IndexedDB (公開IDの端末内履歴のみ)
       │                                  └── ThreeUniverse (WebGPU → WebGL2 + picking tooltip, 最大1,024描画)
       ├── Kubo probe (明示操作後だけ Kubo RPC/CORSを15秒更新)
       └── Zig: 配置・物理・線分バッファ / Rust: 集計
```

秘密鍵、Kubo 認証情報、Pinata トークンはブラウザへ渡しません。CSP、COOP/COEP/CORP、HSTS、厳格な Permissions Policy、ハッシュ付き静的資産キャッシュを配信します。IPFS はプロトコル名として技術文書で扱いますが、製品名・ロゴは独自の **Peerstellation** に分離しました。名称は GitHub/npm/一般検索の完全一致を予備調査した結果であり、商標の法的なクリアランスを意味しません。

### ツールチェーンとThree UIの判断

TypeScriptはnpmの現行安定版 **7.0.2** を固定し、静的解析と整形は **Biome 2.5.11** に統一しています。このリポジトリにはESLint設定・依存・実行入口はありません。CSSは **Tailwind CSS 4.3.3** のViteプラグインを使い、色・文字の設計トークンをコンパイル時に生成します。現在のClaudeデザイン固有の軌道・星空・ホバー配置は既存のCSSで保持し、Tailwindユーティリティへ段階的に移行できる構成です。

「three-ui」というnpmパッケージ（1.1.1）は2020年公開のReact 16 + Material UI部品集で、Three.jsの3D UIではありません。現行の `@darrylondil/react-three-ui`（0.2.0）はReact Three Fiber専用の別設計です。Peerstellationは軽量なバニラTypeScript、DOMの意味構造、WCAG向けキーボード操作を既に採用しているため、これらを全画面へ置き換えると初期JSとアクセシビリティの保証を失います。そこでClaudeの宇宙デザインは維持し、情報カードと一覧は意味のあるDOM、3D空間だけをThree.jsで描画します。将来Three UIを使う場合も、実測したアクセシビリティと性能を満たす限定的な視覚レイヤーとして導入します。Tailwindは静的HTMLとバニラTypeScriptに適したゼロランタイムの選択であり、React/Babel/PostCSSを前提とするStyleXはこの構成へ導入していません。

### WASMとThree.jsの境界

Zig WebAssemblyはノード位置、速度、中心引力、反発、減衰、中心/リレー線分の位置と輝度を計算し、Three.jsの `BufferAttribute` がその線形メモリを直接参照します。Rust WebAssemblyはピア集計と遅延統計を担当します。これで毎フレームの数値計算と配列コピーをTypeScriptから外しています。

Three.js自身はブラウザのWebGPU/WebGL APIを呼び出すJavaScriptライブラリであり、DOM/GPUコンテキストなしにRust/Zigだけで実行できません。そのため、Three.jsのシーン生成、GPUリソース管理、描画呼び出し、DOMイベントとアクセシビリティはTypeScriptに残し、WASMを数値カーネルとして厳密に境界付けています。描画は `WebGPURenderer` を第一候補にし、ブラウザがWebGPUを初期化できない場合は同じCanvas上でThree.jsのWebGL2バックエンドへ自動フォールバックします。現在のマテリアルは両バックエンドで利用できる組み込みマテリアルに限定し、WebGPU未対応の `ShaderMaterial` や `onBeforeCompile` へ依存しません。これは「Three.jsの処理を全部WASMにした」と偽装せず、ブラウザの実行モデルに沿った構成です。

### 参考作品と独自性

GPU手続き生成のシネマティック作品 [ABYSSAL / natural-disasters](https://github.com/Token-Gremlin/natural-disasters) の品質プリセット、動的な負荷計測、決定的な実機スクリーンショットという設計思想を参考にしました。Peerstellationのノード配置、到着演出、色、UI、WASM ABI、コード、シェーダー、文章、命名は独自に実装しており、参照リポジトリのソースは取り込んでいません。ABYSSALはMITライセンスで公開されていますが、Peerstellationの観測対象は実際に取得したHelia/libp2p情報だけに限定されます。

品質は一方向の「軽量化」ではなく、120フレームのp95と最大フレーム時間を基準に `cinema → balanced → efficient → still` を往復します。p95が目標の1.25倍を超えるか、約20.0ms（16.7msの1.2倍）を超えるスパイクが連続するとピクセル比と星屑の描画数を下げ、十分な余裕が続けば一段ずつ戻します。GPUはThree.jsのtimestamp-queryが利用できる場合、直近値とp50/p95/maxを別々にCanvas診断属性へ残します。新しいピアは discovery → ping → link → settle → reframe の段階を持ち、線分は `link` 以降だけを実測位置へ伸ばします。これらの状態はCanvasの診断属性にも残り、実機テストで視覚状態と計測値を同時に検証できます。

## 無料運用と収益化の境界

静的配信は Cloudflare Workers Static Assets を既定にし、無料枠内の公開体験を維持します。広告、指紋採取、第三者トラッカーは入れません。支援導線は別リリースで GitHub Sponsors 等を設定できるようにし、運営費が必要になった場合だけ、次の順序で拡張します。

1. 透明な個人支援（GitHub Sponsors / Ko-fi）
2. CID 固定の到達性レポートと CSV/JSON エクスポート
3. 企業向けの認証済み履歴・監視機能（公開版の観測範囲とは分離）

## ライセンス

MIT © [tadanobutubutu](https://github.com/tadanobutubutu)
