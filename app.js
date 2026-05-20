/*
 * QR-INVENTERING – PWA KLIENTDEL
 * Extraherad från GAS app.html, google.script.run → fetch/gasCall
 */

/* ===== Service Worker + update-banner ===== */
// APP_VERSION bumpas synkat med sw.js CACHE och index.html app.js?v=
// Används för att räkna ut vilka changelog-entries som är "nya" för användaren.
const APP_VERSION = 135;
// QA-testfäste — flag-gated, PROD NO-OP. På via ?qa=1 eller localStorage.qaMode='1'.
// Möjliggör autonom verifiering i desktop-Chrome FÖRE deploy: __qaScan injicerar
// en avkodad tagg i exakt samma onScanResult-pipeline som en riktig skan;
// __qaRefresh kör initData-rebuilden deterministiskt (simulerar 15s-pollen);
// __qaState läser tagCache/metaCache + logSingle-räknare. INGA prod-vägar rör
// QA utom dessa gated definitioner (ingen scan-/synk-logik ändrad).
const QA_MODE=(()=>{try{return new URLSearchParams(location.search).has('qa')||localStorage.getItem('qaMode')==='1';}catch{return false;}})();
let _qaLogSingleCount=0;
if(QA_MODE){
  window.__qaRefresh=()=>preloadShared().then(initData);
  window.__qaState=(t)=>{const nt=normTag(String(t));return{tag:nt,item:tagCache.get(nt)||null,meta:metaCache.get(nt)||null,logSingleCount:_qaLogSingleCount};};
  window.__qaReset=()=>{_qaLogSingleCount=0;};
}

// Detekteras tidigt — ?print=1-tabben är ephemeral och ska INTE delta i
// update-flow (banner, controllerchange, polling, what's new). Annars
// reloadar tabben vid uppgradering med samma URL → window.print() triggas
// igen → "Tillåt utskrift?"-prompt vid varje uppgradering.
const _isPrintTab = new URLSearchParams(location.search).get('print') === '1';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { scope: './' }).then(reg => {
    if (_isPrintTab) return;

    // Tab öppnas medan en SW redan ligger waiting (bakgrunds-uppdatering)
    if (reg.waiting && navigator.serviceWorker.controller) {
      showUpdateBanner(reg);
    }
    // Manuell uppdaterings-check vid varje sidladdning
    reg.update().catch(() => {});

    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateBanner(reg);
        }
      });
    });
  }).catch(() => {});

  if (!_isPrintTab) {
    // _swReloading flyttat till sessionStorage: en funktionsscoped flagga
    // nollställdes vid varje sidladdning och gav inget skydd mot dubbel-reload
    // över laddningar (rotorsak #2: bränd controllerchange). sessionStorage
    // överlever reload i samma tab men rensas vid äkta cold-start, så ingen
    // permanent reload-loop kan uppstå.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (sessionStorage.getItem('_swReloading') === '1') return;
      sessionStorage.setItem('_swReloading', '1');
      location.reload();
    });

    // Kolla efter ny version regelbundet OCH när PWA:n blir synlig.
    // Två parallella mekanismer: (1) SW-baserad reg.update() — men den lider
    // av iOS Safari HTTP-cache som ibland fastnar i flera dagar, (2) en
    // ren fetch av changelog.json som kringgår SW-cachen helt och visar
    // banner direkt om latest > APP_VERSION. Backup till SW-flödet.
    const checkForUpdate = () => {
      // P3.5(b): update-detektering FÖRST/oberoende. Tidigare `await
      // resyncPendingTagLinks()` blockerade pollVersionViaChangelog när GAS
      // var otillgängligt (resyncens Save.linkTag-anrop hänger på timeout)
      // → banner visades ALDRIG för redan öppen PWA → installerad app kunde
      // inte uppgraderas utan manuell swipe-kill (cold-start-vägen på rad
      // 35-49 är inte checkForUpdate-gated och fungerade alltid).
      // Resync triggas separat fire-and-forget nedan — behåller §11.1-/9.6-
      // intent (skicka köade pending-skrivningar) utan att svälta detektering.
      navigator.serviceWorker.getRegistration().then(reg => {
        reg?.update().catch(() => {});
      }).catch(() => {});
      pollVersionViaChangelog();
      // Idempotent (_resyncInFlight + _inflight-guard) → krockar ej med
      // online-listenern eller visibilitychange-handlern nedan.
      try { resyncPendingTagLinks(); } catch (_) {}
    };
    if (QA_MODE) window.__qaCheckForUpdate = checkForUpdate;
    setInterval(checkForUpdate, 60000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkForUpdate();
    });
  }
}

async function pollVersionViaChangelog() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 3000);
  try {
    const res = await fetch('changelog.json?ts=' + Date.now(), { cache: 'no-store', signal: ac.signal });
    if (!res.ok) return;
    const log = await res.json();
    const latest = Number(log.latest) || 0;
    if (latest > APP_VERSION) showUpdateBanner(null);
  } catch {} finally { clearTimeout(timer); }
}

async function forceUpdate() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch {}
  location.reload();
}

// Ren, state-agnostisk beslutslogik för uppgraderingsknappen. Avgör åtgärd
// utifrån FÄRSK SW-state vid klick (inte cachad `reg`). Rotorsak #1: tidigare
// `if (reg?.waiting) postMessage else forceUpdate()` gav ALLTID forceUpdate()
// för changelog-poll-bannern (reg=null) → unregister+cache-wipe race:ade
// pågående install + iOS HTTP-cache gav samma gamla app.js → banner igen.
// Nu: ingen registrering alls = forceUpdate som SISTA utväg; annars mjuk väg.
function decideUpdateAction({ hasRegistration, hasWaiting }) {
  if (!hasRegistration) return 'forceUpdateLastResort';
  if (hasWaiting) return 'skipWaiting';
  return 'updateAndWait';
}
// Stor singel-bekräftelse-overlay ska BARA visas när en singel-artikel
// registreras direkt via SKANNING (det användaren bad om) — aldrig från
// dialog-knappar (confirmSingle/registerSingleBtn), där en helskärms-✓ vore
// malplacerad. Ren predikat-fn → testbar utan DOM; triggern hålls lokal till
// skan-vägen (ej i Save.logSingle som delas av 4 callsites) → ingen
// dubbelfyrning (jfr tidigare delad-fn+listener-regression).
function shouldShowSingelConfirm({ via, type } = {}) {
  return via === 'scan' && type === 'singel';
}
// Steg5: den STORA gröna bocken får INTE visas förrän serveroperationen är
// VERIFIERAT lyckad — annars ger ett tyst logTag-fel (nät/lock/stale) en stark
// falsk success (samma falsk-success-klass som linkTag/updateMeta/batch stängt).
// Återanvänder EXAKT samma 'verified'-kriterium som steg4:s shouldShowLinkSuccess
// (ingen parallell klassificerare): bocken visas BARA vid classifyLinkResult
// === 'verified'. 'pending-retry' (offline/uttömt) och 'rejected' (server-
// avvisning) → ingen bock; logSingle visar ⚠️/pending-status i historiken.
function shouldShowSingelConfirmForResult(cls) { return cls === 'verified'; }
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { decideUpdateAction, shouldShowSingelConfirm, shouldShowSingelConfirmForResult };
}

// Vänta in en ny `waiting`-SW efter reg.update(). Pollar reg.waiting samt
// lyssnar på updatefound/statechange. EN engångslyssnare per anrop som
// städas direkt vid träff/timeout → ingen permanent eller stackad listener
// (jfr v120-regression: delad funktion + permanent listener = dubbel-event).
function waitForWaitingWorker(reg, timeoutMs) {
  return new Promise(resolve => {
    if (reg.waiting) { resolve(reg.waiting); return; }
    let done = false;
    const finish = (w) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reg.removeEventListener('updatefound', onUpdateFound);
      resolve(w);
    };
    const onUpdateFound = () => {
      const nw = reg.installing;
      if (!nw) return;
      const onState = () => {
        if (nw.state === 'installed' || nw.state === 'activated') {
          nw.removeEventListener('statechange', onState);
          finish(reg.waiting || (nw.state === 'installed' ? nw : null));
        }
      };
      nw.addEventListener('statechange', onState);
    };
    reg.addEventListener('updatefound', onUpdateFound);
    const timer = setTimeout(() => finish(reg.waiting || null), timeoutMs);
  });
}

async function fetchChangelogSince(currentVersion) {
  // Timeout så banner inte hänger asynkront om changelog.json är slow/nere.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 3000);
  try {
    const res = await fetch('changelog.json?ts=' + Date.now(), { cache: 'no-store', signal: ac.signal });
    if (!res.ok) return [];
    const log = await res.json();
    const versions = Array.isArray(log.versions) ? log.versions : [];
    return versions
      .filter(v => Number(v.version) > Number(currentVersion))
      .flatMap(v => Array.isArray(v.notes) ? v.notes : []);
  } catch { return []; }
  finally { clearTimeout(timer); }
}

async function showUpdateBanner(reg) {
  if (document.getElementById('updateBanner')) return;
  // Banner är medvetet enkel — detaljerade ändringar visas i "What's new"-modal
  // EFTER reload. Visa dock current → latest så användaren förstår vad som händer.
  let latestVersion = null;
  try {
    const res = await fetch('changelog.json?ts=' + Date.now(), { cache: 'no-store' });
    if (res.ok) {
      const log = await res.json();
      latestVersion = Number(log.latest) || null;
    }
  } catch {}

  const banner = document.createElement('div');
  banner.id = 'updateBanner';
  const title = document.createElement('span');
  title.className = 'updateBannerTitle';
  const titleText = document.createElement('div');
  titleText.textContent = 'Ny version tillgänglig';
  title.appendChild(titleText);
  if (latestVersion && latestVersion > APP_VERSION) {
    const versionLine = document.createElement('div');
    versionLine.className = 'updateBannerVersion';
    versionLine.textContent = `Du kör version ${APP_VERSION} — version ${latestVersion} finns att uppgradera till`;
    title.appendChild(versionLine);
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'updateBtn';
  btn.textContent = 'Uppgradera version';
  // State-agnostisk: ignorera den `reg` bannern skapades med (kan vara null
  // från changelog-poll, eller stale). Hämta FÄRSK registrering vid klick och
  // låt decideUpdateAction välja väg utifrån verklig SW-state just nu.
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    // Vänta in pending Sheet-skrivningar innan reload — annars kan en ändring
    // som väntar på flush förloras vid SW-byte. Timeout 4s så banner inte hänger
    // om sync är trasigt.
    try { await Promise.race([waitForPendingSync(), new Promise(r => setTimeout(r, 4000))]); } catch {}

    let freshReg = null;
    try {
      freshReg = ('serviceWorker' in navigator)
        ? await navigator.serviceWorker.getRegistration()
        : null;
    } catch { freshReg = null; }

    const action = decideUpdateAction({
      hasRegistration: !!freshReg,
      hasWaiting: !!(freshReg && freshReg.waiting),
    });

    if (action === 'forceUpdateLastResort') {
      // Ingen SW registrerad alls — enda kvarvarande vägen.
      forceUpdate();
      return;
    }

    // Fallback-reload-timer: om controllerchange inte fyrar inom ~3s (rotorsak
    // #2: SW redan claimad → SKIP_WAITING till en waiting som inte finns =
    // no-op, ingen ny controllerchange) reloadar vi ändå. sessionStorage-
    // guarden delas med controllerchange-lyssnaren → ingen dubbel-reload.
    const fallbackReload = () => {
      if (sessionStorage.getItem('_swReloading') === '1') return;
      sessionStorage.setItem('_swReloading', '1');
      location.reload();
    };
    setTimeout(fallbackReload, 3000);

    if (action === 'skipWaiting') {
      freshReg.waiting.postMessage('SKIP_WAITING');
      return;
    }
    // action === 'updateAndWait': trigga update, vänta in ny waiting (max 5s),
    // posta SKIP_WAITING. Uteblir waiting tar fallback-timern hand om reload.
    try { await freshReg.update(); } catch {}
    const waiting = await waitForWaitingWorker(freshReg, 5000);
    if (waiting) waiting.postMessage('SKIP_WAITING');
  });
  banner.append(title, btn);
  document.body.appendChild(banner);
}

// What's new-modal: visas vid load om användaren just hoppat över en
// eller flera versioner. lastSeenVersion uppdateras när användaren
// stänger modalen, så samma "what's new" visas inte igen.
async function maybeShowWhatsNew() {
  // Test-stöd: ?asVersion=N overridar localStorage så man kan
  // simulera "jag är användare som missat versionerna N+1...APP_VERSION"
  // utan att faktiskt hoppa över versioner i naturligt flöde.
  const override = parseInt(new URLSearchParams(location.search).get('asVersion'), 10);
  const stored = !Number.isNaN(override)
    ? override
    : parseInt(localStorage.getItem('vitaliseraLastSeenVersion'), 10);
  if (Number.isNaN(stored)) {
    // Första gången — bara markera nuvarande version som sedd, ingen modal.
    localStorage.setItem('vitaliseraLastSeenVersion', String(APP_VERSION));
    return;
  }
  if (stored >= APP_VERSION) return;

  const notes = await fetchChangelogSince(stored);
  if (!notes.length) {
    localStorage.setItem('vitaliseraLastSeenVersion', String(APP_VERSION));
    return;
  }

  const overlay = document.createElement('div');
  overlay.id = 'whatsNewOverlay';

  const card = document.createElement('div');
  card.className = 'whatsNewCard';

  const h = document.createElement('h2');
  h.textContent = 'Nyheter sedan din förra version';
  card.appendChild(h);

  const list = document.createElement('ul');
  for (const n of notes) {
    const li = document.createElement('li');
    li.textContent = n;
    list.appendChild(li);
  }
  card.appendChild(list);

  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'btn';
  ok.textContent = 'OK';
  const isTest = !Number.isNaN(override);
  ok.addEventListener('click', () => {
    // I test-mode (?asVersion=N): skriv inte localStorage, så testet kan
    // upprepas. I riktig användning: markera versionen som sedd.
    if (!isTest) localStorage.setItem('vitaliseraLastSeenVersion', String(APP_VERSION));
    overlay.remove();
  });
  card.appendChild(ok);

  overlay.appendChild(card);
  document.body.appendChild(overlay);
}
maybeShowWhatsNew();

/* ===== GAS API wrapper ===== */
const GAS_URL = 'https://script.google.com/macros/s/AKfycbyYTZvZbkjD6nyPzaUIU20zqmGKl7POxrMbax657CwUnpkHPOeqvqkLwJsS2eUOZ6gbaw/exec';

async function gasCall(fn, params = {}, timeoutMs = 30000) {
  // Per-anrop-timeout (default 30s, oförändrat för alla anropare som inte
  // skickar timeoutMs): GAS cold-start kan ta ~10s, mobilnät-tap kan tappa
  // förbindelsen helt utan native error. Utan timeout hänger UI:n i evighet.
  // preload tål längre (full-scan 7-13s, ska SLUTFÖRAS ej abort:a+retry-storma)
  // → callsiten skickar 60000. Snabba skriv-anrop (logTag/updateMeta/cacheTs/
  // resync) behåller defaulten så de inte svälts av en långsam preload.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(GAS_URL, {
      method: 'POST',
      body: JSON.stringify({ fn, ...params }),
      redirect: 'follow',
      signal: ac.signal
    });
    if (!res.ok) throw new Error('Server error: ' + res.status);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Ogiltigt svar från servern');
    }
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Timeout — servern svarade inte inom ' + Math.round(timeoutMs / 1000) + 's');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Retry-wrapper för gasCall — för wifi/nät-instabilitet. Försöker upp till retries+1 gånger
// med exponential backoff. Retry:ar bara transient-fel (timeout, nätverk, server-error utan
// specifik orsak). Validation-fel (collision, ogiltig tag, saknad flik) returneras direkt
// utan retry. onAttempt-callback körs före varje försök så UI kan visa "försök N".
async function gasCallWithRetry(fn, params = {}, opts = {}) {
  const retries = opts.retries ?? 3;
  const backoff = opts.backoff ?? [800, 2000, 5000];
  const onAttempt = opts.onAttempt || (() => {});
  // Vidarebefordra ev. per-anrop-timeout; utelämnad → gasCall behåller sin
  // 30s-default (oförändrat beteende för alla nuvarande retry-anropare).
  const timeoutMs = opts.timeoutMs;
  let lastErr = '';
  for (let i = 0; i <= retries; i++) {
    onAttempt(i + 1, retries + 1);
    try {
      const res = timeoutMs == null ? await gasCall(fn, params) : await gasCall(fn, params, timeoutMs);
      // Success
      if (res?.ok) return res;
      // Specifika permanent-fel: returnera direkt utan retry
      if (res?.collision) return res;
      if (res?.msg && /Ogiltig|sheetName.*krävs|Flik finns inte|saknas/i.test(res.msg)) return res;
      lastErr = res?.msg || 'Okänt server-fel';
    } catch (err) {
      lastErr = err.message || String(err);
    }
    if (i < retries) {
      if (window.DEBUG_TAG) console.warn(`gasCallWithRetry ${fn} försök ${i+1} fail: ${lastErr}, retry om ${backoff[i]}ms`);
      await new Promise(r => setTimeout(r, backoff[i] || 1000));
    }
  }
  return { ok: false, msg: `Misslyckades efter ${retries+1} försök: ${lastErr}`, exhausted: true };
}

// Kastar om svaret har ok:false. Används för alla muterande anrop så att .then() inte
// råkar markera operationen som lyckad när servern faktiskt returnerade ett fel.
function assertOk(r) {
  if (r && r.ok === false) throw new Error(r.msg || r.error || 'Okänt serverfel');
  return r;
}

// Bug 2.7: skilj "nätfel/uttömt → ej bekräftat" från "servern avvisade → äkta fel".
// gasCallWithRetry returnerar {ok:false,exhausted:true} när alla försök misslyckats
// (offline kastar TypeError, fångas i dess catch → kastar ALDRIG vidare). Tidigare
// rullade linkTag tillbaka även detta → felet doldes helt (ingen gul, ingen ⚠️,
// success-banner redan visad). Nu: exhausted/nätfel → 'pending-retry' (behåll
// pendingSync, ⚠️, online-resync). Endast ÄKTA server-avvisning (collision /
// staleRow / valideringsfel UTAN exhausted) → 'rejected' (rollback som förr).
// Ren funktion — testbar utan DOM/nät.
function classifyLinkResult(r) {
  if (r && r.ok === true) return 'verified';
  if (r && (r.collision === true || r.staleRow === true)) return 'rejected';
  if (r && r.exhausted === true) return 'pending-retry';
  if (!r) return 'pending-retry';            // ingen res = nätfel innan svar
  // ok:false UTAN exhausted = servern svarade och avvisade (validering m.m.)
  return 'rejected';
}
// Success-bannern får INTE påstå framgång förrän verifierat. Callsites använder
// detta för att välja slut-UI: bara 'verified' → "Tag kopplad".
function shouldShowLinkSuccess(cls) { return cls === 'verified'; }

// #34: behållar-dialogens datumändring sparades tidigare ENDAST via en
// fire-and-forget change-handler (iOS-`change` opålitlig, closeDialog rev
// fältet, ingen appendLog, ingen verifiering). saveBtn hoppade dessutom helt
// förbi datum vid oförändrat saldo (`if (newCount === oldCount) return`).
// Ren beslutsfunktion: jämför aktuellt datumfält mot ORIGINALvärdet OCH mot
// senast committade värdet (no-double-commit om change-handlern redan sparat
// exakt samma värde). Returnerar vad som ska göras — DOM/nät-fritt, testbart.
//   origYMD          = artikelns datum när dialogen öppnades ("" om inget)
//   currentYMD       = vad fältet visar nu ("" = rensat → avinventera)
//   lastCommittedYMD = senaste värde vi FAKTISKT skickat (init = origYMD)
// → { action:'none' }                inget att göra (oförändrat ELLER redan committat)
// → { action:'set',   ymd }          datum ändrat → updateMeta lastYMD
// → { action:'clear' }               fältet rensat → clearTimestamp/avinventera
function decideDateCommit(origYMD, currentYMD, lastCommittedYMD) {
  const cur = String(currentYMD == null ? '' : currentYMD);
  const last = String(lastCommittedYMD == null ? '' : lastCommittedYMD);
  // Redan committat exakt detta värde (change-handlern hann före) → no-op.
  if (cur === last) return { action: 'none' };
  if (cur === '') return { action: 'clear' };
  return { action: 'set', ymd: cur };
}

// Pending tag-länkar som väntar på bekräftelse (ej bekräftade pga nätfel/uttömt).
// Nyckel = scannedTag. Värde = { scannedTag, sheetName, rowNum, currentTag, name }.
// Töms när online-resync lyckas (verified) eller servern äkta-avvisar (rejected).
const _pendingTagLinks = new Map();
// 9.6: pending logSingle-jobb (singel-registrering som inte bekräftades pga
// nätfel/uttömt). Tidigare visade logSingle "sparas när du är online igen"
// MEN registrerade jobbet ingenstans → resync:ades ALDRIG → meddelandet ljög.
// Samma resync-mekanism som _pendingTagLinks (selectPendingResync + EN online-
// /visibilitychange-listener + _inflight-guard) drar nu BÅDE map:arna. Nyckel
// = tag. Värde = { tag, name, sheetName, rowNum }. Self-delete vid
// verified/rejected; behålls om fortf. offline.
const _pendingLogSingle = new Map();
// Ren urvalsfunktion: vilka pending-länkar ska re-försökas vid online-event?
// Idempotent — returnerar bara poster som inte redan har ett aktivt re-försök.
function selectPendingResync(map) {
  const out = [];
  for (const [k, v] of (map instanceof Map ? map : new Map())) {
    if (v && !v._inflight) out.push({ key: k, job: v });
  }
  return out;
}

// 9.6: pending-jobben var enbart in-memory → iPhone dödar PWA i bakgrund =
// permanent tyst dataförlust av offline-skannade artiklar. Persistera bara
// data-fälten (EXKL _le DOM-nod / _inflight runtime) till localStorage;
// rehydrera vid init så en tidsdriven/visibilitychange-resync kan skicka dem.
const _PENDING_LS_KEY = 'vitaliseraPendingSync';
function _persistPending_() {
  try {
    const tagLinks = [];
    for (const v of _pendingTagLinks.values()) {
      if (v && v.scannedTag) tagLinks.push({
        scannedTag: v.scannedTag, sheetName: v.sheetName ?? null,
        rowNum: v.rowNum ?? null, currentTag: v.currentTag ?? null, name: v.name ?? ''
      });
    }
    const logSingle = [];
    for (const v of _pendingLogSingle.values()) {
      if (v && v.tag) logSingle.push({
        tag: v.tag, name: v.name ?? '', sheetName: v.sheetName ?? null, rowNum: v.rowNum ?? null
      });
    }
    if (!tagLinks.length && !logSingle.length) { localStorage.removeItem(_PENDING_LS_KEY); return; }
    localStorage.setItem(_PENDING_LS_KEY, JSON.stringify({ tagLinks, logSingle }));
  } catch (_) {}
}
function _rehydratePending_() {
  try {
    const raw = localStorage.getItem(_PENDING_LS_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d && Array.isArray(d.tagLinks)) for (const j of d.tagLinks) {
      if (j && j.scannedTag && !_pendingTagLinks.has(j.scannedTag)) _pendingTagLinks.set(j.scannedTag, j);
    }
    if (d && Array.isArray(d.logSingle)) for (const j of d.logSingle) {
      if (j && j.tag && !_pendingLogSingle.has(j.tag)) _pendingLogSingle.set(j.tag, j);
    }
  } catch (_) {}
}
_rehydratePending_();
if (QA_MODE) window.__qaPending = () => ({
  tagLinks: _pendingTagLinks.size,
  logSingle: _pendingLogSingle.size,
  tagLinksData: [..._pendingTagLinks.values()],
  logSingleData: [..._pendingLogSingle.values()]
});

/* ===== AI-assistenter =====
 * Backend tolererar att secret saknas (om AI_SHARED_SECRET inte satt i Script Properties).
 * localStorage-nyckel 'vitaliseraAiSecret' kan sättas manuellt av admin om skydd behövs.
 */
const _aiSuggestCache = new Map(); // 'name|place' → {category,unit,type}
const _aiSearchCache = new Map();  // query.lowercase → [{name,reason}]
function _aiGetSecret() { try { return localStorage.getItem('vitaliseraAiSecret') || ''; } catch (_) { return ''; } }

/* LATENSFIX: bygg distinkta kategorier-per-flik + cross-sheet-enheter ur den
 * data klienten REDAN har (tagCache.category + metaCache.unit, samma rådata som
 * preloadTags-payloaden backend annars loopar ~50+ Sheet-läsningar för).
 * Returnerar EXAKT samma struktur/sortering som backendens
 * _deriveCatsUnitsFromPreload_ (perSheet i första-sedd-ordning, kategorier &
 * enheter trim:ade, tomma bort, .sort() default-lexikografiskt = som
 * _distinctCol_). Skickas till aiSuggest så no-place-grenen kan HOPPA loopen.
 * Tom (cold cache före preload) → returnera null → backend kör sin fallback. */
function _collectAiDistinct() {
  if (!tagCache.size) return null;
  const catBySheet = {};      // sheet -> Set(kategori)
  const sheetOrder = [];      // bevara första-sedd-ordning
  const unitSet = new Set();
  for (const v of tagCache.values()) {
    const sheet = String(v?.sheetName || v?.place || '');
    if (!(sheet in catBySheet)) { catBySheet[sheet] = new Set(); sheetOrder.push(sheet); }
    const cat = String(v?.category || '').trim();
    if (cat) catBySheet[sheet].add(cat);
  }
  for (const m of metaCache.values()) {
    const u = String(m?.unit || '').trim();
    if (u) unitSet.add(u);
  }
  // .sort() utan komparator = samma ordning som backendens [...set].sort()
  const perSheet = sheetOrder.map(s => ({
    sheet: s,
    categories: [...catBySheet[s]].sort()
  }));
  const allUnits = [...unitSet].sort();
  if (!perSheet.length && !allUnits.length) return null;
  return { perSheet, allUnits };
}

async function aiSuggest(name, place) {
  const n = (name || '').trim();
  const p = (place || '').trim();
  if (n.length < 3) return null;
  const key = n.toLowerCase() + '|' + p.toLowerCase();
  if (_aiSuggestCache.has(key)) return _aiSuggestCache.get(key);
  try {
    const params = { name: n, place: p, secret: _aiGetSecret() };
    // Bara relevant för no-place-grenen (cross-sheet). Skicka ändå alltid när
    // vi har data — backend ignorerar fältet i place-grenen.
    if (!p) {
      const d = _collectAiDistinct();
      if (d) { params.categories = d.perSheet; params.units = d.allUnits; }
    }
    const res = await gasCall('aiSuggest', params);
    if (res && res.ok) { _aiSuggestCache.set(key, res); return res; }
  } catch (_) {}
  return null;
}

async function aiSearch(query, candidates) {
  const q = (query || '').trim();
  if (!q || !Array.isArray(candidates) || !candidates.length) return null;
  const key = q.toLowerCase();
  if (_aiSearchCache.has(key)) return _aiSearchCache.get(key);
  try {
    const res = await gasCall('aiSearch', { query: q, candidates, secret: _aiGetSecret() });
    if (res && res.ok && Array.isArray(res.results)) {
      _aiSearchCache.set(key, res.results);
      return res.results;
    }
  } catch (_) {}
  return null;
}

function markLogFail(le, err) {
  if (!le) return;
  const icon = le.querySelector(".icon"); if (icon) icon.textContent = "⚠️";
  const msg = le.querySelector(".msg");
  if (msg) msg.textContent += " – " + (err?.message || 'fel');
  show("Kunde inte spara", "warn");
}

/* ===== Utils ===== */
const qs=(s,p=document)=>p.querySelector(s), qsa=(s,p=document)=>Array.from(p.querySelectorAll(s));
const normTag=x=>{const s=String(x||"").trim();return s.startsWith("S")?s:s.replace(/[^\d]/g,"");};
// Escape för säker interpolation i innerHTML — Sheet-data kan innehålla <, >, ", ', &.
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Preferenser för ikoner i listan (togglas i Inställningar-dialogen).
const prefs = {
  iconTag:     localStorage.getItem('vitaliseraIconTag')     === 'true',
  iconType:    localStorage.getItem('vitaliseraIconType')    === 'true',
  iconComment: localStorage.getItem('vitaliseraIconComment') !== 'false' // default true
};

function renderRowIcons(t, item, hasComment) {
  const out = [];
  if (prefs.iconTag && !t.startsWith('S')) out.push('<span class="rowIcon">🏷️</span>');
  if (prefs.iconType && item.type === 'singel') out.push('<span class="rowIcon">•</span>');
  if (prefs.iconComment && hasComment) {
    out.push(`<span class="infoIcon" data-tag="${t}">ℹ️</span>`);
  }
  return out.length ? ' ' + out.join('') : '';
}

// Checksum-validering per format. ZXing:s Reed-Solomon skyddar QR/Data Matrix
// inbyggt; för 1D-streckkoder gör vi extra validering mot fel-läsningar i
// dåligt ljus som råkar matematiskt likna en annan giltig kod.
function isValidEAN13(code) {
  if (!/^\d{13}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(code[i]) * (i % 2 === 0 ? 1 : 3);
  return ((10 - (sum % 10)) % 10) === Number(code[12]);
}
function isValidUPCA(code) {
  if (!/^\d{12}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += Number(code[i]) * (i % 2 === 0 ? 3 : 1);
  return ((10 - (sum % 10)) % 10) === Number(code[11]);
}
function isValidEAN8(code) {
  if (!/^\d{8}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(code[i]) * (i % 2 === 0 ? 3 : 1);
  return ((10 - (sum % 10)) % 10) === Number(code[7]);
}

// Mappa zxing-format-enum (number eller string) till routing-key.
function formatName(fmt) {
  if (fmt == null) return null;
  if (typeof fmt === 'string') return fmt;
  // BarcodeFormat-enum kan vara number — slå upp namnet via ZXing-globalen.
  try {
    const bf = (typeof ZXing !== 'undefined') ? ZXing.BarcodeFormat : null;
    if (bf) {
      for (const k of Object.keys(bf)) if (bf[k] === fmt) return k;
    }
  } catch {}
  return String(fmt);
}

// Multi-frame-konsensus: kräv samma kod 2 gånger inom 3 sekunder innan accept.
// Bara för 1D-streckkoder. QR/Data Matrix bypassas i acceptScan() eftersom
// Reed-Solomon-koden inom dem redan ger garanterad integritet.
const _scanConsensus = { code: null, ts: 0 };
const SCAN_CONSENSUS_TIMEOUT_MS = 3000;
function passesScanConsensus(code) {
  const now = Date.now();
  if (_scanConsensus.code === code && now - _scanConsensus.ts < SCAN_CONSENSUS_TIMEOUT_MS) {
    _scanConsensus.code = null;
    _scanConsensus.ts = 0;
    return true;
  }
  _scanConsensus.code = code;
  _scanConsensus.ts = now;
  return false;
}

// ZXing decode-hints: tidigare aktiverade vi TRY_HARDER men det visade sig
// blockera JS-tråden så att laser-animationen släpade och zxing inte hittade
// koder alls i komplexa scener. Konsensus + lookupByTag-bypass räcker som
// skydd mot felläsningar — vi kör default-hints (snabbare).
function _zxingHints() {
  return undefined;
}

// Per-format checksum + konsensus där det behövs.
// QR_CODE/DATA_MATRIX/AZTEC/PDF_417 har inbyggd Reed-Solomon-felkorrigering;
// zxing returnerar bara dem efter att RS-validation passerat → vi accepterar
// direkt utan konsensus så användaren får snabb feedback.
const _selfValidatingFormats = new Set(['QR_CODE', 'DATA_MATRIX', 'AZTEC', 'PDF_417']);
function acceptScan(code, format) {
  const fn = formatName(format);
  if (fn === 'EAN_13' && !isValidEAN13(code)) return false;
  if (fn === 'UPC_A' && !isValidUPCA(code)) return false;
  if (fn === 'EAN_8' && !isValidEAN8(code)) return false;
  // Format okänt → fall tillbaka på sifferlängd-heuristik
  if (!fn) {
    if (/^\d{13}$/.test(code) && !isValidEAN13(code)) return false;
    if (/^\d{12}$/.test(code) && !isValidUPCA(code)) return false;
    if (/^\d{8}$/.test(code) && !isValidEAN8(code)) return false;
  }
  if (_selfValidatingFormats.has(fn)) return true;
  // Känd tag = redan kopplad till en produkt → ingen risk för fel-koppling.
  // Accept direkt utan konsensus så användaren får snabb feedback.
  // Konsensus krävs bara för OKÄNDA koder (potentiella felläsningar som
  // annars skulle öppna "Koppla till befintlig?"-dialog felaktigt).
  if (lookupByTag(code)) return true;
  return passesScanConsensus(code);
}

// Slår upp en skannad tag i tagCache — primär nyckel först, sedan altTags linjärt.
// Fallback: gsheets tappar ledande nollor i TAG-celler ("01234" → 1234). Om exakt
// match miss:ar, jämför numeriskt (utan ledande 0:or) så skadade tags fångas.
function lookupByTag(scanned) {
  if (tagCache.has(scanned)) return { tag: scanned, item: tagCache.get(scanned) };
  for (const [primary, item] of tagCache.entries()) {
    if (item.altTags && item.altTags.includes(scanned)) return { tag: primary, item };
  }
  const scannedNum = scanned.replace(/^0+/, '') || '0';
  if (scannedNum === scanned) return null;
  for (const [primary, item] of tagCache.entries()) {
    if ((primary.replace(/^0+/, '') || '0') === scannedNum) return { tag: primary, item };
    if (item.altTags) {
      for (const t of item.altTags) {
        if ((String(t).replace(/^0+/, '') || '0') === scannedNum) return { tag: primary, item };
      }
    }
  }
  return null;
}
const fmtDate=t=>{try{if(!t)return"";const d=new Date(t);return isNaN(d)?"":d.toLocaleDateString("sv-SE");}catch{return"";}};
const toDayMs=ms=>{if(!ms)return null;const d=new Date(ms);d.setHours(0,0,0,0);return d.getTime();};
const toDayStr=ms=>ms?new Date(ms).toLocaleDateString("sv-SE"):"";
const parseLocalYMD=str=>{const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(str||"");if(!m)return NaN;const d=new Date(+m[1],+m[2]-1,+m[3]);d.setHours(0,0,0,0);return d.getTime();};
const normPlace=p=>{const v=(p??"").toString().trim();return v?v:"Okänd";};
function renderLinkified(el, s) {
  el.textContent = "";
  const re = /(https?:\/\/[^\s]+)/g;
  let pos = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > pos) el.append(document.createTextNode(s.slice(pos, m.index)));
    const a = document.createElement("a");
    a.href = m[0]; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = m[0];
    el.append(a);
    pos = m.index + m[0].length;
  }
  if (pos < s.length) el.append(document.createTextNode(s.slice(pos)));
}
const INVENTORY_WINDOW_DAYS = 5;

/* ===== DOM ===== */
const v=qs('#preview'), s=qs('#status'), logList=qs('#logList'),
listInv=qs('#listInventerat'), listEj=qs('#listEj'), overlay=qs('#overlay'),
scanBox=qs('#scanBox'), startBtn=qs('#startBtn'), settingsBtn=qs('#settingsBtn'),
sound=qs('#successSound'), blip=qs('#blipSound'),
dlg=qs('#dialogBox'), dlgTitle=qs('#dialogTitle'), dlgInfo=qs('#dialogInfo'),
dlgInput=qs('#dialogInput'), dlgInputWrap=qs('#dialogInputWrap'), dlgInputSuffix=qs('#dialogInputSuffix'), dlgBtns=qs('#dialogBtns'),
newItemFields=qs('#newItemFields'), manualName=qs('#manualName'),
manualType=qs('#manualType'), manualQty=qs('#manualQty'),
nameDialog=qs('#nameDialog'), userNameInput=qs('#userNameInput'), saveNameBtn=qs('#saveNameBtn'),
settingsDialog=qs('#settingsDialog'), placeList=qs('#placeList'),
applySettingsBtn=qs('#applySettingsBtn'), toggleAllPlacesBtn=qs('#toggleAllPlacesBtn'), cancelSettingsBtn=qs('#cancelSettingsBtn'),
searchFab=qs('#searchFab'), searchDialog=qs('#searchDialog'),
searchInput=qs('#searchInput'), searchResults=qs('#searchResults'), closesearchFab=qs('#closesearchFab');

// Tidig kontroll: visa namn-dialog direkt om ej sparat namn
setTimeout(() => ensureName(() => {}), 0);

/* ===== STATE ===== */
let reader,lastCode="",userName=null,lastCamera=null;
let busy=false,preloadDone=false,cameraOn=false;
const tagCache=new Map(),metaCache=new Map();const placeSet=new Set();
let maxLastMs=null;const COOLDOWN_MS=1200;let activePlaces=null;
let activeSteps=null;  // null = alla steg synliga, Set<string> = bara dessa
let onlyLow=false;
let showUnit=false;
let hideZero=false;
let hideMin=false;
let hasStarted = false;
let cameraVisible = false;
let visibleTags = [];
let currentDialogTag = null;
let extraFieldsExpanded = false;
let invertGroups = localStorage.getItem('vitaliseraInvertGroups') === '1';
let groupByCategory = localStorage.getItem('vitaliseraGroupByCategory') === '1';
let groupByPlace = localStorage.getItem('vitaliseraGroupByPlace') === '1';

/* ===== Status ===== */
function statusDefault(){
  s.className = "";
  if (cameraVisible && cameraOn) s.textContent = "Skannar…";
  else if (hasStarted && !cameraVisible) s.textContent = "Välj artikel i listan";
  else s.textContent = "Välj artikel i listan";
}
function show(msg,cls,{autoreset=true,delay=2500}={}){s.className=cls||"";s.textContent=msg;clearTimeout(show._t);if(autoreset)show._t=setTimeout(()=>statusDefault(),delay);}

/* ===== Kamera-visning ===== */
// Fokus-cykler: tvinga kameran att periodiskt fokusera nära så vi inte är
// beroende av att iOS auto-focus själv detekterar att streckkoden är 5cm bort.
let _backCameras = [];     // Cachelista av back-kameror (för iPhone Pro lins-cykling)
let _backCamIndex = 0;     // Index i _backCameras

// Filtrera fram back-kameror och sortera så ultrawide kommer först (makro-stöd
// på iPhone 13 Pro+ gör att den fokuserar på 2-14cm — perfekt för streckkoder).
function pickBackCameras(cams) {
  const back = (cams || []).filter(d =>
    !/front|user/i.test(d.label || '') &&
    (/back|rear|environment|bak/i.test(d.label || '') || cams.length === 1)
  );
  // Om ingen explicit back finns: fall tillbaka på alla
  const list = back.length ? back : (cams || []);
  // Sortering: ultrawide först (makro), sedan wide, sedan telephoto
  return list.slice().sort((a, b) => {
    const score = d => {
      const l = (d.label || '').toLowerCase();
      if (/ultra\s*wide|ultrawide/i.test(l)) return 0;
      if (/telephoto/i.test(l)) return 2;
      return 1;
    };
    return score(a) - score(b);
  });
}
// Tidigare hade vi en focus-cykler som växlade mellan continuous/manual-near/manual-medium
// var 1.2s. Den syntes som visuell hop när bilden re-fokuserade och hjälpte inte
// ändå (iOS ignorerar manual focus). Center-focus-hint via pointsOfInterest=(0.5,0.5)
// vid kamera-start räcker.
function startFocusCycler() { /* no-op — behållen för API-kompatibilitet */ }
function stopFocusCycler() { /* no-op */ }

// Visa/dölj lens-knappen baserat på antal back-kameror
function updateLensSwitchVisibility() {
  const btn = qs('#lensSwitchBtn');
  if (!btn) return;
  if (_backCameras.length > 1) btn.classList.remove('hidden');
  else btn.classList.add('hidden');
}

// Cycle till nästa back-kamera. Restartar reader med ny deviceId.
async function cycleBackCamera() {
  if (_backCameras.length < 2) return;
  _backCamIndex = (_backCamIndex + 1) % _backCameras.length;
  const next = _backCameras[_backCamIndex];
  lastCamera = next;
  const lensName = (next.label || '').match(/ultra\s*wide|wide|telephoto/i)?.[0] || `lins ${_backCamIndex + 1}`;
  show(`Bytte till ${lensName}`, 'ok');
  // Restart aktuell scan-flow med nya kameran
  if (tagScanCallback) {
    try { reader?.reset(); } catch {}
    stopFocusCycler();
    await startTagCamera();
  } else if (cameraOn) {
    try { reader?.reset(); } catch {}
    stopFocusCycler();
    await startCamera();
  }
}
qs('#lensSwitchBtn')?.addEventListener('click', cycleBackCamera);

function getActiveTrack() {
  return v.srcObject?.getVideoTracks?.()[0] || null;
}

// Canvas-crop-decoder: parallell decode-loop som drar scanBox-regionen från video
// till en canvas i full sensor-upplösning. Ger ZXing en MINDRE bild med fler
// pixlar per streckkod-bredd → bättre detection på små/små-skarpa koder än
// att försöka tolka hela video-frame:n. Optisk zoom är inte möjlig i web-API,
// men crop ger samma effekt som "digital crop på sensor"-data utan upscaling.
let _cropDecodeStop = null;
function startCropDecode(onResult) {
  stopCropDecode();
  // @zxing/library@0.20.0 har INTE decodeFromCanvas. Vi bygger BinaryBitmap
  // manuellt via HTMLCanvasElementLuminanceSource → HybridBinarizer → decodeBitmap.
  if (typeof ZXing === 'undefined' ||
      !reader?.decodeBitmap ||
      !ZXing.HTMLCanvasElementLuminanceSource ||
      !ZXing.HybridBinarizer ||
      !ZXing.BinaryBitmap) return;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let stopped = false;

  // Rotations-cykling: ZXing's 1D-decoder vill ha streckkoder horisontellt.
  // Vi roterar canvas-bilden i flera vinklar per tick så streckkoder som
  // hålls snett (15°, 30° etc.) ändå kan tolkas. Diagonal canvas-storlek
  // så streckkoden inte cliper vid 45°.
  const rotations = [0, 15, 30, 45, 60, 75, 90]; // grader — finare täckning för sneda streckkoder
  async function tick() {
    if (stopped) return;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (vw && vh) {
      // Crop till mitten 70% × 50% (matchar scanBox-rutan visuellt)
      const cropW = Math.floor(vw * 0.7);
      const cropH = Math.floor(vh * 0.5);
      const cropX = Math.floor((vw - cropW) / 2);
      const cropY = Math.floor((vh - cropH) / 2);
      const diag = Math.ceil(Math.sqrt(cropW * cropW + cropH * cropH));
      if (canvas.width !== diag) canvas.width = diag;
      if (canvas.height !== diag) canvas.height = diag;

      let result = null;
      for (const deg of rotations) {
        if (stopped) return;
        try {
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, diag, diag);
          ctx.save();
          ctx.translate(diag / 2, diag / 2);
          if (deg) ctx.rotate(deg * Math.PI / 180);
          ctx.drawImage(v, cropX, cropY, cropW, cropH, -cropW / 2, -cropH / 2, cropW, cropH);
          ctx.restore();
          const lum = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
          const bin = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(lum));
          const r = reader.decodeBitmap(bin);
          if (r) { result = r; break; } // första träff vinner
        } catch {
          // NotFoundException är normalt
        }
      }

      if (result && !stopped && onResult) {
        const fmt = result.getBarcodeFormat ? result.getBarcodeFormat() : result.barcodeFormat;
        onResult({
          text: result.getText ? result.getText() : (result.text || ''),
          resultPoints: [],
          barcodeFormat: fmt
        });
      }
    }
    if (!stopped) setTimeout(tick, 150); // 4 rotations × 150ms = ~6fps total
  }
  tick();
  _cropDecodeStop = () => { stopped = true; };
}
function stopCropDecode() {
  if (_cropDecodeStop) { _cropDecodeStop(); _cropDecodeStop = null; }
}

// Tap-to-focus: tappa i preview för att fokusera där. Fungerar där iOS exponerar
// pointsOfInterest + focusMode='single-shot'.
v?.addEventListener('click', e => {
  const track = getActiveTrack();
  if (!track || !track.applyConstraints) return;
  const rect = v.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  track.applyConstraints({
    advanced: [{ pointsOfInterest: [{ x, y }], focusMode: 'single-shot' }]
  }).catch(() => {});
});

function hideCamera(){
  stopFocusCycler();
  stopCropDecode();
  qs('#lensSwitchBtn')?.classList.add('hidden');
  // Göm snap-FAB + ev. AI-notice när kameran stängs
  const $snap = qs('#snapBtn');
  if ($snap) { $snap.classList.remove('show'); setTimeout(() => $snap.classList.add('hidden'), 280); }
  if (window.vision && window.vision.hideVisionNotice) window.vision.hideVisionNotice();
  try{ reader && reader.reset(); }catch{}
  try{
    const so = v.srcObject;
    if (so){ so.getTracks?.forEach(t=>t.stop()); v.srcObject = null; }
  }catch{}
  try{ v.pause(); }catch{}
  cameraOn = false;
  cameraVisible = false;
  qs('#cameraBox')?.classList.add('hidden');
  startBtn.textContent = "📷 Skanna";
  statusDefault();
}

async function showCamera(){
  qs('#cameraBox')?.classList.remove('hidden');
  cameraVisible = true;
  startBtn.textContent = "Dölj skanner";
  // Fäll upp snap-FAB ovanför Dölj skanner — växer fram med RAF för smooth animation
  const $snap = qs('#snapBtn');
  if ($snap) {
    $snap.classList.remove('hidden');
    requestAnimationFrame(() => $snap.classList.add('show'));
  }
  // Force-restart laser-animation. iOS Safari startar inte alltid CSS-animations
  // automatiskt när elementet just blivit synligt — utan en reflow ligger den
  // pausad tills första style-mutation (flashFeedback) väcker den.
  const laser = qs('#scanLaser');
  if (laser) {
    laser.style.animation = 'none';
    void laser.offsetHeight;
    laser.style.animation = '';
    laser.style.animationPlayState = 'running';
  }
  if (!cameraOn){ await startCamera(); }
  statusDefault();
}

/* ===== Prevent zoom on camera area ===== */
(function(){const area=qs('#cameraBox');if(!area)return;const opts={passive:false};
['gesturestart','gesturechange','gestureend'].forEach(ev=>area.addEventListener(ev,e=>e.preventDefault(),opts));
let last=0;area.addEventListener('touchend',e=>{const now=Date.now();if(now-last<300){e.preventDefault();}last=now;},opts);})();

/* ===== Audio ===== */
let actx=null;
function ensureAudioCtx(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();if(actx.state==='suspended')actx.resume();}catch{}}
// Systembolaget-stil scanner-bip: brus-transient + triangle-ton med svag pitch-down.
// Två lager — den 10ms-långa bandpass-filtrade brus-transienten ger den karakteristiska
// "klick"-attacken som riktiga POS-scanners har; triangle-tonen 1800→1720Hz under 140ms
// ger den varmare följande tonen.
function beep() {
  if (!actx) return false;
  try {
    const ctx = actx;
    const t0 = ctx.currentTime + 0.001;

    // Brus-transient — kort vit-brus genom bandpass 3200Hz för "klick"-attack
    const noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.05), ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuf;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 3200;
    noiseFilter.Q.value = 4;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.0001, t0);
    noiseGain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.002);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.010);
    noiseSrc.connect(noiseFilter).connect(noiseGain).connect(ctx.destination);
    noiseSrc.start(t0);
    noiseSrc.stop(t0 + 0.02);

    // Ton — triangle 1800→1720Hz, lowpass 5500Hz, 140ms exp-decay
    const tonStart = t0 + 0.006;
    const dur = 0.140;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1800, tonStart);
    osc.frequency.exponentialRampToValueAtTime(1720, tonStart + dur);

    filter.type = 'lowpass';
    filter.frequency.value = 5500;
    filter.Q.value = 0.7;

    gain.gain.setValueAtTime(0.0001, tonStart);
    gain.gain.exponentialRampToValueAtTime(0.38, tonStart + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, tonStart + dur);

    osc.connect(filter).connect(gain).connect(ctx.destination);
    osc.start(tonStart);
    osc.stop(tonStart + dur + 0.02);

    return true;
  } catch { return false; }
}
async function flashFeedback(txt){try{ensureAudioCtx();if(!beep()){blip.currentTime=0;await blip.play();}}catch{}show(txt);const laser=qs('#scanLaser');if(laser)laser.style.animationPlayState="paused";try{v.pause();}catch{}overlay.classList.add('flashOverlay');await new Promise(r=>setTimeout(r,900));overlay.classList.remove('flashOverlay');try{v.play();}catch{}if(laser)laser.style.animationPlayState="running";}
// Stor, animerad ✓-bekräftelse vid singel-skan. Transient element i #overlay
// (samma infrastruktur som scanBox/flashOverlay), pointer-events:none → blockerar
// inte nästa skan. CSS-animationen tar bort den visuellt efter ~1.2s; vi rensar
// DOM-noden efter 1400ms. Idempotent: ev. tidigare nod tas bort först.
function showSingelConfirm(name){
  try{
    if(!overlay) return;
    const prev=overlay.querySelector('.singelConfirm'); if(prev) prev.remove();
    const el=document.createElement('div');
    el.className='singelConfirm';
    el.innerHTML='<div class="scCheck"><svg viewBox="0 0 100 100" aria-hidden="true">'
      +'<path d="M22 52 L42 72 L78 30"/></svg></div>'
      +'<div class="scLabel">'+esc(name||'Artikel')+' inventerad</div>';
    overlay.appendChild(el);
    setTimeout(()=>{ try{ el.remove(); }catch{} },1400);
  }catch{}
}
// Stark OMEDELBAR "fångad"-signal vid skan-singel-autoregister. Visas direkt
// (ej på server-svar) → användaren ser tydligt att skanningen registrerats utan
// att skanna 15 ggr. Fryser kameran ~2500ms (kvarliggande tagg kan ej re-fyra
// under frysen) och visar artikelnamnet stort. "Registrerad – sparas" är ärligt:
// optimistisk + köad write (v126/v129-pipelinen levererar); genuint serverfel
// syns ändå via Save.logSingle:s ⚠️/historik. Visuellt skild från showSingelConfirm
// (egen klass .singelCaptured). pointer-events:none → blockerar ej tap.
async function showSingelCaptured(name){
  const laser=qs('#scanLaser');
  try{
    if(overlay){
      const prev=overlay.querySelector('.singelCaptured'); if(prev) prev.remove();
      const el=document.createElement('div');
      el.className='singelCaptured';
      el.innerHTML='<div class="sgcName">'+esc(name||'Artikel')+'</div>'
        +'<div class="sgcSub">✓ Registrerad – sparas</div>';
      overlay.appendChild(el);
    }
    if(laser)laser.style.animationPlayState="paused";
    try{v.pause();}catch{}
    await new Promise(r=>setTimeout(r,2500));
  }catch{}
  finally{
    try{v.play();}catch{}
    if(laser)laser.style.animationPlayState="running";
    try{ const el=overlay&&overlay.querySelector('.singelCaptured'); if(el) el.remove(); }catch{}
  }
}
const cooldown=(t,ms=COOLDOWN_MS)=>{lastCode=t;setTimeout(()=>{ if(lastCode===t) lastCode=""; },ms);};
const dialogOpen=()=>!dlg.classList.contains('hidden')||!nameDialog.classList.contains('hidden')||!settingsDialog.classList.contains('hidden')||!searchDialog.classList.contains('hidden');

/* ===== Logg ===== */
const MAX_LOG = 5;
const undoData = new Map();
const UNDO_WINDOW_MS = 15000;

function appendLog(msg, tag, icon = "⏳") {
  const e = document.createElement("button");
  e.type = "button";
  e.className = "logEntry clickable";
  e.innerHTML = `<span class="icon">${esc(icon)}</span><span class="msg">${esc(msg)}</span>`;
  e.onclick = () => openContainerForTag(tag);
  logList.prepend(e);
  while (logList.children.length > MAX_LOG) logList.removeChild(logList.lastChild);
  // Visa toggle-knappen så snart vi har minst en logg-post
  const tog = qs('#logToggleBtn');
  if (tog) tog.classList.remove('hidden');
  return e;
}

// Toggle-knapp för historik (default kollapsad)
qs('#logToggleBtn')?.addEventListener('click', () => {
  const list = qs('#logList');
  const tog = qs('#logToggleBtn');
  if (!list || !tog) return;
  const collapsed = list.classList.toggle('collapsed');
  tog.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  tog.textContent = collapsed ? '▾ Historik' : '▴ Historik';
});
function markAsDone(e) {
  const icon = e.querySelector(".icon");
  const msg  = e.querySelector(".msg");
  icon.textContent = "✅";
  msg.textContent = msg.textContent.replace("uppdateras", "uppdaterad");
}
function addUndoButton(logEntry, tag, prevOverride) {
  const cached = tagCache.get(tag);
  // prevOverride = FÖREGÅENDE meta-snapshot taget SYNKRONT av callern
  // FÖRE den optimistiska setLocalMeta (logSingle:_undoPrev). Krävs för
  // att undo ska återställa artikelns FAKTISKA tidigare tidsstämpel —
  // metaCache här innehåller redan det NYSS satta (dagens) värdet.
  // Fallback till metaCache bara om ingen snapshot skickades (bakåtkompat).
  const meta = prevOverride || metaCache.get(tag) || {};
  const prev = { lastMs: meta.lastMs ?? null, user: meta.user || "", sheetName: cached?.sheetName, rowNum: cached?.rowNum };
  undoData.set(tag, prev);

  const undoBtn = document.createElement("span");
  undoBtn.className = "undoLink";
  undoBtn.textContent = "Ångra";
  undoBtn.onclick = (ev) => {
    ev.stopPropagation();
    setLocalMeta(tag, { lastMs: prev.lastMs || null, user: prev.user || "" });
    recomputeMaxLast();
    renderLists();
    const payload = { clearUser: true, userName: prev.user || "", sheetName: prev.sheetName, rowNum: prev.rowNum };
    if (prev.lastMs) {
      const d = new Date(prev.lastMs);
      payload.lastYMD = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    } else {
      payload.clearTimestamp = true;
    }
    // D (samma klass): tidigare fire-and-forget — svaret observerades ALDRIG.
    // Anropsformen {tag,args:payload} ÄR korrekt (doPost: updateMeta(body.tag,
    // body.args), identiskt med övriga 7 callsites — promptens "fel form"-
    // premiss stämde ej). Den ÄKTA defekten: ångra kunde tyst misslyckas men
    // visa "Ångrad". Nu verifierat via classifyLinkResult (samma sanningskälla
    // som linkTag/logSingle): ej-verifierat → ⚠️ på raden, ingen falsk success.
    const icon = logEntry.querySelector(".icon");
    if (icon) icon.textContent = "↩️";
    const msg = logEntry.querySelector(".msg");
    if (msg) msg.textContent = msg.textContent.replace("uppdaterad", "ångrad");
    undoBtn.remove();
    undoData.delete(tag);
    show("Ångrad", "warn");
    gasCallWithRetry('updateMeta', {tag, args: payload})
      .then(res => {
        if (classifyLinkResult(res) !== 'verified') {
          if (icon) icon.textContent = '⚠️';
          if (msg) msg.textContent += ' – ångra ej bekräftad';
          show("Ångra kunde inte bekräftas", "warn");
        }
      })
      .catch(err => {
        if (icon) icon.textContent = '⚠️';
        if (msg) msg.textContent += ' – ' + (err?.message || 'fel');
        show("Ångra kunde inte bekräftas", "warn");
      });
  };
  logEntry.appendChild(undoBtn);
  setTimeout(() => {
    undoBtn.remove();
    undoData.delete(tag);
  }, UNDO_WINDOW_MS);
}

/* ===== Save — funktion-grupperat objekt för spara-flöden =====
 * Tunn helper: hanterar appendLog + cache-mutation + gasCallWithRetry + rollback + markAsDone.
 * UI-side-effects (closeDialog, cooldown, renderLists, show/setMsg, DOM-update) sköts av callern.
 */
const Save = {
  /**
   * Koppla en skannad tag till en befintlig artikelrad.
   *
   * Hanterar två varianter automatiskt baserat på currentTag-prefix:
   *   - Befintlig artikel (currentTag = numerisk tag): optimistisk altTags-push,
   *     rollback vid fail.
   *   - Syntetisk artikel (currentTag startsWith 'S'): ingen optimistic; vid
   *     success byts cache-nyckeln S* → res.tag och metaCache flyttas.
   *
   * target: { name, sheetName, rowNum, currentTag }
   * returnerar: { ok, tag?, res?, err?, le, collision?, alreadyPresent? }
   */
  async linkTag(scannedTag, target) {
    const { name, sheetName, rowNum, currentTag } = target;
    const isSynthetic = String(currentTag || '').startsWith('S');
    const le = appendLog(`${name} – tag ${scannedTag} kopplas`, currentTag);

    if (!isSynthetic) {
      const oldData = tagCache.get(currentTag);
      if (oldData) tagCache.set(currentTag, {
        ...oldData,
        altTags: [...(oldData.altTags || []), scannedTag],
        pendingSync: true
      });
    }

    // Hjälpare: registrera EJ-bekräftad länk för online-resync + behåll pending.
    // Återanvänds av både catch (oväntat throw) och exhausted-fail-pathen.
    const _markPendingRetry = (msgTail) => {
      // BEHÅLL pendingSync:true + scannedTag i altTags (optimistiskt, men pending).
      // Ingen rollback → renderLists gulmarkerar raden (pendingSync-CSS).
      if (!isSynthetic) {
        const cur = tagCache.get(currentTag);
        if (cur) tagCache.set(currentTag, {
          ...cur,
          altTags: (cur.altTags || []).includes(scannedTag)
            ? (cur.altTags || [])
            : [...(cur.altTags || []), scannedTag],
          pendingSync: true
        });
      }
      _pendingTagLinks.set(scannedTag, { scannedTag, sheetName, rowNum, currentTag, name });
      _persistPending_();
      if (le) {
        const ic = le.querySelector('.icon'); if (ic) ic.textContent = '⚠️';
        const m = le.querySelector('.msg');
        if (m) m.textContent = `${name} – ej bekräftat – försöker igen${msgTail ? ' (' + msgTail + ')' : ''}`;
      }
    };

    let res;
    try {
      res = await gasCallWithRetry('addTag',
        { sheetName, rowNum, newTag: scannedTag },
        { onAttempt: (n, total) => {
            if (n > 1 && le) le.querySelector('.msg').textContent =
              `${name} – tag ${scannedTag} kopplas (försök ${n}/${total})`;
          } }
      );
    } catch (err) {
      // gasCallWithRetry kastar normalt INTE (returnerar {exhausted}). Ett throw
      // här = oväntat (ej server-avvisning) → behandla som ej-bekräftat, ej rollback.
      _markPendingRetry();
      return { ok: false, pending: true, err, le };
    }

    if (res && res.ok) {
      if (isSynthetic) {
        const oldData = tagCache.get(currentTag);
        if (oldData) {
          tagCache.delete(currentTag);
          tagCache.set(res.tag, {
            ...oldData,
            sheetName: null,
            rowNum: null,
            altTags: oldData.altTags || [],
            pendingSync: false
          });
          const oldMeta = metaCache.get(currentTag);
          if (oldMeta) { metaCache.delete(currentTag); metaCache.set(res.tag, oldMeta); }
        }
      } else {
        const cur = tagCache.get(currentTag);
        if (cur) tagCache.set(currentTag, { ...cur, pendingSync: false });
      }
      _pendingTagLinks.delete(scannedTag); // bekräftat → ej längre pending
      _persistPending_();
      markAsDone(le);
      return { ok: true, tag: res.tag, alreadyPresent: !!res.alreadyPresent, le };
    }

    // Fail-path: skilj "ej bekräftat (nätfel/uttömt)" från "äkta avvisat".
    const cls = classifyLinkResult(res);
    if (cls === 'pending-retry') {
      // Offline/uttömt: BEHÅLL pending, ⚠️, registrera för online-resync.
      // Ingen rollback → felet döljs INTE (gul rad + ⚠️ + ingen success-banner).
      _markPendingRetry();
      return { ok: false, pending: true, res, le };
    }

    // Äkta server-avvisning (collision / staleRow / valideringsfel UTAN exhausted)
    // → rollback exakt som förr. scannedTag tillhör inte denna rad.
    _pendingTagLinks.delete(scannedTag);
    _persistPending_();
    if (!isSynthetic) {
      const cur = tagCache.get(currentTag);
      if (cur) tagCache.set(currentTag, {
        ...cur,
        altTags: (cur.altTags || []).filter(t => t !== scannedTag),
        pendingSync: false
      });
    }
    const failMsg = res && res.collision
      ? `redan kopplad till "${res.existingName}"`
      : ((res && res.msg) || 'misslyckades');
    if (le) {
      const ic = le.querySelector('.icon'); if (ic) ic.textContent = '⚠️';
      le.querySelector('.msg').textContent = `${name} – ${failMsg}`;
    }
    return { ok: false, res, le, collision: !!(res && res.collision) };
  },

  /**
   * Registrera en singel-artikel som inventerad (qty 1, dagens datum, ditt namn).
   *
   * Konsoliderar det identiska mönstret från 4 callsites:
   * appendLog + show + logTag + assertOk + markAsDone + addUndoButton +
   * markLogFail + optimistisk setLocalMeta + recomputeMaxLast + renderLists.
   *
   * Fire-and-then (ej await): UI uppdateras optimistiskt direkt, server-synk
   * i bakgrunden — samma offline-first-mönster som resten av appen.
   * Callern behåller eget ansvar för cooldown/busy/return/tagCache-prep.
   *
   * Steg5: skan-callsites kan villkora den STORA gröna bocken på ett VERIFIERAT
   * utfall genom att skicka target.onResult(cls). cls klassificeras med samma
   * classifyLinkResult som steg4:s linkTag (verified | pending-retry | rejected)
   * — ingen parallell klassificerare. gasCallWithRetry används (i st.f. bare
   * gasCall) så exhausted/nätfel kan skiljas från äkta server-avvisning. De TVÅ
   * dialog-baserade callsites:na skickar INGEN onResult → exakt oförändrat
   * optimistiskt beteende (ingen bock visas där ändå).
   *
   * target: { name, sheetName?, rowNum?, onResult? }
   * returnerar: log-entry-elementet (för ev. vidare UI-bruk)
   */
  logSingle(tag, target) {
    if(QA_MODE)_qaLogSingleCount++;
    const { name, sheetName, rowNum, onResult } = target;
    // Undo-fix: fånga FÖREGÅENDE meta-tillstånd SYNKRONT, FÖRE den
    // optimistiska setLocalMeta nedan klobbrar metaCache med Date.now().
    // addUndoButton anropas i .then() (efter server-svar) — då har
    // metaCache redan dagens värde. Utan denna snapshot återställde
    // "Ångra" alltid till idag (→ parseYMD_ kl 12:00). null lastMs =
    // artikeln var aldrig inventerad → undo ska clearTimestamp.
    const _prevMeta = metaCache.get(tag) || {};
    const _undoPrev = { lastMs: _prevMeta.lastMs ?? null, user: _prevMeta.user || "" };
    // 9.6: _resyncLe (när satt) = återanvänd befintlig historik-rad vid
    // online-resync istället för att appenda en ny ⏳-rad varje försök
    // (annars log-spam vid upprepade resync-event).
    const le = target._resyncLe || appendLog(`${name} – uppdateras`, tag);
    show("Sparar…");
    gasCallWithRetry('logTag', {
      tag, name, type: "singel", qty: 1, user: userName,
      sheetName: sheetName ?? null, rowNum: rowNum ?? null
    })
      .then(res => {
        // gasCallWithRetry kastar normalt INTE — den returnerar
        // {ok:false,exhausted:true} vid uttömt/nätfel. classifyLinkResult
        // mappar: ok:true → verified; exhausted/inget svar → pending-retry;
        // ok:false utan exhausted (validering m.m.) → rejected. C/#33:
        // {ok:false,staleRow:true} (logTag UPDATE-grenen genom _staleRowGuard_)
        // → rejected → markLogFail (ingen falsk bock på fel rad).
        const cls = classifyLinkResult(res);
        if (cls === 'verified') {
          _pendingLogSingle.delete(tag);          // bekräftat → ej längre pending
          _persistPending_();
          // Server bekräftad → släpp pendingSync så server blir sanningskälla
          // igen vid nästa poll (spegel av v125 commitContainerDate verified).
          tagCache.set(tag, { ...(tagCache.get(tag) || {}), pendingSync: false });
          markAsDone(le); addUndoButton(le, tag, _undoPrev);
        } else if (cls === 'pending-retry') {
          // Ej bekräftat (offline/uttömt): ingen falsk bock. ⚠️ + diskret
          // status — optimistisk lokal write står kvar (gul rad via
          // pendingSync-mönstret i renderLists). 9.6: REGISTRERA jobbet så
          // resyncPendingTagLinks faktiskt re-försöker det vid online —
          // meddelandet blir SANT. _inflight nollas så nästa event kan ta det.
          const job = _pendingLogSingle.get(tag) || { tag, name, sheetName, rowNum };
          job._inflight = false;
          job._le = le;                 // återanvänd samma rad vid resync
          _pendingLogSingle.set(tag, job);
          _persistPending_();
          if (le) {
            const ic = le.querySelector('.icon'); if (ic) ic.textContent = '⚠️';
            const m = le.querySelector('.msg');
            if (m) m.textContent = `${name} – sparas när du är online igen`;
          }
          show("Ingen kontakt — sparas när du är online igen", "warn");
        } else {
          // Äkta server-avvisning (validering / staleRow) → ingen bock,
          // ⚠️ + felmeddelande. Avregistrera — re-försök är meningslöst.
          // P2: rulla tillbaka optimistisk write + släpp pendingSync så listan
          // inte falskt visar "inventerad idag" (spegel av v125 rejected).
          _pendingLogSingle.delete(tag);
          _persistPending_();
          metaCache.set(tag, _prevMeta);
          tagCache.set(tag, { ...(tagCache.get(tag) || {}), pendingSync: false });
          recomputeMaxLast(); renderLists();
          markLogFail(le, new Error((res && res.msg) || 'serverfel'));
        }
        if (typeof onResult === 'function') { try { onResult(cls); } catch (_) {} }
      })
      .catch(err => {
        // gasCallWithRetry kastar bara vid oväntat fel (ej server-avvisning) →
        // behandla som ej bekräftat (pending-retry), ingen falsk bock.
        const job = _pendingLogSingle.get(tag) || { tag, name, sheetName, rowNum };
        job._inflight = false;
        job._le = le;                   // återanvänd samma rad vid resync
        _pendingLogSingle.set(tag, job);
        _persistPending_();
        markLogFail(le, err);
        if (typeof onResult === 'function') { try { onResult('pending-retry'); } catch (_) {} }
      });
    setLocalMeta(tag, { lastMs: Date.now(), user: userName });
    // P2-fix: skydda den optimistiska writen mot 15s-pollens initData-rebuild
    // (snapshotar BARA pendingSync-poster, ~app.js:2306). Utan detta klobbas
    // lastMs tillbaka → singeln "ligger kvar i Ej inventerat" tills server-
    // preload färskats (server→klient-stale). Spegel av v125 commitContainerDate.
    tagCache.set(tag, { ...(tagCache.get(tag) || {}), pendingSync: true });
    recomputeMaxLast();
    renderLists();
    return le;
  }
};

/* ===== Gemensam artikel-sök (en källa, samma fuzzy överallt) =====
   Search.articles kapslar EXAKT den fuzzy-logik som tidigare låg inline i
   renderSearchResults: bygg en wordMap (namn + synonymer) av kandidat-
   entries och kör Autocomplete.suggest med de kanoniska opts:na. TUNN —
   ingen DOM, ingen dialog, ingen AI. Callsites gör sin egen filtrering
   (activePlaces/onlyLow) FÖRE och äger sin egen UI/koppling EFTER.

   entries: iterable av [tag, val]-par (samma form som tagCache.entries()).
   opts.fuzzy=false → exakt samma Autocomplete-opts som findSimilarItems
   (minPrefixHits:0, ingen fuzzyThreshold). Default = renderSearchResults-opts.
   Returnerar [{ tag, label, syn?, source }] i Autocomplete-rankad ordning,
   en post per tag (dedupe på tag, första träff vinner). */
const Search = {
  // Kanoniska opts — bit-identiska mot tidigare renderSearchResults-anrop.
  SUGGEST_OPTS: { matchMode: 'substring', maxSuggestions: 200, minPrefixHits: 8, fuzzyThreshold: 2.5 },
  _buildWordMap(entries) {
    const wordMap = new Map();
    for (const [tag, val] of entries) {
      const name = val && val.name || ""; if (!name) continue;
      const nameKey = name.toLocaleLowerCase('sv');
      if (!wordMap.has(nameKey)) wordMap.set(nameKey, { tag, label: name });
      if (Array.isArray(val.synonyms)) {
        for (const s of val.synonyms) {
          const sn = String(s || "").trim(); if (!sn) continue;
          const sk = sn.toLocaleLowerCase('sv');
          if (!wordMap.has(sk)) wordMap.set(sk, { tag, label: name, syn: sn });
        }
      }
    }
    return wordMap;
  },
  articles(query, entries, opts) {
    if (typeof Autocomplete === 'undefined') return [];
    const qn = (query || "").toLocaleLowerCase('sv').trim();
    if (!qn) return [];
    const wordMap = this._buildWordMap(entries);
    const wordlist = [...wordMap.keys()];
    const o = opts || {};
    // queries: stöd per-ord-split (findSimilarItems-beteende) via opts.splitWords
    let queries = [qn];
    if (o.splitWords) {
      const words = qn.split(/\s+/).filter(w => w.length >= 3);
      queries = words.length ? [qn, ...words] : [qn];
    }
    const sopts = o.fuzzy === false
      ? { matchMode: 'substring', maxSuggestions: o.maxSuggestions || 200, minPrefixHits: 0 }
      : { ...this.SUGGEST_OPTS, ...(o.maxSuggestions ? { maxSuggestions: o.maxSuggestions } : {}) };
    const out = [];
    const seenTag = new Set();
    const seenWord = new Set();
    for (const q of queries) {
      const suggestions = Autocomplete.suggest(q, wordlist, sopts);
      for (const sug of suggestions) {
        if (seenWord.has(sug.word)) continue;
        seenWord.add(sug.word);
        const info = wordMap.get(sug.word); if (!info) continue;
        if (seenTag.has(info.tag)) continue;
        seenTag.add(info.tag);
        out.push({ tag: info.tag, label: info.label, syn: info.syn, source: sug.source });
        if (o.maxSuggestions && out.length >= o.maxSuggestions) return out;
      }
      if (o.maxSuggestions && out.length >= o.maxSuggestions) break;
    }
    return out;
  }
};

/* ===== Online-resync av ej-bekräftade tag-länkar (bug 2.7) =====
 * När nätet kommer tillbaka: re-försök varje pending tag-länk via samma
 * Save.linkTag-väg (idempotent — backend addTag är idempotent: redan kopplad
 * tag → alreadyPresent, ej dubblett). EN listener, idempotent guard (_inflight)
 * så ett pågående re-försök inte dubbelfyrar (v120-lärdom: undvik dubbel-event).
 */
let _resyncInFlight = false;
async function resyncPendingTagLinks() {
  if (_resyncInFlight) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const linkJobs = selectPendingResync(_pendingTagLinks);
  // 9.6: samma idempotenta urval (selectPendingResync) för logSingle-jobb —
  // INGEN parallell mekanism, INGEN ny listener: en och samma sweep drar
  // båda map:arna under samma _resyncInFlight-guard.
  const singleJobs = selectPendingResync(_pendingLogSingle);
  if (!linkJobs.length && !singleJobs.length) return;
  _resyncInFlight = true;
  try {
    for (const { key, job } of linkJobs) {
      job._inflight = true;
      try {
        const r = await Save.linkTag(job.scannedTag, {
          name: job.name,
          sheetName: job.sheetName,
          rowNum: job.rowNum,
          currentTag: job.currentTag
        });
        // verified/rejected → Save.linkTag har redan _pendingTagLinks.delete:at.
        // pending igen (fortf. offline) → posten finns kvar, _inflight nollas.
        if (r && r.pending) { job._inflight = false; }
      } catch (_) {
        job._inflight = false; // oväntat → låt nästa online-event försöka igen
      }
    }
    for (const { key, job } of singleJobs) {
      job._inflight = true;   // markera FÖRE (selectPendingResync hoppar då över)
      try {
        // Re-kör EXAKT samma Save.logSingle-väg (ingen separat gasCall-path).
        // logSingle:s .then self-delete:ar _pendingLogSingle vid verified/
        // rejected och nollar _inflight + behåller posten vid pending-retry.
        // _resyncLe återanvänder samma historik-rad (ingen ny ⏳ per försök).
        // logTag UPDATE-grenen är idempotent (skriver om qty=1/datum/user på
        // befintlig rad); appendRow sker bara om ingen rad finns ännu.
        Save.logSingle(job.tag, {
          name: job.name, sheetName: job.sheetName, rowNum: job.rowNum,
          _resyncLe: job._le || null
        });
      } catch (_) {
        job._inflight = false; // oväntat → nästa event försöker igen
      }
    }
    if (typeof renderLists === 'function') renderLists();
  } finally {
    _resyncInFlight = false;
  }
}
if (typeof window !== 'undefined' && window.addEventListener) {
  // EN enda online-listener (idempotent via _resyncInFlight + _inflight-guard).
  window.addEventListener('online', resyncPendingTagLinks);
}

/* ===== Bundlad uppdateringskö ===== */
const updateQueue = [];
let updateTimer = null;
let flushInFlight = null;
function queueUpdate(fnName, args) {
  updateQueue.push({ fnName, args });
  if (!updateTimer) updateTimer = setTimeout(flushUpdates, 1000);
}
async function waitForPendingSync() {
  if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; flushUpdates(); }
  if (flushInFlight) { try { await flushInFlight; } catch (_) {} }
}
// Bygg batch-payload från updateQueue + töm kön synkront (måste ske före gasCall
// så nya queueUpdate under flight hamnar i nästa batch, inte denna).
// updateMeta-jobb får userName injicerat här (övriga skickar det själva).
function _buildBatch_() {
  const batch = updateQueue.map(job =>
    job.fnName === "updateMeta"
      ? { fnName: job.fnName, args: { ...job.args, userName } }
      : job
  );
  updateQueue.length = 0;
  updateTimer = null;
  return batch;
}

// Rensa busy/overlay-state. Körs i BÅDE then och catch (synk klar oavsett utfall).
function _clearSyncBusyUI_() {
  busy = false;
  overlay.classList.remove("blurred");
  overlay.style.pointerEvents = "";
}

// Stale-detektering: ett jobb räknas som ÄKTA lyckat BARA om servern svarade
// ok:true UTAN staleRow OCH (om backend ekade writtenTag) writtenTag matchar
// förväntad tag. writtenTag kan saknas (äldre/ej-deployad backend) → då litar
// vi på ok:true som förr (bakåtkompat: ny frontend mot gammal backend
// degraderar exakt till tidigare beteende). Normalisering = samma som
// backend normalizeTag/_zk (icke-siffror bort + leading-zero-strippad nyckel).
function _normTagFE_(x) { return String(x == null ? '' : x).trim().replace(/[^\d]/g, ''); }
function _isJobVerifiedOk_(expectedTag, r) {
  if (!r || r.ok === false) return false;
  if (r.staleRow === true) return false;
  // Syntetisk förväntad tag (S..R..): backend skippar tag-verifiering (samma
  // /^S[A-Za-z]/-mönster som resolveItem/_verifyTagInRow_). _normTagFE_ skulle
  // strippa bokstäver och ge en falsk pseudo-tag ("SStegR5" → "5") → felaktig
  // mismatch. Hoppa över jämförelsen → lita på ok:true (bakåtkompat).
  if (r.writtenTag != null && r.writtenTag !== '' &&
      !/^S[A-Za-z]/.test(String(expectedTag == null ? '' : expectedTag))) {
    const exp = _normTagFE_(expectedTag);
    const got = _normTagFE_(r.writtenTag);
    if (exp) {
      const zk = s => (s.replace(/^0+/, '') || '0');
      if (exp !== got && zk(exp) !== zk(got)) return false;
    }
  }
  return true;
}

// Per-index-matchning: tag kan förekomma flera gånger i samma batch (två
// updateMeta-jobb på samma rad). Rensar pendingSync på ÄKTA verifierat
// lyckade (ok + ej stale + writtenTag matchar); allt annat → fail-tag,
// pendingSync behålls (gul + ⚠️ i historik via _renderBatchOutcome_).
function _applyBatchResults_(batch, res) {
  const results = Array.isArray(res?.results) ? res.results : [];
  const failedTags = [];
  for (let i = 0; i < batch.length; i++) {
    const tag = batch[i].args.tag;
    const r = results[i];
    if (!_isJobVerifiedOk_(tag, r)) {
      failedTags.push(tag);
    } else {
      const cur = tagCache.get(tag);
      if (cur) tagCache.set(tag, { ...cur, pendingSync: false });
    }
  }
  return failedTags;
}

// msgLine + status-banner. Vid fail behålls meddelandet (med pendingSync-CSS
// på raderna) tills nästa flush — annars försvinner felet tyst efter 5s.
function _renderBatchOutcome_(failedTags) {
  const msgLine = document.querySelector("#msgLine");
  if (failedTags.length > 0) {
    const label = `⚠️ ${failedTags.length} ${failedTags.length === 1 ? 'rad' : 'rader'} kunde inte sparas`;
    if (msgLine) { msgLine.className = "msgLine warn"; msgLine.textContent = label; }
    show(label, "warn", { autoreset: false });
  } else {
    if (msgLine) { msgLine.className = "msgLine ok"; msgLine.textContent = "☑️ Synkroniserad med Google Sheets"; }
    show("☑️ Synkroniserad med Google Sheets", "ok", { autoreset: false });
  }
  setTimeout(() => {
    if (msgLine) msgLine.textContent = "";
    if (failedTags.length === 0) statusDefault();
  }, 5000);
}

// Hämta server-cachens timestamp; om nyare än vår senaste → hämta färsk data.
function _revalidateCacheTs_() {
  gasCall('cacheTs').then(ts => {
    if (ts > (window._lastCacheTs || 0)) {
      window._lastCacheTs = ts;
      console.log("Servercache uppdaterad, hämtar ny data...");
      preloadShared().then(initData);
    }
  });
}

// Orkestrerar: bygg batch → skicka → applicera resultat → rendera utfall →
// revalidera cache. Ansvaren är utbrutna i _-helpers ovan; ordning/timing
// är identisk med pre-refaktor (synk-kärna, får ej ändra beteende).
function flushUpdates() {
  if (updateQueue.length === 0) return;

  const batch = _buildBatch_();
  console.log("Skickar batch:", batch.map(b => b.args.tag));

  flushInFlight = gasCall('batch', {batch})
    .then(res => {
      _clearSyncBusyUI_();
      const failedTags = _applyBatchResults_(batch, res);
      console.log("Synk klar:", batch.length - failedTags.length, "ok,", failedTags.length, "fail");
      renderLists();
      _renderBatchOutcome_(failedTags);
      _revalidateCacheTs_();
    })
    .catch(err => {
      _clearSyncBusyUI_();
      console.error("batch fail", err);
      const msgLine = document.querySelector("#msgLine");
      if (msgLine) {
        msgLine.className = "msgLine warn";
        msgLine.textContent = "❌ Fel vid synkning – försök igen.";
      }
      show("Fel vid synkning", "warn", { autoreset: false });
    })
    .finally(() => { flushInFlight = null; });
}

/* ===== Meta ===== */
function setLocalMeta(tag,patch){const prev=metaCache.get(tag)||{};let next={...prev,...patch};if(typeof next.lastMs==="number"){next.lastMs=toDayMs(next.lastMs);next.lastStr=toDayStr(next.lastMs);}else if(typeof next.lastStr==="string"&&next.lastStr){const ms=parseLocalYMD(next.lastStr);next.lastMs=toDayMs(ms);next.lastStr=toDayStr(next.lastMs);}else if(prev.lastMs){next.lastMs=prev.lastMs;next.lastStr=prev.lastStr||toDayStr(prev.lastMs);}else{next.lastMs=null;next.lastStr="";}metaCache.set(tag,next);}
function recomputeMaxLast(){let max=null;for(const v of metaCache.values())if(v.lastMs!=null)max=(max==null||v.lastMs>max)?v.lastMs:max;maxLastMs=max;}

/* ===== Filter (flik-selector + gruppering) ===== */
function loadSettings(){
  try{
    const raw = localStorage.getItem('vitaliseraPlaceFilter');
    if(!raw){ activePlaces = null; }
    else {
      const arr = JSON.parse(raw);
      activePlaces = Array.isArray(arr) && arr.length ? new Set(arr) : null;
    }
  }catch{ activePlaces = null; }
  try{ onlyLow = localStorage.getItem('vitaliseraOnlyLow') === '1'; }catch{ onlyLow = false; }
  try{ showUnit = localStorage.getItem('vitaliseraShowUnit') === '1'; }catch{ showUnit = false; }
  try{ hideZero = localStorage.getItem('vitaliseraHideZero') === '1'; }catch{ hideZero = false; }
  try{ hideMin = localStorage.getItem('vitaliseraHideMin') === '1'; }catch{ hideMin = false; }
  try{
    const raw = localStorage.getItem('vitaliseraActiveSteps');
    if (!raw) { activeSteps = null; }
    else {
      const arr = JSON.parse(raw);
      activeSteps = Array.isArray(arr) && arr.length ? new Set(arr) : null;
    }
  } catch { activeSteps = null; }
}
function saveSettings(){
  if(!activePlaces || activePlaces.size === 0) localStorage.removeItem('vitaliseraPlaceFilter');
  else localStorage.setItem('vitaliseraPlaceFilter', JSON.stringify([...activePlaces]));
  localStorage.setItem('vitaliseraOnlyLow', onlyLow ? '1' : '0');
  localStorage.setItem('vitaliseraShowUnit', showUnit ? '1' : '0');
  localStorage.setItem('vitaliseraHideZero', hideZero ? '1' : '0');
  localStorage.setItem('vitaliseraHideMin', hideMin ? '1' : '0');
  if (!activeSteps || activeSteps.size === 0) localStorage.removeItem('vitaliseraActiveSteps');
  else localStorage.setItem('vitaliseraActiveSteps', JSON.stringify([...activeSteps]));
}

// Samla unika steg från tagCache. Step-värden kan vara kommaseparerade
// (t.ex. "Steg 2, Steg 3B") för artiklar som tillhör flera steg.
function collectSteps() {
  const set = new Set();
  for (const v of tagCache.values()) {
    const raw = String(v?.step || '').trim();
    if (!raw) continue;
    for (const part of raw.split(',')) {
      const t = part.trim();
      if (t) set.add(t);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'sv'));
}

// True om artikelns step matchar minst ETT av activeSteps.
// Returnerar true för artiklar UTAN step om activeSteps är aktiv (visar inte exklusiva).
// Hmm — det är osäkert beteende. Säkrare: artiklar utan step visas alltid.
function itemPassesStepFilter(item) {
  if (!activeSteps || activeSteps.size === 0) return true;
  const raw = String(item?.step || '').trim();
  if (!raw) return true; // artiklar utan step-info visas alltid
  for (const part of raw.split(',')) {
    if (activeSteps.has(part.trim())) return true;
  }
  return false;
}
/* Rensa activePlaces från platser som inte längre finns i tagCache. Annars kan en
   sparad plats som försvunnit (t.ex. inkompatibel flik borttagen från preload)
   filtrera bort alla artiklar utan att kunna avbockas från filterdialogen. */
function sanitizePlaceFilter(){
  if (!activePlaces) return;
  if (tagCache.size === 0) return;
  const existing = new Set();
  for (const v of tagCache.values()) {
    existing.add((v?.place && String(v.place).trim()) || "Okänd");
  }
  const cleaned = new Set([...activePlaces].filter(p => existing.has(p)));
  if (cleaned.size === activePlaces.size) return;
  activePlaces = cleaned.size ? cleaned : null;
  if (!activePlaces) localStorage.removeItem('vitaliseraPlaceFilter');
  else localStorage.setItem('vitaliseraPlaceFilter', JSON.stringify([...activePlaces]));
}

function openSettingsDialog() {
  placeList.innerHTML = "";

  const title0 = document.createElement('div');
  title0.className = 'filterSectionTitle filterSectionTitle--first';
  title0.textContent = 'Listinställningar';
  placeList.appendChild(title0);

  const row0 = document.createElement('div');
  row0.className = 'placeRow';
  const chk0 = document.createElement('input');
  chk0.type = 'checkbox';
  chk0.dataset.onlylow = '1';
  chk0.checked = !!onlyLow;
  const txt0 = document.createElement('div');
  txt0.className = 'placeTxt';
  txt0.textContent = 'Visa endast artiklar med för lågt saldo';
  row0.append(chk0, txt0);
  row0.addEventListener('click', e => { if (e.target !== chk0) chk0.checked = !chk0.checked; });
  placeList.appendChild(row0);

  const rowCat = document.createElement('div');
  rowCat.className = 'placeRow';
  const chkCat = document.createElement('input');
  chkCat.type = 'checkbox';
  chkCat.dataset.groupbycat = '1';
  chkCat.checked = !!groupByCategory;
  const txtCat = document.createElement('div');
  txtCat.className = 'placeTxt';
  txtCat.textContent = 'Gruppera efter kategori';
  rowCat.append(chkCat, txtCat);
  rowCat.addEventListener('click', e => { if (e.target !== chkCat) chkCat.checked = !chkCat.checked; });
  placeList.appendChild(rowCat);

  const rowPlc = document.createElement('div');
  rowPlc.className = 'placeRow';
  const chkPlc = document.createElement('input');
  chkPlc.type = 'checkbox';
  chkPlc.dataset.groupbyplace = '1';
  chkPlc.checked = !!groupByPlace;
  const txtPlc = document.createElement('div');
  txtPlc.className = 'placeTxt';
  txtPlc.textContent = 'Gruppera efter plats';
  rowPlc.append(chkPlc, txtPlc);
  rowPlc.addEventListener('click', e => { if (e.target !== chkPlc) chkPlc.checked = !chkPlc.checked; });
  placeList.appendChild(rowPlc);

  const rowUnit = document.createElement('div');
  rowUnit.className = 'placeRow';
  const chkUnit = document.createElement('input');
  chkUnit.type = 'checkbox';
  chkUnit.dataset.showunit = '1';
  chkUnit.checked = !!showUnit;
  const txtUnit = document.createElement('div');
  txtUnit.className = 'placeTxt';
  txtUnit.textContent = 'Visa enhet istället för datum';
  rowUnit.append(chkUnit, txtUnit);
  rowUnit.addEventListener('click', e => { if (e.target !== chkUnit) chkUnit.checked = !chkUnit.checked; });
  placeList.appendChild(rowUnit);

  const rowZero = document.createElement('div');
  rowZero.className = 'placeRow';
  const chkZero = document.createElement('input');
  chkZero.type = 'checkbox';
  chkZero.dataset.hidezero = '1';
  chkZero.checked = !!hideZero;
  const txtZero = document.createElement('div');
  txtZero.className = 'placeTxt';
  txtZero.textContent = 'Dölj artiklar med saldo 0';
  rowZero.append(chkZero, txtZero);
  rowZero.addEventListener('click', e => { if (e.target !== chkZero) chkZero.checked = !chkZero.checked; });
  placeList.appendChild(rowZero);

  const rowMin = document.createElement('div');
  rowMin.className = 'placeRow';
  const chkMin = document.createElement('input');
  chkMin.type = 'checkbox';
  chkMin.dataset.hidemin = '1';
  chkMin.checked = !!hideMin;
  const txtMin = document.createElement('div');
  txtMin.className = 'placeTxt';
  txtMin.textContent = 'Dölj Min-kolumnen';
  rowMin.append(chkMin, txtMin);
  rowMin.addEventListener('click', e => { if (e.target !== chkMin) chkMin.checked = !chkMin.checked; });
  placeList.appendChild(rowMin);

  const title1 = document.createElement('div');
  title1.className = 'filterSectionTitle';
  title1.textContent = 'Visa från följande flikar';
  placeList.appendChild(title1);

  const placeSource = placeSet.size
    ? placeSet
    : new Set(Array.from(tagCache.values()).map(v => (v.place && String(v.place).trim()) || "Okänd"));

  const places = [...placeSource].sort((a, b) => a.localeCompare(b, 'sv'));

  // Räkna inventerat/total per flik (samma 5-dagarsfönster som i renderLists).
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const windowStart = now - INVENTORY_WINDOW_DAYS * DAY_MS;
  const windowEnd   = now + INVENTORY_WINDOW_DAYS * DAY_MS;
  const placeCounts = new Map();
  for (const [t, item] of tagCache.entries()) {
    if (!item?.name) continue;
    const p = (item.place && String(item.place).trim()) || "Okänd";
    const c = placeCounts.get(p) || { total: 0, inv: 0 };
    c.total++;
    const meta = metaCache.get(t);
    if (meta?.lastMs && meta.lastMs >= windowStart && meta.lastMs <= windowEnd) c.inv++;
    placeCounts.set(p, c);
  }

  for (const p0 of places) {
    const p = (p0 && String(p0).trim()) || "Okänd";
    const row = document.createElement('div');
    row.className = 'placeRow';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.dataset.place = p;
    chk.checked = !activePlaces || activePlaces.has(p);
    const txt = document.createElement('div');
    txt.className = 'placeTxt';
    const c = placeCounts.get(p) || { total: 0, inv: 0 };
    txt.textContent = `${p} (${c.inv}/${c.total})`;
    row.append(chk, txt);
    row.addEventListener('click', e => { if (e.target !== chk) chk.checked = !chk.checked; });
    placeList.appendChild(row);
  }

  // Step-filter — bara om det finns artiklar med step-värden i datan
  const allSteps = collectSteps();
  if (allSteps.length) {
    const titleSteps = document.createElement('div');
    titleSteps.className = 'filterSectionTitle';
    titleSteps.textContent = 'Visa från följande steg';
    placeList.appendChild(titleSteps);
    for (const s of allSteps) {
      const row = document.createElement('div');
      row.className = 'placeRow';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.dataset.step = s;
      chk.checked = !activeSteps || activeSteps.has(s);
      const txt = document.createElement('div');
      txt.className = 'placeTxt';
      txt.textContent = s;
      row.append(chk, txt);
      row.addEventListener('click', e => { if (e.target !== chk) chk.checked = !chk.checked; });
      placeList.appendChild(row);
    }
  }

  const titleIcons = document.createElement('div');
  titleIcons.className = 'filterSectionTitle';
  titleIcons.textContent = 'Visa ikoner';
  placeList.appendChild(titleIcons);

  const iconDefs = [
    { key: 'iconTag',     label: 'Tag (🏷️)' },
    { key: 'iconType',    label: 'Singel (•)' },
    { key: 'iconComment', label: 'Kommentar (ℹ️)' }
  ];
  for (const def of iconDefs) {
    const row = document.createElement('div');
    row.className = 'placeRow';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.dataset.icon = def.key;
    chk.checked = !!prefs[def.key];
    const txt = document.createElement('div');
    txt.className = 'placeTxt';
    txt.textContent = def.label;
    row.append(chk, txt);
    row.addEventListener('click', e => { if (e.target !== chk) chk.checked = !chk.checked; });
    placeList.appendChild(row);
  }

  const versionLabel = qs('#versionLabel');
  if (versionLabel && 'caches' in window) {
    caches.keys().then(keys => {
      const cache = keys.find(k => k.startsWith('vitalisera-inv-'));
      versionLabel.textContent = cache ? 'Version ' + cache.replace('vitalisera-inv-', '') : '';
    }).catch(() => {});
  }

  // Synka knapptext med faktiska checkbox-tillståndet (annars HTML-default 'Välj alla'
   // när alla redan är valda — vilseledande)
  const placeBoxes = placeList.querySelectorAll('input[type="checkbox"][data-place]');
  const allPlacesChecked = placeBoxes.length > 0 && [...placeBoxes].every(b => b.checked);
  if (toggleAllPlacesBtn) toggleAllPlacesBtn.textContent = allPlacesChecked ? 'Avmarkera alla' : 'Välj alla';

  overlay.classList.add("blurred");
  settingsDialog.classList.remove("hidden");
}
function closeSettingsDialog() {
  settingsDialog.classList.add("hidden");
  overlay.classList.remove("blurred");
}

settingsBtn?.addEventListener('click', openSettingsDialog);
toggleAllPlacesBtn?.addEventListener('click', () => {
  const onlyLowBox = placeList.querySelector('input[data-onlylow="1"]');
  if (onlyLowBox) onlyLowBox.checked = false;
  const boxes = placeList.querySelectorAll('input[type="checkbox"][data-place]');
  const allChecked = [...boxes].every(b => b.checked);
  boxes.forEach(b => b.checked = !allChecked);
  toggleAllPlacesBtn.textContent = allChecked ? 'Välj alla' : 'Avmarkera alla';
});
applySettingsBtn?.addEventListener('click', () => {
  const onlyLowBox = placeList.querySelector('input[data-onlylow="1"]');
  onlyLow = !!onlyLowBox?.checked;

  const groupByCatBox = placeList.querySelector('input[data-groupbycat="1"]');
  groupByCategory = !!groupByCatBox?.checked;
  localStorage.setItem('vitaliseraGroupByCategory', groupByCategory ? '1' : '0');

  const groupByPlcBox = placeList.querySelector('input[data-groupbyplace="1"]');
  groupByPlace = !!groupByPlcBox?.checked;
  localStorage.setItem('vitaliseraGroupByPlace', groupByPlace ? '1' : '0');

  const showUnitBox = placeList.querySelector('input[data-showunit="1"]');
  showUnit = !!showUnitBox?.checked;

  const hideZeroBox = placeList.querySelector('input[data-hidezero="1"]');
  hideZero = !!hideZeroBox?.checked;

  const hideMinBox = placeList.querySelector('input[data-hidemin="1"]');
  hideMin = !!hideMinBox?.checked;

  const boxes = placeList.querySelectorAll('input[type="checkbox"][data-place]');
  const selPlaces = new Set();
  boxes.forEach(b => { if (b.checked) selPlaces.add(b.dataset.place); });
  activePlaces = (selPlaces.size === boxes.length) ? null : selPlaces;

  const stepBoxes = placeList.querySelectorAll('input[type="checkbox"][data-step]');
  if (stepBoxes.length) {
    const selSteps = new Set();
    stepBoxes.forEach(b => { if (b.checked) selSteps.add(b.dataset.step); });
    activeSteps = (selSteps.size === stepBoxes.length) ? null : selSteps;
  }

  placeList.querySelectorAll('input[type="checkbox"][data-icon]').forEach(b => {
    const key = b.dataset.icon;
    prefs[key] = !!b.checked;
    localStorage.setItem('vitalisera' + key.charAt(0).toUpperCase() + key.slice(1), String(!!b.checked));
  });

  saveSettings();
  show("Laddar inventeringslistor...", null, { autoreset: false });
  renderLists();
  closeSettingsDialog();
  statusDefault();
});
cancelSettingsBtn?.addEventListener('click', () => closeSettingsDialog());

// På iOS PWA-läge är window.print() begränsad — öppna istället ny tab i Safari
// (target=_blank tvingar ut ur standalone) som auto-triggar print efter render.
function showPrintLoading(text) {
  if (document.getElementById('printLoading')) return;
  const o = document.createElement('div');
  o.id = 'printLoading';
  const s = document.createElement('div');
  s.className = 'printSpinner';
  const t = document.createElement('div');
  t.textContent = text || 'Förbereder utskrift…';
  o.append(s, t);
  document.body.appendChild(o);
}
function hidePrintLoading() {
  document.getElementById('printLoading')?.remove();
}

qs('#printListBtn')?.addEventListener('click', () => {
  // Applya valda inställningar först (annars skriver vi ut det gamla filtret).
  applySettingsBtn?.click();
  const isStandalone = navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  if (isStandalone) {
    showPrintLoading('Öppnar utskrift…');
    const url = location.pathname + '?print=1';
    const w = window.open(url, '_blank');
    if (!w) {
      hidePrintLoading();
      window.print();
    } else {
      // Användaren går till Safari-tabben — overlay rensas automatiskt
      // efter 8s om de återvänder till PWA:n.
      setTimeout(hidePrintLoading, 8000);
    }
  } else {
    showPrintLoading('Förbereder utskrift…');
    setTimeout(() => { window.print(); hidePrintLoading(); }, 50);
  }
});

// Auto-print om sidan laddats med ?print=1 (från PWA → Safari-tab)
let _autoPrintPending = _isPrintTab;
// Visa loading omedelbart — väntan mellan page-load och print-dialog kan
// vara 1-3s på iOS Safari, vilket annars ser ut som att inget händer.
if (_isPrintTab) showPrintLoading('Förbereder utskrift…');

// Stäng iOS text-selection innan knappklick så selection-handles inte stjäl tryck.
document.addEventListener('pointerdown', e => {
  if (e.target.closest('.dialog .actions .btn')) {
    const el = document.activeElement;
    if (el && el !== document.body && typeof el.blur === 'function') el.blur();
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.removeAllRanges) sel.removeAllRanges();
  }
}, true);

/* ===== Kommentar-popup ===== */
document.addEventListener('click', function(e) {
  const icon = e.target.closest('.infoIcon');
  if (!icon) return;
  e.stopPropagation();

  const tag = icon.dataset.tag;
  const tk = tagCache.get(tag) || {};
  const current = (tk.comment || "").trim();

  overlay.classList.add("blurred");
  const d = document.createElement("div");
  d.className = "dialog comment";
  d.innerHTML = `
    <h2>Kommentar</h2>
    <div id="commentDisplay" class="commentDisplay"></div>
    <textarea id="commentEditField" class="commentTextarea"></textarea>
    <div class="actions">
      <button class="btn" id="saveCommentBtn">Spara</button>
      <button class="btn cancel" id="clearCommentBtn">Rensa och stäng</button>
      <button class="btn cancel" id="closeCommentBtn">Stäng</button>
    </div>`;
  document.body.appendChild(d);

  const commentDisplay = d.querySelector("#commentDisplay");
  const textarea       = d.querySelector("#commentEditField");
  const saveBtn        = d.querySelector("#saveCommentBtn");
  const clearBtn       = d.querySelector("#clearCommentBtn");
  const closeBtn       = d.querySelector("#closeCommentBtn");

  renderLinkified(commentDisplay, current);
  textarea.value = current;

  function closeDialogLocal() {
    d.remove();
    overlay.classList.remove("blurred");
    document.removeEventListener("keydown", escHandler);
  }
  const escHandler = ev => { if (ev.key === "Escape") closeDialogLocal(); };
  document.addEventListener("keydown", escHandler);

  saveBtn.onclick = () => {
    const newComment = (textarea.value || "").trim();
    tagCache.set(tag, { ...tk, comment: newComment });
    renderLists();
    show("Kommentar sparad", "ok");
    gasCall('updateMeta', {tag, args: { comment: newComment, userName }})
      .catch(() => show("Kunde inte spara kommentaren", "warn"));
    closeDialogLocal();
  };
  clearBtn.onclick = () => {
    tagCache.set(tag, { ...tk, comment: "" });
    renderLists();
    show("Kommentar rensad", "warn");
    gasCall('updateMeta', {tag, args: { comment: "", userName }})
      .catch(() => show("Kunde inte rensa kommentaren", "warn"));
    closeDialogLocal();
  };
  closeBtn.onclick = closeDialogLocal;
});

/* ===== Sök ===== */
let _linkModeCleanup = null;
function openSearchDialog(){searchInput.value="";searchResults.innerHTML="";overlay.classList.add("blurred");searchDialog.classList.remove("hidden");searchInput.focus();}
function closeSearchDialog(){
  if (_linkModeCleanup) { try { _linkModeCleanup(); } catch(e){} _linkModeCleanup = null; }
  searchDialog.classList.add("hidden");
  overlay.classList.remove("blurred");
  busy = false;
}
searchFab?.addEventListener('click', openSearchDialog);
closesearchFab?.addEventListener('click', closeSearchDialog);
searchInput?.addEventListener('input', e => renderSearchResults(e.target.value));
let _searchAiTimer = null;
// Sätts av openLinkSearchDialog: i "koppla tag"-läge äger länk-handlern (.oninput,
// rad ~3248) #searchResults helt. searchInput har dock en PERMANENT
// addEventListener('input', renderSearchResults) (rad 1624) som .oninput INTE
// ersätter — båda fyrar. Utan denna guard renderar fritextsöket (med AI-sektion
// wired till openContainerForTag) ovanpå/efter länk-listan → fel artikel öppnas
// i stället för att taggen kopplas. Guarden gör renderSearchResults inert i
// länk-läge och städar dess pågående AI-timer.
let _linkModeActive = false;
function renderSearchResults(q){
  if(_linkModeActive){
    if(_searchAiTimer){ clearTimeout(_searchAiTimer); _searchAiTimer=null; }
    return;
  }
  const qn=(q||"").toLocaleLowerCase('sv').trim();
  searchResults.innerHTML="";
  if(_searchAiTimer){ clearTimeout(_searchAiTimer); _searchAiTimer=null; }
  if(!qn) return;

  // Filterpassade entries (activePlaces/onlyLow) — filtreringen ÄGS av
  // callsite, sökningen delegeras till Search.articles (en källa, samma
  // fuzzy överallt). nameToTag = AI-resultat-namn → tag-lookup nedan.
  const passing = [];
  const passingTags = [];
  const nameToTag = new Map();
  for(const [tag, val] of tagCache.entries()){
    const name = val?.name||""; if(!name) continue;
    if(activePlaces && !activePlaces.has(val.place||"Okänd")) continue;
    if(onlyLow){
      const meta = metaCache.get(tag)||{};
      const isLow = (val.minQty||0) && (meta.qty < val.minQty);
      if(!isLow) continue;
    }
    passingTags.push(tag);
    passing.push([tag, val]);
    const nameKey = name.toLocaleLowerCase('sv');
    if(!nameToTag.has(nameKey)) nameToTag.set(nameKey, tag);
  }

  const suggestions = Search.articles(qn, passing);

  const shownTags = new Set();
  for(const info of suggestions){
    if(shownTags.has(info.tag)) continue;
    shownTags.add(info.tag);
    const btn = document.createElement('button');
    btn.type = "button"; btn.className = "statusRow";
    const synHint = info.syn ? ` <span class="sr-syn">(${esc(info.syn)})</span>` : '';
    const fuzzyHint = info.source === 'fuzzy' ? ` <span class="sr-syn">(liknande)</span>` : '';
    const m = metaCache.get(info.tag) || {};
    const saldo = m.qty != null && m.qty !== "" ? `${esc(m.qty)} ${esc(m.unit || "")}`.trim() : "";
    btn.innerHTML = `<span class="sr-name">${esc(info.label)}${synHint}${fuzzyHint}</span><span class="sr-saldo">${saldo}</span><span class="sr-date">${esc(m.lastStr||"")}</span>`;
    const _tag = info.tag;
    addSafeTap(btn,
      () => { closeSearchDialog(); openContainerForTag(_tag); },
      () => { closeSearchDialog(); const c = tagCache.get(_tag); if (c) prepareContainerDialog(c, _tag, { editMode: true }); }
    );
    searchResults.appendChild(btn);
  }

  // AI-kandidater = filterpassade artiklar som INTE redan visats
  const aiCandidates = [];
  for(const tag of passingTags){
    if(!shownTags.has(tag)) {
      const name = tagCache.get(tag)?.name; if(name) aiCandidates.push(name);
    }
  }

  // AI-sökning: kör bara om få visade träffar och query är substantiell.
  if(qn.length >= 3 && shownTags.size < 8 && aiCandidates.length > 0){
    const loading = document.createElement('div');
    loading.className = 'searchAiLoading';
    loading.innerHTML = '<span class="aiSpinner"></span> Söker med AI…';
    // Lägg HÖGST UPP så den alltid syns, även om substring-träffar skjuter ner den
    searchResults.insertBefore(loading, searchResults.firstChild);
    _searchAiTimer = setTimeout(async () => {
      const results = await aiSearch(q, aiCandidates);
      // Avbryt om query ändrats under anropet
      if(searchInput.value.trim().toLocaleLowerCase('sv') !== qn){ loading.remove(); return; }
      loading.remove();
      if(!results || !results.length){
        const empty = document.createElement('div');
        empty.className = 'searchAiEmpty';
        empty.textContent = 'AI hittade inget liknande.';
        searchResults.appendChild(empty);
        return;
      }
      const header = document.createElement('div');
      header.className = 'searchAiHeader';
      header.textContent = 'Liknande (AI)';
      searchResults.appendChild(header);
      for(const r of results){
        const tag = nameToTag.get(String(r.name||"").toLocaleLowerCase('sv'));
        if(!tag) continue;
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'statusRow aiResult';
        btn.innerHTML = `<span class="sr-name">${esc(r.name)}</span><span class="sr-reason">${esc(r.reason||'')}</span>`;
        const _tag = tag;
        addSafeTap(btn,
          () => { closeSearchDialog(); openContainerForTag(_tag); },
          () => { closeSearchDialog(); const c = tagCache.get(_tag); if (c) prepareContainerDialog(c, _tag, { editMode: true }); }
        );
        searchResults.appendChild(btn);
      }
    }, 700);
  }
}

/* ===== Preload helpers ===== */
const PRELOAD_CACHE_KEY = 'vitaliseraPreloadCache_v2';
// Race-skydd: cacheTs-pollern, flushUpdates-kedjan och manuell preloadData kan
// alla råka anropa gasCall('preload') samtidigt. Om en gammal preload (med stale
// data) returnerar EFTER en nyare optimistisk uppdatering, skrivs lokal state
// över. Genom att dela en in-flight promise garanterar vi att bara EN preload-
// fetch är live åt gången och alla callers får samma resultat.
let _preloadInflight = null;
function preloadShared() {
  if (_preloadInflight) return _preloadInflight;
  // 60s timeout: preload full-scannar 9-17 flikar (7-13s) och _bumpCacheTs vid
  // varje write tömmer cachen → ofta full-scan. Den ska SLUTFÖRAS, inte abort:a
  // vid 30s och retry-storma. Snabba skriv-anrop behåller 30s-defaulten (de
  // delar inte längre samma timeout-värde). Den delade in-flight-promisen
  // koalescerar samtidiga preloads (bootstrap/cacheTs-poll/_revalidateCacheTs_)
  // till EN full-scan i stället för parallella.
  _preloadInflight = gasCall('preload', {}, 60000).finally(() => { _preloadInflight = null; });
  return _preloadInflight;
}
function preloadData() {
  preloadShared().then(initData);
}
function initData(records, { fromCache = false } = {}) {
  if (!Array.isArray(records)) {
    console.warn("initData: ogiltigt svar, behåller befintlig cache", records);
    return;
  }

  // Snapshot pending edits innan rebuild — server-datan kan vara före lokala ändringar
  // som ännu inte batch-flushats, så vi får inte tappa pendingSync + lokala värden.
  const pendingSnapshot = [];
  for (const [t, item] of tagCache.entries()) {
    if (item?.pendingSync) pendingSnapshot.push({ t, item, meta: metaCache.get(t) });
  }

  tagCache.clear();
  metaCache.clear();
  placeSet.clear();

  records.forEach(rec => {
    const [t, name, type, qty, unit, last, user, place, minQty, step, comment, rowNum, altTags, category, synonyms, sheetPlace] = rec;
    if (!name) return;
    const nt = normTag(t);
    const plc = normPlace(place);
    const isSynthetic = nt.startsWith("S");

    tagCache.set(nt, {
      name,
      type,
      place: plc,
      sheetPlace: String(sheetPlace || "").trim(),
      category: String(category || "").trim(),
      minQty: Number(minQty) || 0,
      step: String(step || "").trim(),
      comment: String(comment || "").trim(),
      rowNum: rowNum || null,
      sheetName: plc,
      altTags: Array.isArray(altTags) ? altTags : [],
      synonyms: Array.isArray(synonyms) ? synonyms : []
    });

    placeSet.add(plc);
    metaCache.set(nt, {
      qty: Number(qty) || 0,
      unit: String(unit || ""),
      user: String(user || ""),
      lastMs: toDayMs(last),
      lastStr: fmtDate(last)
    });
  });

  // Re-applyera pending edits ovanpå server-data
  for (const { t, item, meta } of pendingSnapshot) {
    const server = tagCache.get(t);
    tagCache.set(t, server ? { ...server, ...item } : item);
    if (meta) metaCache.set(t, meta);
  }

  recomputeMaxLast();
  sanitizePlaceFilter();
  renderLists();
  statusDefault();

  // Både cache- och server-hydrering släpper skanning. Edits mot stale cache
  // är säkra: logTag/updateCount resolvar tag-sökning igen på servern vid anrop.
  preloadDone = true;

  // Persistera bara fräsch server-data (inte en rescue-render från disk)
  if (!fromCache) {
    try { localStorage.setItem(PRELOAD_CACHE_KEY, JSON.stringify({ data: records, ts: Date.now() })); }
    catch (e) { console.warn('preloadCache write failed', e); }
  }
}

/* ===== Öppna container eller artikel ===== */
function openContainerForTag(tag) {
  currentDialogTag = tag;
  const cached = tagCache.get(tag);
  if (!cached) return;
  // FIX v109: ANY artikel-val efter AI-analys triggar fewshot-loggning.
  // consumeVisionResult har egen tidsfönster-guard (5 min) + manualOverride-flag
  // som signalerar om valt namn fanns i AI-listan eller inte. Det betyder Robert
  // kan lära modellen även när AI missade — bara att söka manuellt och tap:a räcker.
  if (window.vision && typeof window.vision.consumeVisionResult === 'function' && cached.name) {
    try { window.vision.consumeVisionResult(cached.name); } catch (e) { console.warn('vision tap-hook', e); }
  }

  const { name, type, sheetName, rowNum } = cached;

  if (type === "singel") {
    const dialogItem = tagCache.get(tag);
    if (dialogItem) {
      prepareSingleDialog(dialogItem, tag);
    }
    return;
  }

  const dialogItem = tagCache.get(tag);
  if (dialogItem) {
    prepareContainerDialog(dialogItem, tag, { loading: false });
  }

  if (sheetName && rowNum) return;

  gasCall('lookup', {tag})
    .then(fresh => {
      if (!fresh) return;
      updateDialogWithFreshData(tag, fresh);
    })
    .catch(() => {
      show("Kunde inte hämta senaste data", "warn");
      document.querySelector("#dialogBox")?.classList.remove("loading");
    });
}

/* ===== Tap vs scroll guard — mobil-only ===== */
const TAP_SLOP_PX = 15;
const TAP_MAX_MS  = 250;
const LONG_MS     = 600;
function addSafeTap(el, onTap, onLong) {
  let pid=null, x0=0, y0=0, t0=0, moved=false, longTimer=null, longFired=false, startTarget=null;
  try { el.style.touchAction = 'pan-y'; } catch {}
  const clearLong = () => { if (longTimer) { clearTimeout(longTimer); longTimer = null; } };
  el.addEventListener('pointerdown', e => {
    if (e.pointerType && e.pointerType !== 'touch') return;
    startTarget = e.target;
    if (startTarget.closest('.infoIcon, a, input, textarea, select, label, [role="button"]')) return;
    pid=e.pointerId; x0=e.clientX; y0=e.clientY; t0=performance.now(); moved=false; longFired=false;
    if (typeof onLong === 'function') {
      longTimer = setTimeout(() => { longTimer=null; longFired=true; onLong(e); }, LONG_MS);
    }
  }, { passive: true });
  el.addEventListener('pointermove', e => {
    if (e.pointerType && e.pointerType !== 'touch') return;
    if (e.pointerId !== pid) return;
    if (Math.abs(e.clientX - x0) > TAP_SLOP_PX || Math.abs(e.clientY - y0) > TAP_SLOP_PX) {
      moved = true; clearLong();
    }
  }, { passive: true });
  el.addEventListener('pointerup', e => {
    if (e.pointerType && e.pointerType !== 'touch') return;
    if (e.pointerId !== pid) return;
    const dt = performance.now() - t0;
    if (!moved && !longFired && dt <= TAP_MAX_MS && typeof onTap === 'function') onTap(e);
    clearLong(); pid=null; startTarget=null;
  }, { passive: true });
  el.addEventListener('pointercancel', () => { clearLong(); pid=null; startTarget=null; }, { passive: true });
}

/* ===== Rendera listor ===== */
function renderLists() {
  const makeHeader = () => {
    const h = document.createElement("div");
    h.className = "statusRow headerRow";
    h.innerHTML = `
      <span class="sr-name">Benämning</span>
      ${hideMin ? "" : '<span class="sr-min">Min</span>'}
      <span class="sr-lastcount">Senast</span>
      <span class="sr-date">${showUnit ? "Enhet" : "Datum"}</span>`;
    return h;
  };

  const today = toDayMs(Date.now());
  const allTags = [...tagCache.keys()].sort((a, b) =>
    (tagCache.get(a)?.name || "").localeCompare(tagCache.get(b)?.name || "")
  );

  const _visible = [];
  const invItems = [];
  const ejItems  = [];
  for (const t of allTags) {
    const item = tagCache.get(t) || {};
    const meta = metaCache.get(t) || {};
    const name = item.name || "";
    if (!name) continue;

    const place = item.place || "Okänd";
    if (activePlaces && !activePlaces.has(place)) continue;

    const isLow = item.minQty && meta.qty < item.minQty;
    if (onlyLow && !isLow) continue;

    if (!itemPassesStepFilter(item)) continue;

    if (hideZero && (Number(meta.qty) || 0) === 0) continue;

    _visible.push(t);

    const hasComment = !!(item.comment || "").trim();

    const row = document.createElement("button");
    row.type = "button";
    let rowClass = "statusRow clickable";
    if (isLow) rowClass += " low";
    if (item.pendingSync) rowClass += " pendingSync";
    row.className = rowClass;
    row.dataset.tag = t;

    row.innerHTML = `
      <span class="sr-name">${esc(name)}${renderRowIcons(t, item, hasComment)}</span>
      ${hideMin ? "" : `<span class="sr-min">${esc(item.minQty ?? "")}</span>`}
      <span class="sr-lastcount">${esc(meta.qty ?? "")}</span>
      <span class="sr-date">${esc(showUnit ? (meta.unit || "") : (meta.lastStr || ""))}</span>`;

    addSafeTap(row, (e) => { if (!e.target.closest('.infoIcon')) openContainerForTag(t); });

    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const windowStart = now - INVENTORY_WINDOW_DAYS * DAY_MS;
    const windowEnd   = now + INVENTORY_WINDOW_DAYS * DAY_MS;

    const isInv =
      meta.lastMs &&
      meta.lastMs >= windowStart &&
      meta.lastMs <= windowEnd;

    (isInv ? invItems : ejItems).push({
      row,
      category: (item.category || "").trim(),
      place: (item.sheetPlace || "").trim() || "Okänd"
    });
  }

  const makeGroupHeader = (label, variant) => {
    const h = document.createElement("div");
    h.className = variant === "place" ? "categoryHeader placeHeader" : "categoryHeader";
    h.textContent = label;
    return h;
  };
  const bucketBy = (items, key) => {
    const buckets = new Map();
    const noKey = [];
    for (const entry of items) {
      const v = entry[key];
      if (!v) { noKey.push(entry); continue; }
      if (!buckets.has(v)) buckets.set(v, []);
      buckets.get(v).push(entry);
    }
    return { buckets, noKey };
  };
  const appendFlat = (target, items) => {
    for (const { row } of items) target.appendChild(row);
  };
  const appendGrouped = (target, items) => {
    if (!groupByPlace && !groupByCategory) { appendFlat(target, items); return; }
    if (groupByPlace) {
      const { buckets, noKey } = bucketBy(items, "place");
      const places = [...buckets.keys()].sort((a, b) => a.localeCompare(b, 'sv'));
      for (const p of places) {
        target.appendChild(makeGroupHeader(p, "place"));
        appendByCategory(target, buckets.get(p));
      }
      if (noKey.length) {
        target.appendChild(makeGroupHeader("(Ingen plats)", "place"));
        appendByCategory(target, noKey);
      }
    } else {
      appendByCategory(target, items);
    }
  };
  const appendByCategory = (target, items) => {
    if (!groupByCategory) { appendFlat(target, items); return; }
    const { buckets, noKey } = bucketBy(items, "category");
    const cats = [...buckets.keys()].sort((a, b) => a.localeCompare(b, 'sv'));
    for (const c of cats) {
      target.appendChild(makeGroupHeader(c));
      for (const { row } of buckets.get(c)) target.appendChild(row);
    }
    if (noKey.length) {
      target.appendChild(makeGroupHeader("(Ingen kategori)"));
      for (const { row } of noKey) target.appendChild(row);
    }
  };

  listInv.innerHTML = "";
  listEj.innerHTML = "";
  listInv.appendChild(makeHeader());
  listEj.appendChild(makeHeader());
  appendGrouped(listInv, invItems);
  appendGrouped(listEj, ejItems);
  visibleTags = _visible;

  const headerInv = listInv.closest(".group")?.querySelector(".groupTitle");
  const headerEj  = listEj.closest(".group")?.querySelector(".groupTitle");
  let filterText = "";
  if (!activePlaces) filterText = " (Alla)";
  else if (activePlaces.size > 0) filterText = " (" + Array.from(activePlaces).join(", ") + ")";
  if (headerInv) headerInv.textContent = `Inventerat senaste ${INVENTORY_WINDOW_DAYS} dagarna` + filterText;
  if (headerEj)  headerEj.textContent  = "Ej inventerat" + filterText;

  applyGroupOrder();

  if (_autoPrintPending && _visible.length > 0) {
    _autoPrintPending = false;
    // Vänta tills sidan är helt laddad (inkl CSS/fonts) — annars visar
    // iOS Safari "Websidan är inte helt inläst. Vill du fortsätta?".
    const triggerPrint = () => setTimeout(() => {
      hidePrintLoading();
      window.print();
    }, 100);
    if (document.readyState === 'complete') triggerPrint();
    else window.addEventListener('load', triggerPrint, { once: true });
  }
}

/* Växla ordning Inventerat/Ej inventerat */
function applyGroupOrder(){
  const gInv = listInv.closest('.group');
  const gEj  = listEj.closest('.group');
  if (!gInv || !gEj) return;
  const parent = gInv.parentElement;
  if (invertGroups) parent.insertBefore(gEj, gInv);
  else parent.insertBefore(gInv, gEj);
}

/* Gör rubrikerna klickbara */
(function(){
  const gInvHeader = listInv.closest('.group')?.querySelector('.groupHeader');
  const gEjHeader  = listEj.closest('.group')?.querySelector('.groupHeader');
  const onToggle = (e) => {
    // Klick på ?-knappen ska bara expandera hjälp, inte toggla grupp-ordning
    if (e.target.closest('.help-toggle')) return;
    invertGroups = !invertGroups;
    localStorage.setItem('vitaliseraInvertGroups', invertGroups ? '1' : '0');
    applyGroupOrder();
  };
  [gInvHeader, gEjHeader].forEach(h => {
    if (!h) return;
    h.style.cursor = 'pointer';
    h.title = 'Tryck för att byta ordning';
    h.addEventListener('click', onToggle);
  });
})();

/* ===== Dialoger ===== */
function openEditForSingle(tag) {
  const cached = tagCache.get(tag);
  if (!cached) return;
  prepareContainerDialog(cached, tag, { editMode: true });
}
function openDialog(f){
  busy=true; overlay.classList.add("blurred"); dlg.classList.remove("hidden");
  if(typeof f?.focus==="function"){f.focus();try{if(typeof f.select==="function"){const v=(f.value||"");f.setSelectionRange(0,v.length);}}catch{}}
}

/* ===== Swipe-navigering på artikelkort ===== */
(function(){
  const SWIPE_MIN = 60;
  const BASE_TX = 'translateX(-50%)';
  let sx=0, sy=0, swiping=false;

  const setTx = (extra, transition) => {
    dlg.style.transition = transition || 'none';
    dlg.style.transform = extra ? `translateX(calc(-50% + ${extra}px))` : BASE_TX;
  };
  const resetDlg = () => { dlg.style.transition = ''; dlg.style.transform = ''; dlg.style.opacity = ''; };

  dlg.addEventListener('touchstart', e => {
    if (!currentDialogTag || visibleTags.length < 2) return;
    if (e.target.closest('input, textarea, select, button, a')) return;
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; swiping = true;
  }, { passive: true });

  dlg.addEventListener('touchmove', e => {
    if (!swiping) return;
    const dx = e.touches[0].clientX - sx;
    const dy = e.touches[0].clientY - sy;
    if (Math.abs(dy) > Math.abs(dx) + 10) { swiping = false; resetDlg(); return; }
    if (Math.abs(dx) > 15) {
      setTx(dx);
      dlg.style.opacity = Math.max(0.3, 1 - Math.abs(dx) / 300);
    }
  }, { passive: true });

  dlg.addEventListener('touchend', e => {
    if (!swiping) return;
    swiping = false;
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) < SWIPE_MIN) {
      setTx(0, 'transform 0.2s, opacity 0.2s');
      dlg.style.opacity = '';
      return;
    }
    const dir = dx < 0 ? 1 : -1;
    const idx = visibleTags.indexOf(currentDialogTag);
    if (idx < 0) { resetDlg(); return; }
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= visibleTags.length) {
      setTx(0, 'transform 0.3s ease, opacity 0.3s');
      dlg.style.opacity = '';
      return;
    }
    const exitPx = dx < 0 ? -window.innerWidth : window.innerWidth;
    setTx(exitPx, 'transform 0.2s ease-out, opacity 0.2s');
    dlg.style.opacity = '0';
    setTimeout(() => {
      const nextTag = visibleTags[nextIdx];
      closeDialog();
      dlg.style.transition = 'none';
      dlg.style.transform = `translateX(calc(-50% + ${-exitPx}px))`;
      dlg.style.opacity = '0';
      requestAnimationFrame(() => {
        currentDialogTag = nextTag;
        const c = tagCache.get(nextTag);
        if (c) prepareContainerDialog(c, nextTag, { editMode: false });
        requestAnimationFrame(() => {
          dlg.style.transition = 'transform 0.25s ease-out, opacity 0.2s';
          dlg.style.transform = BASE_TX;
          dlg.style.opacity = '1';
        });
      });
    }, 200);
  }, { passive: true });
})();
// Global Escape-handler stänger toppdialog. Tab-trap inom dialogen stöds inte
// fullt ut här, men minst kan användaren backa ut utan musen.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!dlg.classList.contains('hidden')) { closeDialog(); e.preventDefault(); return; }
  if (!searchDialog.classList.contains('hidden')) { closeSearchDialog(); e.preventDefault(); return; }
  if (!settingsDialog.classList.contains('hidden')) { closeSettingsDialog(); e.preventDefault(); return; }
  if (!nameDialog.classList.contains('hidden')) { /* nameDialog kräver namn — skip */ return; }
});

function closeDialog(){
  currentDialogTag = null;
  try { dlgTitle?.blur(); } catch {}
  requestAnimationFrame(() => {
    dlg.classList.add("hidden");
    overlay.classList.remove("blurred");
    overlay.style.pointerEvents = '';
    resetDialog();
    busy = false;
    statusDefault();
    cooldown(lastCode || "__dlg__");
  });
}
// Ren delmängds-logik för delete-frysningen. Returnerar en array av
// form-noder som SKA frysas under radering: extra-divens (.extraFields)
// egna fält + de aktiva action-knapparna i dlgBtns. Sveper medvetet INTE
// hela dlg — de permanenta #newItemFields-noderna återanvänds av andra
// dialoger och får aldrig frysas (bug 3.1: missad thaw → låst ny-artikel).
function computeFreezeSet(extra, dlgBtns){
  const set = [];
  const sel = "button, input, textarea, select";
  if (extra) extra.querySelectorAll(sel).forEach(el => set.push(el));
  if (dlgBtns) dlgBtns.querySelectorAll(sel).forEach(el => { if (!set.includes(el)) set.push(el); });
  return set;
}
// Idempotent säkerhetsnät: re-enabla varje nod under root som bär kvar
// dataset._wasDisabled (läckt fruset state från en delete-väg som missade
// thaw) och rensa flaggan. Dubbel-anrop är ofarligt — efter första passet
// finns inga _wasDisabled kvar, så andra passet är en no-op.
function unfreezeStale(root){
  if (!root) return;
  root.querySelectorAll('[data-_was-disabled]').forEach(el => {
    el.disabled = el.dataset._wasDisabled === "1";
    delete el.dataset._wasDisabled;
  });
}
let _aiSuggestTimer = null;
// Bug 5.2: behållardialogens autosave-debounce (_autoSaveTimer/autoSaveExtra)
// är closure-lokal i prepareContainerDialog och kan ALDRIG nås av resetDialog.
// Swipe mellan kort river .extraFields + bygger nästa kort (~200 ms) INNAN
// debouncen (300 ms) fyrar → den orphanade autoSaveExtra läser NÄSTA kortets
// DOM men har STALE closure-tag/_sn/_rn → backend skriver fel/0 till fel rad
// och returnerar ok → falsk "Synkroniserad", tappad edit. Fixen: varje aktiv
// behållardialog registrerar sin egen flush här. resetDialog kör den SYNKRONT
// innan DOM rivs (closure-tag + rätt DOM fortfarande giltiga) och nollar den,
// så ingen orphanad debounce kan fyra mot fel kort.
let _pendingAutoSaveFlush = null;
// Ren beslutslogik (testbar utan DOM): ska en schemalagd autosave committas
// nu, och i så fall mot vilken tag? Anropas med closure-tag (artikeln fältet
// hör till) + aktuell live-dialog-tag + om detta är en explicit flush.
//  - flush=true  → committa ALLTID mot closure-tag (DOM+closure giltiga, körs
//    från resetDialog innan teardown; currentDialogTag kan redan vara null).
//  - flush=false → debounce-vägen: committa BARA om live-dialogen fortfarande
//    visar samma tag. Annars har vi navigerat bort → skippa (orphan-skydd).
function autoSaveCommitDecision(closureTag, liveDialogTag, isFlush){
  if (isFlush) return { commit: true, tag: closureTag };
  if (liveDialogTag !== closureTag) return { commit: false, tag: null };
  return { commit: true, tag: closureTag };
}
function resetDialog(){
  // Bug 5.2: flush:a pending behållar-autosave SYNKRONT innan DOM rivs nedan.
  // Här är .extraFields/#minQtyEdit + closure-tag/_sn/_rn fortfarande giltiga
  // (resetDialog körs först i både closeDialog-RAF och nästa
  // prepareContainerDialog, före .extraFields-removal). Garanterar att en
  // edit aldrig förloras p.g.a. att kortet revs före debounce.
  if (_pendingAutoSaveFlush) {
    const f = _pendingAutoSaveFlush; _pendingAutoSaveFlush = null;
    try { f(); } catch {}
  }
  // Bort med stale fokus innan vi bygger nytt innehåll. Begränsa till element INOM dlg —
  // annars blur:as t.ex. searchInput när Koppla-till-befintlig öppnar sökdialogen parallellt
  // med att den föregående dialogen stängs (closeDialog kör resetDialog i RAF).
  try {
    if (dlg.contains(document.activeElement)) document.activeElement.blur?.();
  } catch {}
  // Säkerhetsnät mot bug 3.1: om någon delete-väg missade thaw bär noder
  // kvar dataset._wasDisabled och är fortfarande disablade. Återställ dem
  // vid varje dialog-uppbyggnad så ett läckt fruset state aldrig överlever.
  unfreezeStale(dlg);
  dlgTitle.textContent="";dlgTitle.contentEditable="false";dlgTitle.oninput=null;dlgTitle.onblur=null;dlgInfo.innerHTML="";dlgBtns.innerHTML="";newItemFields.classList.add("hidden");dlgInputWrap.classList.add("hidden");dlgInput.value="";dlgInput.disabled=false;dlgInputSuffix.textContent="";manualName.value="";manualName.oninput=null;manualQty.value="";{const _mq=qs('#manualMinQty');if(_mq)_mq.value="";}if(_aiSuggestTimer){clearTimeout(_aiSuggestTimer);_aiSuggestTimer=null;}dlg.querySelectorAll('.tagScanRow,.extraFields,.aiChip,.commentBlock').forEach(el=>el.remove());
}

/* ===== Behållare-dialog ===== */
/* ===== Singel-bekräftelsedialog ===== */
function prepareSingleDialog(item, tag) {
  resetDialog();
  currentDialogTag = tag;
  const meta = metaCache.get(tag) || {};
  const toYMD = d => { if (!d) return ""; const dt = new Date(d); if (isNaN(dt)) return ""; return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`; };

  dlgTitle.textContent = item.name || "Okänd artikel";
  dlgTitle.contentEditable = "false";
  const ha=document.getElementById('help-article'); if(ha){ha.classList.remove('open'); ha.innerHTML='<b>Registrera inventering</b> bekräftar dagens inventering med ditt namn och datum.<br><b>Nytt datum</b> ändrar inventeringsdatum; rensa fältet för att avinventera artikeln.<br>"⚙️ Egenskaper" öppnar kommentar, kategori, enhet, typ, min-mängd och tag.';}

  const todayYMD = toYMD(Date.now());
  const oldDate = toYMD(meta.lastMs);
  dlgInfo.innerHTML = `
    <div class="metaTop">
      <span class="metaQty">${esc(meta.qty ?? 0)} ${esc(meta.unit ?? "")}</span>
      ${meta.user ? `<span class="metaBy"> • ${esc(meta.user)}</span>` : ""}
      ${oldDate ? `<span class="metaBy"> • ${esc(oldDate)}</span>` : ""}
    </div>
    <div class="metaDate" style="margin-top:8px">Nytt datum:<input type="date" id="singleDateEdit" value="${esc(todayYMD)}"></div>
  `;

  dlgBtns.innerHTML = `
    <button id="cancelSingle" class="btn cancel">Stäng</button>
    <button id="editSingle" class="btn icon-btn" aria-label="Egenskaper" title="Egenskaper"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
    <button id="confirmSingle" class="btn">Registrera inventering</button>
    <div id="msgLine" class="msgLine"></div>
  `;

  dlg.classList.remove("hidden");

  const dateInput = qs("#singleDateEdit");
  dateInput.addEventListener('change', () => {
    const newVal = dateInput.value;
    if (!newVal) {
      // Rensa datum = avinventera
      gasCall('updateMeta', {tag, args: {clearTimestamp: true, clearUser: true, userName: ''}});
      setLocalMeta(tag, { lastMs: 0, user: '' });
      recomputeMaxLast(); renderLists();
      const ml = qs("#msgLine"); if(ml){ml.className='msgLine ok';ml.textContent='Datum rensat — artikeln avinventerad';}
    } else {
      const ms = new Date(newVal + 'T12:00:00').getTime();
      gasCall('updateMeta', {tag, args: {lastYMD: newVal, userName}});
      setLocalMeta(tag, { lastMs: ms, user: userName });
      recomputeMaxLast(); renderLists();
      const ml = qs("#msgLine"); if(ml){ml.className='msgLine ok';ml.textContent='Datum uppdaterat';}
    }
  });

  qs("#confirmSingle").onclick = () => {
    dlg.classList.add("hidden");
    Save.logSingle(tag, { name: item.name, sheetName: item.sheetName, rowNum: item.rowNum });
    statusDefault();
  };

  qs("#editSingle").onclick = () => {
    prepareContainerDialog(item, tag, { editMode: true });
  };

  qs("#cancelSingle").onclick = () => {
    dlg.classList.add("hidden");
    statusDefault();
  };
}

function prepareContainerDialog(item, tag, opts = {}) {
  resetDialog();
  const ha=document.getElementById('help-article'); if(ha){ha.classList.remove('open'); ha.innerHTML='Tryck <b>−</b> eller <b>+</b> för att räkna upp/ner med 1 åt gången, eller tappa siffran och skriv in en helt ny total.<br><b>Spara</b> bekräftar mängden och stänger dialogen.<br><b>Nytt datum</b> ändrar inventeringsdatum; rensa fältet för att avinventera.<br>Tryck på artikelnamnet för att byta namn.<br>"⚙️ Egenskaper" visar kommentar, kategori, enhet, typ, min-mängd och tag (tag sparas direkt när du skannar).';}

  const editMode = opts.editMode === true;
  // Reset per dialog: editMode (Fler fält från singel) öppnar expanderat,
  // alla andra ingångar börjar kollapsade så det blir konsekvent UX.
  extraFieldsExpanded = editMode;
  const meta = metaCache.get(tag) || {};
  const _sn = item.sheetName || null;
  const _rn = item.rowNum || null;
  const dialogItem = {
    ...item,
    qty: meta.qty ?? 0,
    unit: meta.unit ?? "",
    user: meta.user ?? "",
    lastMs: meta.lastMs ?? Date.now(),
    minQty: item.minQty ?? 0,
    comment: item.comment ?? ""
  };

  const toYMD = d => {
    if (!d) return "";
    const dt = new Date(d);
    if (isNaN(dt)) return "";
    const y = dt.getFullYear(), m = String(dt.getMonth()+1).padStart(2,"0"), da = String(dt.getDate()).padStart(2,"0");
    return `${y}-${m}-${da}`;
  };
  const isoDate = toYMD(Date.now());
  const setMsg = (text, cls) => { msgLine.className = `msgLine ${cls||""}`; msgLine.textContent = text || ""; };
  const setBtnBusy = (btn, busy=true, labelWhenIdle) => {
    if (!btn) return;
    if (busy) { btn.classList.add("loading"); btn.disabled = true; }
    else { btn.classList.remove("loading"); btn.disabled = false; if (labelWhenIdle) btn.textContent = labelWhenIdle; }
  };
  const validNumber = v => !isNaN(v) && isFinite(v);

  dlgTitle.textContent = dialogItem.name || "Okänd artikel";
  dlgTitle.contentEditable = "true";
  dlgTitle.style.textAlign = "center";
  dlgTitle.style.fontWeight = "700";

  let pendingName = dialogItem.name;
  const commitName = () => {
    const n = (pendingName || "").trim();
    if (n && n !== dialogItem.name) {
      dialogItem.name = n;
      tagCache.set(tag, { ...tagCache.get(tag), name: n });
      // D (samma klass): .catch(console.log) svalde fel TYST — användaren såg
      // det nya namnet i UI:t men det kunde aldrig ha sparats. Verifierat via
      // classifyLinkResult; ej-bekräftat → ⚠️-banner (ingen tyst förlust).
      // gasCallWithRetry → exhausted/nätfel skiljs från äkta server-avvisning.
      gasCallWithRetry('updateName', {tag, newName: n, sheetName: dialogItem.sheetName, rowNum: dialogItem.rowNum})
        .then(res => {
          if (classifyLinkResult(res) !== 'verified') {
            show("Namnbyte kunde inte bekräftas — försök igen", "warn");
          }
        })
        .catch(() => show("Namnbyte kunde inte bekräftas — försök igen", "warn"));
      renderLists();
    }
  };
  // .oninput/.onblur (INTE addEventListener) — dlgTitle är en permanent DOM-nod
  // som återanvänds för varje dialog-öppning. addEventListener skulle stacka
  // gamla lyssnare med stale closures över gamla tag/rowNum, så ett namnbyte
  // skulle triggra updateName för varje tidigare öppnad artikel.
  dlgTitle.oninput = () => (pendingName = dlgTitle.textContent.trim());
  dlgTitle.onblur = commitName;

  const oldDate = toYMD(dialogItem.lastMs);
  const unitSuffix = (dialogItem.unit || "").trim();
  dlgInfo.innerHTML = `
    <div class="metaTop">
      <span class="metaQty">${esc(dialogItem.qty)} ${esc(dialogItem.unit)}</span>
      ${dialogItem.user ? `<span class="metaBy"> • ${esc(dialogItem.user)}</span>` : ""}
      ${oldDate ? `<span class="metaBy"> • ${esc(oldDate)}</span>` : ""}
    </div>
    <div class="metaDate" style="margin-top:8px">Nytt datum:<input type="date" id="containerDateEdit" value="${esc(isoDate)}"></div>
  `;

  // Singel-artiklar har ingen mängd att stega — visa Egenskaper-panelen
  // utan stepper, och behåll "Registrera inventering" som primary-knapp.
  // Behållare visar stepper + Spara som tidigare.
  const isSingle = (item.type || "singel") === "singel";

  if (isSingle) {
    dlgInputWrap.classList.add("hidden");
  } else {
    dlgInputWrap.classList.remove("hidden");
    dlgInput.style.display = "block";
    dlgInput.value = dialogItem.qty;
    dlgInput.placeholder = "Mängd";
    // Enheten visas som dekorativt suffix inuti fältet (t.ex. "ml" till höger).
    // CSS lämnar plats via padding-right så texten inte överlappar.
    dlgInputSuffix.textContent = unitSuffix || "";
  }

  const _gearBtnHTML = `<button id="toggleMore" class="btn icon-btn" aria-label="Egenskaper" title="Egenskaper"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>`;
  dlgBtns.innerHTML = isSingle
    ? `<button id="cancelUpdate" class="btn cancel">Stäng</button>${_gearBtnHTML}<button id="registerSingleBtn" class="btn">Registrera inventering</button><div id="msgLine" class="msgLine"></div>`
    : `<button id="cancelUpdate" class="btn cancel">Stäng</button>${_gearBtnHTML}<button id="saveBtn" class="btn">Spara</button><div id="msgLine" class="msgLine"></div>`;
  const _commentInitial = (dialogItem.comment || "").trim();
  const commentBlock = document.createElement('div');
  commentBlock.className = 'commentBlock';
  commentBlock.innerHTML = `
    <label for="commentEdit">Kommentar</label>
    <textarea id="commentEdit" rows="2">${esc(_commentInitial)}</textarea>
  `;
  dlg.querySelectorAll('.commentBlock').forEach(e => e.remove());
  // Comment FÖRE dlgBtns så knappraden alltid sitter sist (sticky bottom).
  dlgBtns.parentNode.insertBefore(commentBlock, dlgBtns);

  const saveBtn = qs("#saveBtn"), registerSingleBtn = qs("#registerSingleBtn"),
        toggleMore = qs("#toggleMore"),
        cancelBtn = qs("#cancelUpdate"), msgLine = qs("#msgLine");
  const primaryBtn = saveBtn || registerSingleBtn;

  // #34: EN verifierad datum-commit-väg. Anropas av BÅDE change-handlern
  // (iOS-opålitlig men snabb när den fyrar) OCH saveBtn (säker fallback även
  // vid oförändrat saldo). decideDateCommit garanterar att samma värde inte
  // dubbel-committas — _lastCommittedDate börjar = oldDate (originalvärdet)
  // och uppdateras synkront FÖRE gasCall så en efterföljande saveBtn ser att
  // change-handlern redan tagit hand om det. Resultatet verifieras via
  // classifyLinkResult (samma sanningskälla som linkTag/logSingle):
  //   verified    → ✅ + markAsDone
  //   pending-retry → ⚠️ "sparas när du är online igen" (optimistisk lokal
  //                    write står kvar; gul rad via pendingSync-mönstret)
  //   rejected    → ⚠️ markLogFail (t.ex. staleRow från _staleRowGuard_)
  let _lastCommittedDate = oldDate;            // init = artikelns datum vid öppning
  const commitContainerDate = (newVal) => {
    const dec = decideDateCommit(oldDate, newVal, _lastCommittedDate);
    if (dec.action === 'none') return false;
    // Markera committat FÖRE async så samtidig saveBtn ser no-op (ingen dubbel).
    _lastCommittedDate = dec.action === 'clear' ? '' : dec.ymd;
    const isClear = dec.action === 'clear';
    // Snapshot FÖRE optimistisk overwrite — exakt återställning vid server-avvisning.
    const _prevMeta = { ...(metaCache.get(tag) || {}) };
    const _prevItem = { ...(tagCache.get(tag) || {}) };
    const le = appendLog(
      isClear ? `${dialogItem.name} – datum rensat (avinventerad)`
              : `${dialogItem.name} – datum ${dec.ymd}`, tag);
    if (isClear) {
      setLocalMeta(tag, { lastMs: 0, user: '' });
    } else {
      const ms = new Date(dec.ymd + 'T12:00:00').getTime();
      setLocalMeta(tag, { lastMs: ms, user: userName });
    }
    // pendingSync skyddar den optimistiska writen mot poll-rebuild: initData
    // snapshotar BARA pendingSync-poster, annars klobbras lastMs av stale
    // server-preload (CacheService TTL 600s) inom ~15 s → artikeln hoppar
    // tillbaka till "Ej inventerat" tills nästa synk.
    tagCache.set(tag, { ...(tagCache.get(tag) || {}), pendingSync: true });
    recomputeMaxLast(); renderLists();
    // sheetName/rowNum krävs: tagglösa rader har syntetisk S-tag som backend
    // resolveItem ej kan slå upp utan koordinater (→ "tagg ej hittad" → falsk pending).
    const args = isClear
      ? { clearTimestamp: true, clearUser: true, userName: '', sheetName: dialogItem.sheetName, rowNum: dialogItem.rowNum }
      : { lastYMD: dec.ymd, userName, sheetName: dialogItem.sheetName, rowNum: dialogItem.rowNum };
    gasCallWithRetry('updateMeta', { tag, args })
      .then(res => {
        const cls = classifyLinkResult(res);
        if (cls === 'verified') {
          // Server bekräftad → släpp pendingSync så server blir sanningskälla
          // igen vid nästa poll; rensa gul markering direkt.
          tagCache.set(tag, { ...(tagCache.get(tag) || {}), pendingSync: false });
          recomputeMaxLast(); renderLists();
          markAsDone(le);
        } else if (cls === 'pending-retry') {
          // Offline: behåll pendingSync — optimistisk write överlever poll.
          if (le) {
            const ic = le.querySelector('.icon'); if (ic) ic.textContent = '⚠️';
            const m = le.querySelector('.msg');
            if (m) m.textContent += ' – sparas när du är online igen';
          }
        } else {
          // Server AVVISADE (t.ex. staleRow) → rulla tillbaka optimistisk write.
          metaCache.set(tag, _prevMeta);
          tagCache.set(tag, { ..._prevItem, pendingSync: false });
          recomputeMaxLast(); renderLists();
          markLogFail(le, new Error((res && res.msg) || 'serverfel'));
        }
      })
      .catch(err => markLogFail(le, err));
    return true;
  };

  const containerDateInput = qs("#containerDateEdit");
  if (containerDateInput) {
    containerDateInput.addEventListener('change', () => {
      if (commitContainerDate(containerDateInput.value)) {
        setMsg(containerDateInput.value
          ? 'Datum uppdaterat' : 'Datum rensat — artikeln avinventerad', 'ok');
      }
    });
  }

  // Unika kategorier för samma flik (för kategorival i select).
  const sheetForItem = item.sheetName || item.place || "";
  const categorySet = new Set();
  for (const v of tagCache.values()) {
    const c = (v?.category || "").trim();
    if (!c) continue;
    const vSheet = v.sheetName || v.place || "";
    if (sheetForItem && vSheet !== sheetForItem) continue;
    categorySet.add(c);
  }
  const currentCat = (dialogItem.category || "").trim();
  const catList = [...categorySet].sort((a,b) => a.localeCompare(b, 'sv'));
  // Se till att nuvarande värde alltid finns med i listan även om det inte finns på andra rader på fliken
  if (currentCat && !catList.includes(currentCat)) catList.unshift(currentCat);
  const categoryOptions = catList.map(c =>
    `<option value="${esc(c)}"${c === currentCat ? " selected" : ""}>${esc(c)}</option>`
  ).join('');

  // Unika enheter för enhets-select.
  const currentUnit = (dialogItem.unit || "").trim();
  const unitList = collectUnits();
  if (currentUnit && !unitList.includes(currentUnit)) unitList.unshift(currentUnit);
  const unitOptions = unitList.map(u =>
    `<option value="${esc(u)}"${u === currentUnit ? " selected" : ""}>${esc(u)}</option>`
  ).join('');

  // Unika platser (kolumn B) för samma flik.
  const placeSetEdit = new Set();
  for (const v of tagCache.values()) {
    const sp = (v?.sheetPlace || "").trim();
    if (!sp) continue;
    const vSheet = v.sheetName || v.place || "";
    if (sheetForItem && vSheet !== sheetForItem) continue;
    placeSetEdit.add(sp);
  }
  const currentPlace = (dialogItem.sheetPlace || "").trim();
  const placeListEdit = [...placeSetEdit].sort((a,b) => a.localeCompare(b, 'sv'));
  if (currentPlace && !placeListEdit.includes(currentPlace)) placeListEdit.unshift(currentPlace);
  const placeOptionsEdit = placeListEdit.map(p =>
    `<option value="${esc(p)}"${p === currentPlace ? " selected" : ""}>${esc(p)}</option>`
  ).join('');

  const extra = document.createElement("div");
  extra.className = "extraFields";
  extra.innerHTML = `
    <div class="extraFieldsHeader">Egenskaper</div>
    <label>Plats</label>
    <select id="placeEdit">
      <option value=""${!currentPlace ? " selected" : ""}>(ingen)</option>
      ${placeOptionsEdit}
      <option value="__new__">+ Ny plats…</option>
    </select>
    <input id="placeNew" type="text" placeholder="Ange ny plats" style="display:none;margin-top:4px">

    <label>Kategori</label>
    <select id="categoryEdit">
      <option value=""${!currentCat ? " selected" : ""}>(ingen)</option>
      ${categoryOptions}
      <option value="__new__">+ Ny kategori…</option>
    </select>
    <input id="categoryNew" type="text" placeholder="Ange ny kategori" style="display:none;margin-top:4px">

    <label>Enhet</label>
    <select id="unitEdit">
      <option value=""${!currentUnit ? " selected" : ""}>(ingen)</option>
      ${unitOptions}
      <option value="__new__">+ Ny enhet…</option>
    </select>
    <input id="unitNew" type="text" placeholder="Ange ny enhet" style="display:none;margin-top:4px">

    <label>Typ</label>
    <select id="typeEdit">
      <option value="singel"${(item.type||"singel")==="singel"?" selected":""}>Singel</option>
      <option value="behållare"${(item.type||"")==="behållare"?" selected":""}>Behållare</option>
    </select>

    <label>Mängd som ska finnas under kurs</label>
    <input id="minQtyEdit" type="number" inputmode="decimal" value="${esc(dialogItem.minQty)}">

    <label>Tag <span style="font-weight:400;font-size:0.8em;opacity:0.7">(sparas direkt vid skanning)</span></label>
    <div class="tagRow">
      <input id="tagDisplay" type="text" value="${esc(tag.startsWith('S') ? '(ingen tag)' : tag)}" readonly title="Klicka för att se hela taggen">
      <button id="scanTagBtn" class="btn" type="button">Skanna tag</button>
    </div>

    <div class="deleteRow">
      <button id="deleteItemBtn" class="btn delete" type="button">Radera artikel</button>
    </div>
  `;
  dlg.querySelectorAll(".extraFields").forEach(e => e.remove());
  // FÖRE dlgBtns så extraFields scrollar bakom sticky-knapparna istället för
  // att täckas av dem i toppen när de expanderas.
  dlgBtns.parentNode.insertBefore(extra, dlgBtns);
  extra.style.display = extraFieldsExpanded ? "block" : "none";
  toggleMore.classList.toggle('expanded', extraFieldsExpanded);

  // Lyssna på pointerup istället för click — iOS slukar ibland click-eventet
  // när det första trycket bara stänger tangentbordet (input-blur).
  // Pointerup eldas före click, så toggle-actionen körs alltid.
  let _toggleTs = 0;
  const toggleAction = () => {
    if (Date.now() - _toggleTs < 300) return; // dedupe pointerup+click
    _toggleTs = Date.now();
    const vis = extra.style.display !== "none";
    extra.style.display = vis ? "none" : "block";
    toggleMore.classList.toggle('expanded', !vis);
    extraFieldsExpanded = !vis;
  };
  toggleMore.addEventListener('pointerup', toggleAction);
  toggleMore.addEventListener('click', toggleAction);

  // I editMode — phantom-tap från föregående dialog kan annars landa på
  // dlgInput och poppa upp tangentbordet. Blur omedelbart.
  if (editMode) {
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (a && a !== document.body && typeof a.blur === 'function') a.blur();
    });
  }

  // Plats: visa ny-textinput när "+ Ny plats…" valts
  const placeSelEdit = extra.querySelector("#placeEdit");
  const placeNewEdit = extra.querySelector("#placeNew");
  if (placeSelEdit && placeNewEdit) {
    placeSelEdit.addEventListener("change", () => {
      const isNew = placeSelEdit.value === "__new__";
      placeNewEdit.style.display = isNew ? "block" : "none";
      if (isNew) { placeNewEdit.value = ""; placeNewEdit.focus(); }
    });
  }

  // Kategori: visa ny-textinput när "+ Ny kategori…" valts
  const catSel = extra.querySelector("#categoryEdit");
  const catNew = extra.querySelector("#categoryNew");
  if (catSel && catNew) {
    catSel.addEventListener("change", () => {
      const isNew = catSel.value === "__new__";
      catNew.style.display = isNew ? "block" : "none";
      if (isNew) { catNew.value = ""; catNew.focus(); }
    });
  }

  // Enhet: visa ny-textinput när "+ Ny enhet…" valts
  const unitSel = extra.querySelector("#unitEdit");
  const unitNew = extra.querySelector("#unitNew");
  if (unitSel && unitNew) {
    unitSel.addEventListener("change", () => {
      const isNew = unitSel.value === "__new__";
      unitNew.style.display = isNew ? "block" : "none";
      if (isNew) { unitNew.value = ""; unitNew.focus(); }
    });
  }

  // Skanna tag-knapp. `cached` lyfts till funktionsnivå så scanTagBtn-handlern
  // kan referera den utan ReferenceError-risk (var tidigare block-scoped i tagDisplay-blocket).
  const scanTagBtn = extra.querySelector("#scanTagBtn");
  const tagDisplay = extra.querySelector("#tagDisplay");
  const cached = tagCache.get(tag);
  if (tagDisplay) {
    tagDisplay.addEventListener("click", () => {
      const primary = tag.startsWith("S") ? null : tag;
      const alts = cached?.altTags || [];
      const all = [primary, ...alts].filter(Boolean);
      if (!all.length) { show("Ingen tag kopplad ännu", "warn"); return; }
      const label = all.length === 1 ? "Tag" : "Taggar";
      show(`${label}: ${all.join(" • ")}`, "ok", { autoreset: false });
    });
  }
  if (scanTagBtn) {
    scanTagBtn.onclick = () => {
      startTagScanMode(async (scannedTag) => {
        const targetName = cached?.name || tag;
        setMsg("Sparar tag…", "");
        const result = await Save.linkTag(scannedTag, {
          name: targetName,
          sheetName: _sn || (cached?.place),
          rowNum: _rn || (cached?.rowNum),
          currentTag: tag
        });
        if (result.ok) {
          tagDisplay.value = result.tag;
          tagDisplay.style.opacity = "1";
          setMsg("Tag kopplad!", "ok");
          renderLists();
        } else if (result.pending) {
          // Bug 2.7: ej bekräftat (offline/uttömt) — ingen falsk "kopplad",
          // raden står kvar gul + ⚠️, online-resync försöker igen.
          setMsg("Ingen kontakt — sparas när du är online igen", "warn");
          renderLists();
        } else if (result.collision) {
          setMsg(`Taggen är redan kopplad till "${result.res.existingName}"`, "warn");
        } else if (result.err) {
          setMsg("Fel: " + (result.err.message || result.err), "warn");
        } else {
          setMsg(result.res?.msg || "Kunde inte spara tag", "warn");
        }
      });
    };
  }

  if (opts.loading === true) {
    const loader = document.createElement("div");
    loader.id = "dialogLoader";
    Object.assign(loader.style, {
      position: "absolute", inset: "0", background: "rgba(255,255,255,0.85)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: "2000"
    });
    loader.innerHTML = `<div class="spinner"></div>`;
    dlg.appendChild(loader);
    dlg.classList.add("loading");
    // 3.1/3.2-fix: tagga _wasDisabled (spegel av delete-freeze ~3516) så
    // resetDialogs unfreezeStale ALLTID kan återställa korrekt disabled-state
    // även om updateDialogWithFreshData (enda re-enable, rad ~3571) aldrig
    // körs (fresh-fetch failar/avbryts vid långsam backend). Utan markören
    // läckte blanket-disable → permanenta #manual*-noder fast disabled i
    // nästa "Ny artikel"-dialog (Malins 3.1/3.2 "BUG!").
    dlg.querySelectorAll("button, input, textarea").forEach(e => { e.dataset._wasDisabled = e.disabled ? "1" : "0"; e.disabled = true; });
  }

  const markError = (el, on=true) => el && el.classList[on ? "add" : "remove"]("input-error");
  const normDate = v => {
    const s = (v||"").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (isNaN(d)) return "";
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,"0"), da = String(d.getDate()).padStart(2,"0");
    return `${y}-${m}-${da}`;
  };

  // Stepper [−]/[+] justerar siffran med 1 åt gången. Användaren kan också
  // tappa siffran och skriva en ny total direkt. Spara skickar den slutliga
  // siffran till samma updateCount-API som de gamla Öka/Ny total-knapparna.
  const qtyDecBtn = qs("#qtyDec");
  const qtyIncBtn = qs("#qtyInc");
  const adjustQty = (delta) => {
    const v = parseFloat((dlgInput.value || "0").replace(",", ".")) || 0;
    const next = Math.max(0, v + delta);
    dlgInput.value = String(next);
    markError(dlgInput, false);
    setMsg("", "");
  };
  if (qtyDecBtn) qtyDecBtn.onclick = () => adjustQty(-1);
  if (qtyIncBtn) qtyIncBtn.onclick = () => adjustQty(1);

  // Markera siffran på focus så användaren kan skriva en ny total direkt
  // utan att först radera. Och Enter på tangentbordet sparar — slipper
  // tappa bort sig till knappen.
  dlgInput.onfocus = () => { try { dlgInput.select(); } catch {} };
  dlgInput.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); primaryBtn?.click(); }
  };

  // Singel-läge: registerSingleBtn ersätter saveBtn med qty=1 logTag-flow
  // (samma som confirmSingle i prepareSingleDialog).
  if (registerSingleBtn) {
    registerSingleBtn.onclick = () => {
      commitName();
      Save.logSingle(tag, { name: dialogItem.name, sheetName: _sn, rowNum: _rn });
      closeDialog();
    };
  }

  if (saveBtn) saveBtn.onclick = () => {
    commitName();
    setMsg("", ""); markError(dlgInput, false);
    const val = parseFloat((dlgInput.value || "").replace(",", "."));
    if (!validNumber(val)) { markError(dlgInput, true); setMsg("Ogiltigt tal i fältet.", "warn"); return; }
    const newCount = val;
    const oldCount = Number(dialogItem.qty) || 0;
    // #34: hantera ALLA fyra kombinationer av (saldo ändrat × datum ändrat).
    // commitContainerDate är idempotent via decideDateCommit/_lastCommittedDate
    // → om change-handlern redan sparade exakt samma datum blir detta no-op
    // (ingen dubbel-commit). Vid oförändrat saldo MEN ändrat datum sparas nu
    // datumet verifierat (förut: tyst förlust — `return` hoppade förbi det).
    if (newCount === oldCount) {
      const dc = containerDateInput ? containerDateInput.value : undefined;
      if (containerDateInput) commitContainerDate(dc);
      closeDialog();
      return;
    }
    // Saldo ÄNDRAT: spara ev. även datum-ändring (no-op om redan committat).
    if (containerDateInput) commitContainerDate(containerDateInput.value);

    // Logg-text speglar vad användaren gjorde — delta för stepper-justering,
    // total för manuell omskrivning. Heuristik: hopp > 5 i ett enda ändringssteg
    // är troligen direkt-edit, inte +/−-trampning.
    const delta = newCount - oldCount;
    const logText = Math.abs(delta) <= 5
      ? `${dialogItem.name} – ny mängd ${newCount}`
      : `${dialogItem.name} – total ändrad till ${newCount}`;
    const le = appendLog(logText);

    // Optimistic: uppdatera lokalt + stäng dialog direkt. Synk i bakgrunden.
    setLocalMeta(tag, { qty: newCount, lastMs: Date.now(), user: userName });
    recomputeMaxLast(); renderLists();
    show(`${dialogItem.name}: ny mängd ${newCount}.`, "ok");
    closeDialog();

    gasCall('updateCount', {tag, newCount, user: userName, sheetName: _sn, rowNum: _rn})
      .then(assertOk)
      .then(() => markAsDone(le))
      .catch(err => markLogFail(le, err));
  };

  // Auto-save vid blur/change — moderna apps (Notion, Linear) auto-sparar
  // metadata. Slipper "Spara fält"-knapp som förvirrade användaren med
  // mode-konflikt mot Öka/Ny total. Debounce 300ms så snabb-tabbing genom
  // flera fält bara skickar en save.
  let _autoSaveTimer = null;
  // isFlush=true: anropas synkront från resetDialog (via _pendingAutoSaveFlush)
  // INNAN .extraFields rivs — closure-tag/_sn/_rn + DOM giltiga, committa alltid.
  // isFlush=false: debounce-timern fyrade. Om live-dialogen inte längre visar
  // closure-tag har vi navigerat bort (orphan efter swipe) → skippa helt så vi
  // aldrig bygger en payload mot nästa korts DOM med STALE tag/_sn/_rn (5.2).
  const autoSaveExtra = (isFlush) => {
    const decision = autoSaveCommitDecision(tag, currentDialogTag, isFlush === true);
    if (!decision.commit) return;
    setMsg("", "");
    const commentEl = qs("#commentEdit");
    const unitEl = qs("#unitEdit");
    const minEl = qs("#minQtyEdit");
    const dateEl = qs("#dateEdit");

    [commentEl, unitEl, minEl, dateEl].filter(Boolean).forEach(el => markError(el, false));

    const date = dateEl ? normDate(dateEl.value) : "";
    const minQty = parseFloat((minEl.value || "0").replace(",", "."));

    if (dateEl && !date) { markError(dateEl, true); setMsg("Datum är ogiltigt.", "warn"); return; }
    if (!validNumber(minQty) || minQty < 0) { markError(minEl, true); setMsg("Min-mängd ogiltigt.", "warn"); return; }

    const comment = commentEl.value.trim();
    const unitRaw = unitEl.value.trim();
    const unit = unitRaw === "__new__"
      ? (qs("#unitNew")?.value || "").trim()
      : unitRaw;
    const typeVal = (qs("#typeEdit")?.value || "singel").toLowerCase();
    const catRaw = (qs("#categoryEdit")?.value || "").trim();
    const category = catRaw === "__new__"
      ? (qs("#categoryNew")?.value || "").trim()
      : catRaw;
    const placeRaw = (qs("#placeEdit")?.value || "").trim();
    const sheetPlace = placeRaw === "__new__"
      ? (qs("#placeNew")?.value || "").trim()
      : placeRaw;

    // Skip auto-save tills "+ Ny..."-text-input har innehåll. Annars
    // skickar vi tomt värde direkt vid select-change innan användaren
    // hunnit skriva in det nya namnet.
    if (unitRaw === "__new__" && !unit) return;
    if (catRaw === "__new__" && !category) return;
    if (placeRaw === "__new__" && !sheetPlace) return;

    tagCache.set(tag, { ...tagCache.get(tag), comment, unit, minQty, type: typeVal, category, sheetPlace, pendingSync: true });

    const patch = { unit };
    if (date) patch.lastStr = date;
    setLocalMeta(tag, patch);
    recomputeMaxLast();

    setMsg("Sparat ✓", "ok");

    renderLists();

    const payload = { tag, comment, unit, minQty, type: typeVal, category, place: sheetPlace, userName, sheetName: _sn, rowNum: _rn };
    if (date) payload.lastYMD = date;
    queueUpdate("updateMeta", payload);
  };
  // Synkron flush som resetDialog kör innan kortet rivs: avbryt den pending
  // debouncen (annars kan den orphanas och fyra mot nästa kort) och committa
  // omedelbart mot DENNA closures tag/_sn/_rn medan DOM ännu är giltig.
  const flushAutoSave = () => {
    if (_autoSaveTimer) { clearTimeout(_autoSaveTimer); _autoSaveTimer = null; }
    autoSaveExtra(true);
  };
  const scheduleAutoSave = () => {
    clearTimeout(_autoSaveTimer);
    // Registrera DENNA dialogs flush globalt så resetDialog (utan closure-
    // åtkomst) kan committa den synkront före teardown/kortbyte. Ingen ny
    // permanent listener — flushen lever i samma closure som debouncen och
    // konsumeras av resetDialog (nollar handtaget) eller av timern själv.
    _pendingAutoSaveFlush = flushAutoSave;
    _autoSaveTimer = setTimeout(() => { _pendingAutoSaveFlush = null; autoSaveExtra(false); }, 300);
  };

  // Selects → change-event. Text/textarea/number → blur-event.
  // Kommentar-fältet ligger utanför .extraFields (i commentBlock), använd qs().
  ['#placeEdit', '#categoryEdit', '#unitEdit', '#typeEdit'].forEach(sel => {
    extra.querySelector(sel)?.addEventListener('change', scheduleAutoSave);
  });
  ['#minQtyEdit', '#placeNew', '#categoryNew', '#unitNew'].forEach(sel => {
    extra.querySelector(sel)?.addEventListener('blur', scheduleAutoSave);
  });
  // 5.2-fix: #minQtyEdit sparade ENBART på blur. Ändras "antal som ska finnas"
  // och man navigerar vidare snabbt (flera artiklar i rad) UTAN att fältet
  // blur:ar → scheduleAutoSave kördes aldrig → _pendingAutoSaveFlush förblev
  // null → resetDialogs synkrona flush blev no-op → editen tyst förlorad i
  // BÅDE PWA och Sheet. 'input' registrerar flushen direkt; resetDialog
  // committar den då synkront mot rätt closure-tag vid teardown. Samma
  // debounce/orphan-skydd (scheduleAutoSave är clearTimeout-idempotent).
  extra.querySelector('#minQtyEdit')?.addEventListener('input', scheduleAutoSave);
  qs('#commentEdit')?.addEventListener('blur', scheduleAutoSave);
  // P4 (samma 5.2-klass som P1 #minQtyEdit): #placeNew/#categoryNew/#unitNew/
  // #commentEdit sparade ENBART på blur → tyst förlorade vid snabb navigering
  // utan att fältet blur:ar. 'input' registrerar flushen direkt så resetDialog
  // committar den synkront mot rätt closure-tag vid teardown. Samma debounce/
  // orphan-skydd (scheduleAutoSave är clearTimeout-idempotent).
  ['#placeNew', '#categoryNew', '#unitNew'].forEach(sel => {
    extra.querySelector(sel)?.addEventListener('input', scheduleAutoSave);
  });
  qs('#commentEdit')?.addEventListener('input', scheduleAutoSave);

  // pointerup + click-dedupe så Stäng funkar även när tangentbordet är uppe
  // (iOS slukar ibland click-eventet efter input-blur).
  let _cancelTs = 0;
  const cancelAction = () => {
    if (Date.now() - _cancelTs < 300) return;
    _cancelTs = Date.now();
    closeDialog(); show("Avbrutet", "warn");
  };
  cancelBtn.addEventListener('pointerup', cancelAction);
  cancelBtn.addEventListener('click', cancelAction);

  // Radera artikel
  const deleteBtn = extra.querySelector("#deleteItemBtn");
  if (deleteBtn) {
    // Nya artiklar (pendingSync) saknar bekräftad rowNum — radering skulle misslyckas.
    const cached = tagCache.get(tag);
    const canDelete = !!_rn && !cached?.pendingSync;
    if (!canDelete) {
      deleteBtn.disabled = true;
      deleteBtn.title = "Vänta tills artikeln synkats";
    }
    let confirmArmed = false;
    let armTimer = null;
    deleteBtn.onclick = async () => {
      if (!confirmArmed) {
        confirmArmed = true;
        const prev = deleteBtn.textContent;
        deleteBtn.textContent = "Tryck igen för att bekräfta";
        deleteBtn.classList.add("confirm");
        armTimer = setTimeout(() => {
          confirmArmed = false;
          deleteBtn.textContent = prev;
          deleteBtn.classList.remove("confirm");
        }, 4000);
        return;
      }
      clearTimeout(armTimer);
      // Frys dialogen under radering — annars kan Spara-klick lägga till updateMeta
      // i kön EFTER att raden raderats, och raderar i princip vad som nu ligger på samma row.
      // OBS: bara extra-divens (.extraFields) fält + de aktiva dlgBtns-knapparna fryses.
      // De permanenta #newItemFields-noderna (#manual*) ligger också i dlg men återanvänds
      // av ny-artikel-dialogen — fryser vi dem och missar thaw låser sig nästa dialog.
      const frozen = computeFreezeSet(extra, dlgBtns);
      frozen.forEach(el => { el.dataset._wasDisabled = el.disabled ? "1" : "0"; el.disabled = true; });
      setBtnBusy(deleteBtn, true);
      setMsg("Raderar…", "");
      const tagAtClick = tag;
      const thawDialog = () => {
        frozen.forEach(el => { el.disabled = el.dataset._wasDisabled === "1"; delete el.dataset._wasDisabled; });
      };
      try {
        // deleteRow shiftar rader — flush:a köade batch-jobb först annars skrivs
        // uppdateringar till fel rad.
        if (updateQueue.length > 0 || flushInFlight) {
          setMsg("Synkar pending ändringar…", "");
          await waitForPendingSync();
        }
        const res = await gasCall('deleteItem', { tag, sheetName: _sn, rowNum: _rn });
        if (!res || res.ok === false) {
          setMsg(res?.msg || "Kunde inte radera", "warn");
          setBtnBusy(deleteBtn, false);
          thawDialog();
          confirmArmed = false;
          deleteBtn.textContent = "Radera artikel";
          deleteBtn.classList.remove("confirm");
          return;
        }
        tagCache.delete(tag);
        metaCache.delete(tag);
        recomputeMaxLast();
        renderLists();
        // Tina ALLTID innan vi stänger — symmetriskt med error/catch-vägarna.
        // closeDialog→resetDialog städar inte godtyckliga frysta noder, så
        // utan detta läcker fruset state till nästa dialog (bug 3.1).
        thawDialog();
        // Stäng bara dialogen om samma artikel fortfarande är öppen.
        if (currentDialogTag === tagAtClick) closeDialog();
        show(`"${item.name || tag}" raderad`, "ok");
      } catch (err) {
        setMsg("Fel: " + (err?.message || err), "warn");
        setBtnBusy(deleteBtn, false);
        thawDialog();
        confirmArmed = false;
        deleteBtn.textContent = "Radera artikel";
        deleteBtn.classList.remove("confirm");
      }
    };
  }

  openDialog(dlgInput);
}

function updateDialogWithFreshData(tag, freshItem) {
  const box = qs("#dialogBox");
  if (!box) return;

  box.classList.remove("loading");
  qs("#dialogLoader")?.remove();
  box.querySelectorAll("button, input, textarea").forEach(el => el.disabled = false);

  metaCache.set(tag, {
    qty: Number(freshItem.qty) || 0,
    unit: freshItem.unit || "",
    user: freshItem.user || "",
    lastMs: toDayMs(freshItem.last),
    lastStr: fmtDate(freshItem.last)
  });

  const old = tagCache.get(tag) || {};
  const merged = { ...old, ...freshItem };
  tagCache.set(tag, merged);

  const normalizeNum = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
  const normalizeStr = v => (v == null ? "" : String(v).trim().toLowerCase());

  const changed = [];
  const metaNow = metaCache.get(tag) || {};
  if (normalizeNum(freshItem.qty) !== normalizeNum(metaNow.qty)) changed.push("mängd");
  if (normalizeStr(freshItem.unit) !== normalizeStr(metaNow.unit)) changed.push("enhet");
  if (normalizeStr(freshItem.comment) !== normalizeStr(old.comment)) changed.push("kommentar");
  if (normalizeNum(freshItem.minQty) !== normalizeNum(old.minQty)) changed.push("minnivå");

  if (changed.length > 0) {
    show("Uppdaterad från Google Sheets: " + changed.join(", "), "ok");
    const blinkTargets = [qs("#dialogInfo"), qs("#dialogInput"), qs("#unitEdit")].filter(Boolean);
    blinkTargets.forEach(el => {
      el.style.transition = "background 0.6s";
      el.style.background = "#ffffcc";
      setTimeout(() => (el.style.background = ""), 1600);
    });
  } else {
    show("Synkroniserad med Google Sheets", "ok");
  }

  if (!dlg.classList.contains("hidden")) {
    const unitEl = qs("#unitEdit");
    const commentEl = qs("#commentEdit");
    const minEl = qs("#minQtyEdit");
    if (unitEl) {
      const freshUnit = (merged.unit || "").trim();
      // Om fresh-enheten inte finns som option, infoga den (före __new__-sentinel)
      // så att select kan visa den selected. Annars faller value tillbaka till tom.
      if (freshUnit && !Array.from(unitEl.options).some(o => o.value === freshUnit)) {
        const opt = document.createElement("option");
        opt.value = freshUnit;
        opt.textContent = freshUnit;
        const sentinel = unitEl.querySelector('option[value="__new__"]');
        unitEl.insertBefore(opt, sentinel);
      }
      unitEl.value = freshUnit;
    }
    if (commentEl) commentEl.value = merged.comment || "";
    if (minEl) minEl.value = merged.minQty ?? "";
  }

  renderLists();
}

/* ===== Ny artikel ===== */
/* ===== Tag-skanningsläge ===== */
let tagScanCallback = null;

function startTagScanMode(cb) {
  tagScanCallback = cb;
  dlg.classList.add("hidden");
  overlay.classList.remove("blurred");
  qs('#cameraBox')?.classList.remove('hidden');
  cameraVisible = true;
  s.className = ""; s.textContent = "Skanna tag att koppla – tryck Avbryt för att avbryta";
  startBtn.textContent = "Avbryt";
  // Starta alltid om readern så tag-scan-callbacken registreras. Om huvudscannern
  // redan kör är dess callback installerad på readern; utan reset här skulle
  // tag-callbacken aldrig köras.
  startTagCamera();
}

async function startTagCamera() {
  try { reader && reader.reset(); } catch {}
  reader = new ZXing.BrowserMultiFormatReader(_zxingHints());
  const cams = await reader.listVideoInputDevices();
  _backCameras = pickBackCameras(cams);
  let cam = lastCamera || _backCameras[0] || cams[0];
  // Synka _backCamIndex med vald cam så lens-knappen vet var den är
  const idx = _backCameras.findIndex(c => c.deviceId === cam?.deviceId);
  _backCamIndex = idx >= 0 ? idx : 0;
  lastCamera = cam;
  if (!cam) { show("Ingen kamera", "warn"); cancelTagScan(); return; }
  cameraOn = true;
  updateLensSwitchVisibility();

  const onTagResult = async res => {
    if (!res || !res.resultPoints || !tagScanCallback) return;
    const scanned = normTag(res.text || "");
    if (!scanned || scanned === lastCode) return;
    const fmt = res.getBarcodeFormat ? res.getBarcodeFormat() : res.barcodeFormat;
    if (!acceptScan(scanned, fmt)) return;

    // Tom resultPoints (från crop-decode) → vacuous truth → skip positions-validation
    const pts = res.resultPoints || [];
    if (pts.length) {
      const vw = v.videoWidth || 1, vh = v.videoHeight || 1;
      const c = v.getBoundingClientRect();
      const k = Math.max(c.width / vw, c.height / vh);
      const srect = scanBox.getBoundingClientRect();
      const inset = 8;
      const X = pts.map(p => c.left + (c.width - vw * k) / 2 + p.x * k);
      const Y = pts.map(p => c.top + (c.height - vh * k) / 2 + p.y * k);
      const inX = x => x >= srect.left + inset && x <= srect.right - inset;
      const inY = y => y >= srect.top + inset && y <= srect.bottom - inset;
      if (!X.every(inX) || !Y.every(inY)) return;
    }

    await flashFeedback("Tag avläst: " + scanned);
    const cb = tagScanCallback;
    cancelTagScan();
    cb(scanned);
  };

  startFocusCycler();
  reader.decodeFromVideoDevice(cam.deviceId, v, onTagResult);
  // Parallell crop-decode för bättre detection på små streckkoder
  startCropDecode(onTagResult);
  // Hint:a iOS att fokusera mitten av bilden (där scanBox visas)
  setTimeout(() => {
    const track = getActiveTrack();
    if (track?.applyConstraints) {
      track.applyConstraints({
        advanced: [{ pointsOfInterest: [{ x: 0.5, y: 0.5 }], focusMode: 'continuous' }]
      }).catch(() => {});
    }
  }, 800);
}

function cancelTagScan() {
  tagScanCallback = null;
  hideCamera();
  dlg.classList.remove("hidden");
  overlay.classList.add("blurred");
  statusDefault();
}

/* ===== "Koppla till befintlig" vid okänd tag ===== */
// Sök tagCache efter befintliga artiklar som matchar ett OFF-förslag.
// Använder Autocomplete-engine (substring + fuzzy) för att hitta liknande
// — om OFF säger "Kaffe Lavazza" och vi har en "Kaffe Zoégas" är det
// förmodligen samma kategori → erbjud koppla istället för skapa ny.
function findSimilarItems(name, max = 3) {
  if (!name) return [];
  // Lokal fuzzy via gemensam Search.articles (en källa). splitWords +
  // fuzzy:false replikerar exakt det gamla per-ord/minPrefixHits:0-anropet:
  // "Lasagne Plattor" söker både hela frasen och "lasagne"/"plattor" separat
  // så det matchar ihopskrivna "Lasagneplattor". sheetName/rowNum (som
  // Save.linkTag behöver) hämtas från tagCache eftersom Search.articles
  // medvetet är tunn och bara returnerar tag/label.
  const hits = Search.articles(name, tagCache.entries(), {
    splitWords: true, fuzzy: false, maxSuggestions: max
  });
  const results = [];
  for (const h of hits) {
    const val = tagCache.get(h.tag);
    results.push({ tag: h.tag, name: h.label, sheetName: val?.sheetName, rowNum: val?.rowNum });
    if (results.length >= max) break;
  }
  return results;
}

// OpenFoodFacts ger ofta långa namn som "Coca-Cola Original Taste 33cl burk pant".
// Klipp bort enheter/förpackningstermer + begränsa till första orden.
function simplifyOffName(name) {
  if (!name) return '';
  const original = String(name).trim();
  let s = original
    .replace(/\b\d+([.,]\d+)?\s?(cl|ml|dl|l|g|gr|kg|st|x|pcs|tabletter|bites|pack)\b/gi, '')
    .replace(/\b(plåtburk|burk|pant|påse|flaska|låda|paket|tub|spray|pack|kartong|tetra|återvinning|original|taste|flavour|flavor|mini|midi|maxi|small|medium|large|liten|stor|extra|premium|classic)\b/gi, '')
    .replace(/[,;(].*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const words = s.split(' ').filter(Boolean);
  const trimmed = words.slice(0, 4).join(' ').trim();
  // Om regex åt upp allt (t.ex. "33cl burk") — fall tillbaka på originalet
  return trimmed || original;
}

// OpenFoodFacts-lookup för EAN/UPC. Returnerar förslagsobjekt eller null.
async function fetchOpenFoodFacts(barcode) {
  if (!/^\d{8,13}$/.test(barcode)) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json`,
      { signal: ac.signal, headers: { 'Accept': 'application/json' } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 1 || !data.product) return null;
    const p = data.product;
    const rawName = (p.product_name_sv || p.product_name || '').trim();
    if (!rawName) return null;
    const brand = (p.brands || '').split(',')[0].trim();
    const quantity = (p.quantity || '').trim();
    return { name: simplifyOffName(rawName), rawName, brand, quantity };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function showLinkTagDialog(scannedTag) {
  resetDialog();
  dlgTitle.textContent = "Okänd tag";
  // Sätt hjälptext för DENNA dialog — annars läcker texten från tidigare dialog
  // (t.ex. prepareNewItemDialog som sätter "Fyll i benämning, typ...").
  const ha = document.getElementById('help-article');
  if (ha) {
    ha.classList.remove('open');
    ha.innerHTML = 'Den här streckkoden känner appen inte igen.<br><b>Använd förslag</b> = skapa ny artikel med namn från OpenFoodFacts.<br><b>Skapa ny artikel</b> = fyll i alla fält manuellt.<br><b>Koppla till befintlig</b> = sök upp en artikel du redan har och koppla denna kod till den.<br>Om appen visar "Du har redan liknande" — tryck en av dem för snabb koppling.';
  }
  const offUrl = `https://se.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(scannedTag)}&search_simple=1&action=process`;
  dlgInfo.innerHTML = `Tag <b>${esc(scannedTag)}</b> hittades inte.<div id="offResult" data-tag="${esc(scannedTag)}" style="margin-top:10px;font-size:0.9em;opacity:0.85"><span class="aiSpinner"></span> Söker på OpenFoodFacts…</div>`;
  dlgBtns.innerHTML = `
    <button id="cancelLinkBtn" class="btn cancel">Avbryt</button>
    <button id="createNewFromScan" class="btn">Skapa ny artikel</button>
    <button id="linkExistingBtn" class="btn">Koppla till befintlig</button>
  `;
  qs("#createNewFromScan").onclick = () => { prepareNewItemDialog(scannedTag); };
  qs("#cancelLinkBtn").onclick = () => { closeDialog(); cooldown(scannedTag); };
  qs("#linkExistingBtn").onclick = () => {
    // iOS PWA: öppna sökdialogen INNAN vi stänger denna — annars blur:ar closeDialog()
    // searchInput direkt efter att vi satt focus, och iOS-tangentbordet öppnas inte.
    openLinkSearchDialog(scannedTag);
    closeDialog();
  };
  openDialog();

  // Async lookup — uppdaterar dialog vid resultat. Användaren kan ha hunnit
  // välja något annat under tiden, så kontrollera att dialogen fortfarande
  // visar SAMMA tag innan vi muterar den.
  fetchOpenFoodFacts(scannedTag).then(suggestion => {
    const target = qs("#offResult");
    if (!target || target.dataset.tag !== scannedTag) return; // dialog stängd eller ny tag öppnad
    if (!suggestion) {
      target.innerHTML = `Inget förslag från OpenFoodFacts. <a href="${esc(offUrl)}" target="_blank" rel="noopener">Sök manuellt</a>`;
      return;
    }
    const labelParts = [suggestion.name];
    if (suggestion.brand) labelParts.push(suggestion.brand);
    if (suggestion.quantity) labelParts.push(suggestion.quantity);
    const label = labelParts.join(' • ');

    // "Du har redan liknande" — namn → artikel-resolver. Bug C: när OFF bara
    // ger ett engelskt namn ("Virgin Olive Oil") kan lokal Damerau-Levenshtein
    // ALDRIG matcha svenska "Olivolja" (cross-language). Lös semantiskt via
    // den befintliga, cachade backend-aiSearch (olive→oliv). Lokal fuzzy körs
    // FÖRST (snabb, synkron) och AI-träffar slås in efteråt (dedupe på tag).
    // Detta gäller BARA OFF-flödet — fritextsöket förblir lokal fuzzy.
    const nameResolve = new Map(); // norm(name) → {tag,name,sheetName,rowNum}
    const aiCandidates = [];
    for (const [tag, val] of tagCache.entries()) {
      const nm = val?.name; if (!nm) continue;
      const k = nm.toLocaleLowerCase('sv');
      if (!nameResolve.has(k)) {
        nameResolve.set(k, { tag, name: nm, sheetName: val.sheetName, rowNum: val.rowNum });
        aiCandidates.push(nm);
      }
    }

    const renderSimilar = (matches) => {
      const seen = new Set();
      const uniq = [];
      for (const m of matches) { if (m && !seen.has(m.tag)) { seen.add(m.tag); uniq.push(m); } }
      let similarHtml = '';
      if (uniq.length) {
        similarHtml = `<div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(0,0,0,.1)"><i style="font-size:0.85em;display:block;margin-bottom:4px">Du har redan liknande:</i>`;
        for (const m of uniq) {
          similarHtml += `<button type="button" class="btn cancel offMatchBtn" data-tag="${esc(m.tag)}" data-sheet="${esc(m.sheetName||'')}" data-row="${esc(m.rowNum||'')}" data-name="${esc(m.name)}" style="display:block;margin-top:4px;font-size:0.9em;width:100%">Koppla till "${esc(m.name)}"</button>`;
        }
        similarHtml += `</div>`;
      }
      target.innerHTML = `<b>OpenFoodFacts föreslår:</b><br>${esc(label)}<br><button type="button" id="useOffSuggestion" class="btn" style="margin-top:8px">Använd förslag</button>${similarHtml}`;
      wireOffButtons();
      wireUseOff();
    };

    // Wire upp matches-knapparna: klick → addTag mot vald artikel
    function wireOffButtons() {
    target.querySelectorAll('.offMatchBtn').forEach(btn => {
      btn.onclick = async () => {
        const sheetName = btn.dataset.sheet || null;
        const rowNum = btn.dataset.row ? Number(btn.dataset.row) : null;
        const matchTag = btn.dataset.tag;
        const matchName = btn.dataset.name;
        closeDialog();
        cooldown(scannedTag);
        // Bug 2.7: visa INTE "Tag kopplad" före svar — banner får ej ljuga
        // offline. Neutral progress; definitivt utfall efter await.
        show('Kopplar tag…');
        const result = await Save.linkTag(scannedTag, {
          name: matchName,
          sheetName,
          rowNum,
          currentTag: matchTag
        });
        if (result.ok) {
          show(`Tag kopplad till "${matchName}"`, 'ok');
        } else if (result.pending) {
          show('Ingen kontakt — sparas när du är online igen', 'warn');
        } else {
          if (result.collision) {
            show(`Redan kopplad till "${result.res.existingName}"`, 'warn');
          } else if (result.err) {
            show('Oväntat fel — kopplingen rullades tillbaka', 'warn');
          } else {
            show(result.res?.msg || 'Kunde inte koppla — rullade tillbaka', 'warn');
          }
        }
      };
    });
    }

    // Pre-warm AI-förslag i bakgrunden direkt — när användaren klickar
    // "Använd förslag" är resultatet ofta redan klart, så vi slipper
    // 600ms-debouncen och GAS cold-start-fördröjningen. Startas EN gång
    // (re-render av similar-listan ska inte trigga om).
    const aiPrewarm = aiSuggest(suggestion.name, '').catch(() => null);

    function wireUseOff() {
    qs("#useOffSuggestion").onclick = async () => {
      prepareNewItemDialog(scannedTag);
      const nameInput = qs('#manualName');
      if (!nameInput) return;
      nameInput.value = suggestion.name;
      // Skip dispatchEvent('input') — den skulle trigga manualName.oninput
      // som startar EN NY aiSuggest med 600ms debounce. Använd pre-warm istället.
      const aiChip = dlg.querySelector('.aiChip');
      if (aiChip) {
        aiChip.innerHTML = '<span class="aiSpinner"></span><span class="aiChipHint">AI tänker…</span>';
        aiChip.classList.remove('hidden');
      }
      const s = await aiPrewarm;
      // Säkerställ att användaren inte hunnit skriva över namnet
      if (nameInput.value.trim() !== suggestion.name.trim()) return;
      if (!s || !s.ok || !aiChip) {
        if (aiChip) aiChip.classList.add('hidden');
        return;
      }
      const parts = [];
      if (s.place) parts.push(s.place);
      if (s.category) parts.push(s.category);
      if (s.unit) parts.push(s.unit);
      if (s.type) parts.push(s.type);
      if (!parts.length) { aiChip.classList.add('hidden'); return; }
      aiChip.innerHTML = `<button type="button" class="aiChipBtn">📎 ${esc(parts.join(' · '))}</button><span class="aiChipHint">Tryck för att fylla i</span>`;
      aiChip.querySelector('.aiChipBtn').onclick = () => {
        // Kör samma applyAiSuggest-logik. Eftersom den definieras inom
        // prepareNewItemDialog och inte exporteras, tillämpa fält-för-fält här.
        if (s.type) qs('#manualType').value = s.type === 'behållare' ? 'behållare' : 'singel';
        if (s.place) {
          const placeSel = qs('#manualPlace');
          if (placeSel && [...placeSel.options].some(o => o.value === s.place)) {
            placeSel.value = s.place;
            populateNewCategoryDropdown(s.place);
          }
        }
        const setSel = (selId, newId, val) => {
          if (!val) return;
          const sel = qs(selId); const newIn = qs(newId);
          if (!sel) return;
          const match = [...sel.options].some(o => o.value === val);
          if (match) { sel.value = val; if (newIn) { newIn.style.display = 'none'; newIn.value = ''; } }
          else { sel.value = '__new__'; if (newIn) { newIn.style.display = 'block'; newIn.value = val; } }
        };
        setSel('#manualUnit', '#manualUnitNew', s.unit);
        setSel('#manualCategory', '#manualCategoryNew', s.category);
        aiChip.classList.add('hidden');
      };
    };
    }

    // 1) Lokal fuzzy direkt (snabb, täcker svenska OFF-namn omedelbart).
    renderSimilar(findSimilarItems(suggestion.name));

    // 2) Semantisk AI-sök (Bug C): rawName = OFF:s OförenkLade namn ("Virgin
    //    Olive Oil") ger AI mest signal. aiSearch är cachad backend och löser
    //    cross-language (olive→oliv) som lokal Damerau-Levenshtein inte kan.
    //    Slå in AI-träffarna i samma "liknande"-lista (dedupe på tag).
    const aiQuery = (suggestion.rawName || suggestion.name || '').trim();
    if (aiQuery && aiCandidates.length) {
      aiSearch(aiQuery, aiCandidates).then(aiRes => {
        // Dialogen kan ha stängts/bytt tag medan AI körde.
        if (!target.isConnected || target.dataset.tag !== scannedTag) return;
        if (!Array.isArray(aiRes) || !aiRes.length) return;
        const local = findSimilarItems(suggestion.name);
        const aiMatches = [];
        for (const r of aiRes) {
          const hit = nameResolve.get(String(r.name || '').toLocaleLowerCase('sv'));
          if (hit) aiMatches.push(hit);
        }
        if (!aiMatches.length) return;
        // Lokala först (snabb/exakt), sedan AI-semantiska — renderSimilar
        // dedupe:ar på tag så inget visas dubbelt.
        renderSimilar([...local, ...aiMatches]);
      }).catch(() => {});
    }
  });
}

function openLinkSearchDialog(tagToLink) {
  searchInput.value = "";
  searchResults.innerHTML = "";
  overlay.classList.add("blurred");
  searchDialog.classList.remove("hidden");
  // iOS PWA: focus måste köras SYNCHRONOUSLY inom user-gesture för att tangentbordet
  // ska öppnas. RAF eller setTimeout läggs OFTA utanför user-gesture-fönstret på iOS.
  // Matcher openSearchDialog (rad 1406) som funkar.
  if (document.activeElement && document.activeElement !== searchInput && document.activeElement.blur) {
    document.activeElement.blur();
  }
  searchInput.focus();
  // Fallback om sync-call råkade missa (sällan men hänt vid DOM-race):
  requestAnimationFrame(() => searchInput.focus());

  const h2 = searchDialog.querySelector("h2");
  const origTitle = h2.textContent;
  h2.textContent = "Välj artikel att koppla tag till";

  const origHandler = searchInput.oninput;
  const origFabClick = closesearchFab.onclick;
  // Bug 1: #newItemBtn har en PERMANENT addEventListener → createManualArticle
  // (rad ~3584) som gör tag='M'+Date.now() och IGNORERAR den skannade taggen.
  // I länk-läge ska "Ny artikel" i stället bära scannedTag vidare så den nya
  // artikeln får taggen. Override via onclick (körs före listener) som öppnar
  // ny-artikel-dialogen med tagToLink och stänger sökdialogen.
  const newItemBtn = qs('#newItemBtn');
  const origNewItemClick = newItemBtn ? newItemBtn.onclick : null;
  if (newItemBtn) {
    newItemBtn.onclick = (ev) => {
      ev.stopImmediatePropagation();           // hindra createManualArticle-listenern
      closeSearchDialog();                      // städar _linkModeCleanup nedan
      prepareNewItemDialog(tagToLink);          // bär scannedTag → ny rad får taggen
    };
  }
  _linkModeActive = true;
  // Permanent addEventListener(renderSearchResults) är nu igång parallellt med
  // .oninput-länk-handlern; stäng av fritextsökets pågående AI-timer direkt.
  if (_searchAiTimer) { clearTimeout(_searchAiTimer); _searchAiTimer = null; }
  // Central cleanup — körs av closeSearchDialog oavsett om man avbryter eller slutför.
  _linkModeCleanup = () => {
    _linkModeActive = false;
    h2.textContent = origTitle;
    searchInput.oninput = origHandler;
    closesearchFab.onclick = origFabClick;
    if (newItemBtn) newItemBtn.onclick = origNewItemClick;
  };
  searchInput.oninput = (e) => {
    const qn = (e.target.value || "").toLocaleLowerCase('sv').trim();
    searchResults.innerHTML = "";
    if (!qn) return;
    // Samma fuzzy-sök som fritextsöket (Search.articles) i stället för den
    // gamla råa substring-loopen → "olivilja" träffar nu "Olivolja".
    // Behåll syntetisk-vs-vanlig-gren + Save.linkTag-logiken oförändrad.
    let count = 0;
    for (const hit of Search.articles(qn, tagCache.entries(), { maxSuggestions: 50 })) {
      if (count >= 50) break;
      const tag = hit.tag;
      const val = tagCache.get(tag);
      const name = val?.name || "";
      if (!name) continue;
      const btn = document.createElement('button');
      btn.type = "button"; btn.className = "statusRow";
      const hasTag = !tag.startsWith("S");
      btn.innerHTML = `<span class="sr-name">${esc(name)}</span><span class="sr-date">${hasTag ? "har tag" : "ingen tag"}</span>`;
      btn.onclick = async () => {
        closeSearchDialog();
        const isSynthetic = tag.startsWith("S");
        const target = {
          name,
          sheetName: val.sheetName || val.place,
          rowNum: val.rowNum,
          currentTag: tag
        };
        if (!isSynthetic) {
          // Mönster A: optimistisk UI-respons (gul/pending-rad) innan svar.
          // Bug 2.7: banner får INTE påstå "kopplad" före await — neutral
          // progress; definitivt utfall (inkl pending) efter await.
          show("Kopplar tag…");
          renderLists();
          cooldown(tagToLink);
          const result = await Save.linkTag(tagToLink, target);
          renderLists();
          if (result.ok) {
            show(`Tag kopplad till "${name}"`, "ok");
          } else if (result.pending) {
            show("Ingen kontakt — sparas när du är online igen", "warn");
          } else if (result.collision) {
            show(`Redan kopplad till "${result.res.existingName}"`, "warn");
          } else if (result.err) {
            show("Oväntat fel — rullade tillbaka: " + (result.err.message || result.err), "warn");
          } else {
            show(result.res?.msg || "Kunde inte koppla — rullade tillbaka", "warn");
          }
          return;
        }
        // Mönster B: syntetisk artikel kräver server-svar för key-swap
        show("Kopplar tag…");
        const result = await Save.linkTag(tagToLink, target);
        if (result.ok) {
          show(`Tag kopplad till "${name}"`, "ok");
          renderLists();
        } else if (result.pending) {
          show("Ingen kontakt — sparas när du är online igen", "warn");
          renderLists();
        } else if (result.collision) {
          show(`Taggen är redan kopplad till "${result.res.existingName}"`, "warn");
        } else if (result.err) {
          show("Fel: " + (result.err.message || result.err), "warn");
        } else {
          show(result.res?.msg || "Kunde inte koppla tag", "warn");
        }
        cooldown(tagToLink);
      };
      searchResults.appendChild(btn);
      count++;
    }
  };

  // FAB har default addEventListener → closeSearchDialog (rad 511).
  // onclick-override körs först och lägger till cooldown. Återställs centralt i _linkModeCleanup.
  closesearchFab.onclick = () => { cooldown(tagToLink); };
}

function populatePlaceDropdown(){
  const sel=qs('#manualPlace'); if(!sel)return;
  sel.innerHTML='';
  const opt0=document.createElement('option'); opt0.value=''; opt0.textContent='Välj flik…'; sel.appendChild(opt0);
  const places=[...placeSet].sort((a,b)=>a.localeCompare(b,'sv'));
  for(const p of places){const o=document.createElement('option'); o.value=p; o.textContent=p; sel.appendChild(o);}
}
function collectUnits(){
  // Enheten lagras i metaCache (via initData/setLocalMeta), inte tagCache.
  const set = new Set();
  for (const m of metaCache.values()) {
    const u = (m?.unit || '').trim();
    if (u) set.add(u);
  }
  return [...set].sort((a,b) => a.localeCompare(b, 'sv'));
}

function populateNewUnitDropdown(){
  const sel = qs('#manualUnit');
  const newInput = qs('#manualUnitNew');
  if (!sel) return;
  const units = collectUnits();
  sel.innerHTML =
    '<option value="">Välj enhet…</option>' +
    units.map(u => `<option value="${esc(u)}">${esc(u)}</option>`).join('') +
    '<option value="__new__">+ Ny enhet…</option>';
  if (newInput) { newInput.style.display = 'none'; newInput.value = ''; }
}

function populateSheetPlaceDropdown(forSheet){
  const sel = qs('#manualSheetPlace');
  const newInput = qs('#manualSheetPlaceNew');
  if (!sel) return;
  const sheet = (forSheet || '').trim();
  const placeSetLocal = new Set();
  for (const v of tagCache.values()) {
    const sp = (v?.sheetPlace || '').trim();
    if (!sp) continue;
    const vSheet = v.sheetName || v.place || '';
    if (sheet && vSheet !== sheet) continue;
    placeSetLocal.add(sp);
  }
  const places = [...placeSetLocal].sort((a,b) => a.localeCompare(b, 'sv'));
  sel.innerHTML =
    '<option value="">Plats (valfri)</option>' +
    places.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('') +
    '<option value="__new__">+ Ny plats…</option>';
  if (newInput) { newInput.style.display = 'none'; newInput.value = ''; }
}

function populateNewCategoryDropdown(forPlace){
  const sel = qs('#manualCategory');
  const newInput = qs('#manualCategoryNew');
  if (!sel) return;
  const place = (forPlace || '').trim();
  const categorySet = new Set();
  for (const v of tagCache.values()) {
    const c = (v?.category || '').trim();
    if (!c) continue;
    const vSheet = v.sheetName || v.place || '';
    if (place && vSheet !== place) continue;
    categorySet.add(c);
  }
  const cats = [...categorySet].sort((a,b) => a.localeCompare(b, 'sv'));
  sel.innerHTML =
    '<option value="">Kategori (valfri)</option>' +
    cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('') +
    '<option value="__new__">+ Ny kategori…</option>';
  if (newInput) { newInput.style.display = 'none'; newInput.value = ''; }
}

function prepareNewItemDialog(scanned){
  let currentTag=scanned;
  lastCode=scanned; resetDialog(); dlgTitle.textContent="Ny artikel";
  const ha=document.getElementById('help-article'); if(ha){ha.classList.remove('open'); ha.innerHTML='Fyll i benämning, typ, enhet, flik, plats och kategori. <b>Enhet är obligatorisk.</b><br><b>Flik</b> = vilket Sheet-blad raden skapas i. <b>Plats</b> = fysisk placering (kolumn B).<br><b>Singel</b> = en enhet per etikett (t.ex. en sax).<br><b>Behållare</b> = variabel mängd (t.ex. papper, krydda, batterier).<br>Saknas enhet, flik, plats eller kategori i listan — välj <b>+ Ny …</b> och skriv in.<br>Tryck "Skanna tag" för att koppla en QR-kod till artikeln.';}

  const isManual=String(scanned).startsWith('M');
  dlgInfo.innerHTML=isManual?'Skapa ny artikel manuellt:' : `Ingen matchning för <b>${esc(scanned)}</b>. Ange uppgifter:`;
  newItemFields.classList.remove("hidden");
  populatePlaceDropdown();
  populateNewUnitDropdown();
  populateSheetPlaceDropdown(qs('#manualPlace')?.value || '');
  populateNewCategoryDropdown(qs('#manualPlace')?.value || '');
  const placeSel = qs('#manualPlace');
  if (placeSel) {
    placeSel.onchange = () => {
      populateSheetPlaceDropdown(placeSel.value);
      populateNewCategoryDropdown(placeSel.value);
    };
  }
  const spSel = qs('#manualSheetPlace');
  const spNew = qs('#manualSheetPlaceNew');
  if (spSel && spNew) {
    spSel.onchange = () => {
      const isNew = spSel.value === '__new__';
      spNew.style.display = isNew ? 'block' : 'none';
      if (isNew) { spNew.value = ''; spNew.focus(); }
    };
  }
  const catSel = qs('#manualCategory');
  const catNew = qs('#manualCategoryNew');
  if (catSel && catNew) {
    catSel.onchange = () => {
      const isNew = catSel.value === '__new__';
      catNew.style.display = isNew ? 'block' : 'none';
      if (isNew) { catNew.value = ''; catNew.focus(); }
    };
  }
  const unitSel = qs('#manualUnit');
  const unitNewInput = qs('#manualUnitNew');
  if (unitSel && unitNewInput) {
    unitSel.onchange = () => {
      const isNew = unitSel.value === '__new__';
      unitNewInput.style.display = isNew ? 'block' : 'none';
      if (isNew) { unitNewInput.value = ''; unitNewInput.focus(); }
    };
  }

  // AI-chip: föreslår kategori/enhet/typ baserat på artikelnamn
  // Placeras DIREKT EFTER manualName så den syns under namnfältet när iOS-tangentbordet är uppe
  const aiChip=document.createElement('div');
  aiChip.className='aiChip hidden';
  manualName.parentNode.insertBefore(aiChip, manualName.nextSibling);
  const applyAiSuggest=(s)=>{
    if(s.type) manualType.value = s.type === 'behållare' ? 'behållare' : 'singel';
    // Plats först — det påverkar kategori-dropdownens innehåll
    if(s.place){
      const placeSel = qs('#manualPlace');
      if(placeSel && [...placeSel.options].some(o => o.value === s.place)){
        placeSel.value = s.place;
        populateNewCategoryDropdown(s.place);
      }
    }
    const setSelect=(selId, newId, val)=>{
      if(!val) return;
      const sel=qs(selId); const newIn=qs(newId);
      if(!sel) return;
      const match=[...sel.options].some(o => o.value === val);
      if(match){ sel.value = val; if(newIn){ newIn.style.display='none'; newIn.value=''; } }
      else { sel.value='__new__'; if(newIn){ newIn.style.display='block'; newIn.value=val; } }
    };
    setSelect('#manualUnit','#manualUnitNew', s.unit);
    setSelect('#manualCategory','#manualCategoryNew', s.category);
    aiChip.classList.add('hidden');
  };
  manualName.oninput = () => {
    if(_aiSuggestTimer) clearTimeout(_aiSuggestTimer);
    const n=manualName.value.trim();
    if(n.length < 3){ aiChip.classList.add('hidden'); return; }
    // Visa laddningsindikator omedelbart
    aiChip.innerHTML = '<span class="aiSpinner"></span><span class="aiChipHint">AI tänker…</span>';
    aiChip.classList.remove('hidden');
    _aiSuggestTimer = setTimeout(async () => {
      const place = qs('#manualPlace')?.value || '';
      const s = await aiSuggest(n, place);
      if(manualName.value.trim() !== n) return; // namn ändrats under anropet
      if(!s || !s.ok){ aiChip.classList.add('hidden'); return; }
      const parts=[];
      if(s.place) parts.push(s.place);
      if(s.category) parts.push(s.category);
      if(s.unit) parts.push(s.unit);
      if(s.type) parts.push(s.type);
      if(!parts.length){ aiChip.classList.add('hidden'); return; }
      aiChip.innerHTML = `<button type="button" class="aiChipBtn">📎 ${esc(parts.join(' · '))}</button><span class="aiChipHint">Tryck för att fylla i</span>`;
      aiChip.querySelector('.aiChipBtn').onclick = () => applyAiSuggest(s);
      aiChip.classList.remove('hidden');
    }, 600);
  };

  const tagRow=document.createElement('div');
  tagRow.className='tagScanRow';
  tagRow.style.cssText='display:flex;align-items:center;gap:8px;margin:6px 0';
  const tagLabel=document.createElement('span');
  tagLabel.style.cssText='flex:1;text-align:left;font-size:0.85em;color:#555';
  tagLabel.textContent=isManual?'Tag: ingen (manuell)' : `Tag: ${scanned}`;
  tagRow.appendChild(tagLabel);
  const scanTagBtn=document.createElement('button');
  scanTagBtn.type='button'; scanTagBtn.className='btn'; scanTagBtn.textContent='Skanna tag';
  scanTagBtn.style.cssText='font-size:0.85em;padding:6px 12px;flex-shrink:0';
  scanTagBtn.onclick=()=>{
    ensureName(()=>{
      startTagScanMode((newTag)=>{
        currentTag=newTag; lastCode=newTag;
        tagLabel.textContent=`Tag: ${newTag}`;
        scanTagBtn.textContent='Byt tag';
      });
    });
  };
  tagRow.appendChild(scanTagBtn);
  newItemFields.parentNode.insertBefore(tagRow, dlgBtns);

  dlgBtns.innerHTML=`<button id="cancelNewBtn" class="btn cancel">Avbryt</button><button id="saveNewBtn" class="btn">Spara</button>`;
  qs("#saveNewBtn").onclick=()=>{
    const name=manualName.value.trim();
    if(!name){show("Ange benämning","warn");return;}
    const type=manualType.value;
    const qty=parseFloat((manualQty.value||"1").replace(",","."))||1;
    const unitRaw=(qs('#manualUnit')?.value||"").trim();
    const unit = unitRaw === '__new__'
      ? (qs('#manualUnitNew')?.value||'').trim()
      : unitRaw;
    if(!unit){show("Ange enhet","warn");return;}
    const place=(qs('#manualPlace')?.value||"").trim()||"Okänd";
    const spRaw=(qs('#manualSheetPlace')?.value||"").trim();
    const sheetPlace = spRaw === '__new__'
      ? (qs('#manualSheetPlaceNew')?.value||'').trim()
      : spRaw;
    const catRaw=(qs('#manualCategory')?.value||"").trim();
    const category = catRaw === '__new__'
      ? (qs('#manualCategoryNew')?.value||'').trim()
      : catRaw;
    const minQty=parseFloat((qs('#manualMinQty')?.value||'0').replace(',','.'))||0;
    const le=appendLog(`${name} – tillagd (${qty})`,currentTag);
    show("Sparar…");
    // Optimistisk write FÖRE gasCall. pendingSync:true gör att initData preserverar posten
    // om preload-pollen råkar träffa innan logTag-svaret hunnit fram.
    tagCache.set(currentTag,{name,type,place,sheetName:place,sheetPlace,category,minQty,comment:'',step:'',rowNum:null,altTags:[],pendingSync:true});
    setLocalMeta(currentTag,{qty,unit,lastMs:Date.now(),user:userName});
    recomputeMaxLast();renderLists();
    // Skicka all metadata i SJÄLVA logTag-anropet. Tidigare gjordes unit/category/
    // place i ett separat updateMeta efteråt — det misslyckades tyst eftersom
    // currentTag ("M…") strippas av normalizeTag och raden ej hittades. Nu skriver
    // backend metadata direkt i nya raden via cols-guards.
    gasCall('logTag', {
      tag: currentTag, name, type, qty, user: userName,
      sheetName: place||null, unit, category, place: sheetPlace, minQty
    })
      .then(assertOk)
      .then((res) => {
        markAsDone(le);
        const cur=tagCache.get(currentTag);
        if(cur){
          // Manuell artikel skapas TAGGLÖS → vid nästa preload returnerar servern
          // den under sin syntetiska nyckel "S<flik>R<rad>" (preloadTagsWithMeta).
          // Behåller vi M-nyckeln re-applyar initData M-posten OVANPÅ S-posten →
          // artikeln syns TVÅ gånger. Byt därför M→S med EXAKT samma formel som
          // backend, rekonstruerad från res.sheetName + res.row (backend
          // returnerar nu sheetName så vi slipper gissa fliknamnet).
          const updated={...cur,rowNum:res?.row||cur.rowNum,pendingSync:false};
          let newKey=currentTag;
          if(res&&res.new&&res.row&&res.sheetName){
            newKey="S"+String(res.sheetName).replace(/[^a-zA-Z0-9]/g,'')+"R"+res.row;
          }
          if(newKey!==currentTag&&!tagCache.has(newKey)){
            tagCache.delete(currentTag);
            tagCache.set(newKey,updated);
            const m=metaCache.get(currentTag);
            if(m){metaCache.delete(currentTag);metaCache.set(newKey,m);}
          }else{
            tagCache.set(currentTag,updated);
          }
        }
        renderLists();
      })
      .catch(err => markLogFail(le, err));
    closeDialog();cooldown(currentTag);
    show(`Skapad: ${name}`, "ok");
  };
  qs("#cancelNewBtn").onclick=()=>{closeDialog();show("Avbrutet","warn");cooldown(currentTag);};
  openDialog(manualName);
}
function createManualArticle(){
  closeSearchDialog();
  const tag='M'+Date.now();
  prepareNewItemDialog(tag);
}
qs('#newItemBtn')?.addEventListener('click',createManualArticle);
qs('#addBtn')?.addEventListener('click',()=>{ensureName(()=>{createManualArticle();});});

/* ===== Namn (cookie + localStorage) ===== */
function getCookie(k){const m=document.cookie.match(new RegExp('(?:^|; )'+k+'=([^;]*)'));return m?decodeURIComponent(m[1]):null;}
function setCookie(k,v,days){document.cookie=k+'='+encodeURIComponent(v)+'; max-age='+(days*86400)+'; path=/; SameSite=Lax';}
function ensureName(cb){
  const saved=getCookie("vitaliseraUser")||localStorage.getItem("vitaliseraUser");
  const exp=Number(getCookie("vitaliseraExpiry")||localStorage.getItem("vitaliseraExpiry")||0);
  if(saved&&Date.now()<exp){userName=saved;if(typeof cb==="function")cb();return true;}
  nameDialog.classList.remove("hidden"); userNameInput.value=saved||""; saveNameBtn.onclick=()=>{const n=(userNameInput.value||"").trim();if(!n)return;userName=n;
    localStorage.setItem("vitaliseraUser",n);localStorage.setItem("vitaliseraExpiry",Date.now()+365*86400000);
    setCookie("vitaliseraUser",n,365);setCookie("vitaliseraExpiry",String(Date.now()+365*86400000),365);
    nameDialog.classList.add("hidden");if(typeof cb==="function")cb();};
}

/* ===== Bildanalys (snap-FAB + existing searchDialog) =====
 * vision.js är tunn orkestrerare som hookar in i huvudappens existing flöden:
 *   - Artikellistan: window.tagCache (huvudappens cache)
 *   - Inventering: openContainerForTag → existing dialog → existing gasCall pipeline
 *   - Historik/logg: existing appendLog + setLocalMeta + preloadData
 *   - Fewshots: hookade i gasCall nedan när logTag/updateCount lyckas efter en AI-träff
 */
let _visionScriptPromise = null;

// Exponera till vision.js (återanvänder huvudappens GAS-pipeline + UI)
window.GAS_URL = GAS_URL;
window.gasCall = gasCall;
window.preloadData = preloadData;
window.tagCache = tagCache;
window.show = show;
window.statusDefault = statusDefault;
window.showPrintLoading = showPrintLoading; // återanvänds som "Analyserar bild…"-overlay
window.hidePrintLoading = hidePrintLoading;

function _loadVisionScript() {
  if (_visionScriptPromise) return _visionScriptPromise;
  _visionScriptPromise = new Promise((resolve, reject) => {
    if (window.vision) return resolve();
    const s = document.createElement('script');
    s.src = 'vision.js?v=' + APP_VERSION;
    s.onload = () => resolve();
    s.onerror = () => { _visionScriptPromise = null; reject(new Error('Kunde inte ladda vision.js')); };
    document.head.appendChild(s);
  });
  return _visionScriptPromise;
}

// Snap-FAB: tap → lazy-load vision.js → runAnalysis. AI-träffar visas via
// window.openVisionResults (definierad nedan) i existing #searchDialog.
qs('#snapBtn')?.addEventListener('click', () => {
  _loadVisionScript()
    .then(() => window.vision && window.vision.init && window.vision.init())
    .then(() => window.vision && window.vision.runAnalysis(v))
    .catch(e => show('Kunde inte starta bildanalys: ' + (e.message || e), 'warn'));
});

// vision.js anropar denna vid AI-resultat. Populerar existing #searchDialog
// med AI-träffar i samma .statusRow-format som vanlig sökning → tap leder
// till existing openContainerForTag → existing inventeringsdialog.
// FIX v108-review #2: använd _linkModeCleanup-hooken (existing pattern från
// openLinkSearchDialog) så Escape-tangenten också triggar cleanup. Annars
// hänger AI-titel/placeholder kvar nästa gång sökrutan öppnas.
window.openVisionResults = function (matches) {
  if (!Array.isArray(matches) || matches.length === 0) return;
  openSearchDialog();
  const h2 = searchDialog.querySelector('h2');
  const origTitle = h2.textContent;
  const origPlaceholder = searchInput.placeholder;
  // FIX v109: visa hur mycket data som skickas till AI så Robert kan diagnosa
  // synonym-pipelinen direkt utan devtools (om syn-count är 0 är cachen stale)
  const _vd = window._lastVisionResult || {};
  const _artCount = window.tagCache ? window.tagCache.size : 0;
  const _synSample = (window._lastVisionStats && window._lastVisionStats.synonymCount) || 0;
  h2.textContent = 'AI-förslag • ' + _artCount + ' artiklar' + (_synSample ? ' • ' + _synSample + ' syn' : '');
  // FIX v108-review #3: neutral placeholder eftersom skrivande triggar vanlig sökning
  searchInput.placeholder = 'Eller sök artikel…';
  searchInput.value = '';
  _linkModeCleanup = () => {
    h2.textContent = origTitle;
    searchInput.placeholder = origPlaceholder;
  };

  searchResults.innerHTML = '';
  for (const m of matches) {
    if (!m || !m.name) continue;
    let foundTag = null;
    for (const [tag, val] of tagCache.entries()) {
      if (val && val.name === m.name) { foundTag = tag; break; }
    }
    if (!foundTag) continue;

    const meta = metaCache.get(foundTag) || {};
    const saldo = meta.qty != null && meta.qty !== '' ? `${esc(meta.qty)} ${esc(meta.unit || '')}`.trim() : '';
    const reasonHint = m.reason ? ` <span class="sr-syn ai-badge">(AI: ${esc(m.reason).slice(0,40)})</span>` : ` <span class="ai-badge">🤖</span>`;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'statusRow';
    btn.innerHTML = `<span class="sr-name">${esc(m.name)}${reasonHint}</span><span class="sr-saldo">${saldo}</span><span class="sr-date">${esc(meta.lastStr || '')}</span>`;
    const _tag = foundTag;
    // FIX v109: tap-fewshot-trigger flyttad till openContainerForTag-wrapper
    // (central choke-point) så ALLA val efter AI-analys räknas — inklusive
    // manuell sökning om användaren inte hittade i AI-listan.
    addSafeTap(btn,
      () => { closeSearchDialog(); openContainerForTag(_tag); },
      () => { closeSearchDialog(); const c = tagCache.get(_tag); if (c) prepareContainerDialog(c, _tag, { editMode: true }); }
    );
    searchResults.appendChild(btn);
  }
};

/* ===== Kamera ===== */
startBtn?.addEventListener('click', ()=>{
  if (tagScanCallback) { cancelTagScan(); return; }
  ensureAudioCtx();
  blip.play().catch(()=>{});
  sound.play().catch(()=>{});
  ensureName(async ()=>{
    hasStarted = true;
    if (cameraVisible) hideCamera();
    else await showCamera();
  });
});
function stopReader(){stopFocusCycler();stopCropDecode();try{reader&&reader.reset();}catch{}cameraOn=false;statusDefault();}
async function startCamera(){
  stopReader(); reader=new ZXing.BrowserMultiFormatReader(_zxingHints());
  const cams=await reader.listVideoInputDevices();
  _backCameras = pickBackCameras(cams);
  let cam=lastCamera||_backCameras[0]||cams[0];
  const idx = _backCameras.findIndex(c => c.deviceId === cam?.deviceId);
  _backCamIndex = idx >= 0 ? idx : 0;
  lastCamera=cam; if(!cam){show("Ingen kamera","warn");return;}
  cameraOn=true; statusDefault();
  updateLensSwitchVisibility();
  startFocusCycler();
  const onScanResult = async res => {
    if(!res||!res.resultPoints||busy||dialogOpen())return;
    if(!preloadDone){show("Laddar artiklar...",null,{autoreset:false});return;}
    const pts=res.resultPoints||[];
    // Tom resultPoints (från crop-decode) → skip positions/bbox-validation
    if (pts.length) {
      const vw=v.videoWidth||1,vh=v.videoHeight||1;
      const c=v.getBoundingClientRect(); const k=Math.max(c.width/vw,c.height/vh);
      const dispW=vw*k,dispH=vh*k; const offX=c.left+(c.width-dispW)/2, offY=c.top+(c.height-dispH)/2;
      const X=pts.map(p=>offX+p.x*k), Y=pts.map(p=>offY+p.y*k);
      const srect=scanBox.getBoundingClientRect(); const inset=8;
      const inX=x=>x>=srect.left+inset&&x<=srect.right-inset, inY=y=>y>=srect.top+inset&&y<=srect.bottom-inset;
      if(!X.every(inX)||!Y.every(inY))return;
      const bw=Math.max(...X)-Math.min(...X), bh=Math.max(...Y)-Math.min(...Y);
      if(Math.max(bw,bh)<Math.max(srect.width*0.12,srect.height*0.12))return;
    }
    const scanned=normTag(res.text||""); if(!scanned||scanned===lastCode)return;
    const fmt = res.getBarcodeFormat ? res.getBarcodeFormat() : res.barcodeFormat;
    if (!acceptScan(scanned, fmt)) return;
    busy=true; scanBox.classList.add("flash"); setTimeout(()=>scanBox.classList.remove("flash"),220);

    const hit=lookupByTag(scanned);
    if(hit){
      const primaryTag=hit.tag, cached=hit.item;
      const {name,type}=cached; await flashFeedback(name);
      // Användaren kan ha öppnat en dialog via tap under flashFeedbacks 900ms paus.
      // Att då skriva över med scan-resultat ger "flicker" — dialog visas, byts/stängs.
      if (dialogOpen()) { busy=false; cooldown(primaryTag); return; }
      if(type==="singel"){
        // Stark OMEDELBAR "fångad"-signal (ej på server-svar) ersätter den
        // fördröjda showSingelConfirm-bocken som skan-feedback. Server-confirm
        // blir ambient via Save.logSingle:s pendingSync/historik (⚠️ vid
        // genuint fel). cooldown 8000ms → kvarliggande tagg re-fyrar ej; en
        // ANNAN tagg har scanned!==lastCode → skannar fritt direkt.
        Save.logSingle(primaryTag, { name });
        cooldown(primaryTag, 8000); busy=false;
        showSingelCaptured(name);
        return;
      }
      const meta=metaCache.get(primaryTag)||{};
      const localItem={name:cached.name,type:cached.type,place:cached.place,sheetName:cached.sheetName,rowNum:cached.rowNum,qty:meta.qty||0,unit:meta.unit||"",user:meta.user||"",last:meta.lastMs,comment:cached.comment||"",minQty:cached.minQty||0,step:cached.step||""};
      prepareContainerDialog(localItem,primaryTag); busy=false; return;
    }
    await flashFeedback("Läser av…");
    if (dialogOpen()) { busy=false; cooldown(scanned); return; }
    if(preloadDone){busy=false;showLinkTagDialog(scanned);return;}
    show("Hämtar uppgifter…",null,{autoreset:false});
    gasCall('lookup', {tag: scanned}).then(item => {
      if(!item){busy=false;showLinkTagDialog(scanned);return;}
      const type=(item.type||"singel").toLowerCase();
      if(type==="singel"){
        tagCache.set(scanned,{name:item.name,type:"singel",place:normPlace(item.place)});
        // Stark OMEDELBAR "fångad"-signal ersätter fördröjd bock (se
        // cache-hit-grenen ovan). Server-confirm ambient via Save.logSingle.
        Save.logSingle(scanned, { name: item.name });
        cooldown(scanned, 8000); busy=false;
        showSingelCaptured(item.name);
        return;
      }
      setLocalMeta(scanned,{qty:item.qty,unit:item.unit,user:item.user,lastMs:item.last||Date.now()}); recomputeMaxLast(); renderLists(); prepareContainerDialog(item,scanned);
      tagCache.set(scanned, { name: item.name, type: "behållare", place: normPlace(item.place) });
    });
  };
  reader.decodeFromVideoDevice(cam.deviceId, v, onScanResult);
  // Parallell crop-decode för bättre detection på små streckkoder
  startCropDecode(onScanResult);
  // QA: injicera en avkodad tagg i EXAKT samma pipeline som en riktig skan.
  // resultPoints:[] → passerar res-guarden (~rad 4470) och hoppar geometri-
  // blocket precis som crop-decode redan gör. busy/dialogOpen gatar normalt.
  if(QA_MODE){window.__qaScan=(txt)=>{const t=String(txt);return onScanResult({text:t,getText:()=>t,resultPoints:[],__qa:true});};}
  // Hint:a iOS att fokusera mitten av bilden (där scanBox visas) — annars fokuserar
  // iOS auto-focus på mittpunkten av HELA video-frame:n, vilket inte är scanBox.
  setTimeout(() => {
    const track = getActiveTrack();
    if (track?.applyConstraints) {
      track.applyConstraints({
        advanced: [{ pointsOfInterest: [{ x: 0.5, y: 0.5 }], focusMode: 'continuous' }]
      }).catch(() => {});
    }
  }, 800);
}

/* ===== Preload ===== */
window._lastCacheTs = 0;
loadSettings();

// Stale-while-revalidate: rendera från localStorage direkt om möjligt,
// hämta sen färsk server-data i bakgrunden.
// I print-läge (?print=1): skip nätverk helt, använd bara cache så
// utskriften startar omedelbart utan att vänta på server-uppdatering.
let hadCachedPreload = false;
try {
  const raw = localStorage.getItem(PRELOAD_CACHE_KEY);
  if (raw) {
    const cached = JSON.parse(raw);
    if (Array.isArray(cached?.data)) {
      initData(cached.data, { fromCache: true });
      hadCachedPreload = true;
      if (!_isPrintTab) show("Uppdaterar i bakgrunden…", null, { autoreset: false });
    }
  }
} catch (e) { console.warn('preloadCache read failed', e); }

if (!hadCachedPreload && !_isPrintTab) show("Laddar inventeringslistor...", null, { autoreset: false });

// Retry preload med backoff: GAS cold-start kan ta 5-10s, mobilnät-hick ger "Load failed".
async function preloadWithRetry(){
  const delays = [0, 2000, 5000, 10000, 20000]; // 5 försök, totalt ~37s
  let lastErr;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) {
      if (!hadCachedPreload) show(`Försöker igen (${i+1}/${delays.length})…`, null, { autoreset: false });
      await new Promise(r => setTimeout(r, delays[i]));
    }
    // Via preloadShared → koalescera med cacheTs-poll/_revalidateCacheTs_
    // (samma in-flight-promise = ingen parallell full-scan) + 60s-timeout.
    try { return await preloadShared(); }
    catch (err) { lastErr = err; console.warn(`Preload-försök ${i+1} misslyckades:`, err?.message); }
  }
  throw lastErr;
}
// I print-läge: skip nätverks-preload helt och starta inte cacheTs-polling.
// Cache är good-enough för utskrift och vi vill att window.print() ska
// trigga omedelbart utan väntan på GAS cold-start.
const _bootstrapPreload = _isPrintTab
  ? Promise.resolve()
  : preloadWithRetry().then(res => {
      if (res?.error) {
        show("Fel från server: " + res.error, "warn", { autoreset: false });
        return;
      }
      initData(res);
    }).catch(err => {
      console.error("Preload failed after retries:", err);
      const reason = err?.message || 'okänt fel';
      if (hadCachedPreload) show("Kunde inte uppdatera (" + reason + ") — visar senast sparade data", "warn", { autoreset: false });
      else show("Kunde inte ladda: " + reason, "warn", { autoreset: false });
    });
_bootstrapPreload.finally(() => {
  if (_isPrintTab) return;
  // Tyst polling av servercache — startas först när bootstrap är klart så vi
  // inte får race mellan preloadWithRetry och pollern under GAS cold-start.
  setInterval(() => {
    gasCall('cacheTs').then(ts => {
      if (ts > (window._lastCacheTs || 0)) {
        window._lastCacheTs = ts;
        console.log("Servercache uppdaterad, laddar om data tyst...");
        preloadShared().then(initData).catch(() => {});
      }
    }).catch(() => {});
  }, 15000);
});

/* Tangentbordsdetektering */
(function(){
  let kbTimer;
  const vv = window.visualViewport;

  function adjustDialogs() {
    if (!vv) return;
    const kbHeight = window.innerHeight - vv.height;
    const kbOpen = kbHeight > 80;
    // Moderna iOS PWAs hanterar tangentbord via visualViewport-resize automatiskt.
    // Att även lägga till --kb-offset i .dialog{bottom} ger dubbel-shift → dialogen
    // hoppar långt över skärmens topp. Vi behåller variabeln men sätter den till 0
    // så CSS-uttryck som calc(8vh + var(--kb-offset)) inte påverkar layouten.
    document.documentElement.style.setProperty('--kb-offset', '0px');
    if (kbOpen) {
      document.body.classList.add('kb');
      const el = document.activeElement;
      if (el && el.matches('input, textarea, select')) {
        requestAnimationFrame(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
      }
    } else {
      document.body.classList.remove('kb');
    }
  }

  if (vv) {
    vv.addEventListener('resize', adjustDialogs);
  }

  document.addEventListener('focusin', e => {
    if (e.target.matches('input, textarea, select')) {
      clearTimeout(kbTimer);
      document.body.classList.add('kb');
      adjustDialogs();
    }
  });
  document.addEventListener('focusout', () => {
    kbTimer = setTimeout(() => {
      document.body.classList.remove('kb');
      document.documentElement.style.setProperty('--kb-offset', '0px');
    }, 200);
  });
})();

/* ===== Hjälp-toggles ===== */
document.addEventListener('click', e => {
  const toggle = e.target.closest('.help-toggle');
  if (!toggle) return;
  e.stopPropagation();
  const helpId = 'help-' + toggle.dataset.help;
  const box = document.getElementById(helpId);
  if (!box) return;
  box.classList.toggle('open');
});
