// firefox-wasm chrome-demo 配信サーバー
//
// リリース成果物 (chrome-demo の静的ビルド) の配信に必要な3点をすべて担う:
//   1. 静的ファイル配信 (dist/)
//   2. COOP/COEP ヘッダ — SharedArrayBuffer (pthreads) に必須の cross-origin isolation
//   3. /wisp での WISP プロキシ (WebSocket) — エンジンの http(s) 通信はすべてこれ経由
//
// TLS は Cloudflare が終端するため、ここはプレーン HTTP のみ。
// ページが https で配信されれば、demo 側は自動的に wss://<host>/wisp/ に接続する。
import http from 'node:http';
import express from 'express';
import { server as wisp } from '@mercuryworkshop/wisp-js/server';

const PORT = Number(process.env.PORT ?? 8080);

// 公開サーバーなので wisp-js のデフォルト (loopback / プライベート IP への
// 接続拒否 = SSRF 対策) をそのまま使う。内部ネットワークへ意図的に到達させたい
// 場合のみ環境変数で明示的に緩める。
if (process.env.WISP_ALLOW_PRIVATE) {
  wisp.options.allow_loopback_ips = true;
  wisp.options.allow_private_ips = true;
}

const app = express();

app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

app.use(express.static('dist', {
  index: 'index.html',
  setHeaders(res, path) {
    // .zst (gecko.wasm.zst / chrome-assets.tar.zst) は express の mime DB に
    // ないので明示。Content-Length は express.static が付けるため、demo の
    // ダウンロード進捗バーはそのまま機能する。
    if (path.endsWith('.zst')) {
      res.setHeader('Content-Type', 'application/octet-stream');
    }
    // Vite のハッシュ付きアセットは不変なので長期キャッシュ
    if (/\/assets\//.test(path.replace(/\\/g, '/'))) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  if ((req.url || '').startsWith('/wisp')) {
    wisp.routeRequest(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`firefox-wasm chrome-demo listening on http://0.0.0.0:${PORT} (WISP at /wisp)`);
});
