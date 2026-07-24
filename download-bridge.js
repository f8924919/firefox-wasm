// WASM Firefox 内のファイルダウンロードをホスト (実ブラウザ) へ取り出すブリッジ。
//
// 上流にはダウンロードの取り出し機能がない: エンジンは WasmFS 上 (既定では
// メモリ上) に保存するだけで、実 PC へファイルを渡す経路が存在しない。
// このブリッジはエンジンや gecko.js のビルドに手を入れずに JS だけで解決する:
//
//   1. デモが公開する window.geckoEvalChrome (chrome 特権 JS の評価) で
//      ダウンロード保存先を /opfs/downloads に向ける。/opfs は WasmFS の
//      ネイティブ OPFS バックエンド = 実ディスクなので、大容量ファイルが
//      タブのメモリを食い潰す問題もこれで同時に回避される
//   2. 同じ eval で Downloads API (Downloads.sys.mjs) にビューを張り、完了した
//      ダウンロードを chrome グローバル (__dlBridge) のキューに溜める
//   3. ページ側から定期ポーリングでキューを回収し、navigator.storage
//      (同じ OPFS) からファイルを File として取得、<a download> でホストの
//      ダウンロードとして発火する (File はディスクバック Blob なので
//      大容量でもメモリに全載せしない)
//   4. 発火から猶予をおいて OPFS 上の実体を削除して容量を返す
//
// 既知の制限:
//   - 2 件目以降の自動ダウンロードは Chrome の「複数ファイルの自動ダウン
//     ロード」確認でブロックされることがある → 画面右下のトーストのリンクを
//     手でクリックすれば必ず取り出せる (クリックは実ジェスチャなので通る)
//   - ダウンロード UI から保存先を /opfs 外へ変えた場合は取り出せない
//     (コンソールに警告を出すのみ)
//   - PDF などタブ内で開く形式はダウンロード扱いにならない (実 Firefox と同じ)
(() => {
  'use strict';

  const DL_DIR = 'downloads';               // OPFS ルート直下 (= /opfs/downloads)
  const POLL_MS = 2000;
  const CLEANUP_DELAY_MS = 5 * 60 * 1000;   // 発火からファイル削除までの猶予
  const STALE_MS = 24 * 60 * 60 * 1000;     // 起動時に掃除する旧ファイルの閾値
  const MAX_ERRORS = 5;                     // chrome 側エラーの連続回数上限

  // ---- chrome 特権側に仕込むスクリプト -----------------------------------
  // evalChrome は同期評価なので、非同期の初期化は IIFE で走らせて状態を
  // chrome グローバル (__dlBridge) に置き、ページ側からポーリングで読む。
  const SETUP_JS = `(() => {
    if (globalThis.__dlBridge) return 'already';
    const B = globalThis.__dlBridge = { ready: false, err: '', done: [] };
    (async () => {
      Services.prefs.setIntPref('browser.download.folderList', 2);
      Services.prefs.setCharPref('browser.download.dir', '/opfs/${DL_DIR}');
      Services.prefs.setBoolPref('browser.download.useDownloadDir', true);
      Services.prefs.setBoolPref('browser.download.start_downloads_in_tmp_dir', false);
      Services.prefs.setBoolPref('browser.download.always_ask_before_handling_new_types', false);
      await IOUtils.makeDirectory('/opfs/${DL_DIR}', { ignoreExisting: true });
      const { Downloads } = ChromeUtils.importESModule('resource://gre/modules/Downloads.sys.mjs');
      const list = await Downloads.getList(Downloads.ALL);
      const seen = new WeakSet();
      await list.addView({
        onDownloadChanged(dl) {
          if (dl.succeeded && !seen.has(dl)) {
            seen.add(dl);
            B.done.push({ path: dl.target.path, url: dl.source.url });
          }
        },
      });
      B.ready = true;
    })().catch(e => { B.err = String(e); });
    return 'setup-started';
  })()`;

  const POLL_JS = `(() => {
    const B = globalThis.__dlBridge;
    if (!B) return '{"state":"missing"}';
    return JSON.stringify({
      state: B.err ? 'error' : B.ready ? 'ready' : 'starting',
      err: B.err,
      done: B.done.splice(0),
    });
  })()`;

  const RESET_JS = `(delete globalThis.__dlBridge, 'reset')`;

  // ---- ページ側: OPFS からの取り出しとトースト ---------------------------

  const opfsDir = async (create) => {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(DL_DIR, { create: !!create });
  };

  // 前回セッションの残骸 (取り出し済みのはずの古いファイル) を起動時に掃除
  (async () => {
    try {
      const dir = await opfsDir(false);
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== 'file') continue;
        const f = await handle.getFile();
        if (Date.now() - f.lastModified > STALE_MS) await dir.removeEntry(name);
      }
    } catch { /* downloads ディレクトリ未作成なら何もしない */ }
  })();

  let toastBox = null;
  const toast = (el) => {
    if (!toastBox) {
      toastBox = document.createElement('div');
      Object.assign(toastBox.style, {
        position: 'fixed', right: '12px', bottom: '12px', zIndex: '10000',
        display: 'flex', flexDirection: 'column', gap: '8px',
        font: '13px sans-serif',
      });
      document.body.appendChild(toastBox);
    }
    toastBox.appendChild(el);
  };

  const fmtSize = (n) =>
    n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB'
    : n >= 1024 ? (n / 1024).toFixed(1) + ' KB'
    : n + ' B';

  const exportFile = async (name) => {
    const dir = await opfsDir(false);
    const file = await (await dir.getFileHandle(name)).getFile();
    const url = URL.createObjectURL(file);

    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.textContent = '⬇ ' + name + ' (' + fmtSize(file.size) + ')';
    a.title = '自動ダウンロードがブロックされた場合はここをクリック';
    Object.assign(a.style, {
      padding: '8px 12px', borderRadius: '6px', background: '#1f2937',
      color: '#fff', textDecoration: 'none',
      boxShadow: '0 2px 8px rgba(0,0,0,.35)', maxWidth: '320px',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    });
    toast(a);
    a.click();

    // ホスト側の転送が終わる猶予をおいてから URL とディスク上の実体を片付ける
    setTimeout(async () => {
      URL.revokeObjectURL(url);
      a.remove();
      try { (await opfsDir(false)).removeEntry(name); } catch { /* 済み */ }
    }, CLEANUP_DELAY_MS);
  };

  // ---- ポーリングループ ---------------------------------------------------

  let setupDone = false;
  let busy = false;
  let errors = 0;
  let timer = 0;

  const tick = async () => {
    const evalChrome = window.geckoEvalChrome;
    if (!evalChrome || busy) return;  // エンジン未起動 (Launch 前) は待つだけ
    busy = true;
    try {
      if (!setupDone) {
        const r = await evalChrome(SETUP_JS);
        if (r !== 'setup-started' && r !== 'already') {
          console.warn('[dl-bridge] setup: ' + r);
          return;
        }
        setupDone = true;
      }
      const raw = await evalChrome(POLL_JS);
      let st;
      try { st = JSON.parse(raw); } catch {
        console.warn('[dl-bridge] poll: ' + raw);
        return;
      }
      if (st.state === 'missing') { setupDone = false; return; }
      if (st.state === 'error') {
        console.error('[dl-bridge] chrome 側エラー: ' + st.err);
        await evalChrome(RESET_JS);  // 次の tick で作り直す
        setupDone = false;
        if (++errors >= MAX_ERRORS) {
          console.error('[dl-bridge] エラーが続くため停止します');
          clearInterval(timer);
        }
        return;
      }
      errors = 0;
      for (const d of st.done || []) {
        // 期待する保存先は /opfs/downloads/<name> のみ。それ以外 (UI で保存先を
        // 変えた等、特にメモリ上の WasmFS) はページ側から読めない。
        const m = /^\/opfs\/(.+)$/.exec(d.path || '');
        const rel = m && m[1];
        if (!rel || !rel.startsWith(DL_DIR + '/') || rel.split('/').length !== 2) {
          console.warn('[dl-bridge] OPFS 外の保存先は取り出せません: ' + d.path);
          continue;
        }
        const name = rel.slice(DL_DIR.length + 1);
        console.log('[dl-bridge] 取り出し: ' + name + ' <- ' + d.url);
        exportFile(name).catch((e) =>
          console.error('[dl-bridge] export ' + name + ': ' + e));
      }
    } finally {
      busy = false;
    }
  };

  timer = setInterval(tick, POLL_MS);
})();
