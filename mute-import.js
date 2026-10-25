'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let busy = false, objectUrl = null;
  const notice = '取得は表示中の1画面だけです。一覧の続き・終端は画像から確定できません。続きがある場合は、X側で手動スクロールして再度取り込んでください。自動スクロールは行いません。';
  function status(text) { $('muteStatus').textContent = text; }
  function setBusy(value) {
    busy = value;
    for (const id of ['muteCapture', 'muteFile', 'muteRegister']) $(id).disabled = value;
    $('muteCapture').disabled = value || !navigator.mediaDevices?.getDisplayMedia;
  }
  window.openMuteImport = () => {
    $('muteImportModal').style.display = 'flex';
    status(notice);
    if (!navigator.mediaDevices?.getDisplayMedia) {
      $('muteCapture').disabled = true;
      $('muteCaptureHint').textContent = 'このブラウザは画面取得に対応していません。保存済みスクリーンショットを選択してください。';
    }
  };
  window.closeMuteImport = () => {
    if (busy) return;
    $('muteImportModal').style.display = 'none';
    clearPreview();
    $('muteCandidates').value = '';
    $('muteRawText').textContent = '';
    $('muteConfirmed').checked = false;
    $('muteFile').value = '';
  };
  function clearPreview() {
    $('mutePreview').removeAttribute('src');
    $('mutePreview').hidden = true;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  async function recognize(blob) {
    clearPreview();
    $('muteCandidates').value = '';
    $('muteRawText').textContent = '';
    $('muteConfirmed').checked = false;
    let worker;
    let timer;
    let bitmap;
    try {
      if (!blob || blob.size > 20 * 1024 * 1024) throw new Error('20MB以下の画像を選択してください');
      bitmap = await createImageBitmap(blob);
      if (bitmap.width * bitmap.height > 24000000) throw new Error('画像が大きすぎます。表示中の1画面に切り取ってください');
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, Math.sqrt(8000000 / (bitmap.width * bitmap.height)));
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close(); bitmap = null;
      objectUrl = URL.createObjectURL(blob);
      $('mutePreview').src = objectUrl;
      $('mutePreview').hidden = false;
      status('画像を端末内で解析しています。初回は認識用データのダウンロードに時間がかかります。');
      let expired = false;
      const job = (async () => {
        worker = await Tesseract.createWorker('eng', 1, {
          workerPath: new URL('vendor/tesseract/worker.min.js', location.href).href,
          corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0',
          langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
          logger: msg => { if (!expired && msg.status === 'recognizing text') status(`画像を解析中… ${Math.round(msg.progress * 100)}%`); },
        });
        if (expired) { await worker.terminate(); throw new Error('解析を中止しました'); }
        await worker.setParameters({ tessedit_pageseg_mode: '11' });
        return worker.recognize(canvas);
      })();
      const result = await Promise.race([job, new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error('解析が時間内に完了しませんでした。通信状態を確認し、再度お試しください')); }, 90000);
      })]);
      const names = MuteImportUtils.extract(result.data.text);
      $('muteRawText').textContent = result.data.text;
      $('muteCandidates').value = names.map(name => '@' + name).join('\n');
      status(`${names.length}件の候補を読み取りました。読み取れなかったアカウントは候補に出ません。画像全体と照合して不足分を追記し、誤読や自己紹介文中のアカウントを修正・削除してください。候補はまだ登録されていません。\n${notice}`);
    } catch (error) {
      status(`取り込めませんでした: ${error.message}\n${notice}`);
    } finally {
      clearTimeout(timer);
      bitmap?.close();
      if (worker) await worker.terminate().catch(() => {});
    }
  }
  $('muteFile').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file || busy) return;
    setBusy(true);
    try { await recognize(file); } finally { setBusy(false); }
  });
  $('muteCapture').addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    let stream, video;
    try {
      // One user-selected surface, one frame. Never access X DOM, scroll or click.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: false, selfBrowserSurface: 'exclude' });
      video = document.createElement('video');
      video.muted = true; video.srcObject = stream;
      await video.play();
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('画面を取得できませんでした')), 10000);
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => { clearTimeout(timeout); resolve(); });
        else if (video.readyState >= 2) { clearTimeout(timeout); resolve(); }
        else video.onloadeddata = () => { clearTimeout(timeout); resolve(); };
      });
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      stream.getTracks().forEach(track => track.stop());
      video.srcObject = null;
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      await recognize(blob);
    } catch (error) {
      status(`画面取得を中止しました: ${error.message}。画像ファイルからも取り込めます。`);
    } finally {
      stream?.getTracks().forEach(track => track.stop());
      if (video) video.srcObject = null;
      setBusy(false);
    }
  });
  $('muteRegister').addEventListener('click', () => {
    if (busy) return;
    try {
      if (!$('muteConfirmed').checked) throw new Error('ミュート一覧の画像と候補を確認してチェックしてください');
      const names = MuteImportUtils.parseReviewed($('muteCandidates').value);
      const source = MuteImportUtils.account($('muteSourceAccount').value);
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && JSON.stringify(JSON.parse(saved).map(normalizeArtist)) !== JSON.stringify(artists)) {
        throw new Error('別タブで一覧が変更されています。候補を控え、ページを読み込み直してから登録してください');
      }
      const result = MuteImportUtils.merge(artists, names, source, new Date().toISOString(), uid);
      // Persist first; storage failure must leave both memory and existing data intact.
      localStorage.setItem(STORAGE_KEY, JSON.stringify(result.artists));
      artists = result.artists;
      renderList();
      $('muteCandidates').value = '';
      $('muteConfirmed').checked = false;
      status(`新規${result.added}件・既存${result.updated}件をこのブラウザに保存しました。端末間で共有するには「GitHubに保存」を押してください。\n${notice}`);
    } catch (error) { status(error.message); }
  });
})();
