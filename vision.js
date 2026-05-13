/* Vision-modul: AWS Rekognition + Claude semantic match.
 * Tunn orkestrerare — INGEN egen UI eller cache. Allt går genom huvudappens flöden:
 *   - Artikellistan kommer från window.tagCache (huvudappens existing cache)
 *   - Resultat visas via window.openVisionResults(matches) → existing #searchDialog
 *   - Val av artikel triggar openContainerForTag → existing inventeringsdialog
 *   - Fewshot-loggning hookas in i gasCall('logTag'|'updateCount') via window._visionMatchTrigger
 * Exporter: window.vision.{init, runAnalysis}
 */
(function () {
  'use strict';

  const REK_API_URL = 'https://ok2n3nm2ziydvid6b6gqgiyfmy0uvtha.lambda-url.eu-west-1.on.aws/';
  const FEWSHOTS_CACHE_KEY = 'vitalisera-vision-fewshots-v2';
  const FEWSHOTS_TTL_MS = 60 * 60 * 1000;
  const SESSION_ID = Math.random().toString(36).slice(2, 7).toUpperCase();

  let fewshots = [];
  let analyzing = false;

  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function gasCall(fn, params) {
    if (typeof window.gasCall === 'function') return window.gasCall(fn, params || {});
    return Promise.reject(new Error('window.gasCall saknas'));
  }

  function readCacheArray(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !obj.ts || !Array.isArray(obj.data)) return null;
      if ((Date.now() - obj.ts) > FEWSHOTS_TTL_MS) return obj.data; // returnera stale, refresh i bakgrunden
      return obj.data;
    } catch { return null; }
  }
  function writeCacheArray(key, data) {
    try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); }
    catch (e) { console.warn('vision cache write', e); }
  }

  /* Bygg articles-payload till Lambda från huvudappens tagCache.
     Lambda-format: [{name, synonyms?}]. Använder bara unika namn. */
  function buildArticlesFromTagCache() {
    if (!window.tagCache || typeof window.tagCache.entries !== 'function') return [];
    const byName = new Map();
    for (const [, val] of window.tagCache.entries()) {
      const name = (val && val.name || '').trim();
      if (!name) continue;
      const syns = Array.isArray(val.synonyms) ? val.synonyms : [];
      if (!byName.has(name)) byName.set(name, new Set());
      const set = byName.get(name);
      for (const s of syns) { const t = String(s || '').trim(); if (t) set.add(t); }
    }
    return Array.from(byName.entries()).map(([name, synSet]) => ({
      name,
      synonyms: Array.from(synSet).slice(0, 6)
    }));
  }

  async function refreshFewshots() {
    try {
      const fs = await gasCall('getFewshots', { limit: 20 });
      if (fs && fs.ok && Array.isArray(fs.fewshots)) {
        fewshots = fs.fewshots;
        writeCacheArray(FEWSHOTS_CACHE_KEY, fewshots);
      }
    } catch (e) { console.warn('vision: refreshFewshots', e); }
  }

  async function init() {
    const cached = readCacheArray(FEWSHOTS_CACHE_KEY);
    if (cached) fewshots = cached;
    // Bakgrundsuppdate så vi alltid har färska fewshots vid nästa analyze
    refreshFewshots();
  }

  /* ---------- Subtil notifikation ---------- */
  function ensureNoticeDOM() {
    let notice = document.getElementById('visionNotice');
    if (notice) return notice;
    notice = document.createElement('button');
    notice.id = 'visionNotice';
    notice.type = 'button';
    notice.className = 'hidden';
    notice.setAttribute('aria-label', 'Visa AI-förslag');
    document.body.appendChild(notice);
    return notice;
  }

  let _noticeTimer = null;
  let _lastMatches = null;

  function showVisionNotice(matches) {
    const notice = ensureNoticeDOM();
    const n = matches.length;
    notice.innerHTML = '<span class="vn-icon">🤖</span><span class="vn-text">' + n + ' AI-' +
      (n === 1 ? 'förslag' : 'förslag') + '</span><span class="vn-arrow">›</span>';
    notice.classList.remove('hidden');
    _lastMatches = matches;
    notice.onclick = () => {
      hideVisionNotice();
      if (typeof window.openVisionResults === 'function') {
        window.openVisionResults(matches);
      }
    };
    clearTimeout(_noticeTimer);
    _noticeTimer = setTimeout(hideVisionNotice, 12000); // auto-göm efter 12s
  }
  function hideVisionNotice() {
    const notice = document.getElementById('visionNotice');
    if (notice) notice.classList.add('hidden');
    clearTimeout(_noticeTimer);
  }

  /* ---------- Snap + analyze ---------- */
  async function runAnalysis(videoEl) {
    if (analyzing) return;
    analyzing = true;
    try { await _runAnalysisInner(videoEl); }
    finally { analyzing = false; }
  }

  async function _runAnalysisInner(videoEl) {
    if (!videoEl || !videoEl.videoWidth) {
      if (typeof window.show === 'function') window.show('Ingen kamerabild ännu', 'warn');
      return;
    }
    const articles = buildArticlesFromTagCache();
    if (articles.length === 0) {
      if (typeof window.show === 'function') window.show('Artikellistan inte laddad ännu', 'warn');
      return;
    }
    // Debug: verifiera att synonymer flödar igenom (Robert fick 100% match på POC #4
    // efter att synonymer skickades — om antalet synonyms-totalt här är 0 är pipelinen bruten)
    const synTotal = articles.reduce((s, a) => s + (a.synonyms || []).length, 0);
    console.log('vision: ' + articles.length + ' artiklar, ' + synTotal + ' synonymer skickas till Lambda');
    // Exponera så app.js kan visa i AI-dialog-titeln (Robert ser direkt om syn=0)
    window._lastVisionStats = { articleCount: articles.length, synonymCount: synTotal };

    // Snap frame
    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    const side = Math.min(vw, vh);
    const target = Math.min(1024, side);
    const canvas = document.createElement('canvas');
    canvas.width = target; canvas.height = target;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoEl, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, target, target);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const base64 = dataUrl.split(',', 2)[1];

    // UX FIX v110: frys video + visa spinner-overlay (samma "Förbereder utskrift…"-mönster
    // för konsekvent stil). Resultatet öppnar searchDialog DIREKT — inget notice-mellansteg.
    try { videoEl.pause(); } catch {}
    if (typeof window.showPrintLoading === 'function') {
      window.showPrintLoading('Analyserar bild…');
    } else if (typeof window.show === 'function') {
      window.show('Analyserar bild…', null, { autoreset: false });
    }

    try {
      const t0 = performance.now();
      const res = await fetch(REK_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64, articles: articles, fewshots: fewshots, session: SESSION_ID })
      });
      const ms = performance.now() - t0;
      if (!res.ok) throw new Error('Lambda HTTP ' + res.status);
      const data = await res.json();
      console.log('vision: analys klar på', ms.toFixed(0), 'ms', data.claude_cache);

      const matches = Array.isArray(data.claude_matches) ? data.claude_matches : [];

      // Spara senaste AWS+Claude-output globalt — used av fewshot-hooken
      window._lastVisionResult = {
        labels: data.labels || [],
        texts: data.texts || [],
        claudeMatches: matches,
        ts: Date.now(),
        snapDataUrl: dataUrl
      };

      // Återställ UI: göm overlay + spela video igen
      if (typeof window.hidePrintLoading === 'function') window.hidePrintLoading();
      try { videoEl.play().catch(() => {}); } catch {}
      if (typeof window.statusDefault === 'function') window.statusDefault();

      if (matches.length === 0) {
        if (typeof window.show === 'function') window.show('AI hittade inga matchningar', 'warn');
        return;
      }
      // Öppna searchDialog DIREKT (UX FIX v110: skipa notice-mellansteg)
      if (typeof window.openVisionResults === 'function') {
        window.openVisionResults(matches);
      }
    } catch (err) {
      console.error('vision: analys-fel', err);
      if (typeof window.hidePrintLoading === 'function') window.hidePrintLoading();
      try { videoEl.play().catch(() => {}); } catch {}
      if (typeof window.show === 'function') window.show('Bildanalys misslyckades: ' + (err.message || err), 'warn');
    }
  }

  // Anropas av app.js när användaren väljer en artikel (openContainerForTag).
  // FIX v109: tar bort matched-guard. Användaren vill kunna LÄRA modellen även
  // när AI missade — då söker hen manuellt och tapet räknas som bekräftelse.
  // Skydd mot pipeline-förgiftning från orelaterade tag-skanningar: tidsfönster
  // 5 min sedan AI-analysen kördes. Efter det rensas _lastVisionResult.
  const FEWSHOT_WINDOW_MS = 5 * 60 * 1000;

  function consumeVisionResult(chosenArticle) {
    const r = window._lastVisionResult;
    if (!r || !chosenArticle) return;
    if (Date.now() - (r.ts || 0) > FEWSHOT_WINDOW_MS) {
      window._lastVisionResult = null;
      return;
    }
    const wasInAiMatches = Array.isArray(r.claudeMatches)
      && r.claudeMatches.some(m => m && m.name === chosenArticle);
    window._lastVisionResult = null;
    gasCall('logVisionMatch', {
      sessionId: SESSION_ID,
      awsLabels: r.labels,
      awsTexts: r.texts,
      claudeMatches: r.claudeMatches,
      chosenArticle: chosenArticle,
      manualOverride: !wasInAiMatches // signalerar "AI missade, användaren hittade manuellt"
    }).catch(e => console.warn('logVisionMatch', e));
    fewshots.unshift({
      labels: (r.labels || []).slice(0, 6),
      texts: (r.texts || []).slice(0, 3),
      article: chosenArticle
    });
    fewshots = fewshots.slice(0, 20);
    writeCacheArray(FEWSHOTS_CACHE_KEY, fewshots);
  }

  window.vision = { init, runAnalysis, hideVisionNotice, consumeVisionResult };
})();
