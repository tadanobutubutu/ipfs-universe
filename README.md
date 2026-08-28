# Peerstellation

![Peerstellation live peer observatory](./public/hero.png)

> **A browser's reachable neighbourhood, rendered as a living sky.**

Peerstellation is a web-only 3D observatory for real Helia/libp2p observations. The first viewport is intentionally quiet: the sky is the interface, and a node reveals its own details only when hovered, focused, or tapped. No peer, latency, or topology claim is invented.

[![Live site](https://img.shields.io/badge/live-ipfsuniverse.xyz-ccff66?style=for-the-badge)](https://ipfsuniverse.xyz)
[![TypeScript](https://img.shields.io/badge/TypeScript-only-3178c6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-ccff66?style=for-the-badge)](LICENSE)

## 体験

- ページ内で起動した Helia ブラウザノードの接続・発見・切断・ping・identify をリアルタイムに観測します。
- ノードをカーソルで指す、キーボードで選ぶ、スマホでタップする、とその場所にアンカーされたカードへ Peer ID、状態、遅延、方向、transport、protocols、agent/protocol version、アドレス件数を表示します。
- 接続線はこの観測ノードから実際に開いている接続だけです。リモートノード同士の線は、両端から裏付けられた関係がない限り描きません。見栄えのためにトポロジーを捏造しない方針です。
- Zig WebAssembly は安定した全方位の配置と近遠の分布、Rust WebAssembly は接続数・遅延統計を担当し、軽い制御と表示は厳密な TypeScript で実装しています。

## Helia と IPFS Desktop の数字が違う理由

IPFS Desktop の Kubo は TCP/QUIC の常駐ノードです。一方、ブラウザの Helia はブラウザが扱える WebSocket、WebRTC、リレー等だけで別の短命ノードを起動します。そのため Desktop に多数のピアがいても、ページの `connected` が 0〜数件になるのは正常です。ピア表は共有されません。

Peer explorer の **Read local daemon** は明示的に押した時だけ `127.0.0.1:5001/api/v0/id` と `swarm/peers` を読みます。CORS が許可されていない場合は画面に止まり、Kubo の全 RPC を `*` に開放することはありません。ローカル接続を許可する場合も、開発元だけの厳密な Origin を設定してから IPFS Desktop を再起動してください。

```bash
# 例: 開発時だけ許可する Origin。* は使わない
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin \
  '["http://127.0.0.1:4176"]'
```

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
| `npm run test:e2e` | Playwright、axe、レスポンシブ、WebGL フォールバック |
| `npm run deploy:cloudflare` | Wrangler で静的配信を更新 |
| `npm run deploy:pinata` | `PINATA_JWT` がある時だけ CID をピン |

CLI で同梱 Kubo を確認する場合（アプリを停止・変更しません）:

```bash
/Applications/IPFS\ Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/kubo/kubo/ipfs swarm peers --verbose
```

## 設計と安全境界

```text
Helia/libp2p ── typed observations ── PeerReducer (最大512)
       │                                  ├── IndexedDB (公開IDの端末内履歴のみ)
       │                                  └── ThreeUniverse (WebGL2 + picking tooltip)
       ├── Read local daemon (明示操作時のみ Kubo RPC/CORS)
       └── Zig: 配置・物理 / Rust: 集計
```

秘密鍵、Kubo 認証情報、Pinata トークンはブラウザへ渡しません。CSP、COOP/COEP/CORP、HSTS、厳格な Permissions Policy、ハッシュ付き静的資産キャッシュを配信します。IPFS はプロトコル名として技術文書で扱いますが、製品名・ロゴは独自の **Peerstellation** に分離しました。名称は GitHub/npm/一般検索の完全一致を予備調査した結果であり、商標の法的なクリアランスを意味しません。

## 無料運用と収益化の境界

静的配信は Cloudflare Workers Static Assets を既定にし、無料枠内の公開体験を維持します。広告、指紋採取、第三者トラッカーは入れません。支援導線は別リリースで GitHub Sponsors 等を設定できるようにし、運営費が必要になった場合だけ、次の順序で拡張します。

1. 透明な個人支援（GitHub Sponsors / Ko-fi）
2. CID 固定の到達性レポートと CSV/JSON エクスポート
3. 企業向けの認証済み履歴・監視機能（公開版の観測範囲とは分離）

## ライセンス

MIT © [tadanobutubutu](https://github.com/tadanobutubutu)
