/* Vision-modul: AWS Rekognition + Claude semantic match + multi-pick batch-inventering.
 * Lazy-loadad vid första byte till "Bild"-läge i kamera-toggle.
 * Använder existing gasCall/preload/batch-pipeline + Lambda Function URL.
 *
 * Exporter: window.vision.{init, runAnalysis, isReady}
 */
(function () {
  'use strict';

  // Lambda Function URL — konfigurerad i AWS Console, ANYONE_ANONYMOUS + CORS *
  const REK_API_URL = 'https://ok2n3nm2ziydvid6b6gqgiyfmy0uvtha.lambda-url.eu-west-1.on.aws/';
  const SYNTHETIC_TAG_RE = /^S[A-Za-z0-9]+R\d+$/;
  const CACHE_VERSION = 'v1';
  const ARTICLES_CACHE_KEY = 'vitalisera-vision-articles-' + CACHE_VERSION;
  const FEWSHOTS_CACHE_KEY = 'vitalisera-vision-fewshots-' + CACHE_VERSION;
  const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

  const SESSION_ID = Math.random().toString(36).slice(2, 7).toUpperCase();

  let articles = [];
  let fewshots = [];
  let currentMatches = [];
  let lastResponse = null;
  let lastLatencyMs = 0;
  let lastCacheNote = '';
  const selectedItems = new Map(); // name → {qty, article}
  let initPromise = null;

  // === Helpers ===
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function readCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !obj.ts || !Array.isArray(obj.data)) return null;
      return { ts: obj.ts, data: obj.data, stale: (Date.now() - obj.ts) > CACHE_TTL_MS };
    } catch { return null; }
  }

  function writeCache(key, data) {
    try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); }
    catch (e) { console.warn('vision cache write failed', e); }
  }

  // Återanvänd huvudappens gasCall om tillgänglig, annars eget
  async function gasCallLocal(fn, params) {
    if (typeof window.gasCall === 'function') return window.gasCall(fn, params || {});
    if (!window.GAS_URL) throw new Error('Saknar GAS_URL för vision');
    const res = await fetch(window.GAS_URL, {
      method: 'POST',
      body: JSON.stringify(Object.assign({ fn }, params || {}))
    });
    if (!res.ok) throw new Error('GAS HTTP ' + res.status);
    return await res.json();
  }

  function recordsToArticles(records) {
    // preload rad-format (Code.js:313):
    //   [tag, name, type, qty, unit, last, user, sheetName, minQty, step, comment, rowNum, altTags, category, synonyms, sheetPlace]
    const map = new Map();
    for (const rec of records) {
      const name = String(rec[1] || '').trim();
      if (!name) continue;
      const syns = Array.isArray(rec[14]) ? rec[14].map(s => String(s).trim()).filter(Boolean) : [];
      const tag = String(rec[0] || '');
      const sheetName = String(rec[7] || '').trim();
      const rowNum = rec[11] || null;
      const qty = Number(rec[3]) || 0;
      if (!map.has(name)) map.set(name, { syns: new Set(), instances: [] });
      const e = map.get(name);
      for (const s of syns) e.syns.add(s);
      if (e.instances.length === 0 && sheetName && rowNum) {
        e.instances.push({ tag, sheetName, rowNum, currentQty: qty });
      }
    }
    return Array.from(map.entries()).map(([name, e]) => ({
      name,
      synonyms: Array.from(e.syns).slice(0, 6),
      instance: e.instances[0] || null
    }));
  }

  function findArticle(name) {
    return articles.find(a => a.name === name) || null;
  }

  function showToast(msg, isErr) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:100px;left:16px;right:16px;padding:12px;background:' + (isErr ? '#ef4444' : '#4ade80') + ';color:#000;text-align:center;border-radius:8px;z-index:9999;font-weight:500;box-shadow:0 4px 16px rgba(0,0,0,.3)';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }

  // === Refresh i bakgrunden ===
  async function refreshArticles() {
    try {
      const records = await gasCallLocal('preload');
      if (!Array.isArray(records)) return;
      const fresh = recordsToArticles(records);
      writeCache(ARTICLES_CACHE_KEY, fresh);
      articles = fresh;
    } catch (e) { console.warn('vision: refreshArticles failed', e); }
  }

  async function refreshFewshots() {
    try {
      const fs = await gasCallLocal('getFewshots', { limit: 20 });
      if (fs && fs.ok && Array.isArray(fs.fewshots)) {
        fewshots = fs.fewshots;
        writeCache(FEWSHOTS_CACHE_KEY, fewshots);
      }
    } catch (e) { console.warn('vision: refreshFewshots failed', e); }
  }

  // === Init ===
  async function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const cArt = readCache(ARTICLES_CACHE_KEY);
      const cFs = readCache(FEWSHOTS_CACHE_KEY);
      if (cArt && cArt.data.length) {
        articles = cArt.data;
        if (cFs && cFs.data) fewshots = cFs.data;
        // Bakgrundsuppdate, blocka inte
        refreshArticles();
        refreshFewshots();
        return;
      }
      // Ingen cache — fetch synkront via gasCallLocal för konsistens
      const records = await gasCallLocal('preload');
      if (!Array.isArray(records)) throw new Error('Preload returnerade inget array');
      articles = recordsToArticles(records);
      writeCache(ARTICLES_CACHE_KEY, articles);
      try {
        const fs = await gasCallLocal('getFewshots', { limit: 20 });
        if (fs && fs.ok && Array.isArray(fs.fewshots)) {
          fewshots = fs.fewshots;
          writeCache(FEWSHOTS_CACHE_KEY, fewshots);
        }
      } catch (e) { console.warn('vision: getFewshots initial failed', e); }
    })();
    return initPromise;
  }

  function isReady() {
    return articles.length > 0;
  }

  // === Multi-pick rendering ===
  function ensureOverlayDOM() {
    if (document.getElementById('visionResult')) return;
    const div = document.createElement('div');
    div.id = 'visionResult';
    div.className = 'hidden';
    div.innerHTML = `
      <div class="vision-header">
        <h2>AI-analys</h2>
        <button id="visionClose" type="button" aria-label="Stäng">✕</button>
      </div>
      <img id="visionPreview" alt="Snap">
      <div class="vision-section">
        <div class="vision-section-title">Möjliga artiklar — markera de som ska inventeras</div>
        <ul id="visionMatches"></ul>
      </div>
      <div class="vision-section vision-section-secondary">
        <details>
          <summary>Detaljer från AI</summary>
          <div class="vision-section-title">Detekterad text (OCR)</div>
          <ul id="visionTexts"></ul>
          <div class="vision-section-title">Rekognition labels</div>
          <ul id="visionLabels"></ul>
        </details>
      </div>
      <div style="height: 100px"></div>
    `;
    document.body.appendChild(div);

    const regBtn = document.createElement('button');
    regBtn.id = 'visionRegister';
    regBtn.className = 'hidden';
    regBtn.textContent = 'Inventera 0 valda';
    document.body.appendChild(regBtn);

    document.getElementById('visionClose').addEventListener('click', closeResult);
    regBtn.addEventListener('click', registerSelected);

    // Tap-delegation på matches-listan
    const $matches = document.getElementById('visionMatches');
    let touchStartXY = null;

    function onInteract(e, isTouch) {
      const minus = e.target.closest('.qty-minus');
      const plus = e.target.closest('.qty-plus');
      if (minus) {
        const stepper = minus.closest('.qty-stepper');
        if (stepper) { if (isTouch) e.preventDefault(); adjustQty(stepper.dataset.name, -1); }
        return;
      }
      if (plus) {
        const stepper = plus.closest('.qty-stepper');
        if (stepper) { if (isTouch) e.preventDefault(); adjustQty(stepper.dataset.name, +1); }
        return;
      }
      const li = e.target.closest('li.vmatch');
      if (!li || li.dataset.noinv === '1') return;
      if (isTouch) e.preventDefault();
      toggleSelect(li.dataset.name);
    }
    $matches.addEventListener('click', e => onInteract(e, false));
    $matches.addEventListener('touchstart', e => {
      const t = e.touches[0];
      touchStartXY = t ? { x: t.clientX, y: t.clientY } : null;
    }, { passive: true });
    $matches.addEventListener('touchend', e => {
      const s = touchStartXY; touchStartXY = null;
      if (!s) return;
      const t = e.changedTouches[0]; if (!t) return;
      if (Math.abs(t.clientX - s.x) > 10 || Math.abs(t.clientY - s.y) > 10) return;
      onInteract(e, true);
    }, { passive: false });
  }

  function renderMatches() {
    const $matches = document.getElementById('visionMatches');
    const rows = currentMatches.map(m => {
      const art = findArticle(m.name);
      const canInv = !!(art && art.instance);
      const sel = selectedItems.get(m.name);
      const currentQty = canInv ? art.instance.currentQty : 0;
      const newQty = sel ? sel.qty : currentQty;
      const cls = (sel ? 'selected ' : '') + (canInv ? '' : 'no-inv');
      return `
        <li class="vmatch ${cls}" data-name="${esc(m.name)}" ${canInv ? '' : 'data-noinv="1"'}>
          <div class="vrow">
            <div class="vcheck"></div>
            <div class="vinfo">
              <div class="vname">${esc(m.name)}</div>
              <div class="vmeta">${m.reason ? 'AI: ' + esc(m.reason) : ''}${canInv ? '' : ' • <span style="color:#fbbf24">kan inte inventeras</span>'}</div>
              ${canInv ? `<div class="vsaldo">Saldo nu: ${currentQty}${art.instance.sheetName ? ' • ' + esc(art.instance.sheetName) : ''}</div>` : ''}
            </div>
            ${canInv ? `
              <div class="qty-stepper" data-name="${esc(m.name)}">
                <button type="button" class="qty-btn qty-minus" aria-label="−">−</button>
                <span class="qty-val">${newQty}</span>
                <button type="button" class="qty-btn qty-plus" aria-label="+">+</button>
              </div>
            ` : ''}
          </div>
        </li>
      `;
    }).join('');
    const meta = lastLatencyMs > 0
      ? `<li class="vmeta-foot">Tap rad för att markera/avmarkera • +/− för antal • ${lastLatencyMs.toFixed(0)} ms${lastCacheNote}</li>`
      : `<li class="vmeta-foot">Tap rad för att markera/avmarkera • +/− för antal</li>`;
    $matches.innerHTML = rows + meta;
    updateRegisterBtn();
  }

  function updateRegisterBtn() {
    const btn = document.getElementById('visionRegister');
    const total = selectedItems.size;
    btn.disabled = total === 0;
    btn.textContent = total === 0
      ? 'Inventera 0 valda'
      : 'Inventera ' + total + (total === 1 ? ' artikel' : ' artiklar');
  }

  function toggleSelect(name) {
    if (selectedItems.has(name)) {
      selectedItems.delete(name);
    } else {
      const art = findArticle(name);
      if (!art || !art.instance) return;
      selectedItems.set(name, { qty: art.instance.currentQty, article: art });
    }
    renderMatches();
  }

  function adjustQty(name, delta) {
    const sel = selectedItems.get(name);
    if (sel) {
      sel.qty = Math.max(0, sel.qty + delta);
    } else if (delta !== 0) {
      const art = findArticle(name);
      if (!art || !art.instance) return;
      selectedItems.set(name, { qty: Math.max(0, art.instance.currentQty + delta), article: art });
    } else {
      return;
    }
    renderMatches();
  }

  async function registerSelected() {
    if (selectedItems.size === 0) return;
    const btn = document.getElementById('visionRegister');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Inventerar ' + selectedItems.size + '…';
    try {
      const userName = localStorage.getItem('vitaliseraUser') || 'okänd';
      const batch = [];
      for (const [name, sel] of selectedItems.entries()) {
        const inst = sel.article.instance;
        // Absolut total: stepper-värdet är NEW total (inte += currentQty)
        batch.push({
          fnName: 'updateCount',
          args: {
            tag: inst.tag,
            newCount: sel.qty,
            userName: userName,
            sheetName: inst.sheetName,
            rowNum: inst.rowNum
          }
        });
      }
      const res = await gasCallLocal('batch', { batch });
      if (!res) throw new Error('Inget svar från servern');
      if (res.ok === false) {
        const failed = (res.results || []).filter(r => !r.ok).map(r => (r.tag || '?') + ': ' + (r.msg || '')).slice(0, 3);
        throw new Error('Vissa misslyckades: ' + failed.join(', '));
      }

      // Active learning: logga varje verifierad matchning
      for (const [name] of selectedItems.entries()) {
        gasCallLocal('logVisionMatch', {
          sessionId: SESSION_ID,
          awsLabels: (lastResponse && lastResponse.labels) || [],
          awsTexts: (lastResponse && lastResponse.texts) || [],
          claudeMatches: currentMatches,
          chosenArticle: name
        }).catch(e => console.warn('logVisionMatch failed', e));
        fewshots.unshift({
          labels: ((lastResponse && lastResponse.labels) || []).slice(0, 6),
          texts: ((lastResponse && lastResponse.texts) || []).slice(0, 3),
          article: name
        });
      }
      fewshots = fewshots.slice(0, 20);
      writeCache(FEWSHOTS_CACHE_KEY, fewshots);

      showToast('✓ ' + selectedItems.size + ' artiklar inventerade');
      selectedItems.clear();
      // Stäng result + uppdatera huvudappens listor om möjligt
      setTimeout(() => {
        closeResult();
        if (typeof window.preloadData === 'function') window.preloadData();
      }, 700);
    } catch (err) {
      showToast('Kunde inte inventera: ' + (err.message || err), true);
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function closeResult() {
    document.getElementById('visionResult').classList.add('hidden');
    document.getElementById('visionRegister').classList.add('hidden');
    selectedItems.clear();
  }

  // === Snap + analyze ===
  let analyzing = false;
  async function runAnalysis(videoEl) {
    if (analyzing) return; // concurrent-guard mot dubbla taps
    analyzing = true;
    try { return await _runAnalysisInner(videoEl); }
    finally { analyzing = false; }
  }
  async function _runAnalysisInner(videoEl) {
    if (!articles.length) {
      try { await init(); } catch (e) {
        showToast('Kunde inte ladda artikellistan: ' + (e.message || e), true);
        return;
      }
    }
    ensureOverlayDOM();
    const $result = document.getElementById('visionResult');
    const $regBtn = document.getElementById('visionRegister');

    // Snap frame
    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    if (!vw || !vh) { showToast('Ingen kamerabild ännu', true); return; }
    const side = Math.min(vw, vh);
    const target = Math.min(1024, side);
    const canvas = document.createElement('canvas');
    canvas.width = target; canvas.height = target;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoEl, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, target, target);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const base64 = dataUrl.split(',', 2)[1];

    // Visa result-overlay direkt med spinner
    $result.classList.remove('hidden');
    const $preview = document.getElementById('visionPreview');
    $preview.src = dataUrl;
    document.getElementById('visionMatches').innerHTML = '<li class="vmeta-foot"><span class="vspinner"></span> Skickar till AWS + Claude…</li>';
    $regBtn.classList.add('hidden');

    try {
      const t0 = performance.now();
      const res = await fetch(REK_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64, articles: articles, fewshots: fewshots, session: SESSION_ID })
      });
      lastLatencyMs = performance.now() - t0;
      if (!res.ok) throw new Error('Lambda HTTP ' + res.status + ': ' + (await res.text()));
      const data = await res.json();
      lastResponse = data;

      const claudeMatches = Array.isArray(data.claude_matches) ? data.claude_matches : [];
      currentMatches = claudeMatches;
      selectedItems.clear();

      // FIX (v104 review #2): DEFAULT-DESELECTED. Säkerhet > effektivitet.
      // Användaren tappar varje rad hen vill inventera. Förhindrar oavsiktlig
      // mass-inventering om hen bara tappar "Inventera" utan att granska.
      // (Default-selected förgiftar fewshots-pipen med AI false-positives.)

      const cm = data.claude_cache || {};
      lastCacheNote = cm.cache_read ? ' • cache: ' + cm.cache_read + ' in' : cm.cache_create ? ' • cache CREATED' : '';

      // Rendera labels + texts
      const $texts = document.getElementById('visionTexts');
      const $labels = document.getElementById('visionLabels');
      $texts.innerHTML = (data.texts || []).length
        ? data.texts.map(t => `<li>${esc(t.text)} <span class="vconf">${t.confidence}</span></li>`).join('')
        : '<li class="vempty">Ingen text</li>';
      $labels.innerHTML = (data.labels || []).slice(0, 10).map(l => `<li>${esc(l.name)} <span class="vconf">${l.confidence}</span></li>`).join('');

      if (claudeMatches.length === 0) {
        document.getElementById('visionMatches').innerHTML = '<li class="vempty">Inga matchningar från AI.</li>';
        $regBtn.classList.add('hidden');
      } else {
        renderMatches();
        $regBtn.classList.remove('hidden');
      }
    } catch (err) {
      document.getElementById('visionMatches').innerHTML = '<li class="vempty" style="color:#ef4444">Fel: ' + esc(err.message || String(err)) + '</li>';
      $regBtn.classList.add('hidden');
    }
  }

  window.vision = { init, runAnalysis, isReady, closeResult };
})();
