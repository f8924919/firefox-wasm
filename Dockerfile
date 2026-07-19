# syntax=docker/dockerfile:1
# =============================================================================
# HeyPuter/firefox-wasm — ビルド済みリリース成果物ベースの軽量イメージ
#
# 注意: リリースの chrome-demo tarball は VITE_PUTER_BRANDING=1 でビルドされて
# おり、WISP エンドポイントが Puter ホストのリレー (認可が必要で、外部からは
# "not authorized" を返す) に固定されている。そのままでは全サイトがタイムアウト
# するため、ここでは:
#   - エンジン (gecko.wasm.zst) と chrome-assets はリリース成果物を流用し、
#   - デモのフロントエンドだけをブランディング無しで Vite リビルドする
#     (→ WISP が同一オリジンの /wisp/ にデフォルトされ、UI からも変更可能)。
# Gecko 本体のコンパイルは行わないので、ビルドは数分で終わる。
# ソースからのフルビルドは Dockerfile.source を参照。
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: builder — chrome-demo フロントエンドをリリース版エンジンでリビルド
# ---------------------------------------------------------------------------
FROM node:22-slim AS builder

# リポジトリのタグとリリース成果物のバージョンを一致させること
ARG RELEASE_TAG=v0.0.1
ARG PNPM_VERSION=9.12.0
# 追加する日本語フォント。同梱フォントは Liberation Sans (ラテン文字のみ) だけの
# ため、CJK フォントを足さないと日本語が豆腐 (□) になる。エンジンは実行時に
# chrome-assets 内の fonts/ をスキャンするので、アーカイブへの追加だけで済む。
ARG JP_FONT_URL="https://github.com/google/fonts/raw/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf"

# python3/make/g++ は bufferutil (wisp-js の通常依存) のネイティブビルド用。
# arm64 等でビルド済みバイナリが当たらない場合に node-gyp でのビルドが走るため、
# ツールチェーンは builder にだけ入れる (最終イメージには含めない)。
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates zstd python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@${PNPM_VERSION}

WORKDIR /src
RUN git clone --depth 1 --branch ${RELEASE_TAG} https://github.com/HeyPuter/firefox-wasm.git .

ADD https://github.com/HeyPuter/firefox-wasm/releases/download/${RELEASE_TAG}/gecko.js-${RELEASE_TAG}.tar.gz /tmp/gecko.js.tar.gz
ADD https://github.com/HeyPuter/firefox-wasm/releases/download/${RELEASE_TAG}/chrome-demo-${RELEASE_TAG}.tar.gz /tmp/chrome-demo.tar.gz

ADD ${JP_FONT_URL} /tmp/NotoSansJP.ttf

# gecko.js のビルド済み dist (ESM バンドル + gecko.wasm.zst) をワークスペースに配置。
# chrome-assets (Firefox UI リソース) はリリースの静的ビルドから流用するが、
# 展開して fonts/ と browser/fonts/ に日本語フォントを追加してから再パックする
# (chrome-assets.json の uncompressedSize は実行時の zstd 展開に必要なので更新必須)。
RUN set -e; \
    tar -xzf /tmp/gecko.js.tar.gz -C /tmp; \
    cp -r /tmp/gecko.js/dist gecko.js/dist; \
    tar -xzf /tmp/chrome-demo.tar.gz -C /tmp; \
    mkdir /tmp/stage; \
    zstd -d -q /tmp/dist/chrome-assets.tar.zst -o /tmp/ca.tar; \
    tar -xf /tmp/ca.tar -C /tmp/stage; \
    cp /tmp/NotoSansJP.ttf /tmp/stage/fonts/; \
    cp /tmp/NotoSansJP.ttf /tmp/stage/browser/fonts/; \
    tar -cf /tmp/ca-new.tar -C /tmp/stage .; \
    SIZE=$(stat -c%s /tmp/ca-new.tar); \
    printf '{"uncompressedSize":%s}\n' "$SIZE" > demo/chrome/public/chrome-assets.json; \
    zstd -q -f -19 /tmp/ca-new.tar -o demo/chrome/public/chrome-assets.tar.zst; \
    rm -rf /tmp/gecko.js /tmp/dist /tmp/stage /tmp/ca.tar /tmp/ca-new.tar /tmp/*.tar.gz

# VITE_PUTER_BRANDING を設定せずにビルドするのが肝
RUN pnpm install --frozen-lockfile \
    && pnpm --filter chrome-demo build \
    && test -f demo/chrome/dist/index.html \
    && test -f demo/chrome/dist/gecko.wasm.zst

# 後付けスクリプト2点をビルド済み dist に注入する:
#   - ime-shim.js: 上流は canvas への keydown/keyup 転送のみで composition
#     イベント非対応のため IME (日本語等) 入力が効かない問題の修正
#   - wisp-opts-guard.js: 過去の壊れたビルドが localStorage に残した不正
#     WISP URL (→ 全サイト connection timeout) の自動除去
# 詳細は各ファイル冒頭のコメントを参照。
COPY wisp-opts-guard.js ime-shim.js demo/chrome/dist/
RUN sed -i 's#</body>#  <script src="./wisp-opts-guard.js"></script>\n  <script src="./ime-shim.js"></script>\n</body>#' demo/chrome/dist/index.html \
    && grep -q 'ime-shim.js' demo/chrome/dist/index.html \
    && grep -q 'wisp-opts-guard.js' demo/chrome/dist/index.html

# 配信サーバーの依存もツールチェーンのある builder 側でインストールし、
# ランタイムステージには node_modules をコピーするだけにする
COPY package.json /server/package.json
RUN cd /server && npm install --omit=dev && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 2: runtime — COOP/COEP + WISP プロキシ付き Node サーバーで配信
# ---------------------------------------------------------------------------
FROM node:22-slim

WORKDIR /app

COPY package.json ./
COPY --from=builder /server/node_modules ./node_modules
COPY --from=builder /src/demo/chrome/dist ./dist
COPY server.mjs ./

ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "server.mjs"]
