# firefox-wasm セルフホスト構成

[HeyPuter/firefox-wasm](https://github.com/HeyPuter/firefox-wasm)(WebAssembly 版 Firefox)の
chrome-demo を自前サーバーでホストするための Docker + Cloudflare Tunnel 構成です。

ブラウザの中で本物の Gecko エンジン(フル Firefox UI)が動き、Web 閲覧のトラフィックは
サーバー上の WISP リレー経由で外部に出ていきます。

## 特徴

- **リリース成果物ベースの軽量ビルド** (`Dockerfile`) — Gecko 本体はコンパイルせず、
  公式リリースのエンジンを流用してフロントエンドだけをリビルド。数分でビルド完了
- **Puter ブランディングの除去** — リリース版 tarball は WISP エンドポイントが
  Puter ホストのリレー(要認可)に固定されており、そのままでは全サイトがタイムアウトする。
  ブランディング無しで Vite リビルドすることで、同一オリジンの `/wisp/` がデフォルトになる
- **日本語フォント対応** — 同梱フォントはラテン文字のみのため、Noto Sans JP を
  chrome-assets に追加して日本語の豆腐(□)表示を解消
- **ソースからのフルビルド** (`Dockerfile.source`) — Gecko を WASM にコンパイルする場合用
  (RAM 32GB・ディスク空き 60GB 以上推奨、12 コアで 25〜50 分)

## 通信経路

```
[手元のブラウザ内 WASM Gecko エンジン]
   │  wss://<ホスト名>/wisp/  (WebSocket 上の WISP プロトコル)
   ▼
[Cloudflare エッジ] ── Cloudflare Tunnel ──▶ [サーバー上の cloudflared]
   ▼
[server.mjs の WISP リレー]  ── 生の TCP を中継 ──▶  [閲覧先 Web サイト]
```

- 閲覧先との TLS は WASM 内の Gecko がエンドツーエンドで確立するため、
  中継点(Cloudflare / このサーバー)から https 通信の内容は見えません
- 閲覧先から見た接続元 IP はこのサーバーの IP になります

## デプロイ

```bash
docker compose up -d --build
```

`docker-compose.yml` は 2 つの接続パターンをコメントで用意しています。

- **パターン A**(デフォルト): cloudflared がホスト上で動作。コンテナは
  `127.0.0.1:8080` のみに束縛し、トンネルの ingress を `http://localhost:8080` に向ける
- **パターン B**: cloudflared もコンテナの場合。`ports:` を外して同一ネットワークに参加させ、
  ingress を `http://firefox-wasm:8080` に向ける

TLS は Cloudflare が終端します。ページが https で配信されれば、demo 側は自動的に
`wss://<ホスト>/wisp/` に接続します。

新しいリリースに更新する場合は `docker-compose.yml` の `CHROME_DEMO_URL`
(および `Dockerfile` の `RELEASE_TAG`)をリリースタグに合わせてください。

## セキュリティ上の注意

- **公開した `/wisp/` は誰でも使える TCP リレーになります。**
  URL を知っている人は誰でも、このサーバーを踏み台にして任意のホストへ接続できます。
  インターネットに公開する場合は Cloudflare Access 等での認証を強く推奨します
- wisp-js のデフォルト設定により、ループバック / プライベート IP への中継は
  拒否されます(SSRF 対策)。環境変数 `WISP_ALLOW_PRIVATE=1` でこの保護を緩められますが、
  内部ネットワークへ意図的に到達させたい場合以外は設定しないでください
- コンテナは非 root(`node` ユーザー)で動作します

## ライセンス

このリポジトリのファイル(Dockerfile / server.mjs / compose 構成)は [MIT License](LICENSE) です。

アップストリームの [HeyPuter/firefox-wasm](https://github.com/HeyPuter/firefox-wasm) は
MPL-2.0 でライセンスされています。このリポジトリはそのコードを含まず、
ビルド時に取得して利用します。
