// 日本語などの IME (変換入力) を firefox-wasm エンジンへ届けるためのシム。
//
// gecko.js の入力層 (attachInput) は #screen (canvas) 上の keydown/keyup を
// エンジンへ転送するだけで composition イベントを扱わない。さらにフォーカス先が
// 非編集要素の canvas なので、ブラウザはそもそも IME の変換を開始しない
// (キーが生のアルファベットのまま入るか、key="Process"/keyCode=229 になる)。
//
// このシムはエンジンや gecko.js のビルドに手を入れずに JS だけで解決する:
//   1. canvas がフォーカスを得たら画面外の <input> (編集可能要素) へ移し、
//      IME が変換モードに入れるようにする
//   2. 変換中でない通常キーは合成 KeyboardEvent として canvas へ再ディスパッチ
//      (gecko.js の既存リスナーがそのままエンジンへ転送する)
//   3. IME の確定文字列 (compositionend) はコードポイントごとに keydown を合成。
//      gecko.js は e.key が 1 文字なら charCode を算出し、エンジン側
//      (embed-input.cpp do_key) は eKeyPress + charCode で任意の BMP 文字を
//      挿入できるため、これだけで日本語が入る
//   4. 変換中は input を可視化し、直近のクリック位置の近くで変換プレビューと
//      IME 候補ウィンドウを出す (ページ内へのインライン表示はエンジン側に
//      IME API がないため不可)
//
// 既知の制限:
//   - サロゲートペア (絵文字など BMP 外) は charCode 経路で送れないため捨てる
//   - 変換確定前にキャンバスをクリックすると、キャレット移動後に確定文字列が
//     挿入される (実ブラウザは旧位置で確定する)
(() => {
  'use strict';

  const canvas = document.getElementById('screen');
  if (!canvas) return;

  const ime = document.createElement('input');
  ime.type = 'text';
  ime.autocomplete = 'off';
  ime.autocapitalize = 'off';
  ime.spellcheck = false;
  ime.tabIndex = -1;
  ime.setAttribute('aria-hidden', 'true');

  const BASE = {
    position: 'fixed', left: '0px', top: '0px', zIndex: '9999',
    pointerEvents: 'none', margin: '0', outline: 'none',
    font: '16px sans-serif',
  };
  const HIDDEN = {
    width: '1px', height: '1px', padding: '0', border: '0',
    opacity: '0', background: 'transparent', color: 'transparent',
  };
  const PREVIEW = {
    width: '16em', height: 'auto', padding: '2px 8px',
    border: '1px solid #999', borderRadius: '4px', opacity: '1',
    background: '#fff', color: '#000', boxShadow: '0 2px 8px rgba(0,0,0,.25)',
  };
  const style = (props) => Object.assign(ime.style, props);
  style(BASE);
  style(HIDDEN);
  document.body.appendChild(ime);

  // canvas は非編集要素なのでフォーカスをここへ付け替える。エンジン起動時の
  // canvas.focus() と、gecko.js の mousedown ハンドラ内の focus() の両方を拾う。
  canvas.addEventListener('focus', () => ime.focus({ preventScroll: true }));

  // IME 候補ウィンドウは input のキャレット位置に出るため、直近のクリック位置の
  // 少し下へ input を移動しておく (画面外にはみ出さないようクランプ)。
  canvas.addEventListener('mousedown', (e) => {
    style({
      left: Math.max(0, Math.min(e.clientX, innerWidth - 280)) + 'px',
      top: Math.max(0, Math.min(e.clientY + 24, innerHeight - 48)) + 'px',
    });
  });

  // gecko.js の keyItem は e.key / e.keyCode / 修飾キーだけを読む。keyCode は
  // KeyboardEventInit で無視される環境があるため defineProperty で強制する。
  const forward = (type, key, keyCode, src) => {
    const ev = new KeyboardEvent(type, {
      key,
      code: src ? src.code : '',
      ctrlKey: !!(src && src.ctrlKey),
      altKey: !!(src && src.altKey),
      shiftKey: !!(src && src.shiftKey),
      metaKey: !!(src && src.metaKey),
      repeat: !!(src && src.repeat),
    });
    Object.defineProperty(ev, 'keyCode', { value: keyCode });
    canvas.dispatchEvent(ev);
  };

  // 変換中のキーは IME のもの: 転送も preventDefault もしない
  const isImeKey = (e) =>
    e.isComposing || e.keyCode === 229 || e.key === 'Process';

  ime.addEventListener('keydown', (e) => {
    if (isImeKey(e)) return;
    forward('keydown', e.key, e.keyCode, e);
    e.preventDefault();
  });
  ime.addEventListener('keyup', (e) => {
    if (isImeKey(e)) return;
    forward('keyup', e.key, e.keyCode, e);
    e.preventDefault();
  });

  ime.addEventListener('compositionstart', () => style(PREVIEW));

  ime.addEventListener('compositionend', (e) => {
    style(HIDDEN);
    ime.value = '';
    for (const ch of e.data || '') {
      if (ch.length !== 1) continue; // BMP 外は送れない (冒頭コメント参照)
      forward('keydown', ch, 0, null);
      forward('keyup', ch, 0, null);
    }
  });

  ime.addEventListener('blur', () => {
    style(HIDDEN);
    ime.value = '';
  });
})();
