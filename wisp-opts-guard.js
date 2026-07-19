// localStorage の chrome-demo-opts に残った不正な WISP URL を除去するガード。
//
// 過去の VITE_PUTER_BRANDING=1 ビルド (リリース tarball そのまま) を開いた
// ブラウザには、WISP URL としてエラーメッセージ文字列
// ("not authorized to use this endpoint ...") がそのまま保存されていることが
// あり、その値を接続先に使おうとして全サイトが connection timeout になる。
// ws:// / wss:// で始まらない値は接続先として成立しないので落とし、
// デモのデフォルト (同一オリジンの /wisp/) に戻す。
//
// デモ本体 (Vite の module スクリプト) より先に実行される必要があるが、
// module は deferred、これは end-of-body の同期スクリプトなので順序は保証される。
(() => {
  'use strict';
  const KEY = 'chrome-demo-opts';
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const opts = JSON.parse(raw);
    if (opts && typeof opts.wisp === 'string' && !/^wss?:\/\//.test(opts.wisp)) {
      delete opts.wisp;
      localStorage.setItem(KEY, JSON.stringify(opts));
    }
  } catch (e) {
    // JSON ごと壊れているなら丸ごと捨ててデフォルトに戻す
    localStorage.removeItem(KEY);
  }
})();
