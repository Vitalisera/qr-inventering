/*
 * QR-INVENTERING – PWA KLIENTDEL
 * Extraherad från GAS app.html, google.script.run → fetch/gasCall
 */

/* ===== Service Worker + update-banner ===== */
// APP_VERSION bumpas synkat med sw.js CACHE och index.html app.js?v=
// Används för att räkna ut vilka changelog-entries som är "nya" för användaren.
const APP_VERSION = 162;
// S5/U1 (v152): EN sanningskälla för hur länge namnet sparas (localStorage +
// cookie i ensureName). Texterna i index.html ("ett år") ska spegla detta värde.
const NAME_TTL_DAYS = 365;
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
  // onScanResult är hoisted (async function-decl moduleScope) → __qaScan
  // når den även när den definieras nedan. resultPoints:[] hoppar geometri.
  window.__qaScan=(txt,fmt)=>{const t=String(txt);return onScanResult({text:t,getText:()=>t,getBarcodeFormat:()=>fmt,resultPoints:[],__qa:true});};
}

// Detekteras tidigt — ?print=1-tabben är ephemeral och ska INTE delta i
// update-flow (banner, controllerchange, polling, what's new). Annars
// reloadar tabben vid uppgradering med samma URL → window.print() triggas
// igen → "Tillåt utskrift?"-prompt vid varje uppgradering.
const _isPrintTab = new URLSearchParams(location.search).get('print') === '1';

// P0-fix (v142): rensa _swReloading-flaggan vid varje fresh page-load.
// v121 flyttade flaggan från function-scope `let` till sessionStorage för
// att skydda mot dubbel-reload över laddningar. Bi-effekt: flaggan kvarstår
// över ALLA reloads inom samma tab-session, vilket blockerar legitim 2:a
// klick på "Uppgradera version" (fallbackReload + controllerchange-listener
// EARLY-RETURNAR pga guarden = '1'). Roberts 4-klick-symptom. Vid varje
// fresh page-load (inkl. reload som följde en lyckad uppgradering) har
// flaggan tjänat sitt syfte → rensa nu så nästa knapp-klick kan trigga
// reload mot en ev. NYARE version. Säker: om vi når app-init är vi i en
// ny page-load = pågående reload-cykel klar = inget att skydda från längre.
try { sessionStorage.removeItem('_swReloading'); } catch (_) {}

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
      // 5.3 backup: iOS Safari fyrar inte alltid 'online' tillförlitligt efter
      // flygplansläge av (samma rotorsak som drev 9.6 tidsdriven resync). Den
      // dedikerade online-listenern (rad 1774) tar 99% av fallen; denna 60s-
      // tick + visibility tar resten. Idempotent (flushInFlight + tom-check).
      try {
        if (typeof updateQueue !== 'undefined' && updateQueue.length > 0 && !flushInFlight) flushUpdates();
      } catch (_) {}
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
    // P0-spinner (v141): visuell feedback under SW-update + reload-väntan.
    // Mobilt nät + SW-install + reload kan ta 10-20s. Utan feedback ser
    // användaren en död knapp och tror den är trasig (Roberts H3-hypotes,
    // bekräftad genom desktop-harness GRÖN + iPhone observation). Watchdog
    // efter 20s: om vi fortfarande är här (reload skedde inte) → felmeddelande
    // + återaktivera så användaren kan försöka igen. Watchdog städas naturligt
    // av location.reload() i success-path.
    btn.classList.add('loading');
    btn.textContent = 'Hämtar ny version…';
    setTimeout(() => {
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.textContent = 'Försök igen';
    }, 20000);
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

/* ===== Artikelidentitet (v160, A03–A06) =====
 * Varje skrivning bär artikelns beständiga ID (preload-index 16) och det namn
 * servern senast visade (serverName). Servern skriver bara om raden kan bevisas
 * vara den artikeln, annars ROW_UNVERIFIED / ITEM_NOT_FOUND och ingenting skrivs.
 * Identiteten FÅNGAS när användaren agerar och följer sedan med jobbet genom kö,
 * omförsök och omstart. Den slås ALDRIG upp i efterhand för en syntetisk nyckel
 * ("S<flik>R<rad>"): en sådan nyckel är en radposition, och efter en ny lista kan
 * samma nyckel peka på en annan artikel. En gammal backend ignorerar fälten. */
function _isSynthKey_(tag) { return /^S[A-Za-z]/.test(String(tag == null ? '' : tag)); }
// Identitet ur en ögonblicksbild (dialogens item, popupens tk). initData bygger
// NYA objekt i tagCache och muterar aldrig gamla, så en referens tagen när
// dialogen öppnades beskriver artikeln användaren faktiskt ser, även om en ny
// lista hunnit lägga en annan artikel under samma syntetiska nyckel.
function _identityOfItem_(e) {
  const out = {};
  if (e && e.id) out.id = e.id;
  const nm = e ? (e.serverName != null ? e.serverName : e.name) : null;
  if (nm) out.expectedName = String(nm).trim();
  if (e && e.dupTag) out.wireTag = e.dupTag;   // A11: dubblettrad, se _wireBody_
  return out;
}
function _captureIdentity_(tag) {
  const e = tagCache.get(tag);
  const out = {};
  if (e && e.id) out.id = e.id;
  const nm = e ? (e.serverName != null ? e.serverName : e.name) : null;
  if (nm) out.expectedName = String(nm).trim();
  if (e && e.dupTag) out.wireTag = e.dupTag;   // A11: dubblettrad, se _wireBody_
  return out;
}
// Får en lokal (gul) post ta över serverns identitet efter en ny lista? Bara
// när det bevisligen är SAMMA artikel. Under en syntetisk nyckel kan servern nu
// ha en annan artikel; att då ta dess namn som förväntat namn vore exakt den
// tysta felskrivning v160 stänger. Hellre ett synligt ROW_UNVERIFIED.
function _adoptServerIdentity_(key, item, server) {
  if (!server) return false;
  if (!_isSynthKey_(key)) return true;                       // riktig tagg = beständig
  if (item.id && server.id) return item.id === server.id;    // båda har ID
  if (item.serverName == null) return true;                  // optimistisk post, aldrig sett arket
  return String(item.serverName) === String(server.serverName);
}
function _hasIdentity_(o) { return !!o && (o.id !== undefined || o.expectedName !== undefined); }
// Fyller i identitet på ett payload-objekt som saknar den. Muterar objektet, så
// att gasCallWithRetrys omförsök återanvänder EXAKT samma fångade identitet.
function _attachIdentity_(o, tag, allowSynthetic) {
  if (!o || _hasIdentity_(o)) return o;
  if (!allowSynthetic && _isSynthKey_(tag)) return o;
  Object.assign(o, _captureIdentity_(tag));
  return o;
}
// Efter bekräftat namnbyte: köade jobb som fångade det gamla namnet ska bära det
// nya, annars nekas de (servern ser ju nu det nya namnet).
function _renameIdentityInQueues_(tag, oldName, newName) {
  const fix = o => { if (o && o.expectedName === oldName) o.expectedName = newName; };
  try {
    for (const j of updateQueue) if (j && j.args && j.args.tag === tag) fix(j.args);
    for (const j of (_inflightBatch || [])) if (j && j.args && j.args.tag === tag) fix(j.args);
    const ls = _pendingLogSingle.get(tag); if (ls) fix(ls);
    for (const j of _pendingTagLinks.values()) if (j && j.currentTag === tag) fix(j);
    _persistQueue_(); _persistPending_();
  } catch (_) {}
}
// Direkta (icke-köade) skrivanrop sker i samma ögonblick som användarens
// handling → identiteten fångas här om callsiten inte redan gjort det.
const _IDENTITY_DIRECT_FNS_ = { updateMeta: 1, updateName: 1, deleteItem: 1, updateCount: 1 };
function _attachIdentityForSend_(fn, params) {
  if (!params || !_IDENTITY_DIRECT_FNS_[fn]) return;
  // Syntetiska nycklar slås ALDRIG upp vid sändning: cachen kan ha byggts om
  // sedan användaren agerade. Callsiten ska ha skickat identiteten uttryckligen;
  // har den inte det nekar servern (ROW_UNVERIFIED) i stället för att gissa.
  if (fn === 'updateMeta') { if (params.args) _attachIdentity_(params.args, params.tag, false); return; }
  _attachIdentity_(params, params.tag, false);
}

// Servern kunde inte bevisa raden (ROW_UNVERIFIED) eller artikeln är borta
// (ITEM_NOT_FOUND) → listan är inaktuell. Hämta en ny direkt, så användaren kan
// göra om ändringen mot rätt rad utan att behöva leta efter en uppdatera-knapp.
let _identityRefreshAt_ = 0;
function _refreshAfterIdentityError_(code) {
  if (code !== 'ROW_UNVERIFIED' && code !== 'ITEM_NOT_FOUND') return;
  const now = Date.now();
  if (now - _identityRefreshAt_ < 10000) return;   // en gång per 10 s räcker
  _identityRefreshAt_ = now;
  try { preloadShared().then(initData); } catch (_) {}
}

// Namnbyte och skrivning nästan samtidigt (tagglös artikel utan id): båda
// fångade det GAMLA namnet som expectedName. Hinner namnbytet först nekar
// servern skrivningen, eftersom arket då har det nya namnet. Därför väntar
// varje skrivning på samma artikel tills appens eget namnbyte har fått svar,
// och bär sedan det nya namnet om bytet bekräftades. Servern behöver inte
// godta något nytt bevis (B1 orörd), och inget skickas på en gissning.
const _renamesInFlight_ = new Map();
function _beginRename_(tag, oldName, newName) {
  let settle; const done = new Promise(r => { settle = r; });
  const entry = { oldName, newName, done, startedAt: Date.now() };
  _renamesInFlight_.set(tag, entry);
  return ok => { if (_renamesInFlight_.get(tag) === entry) _renamesInFlight_.delete(tag); settle(!!ok); };
}
function _identityTargets_(fn, params) {
  if (!params || fn === 'updateName') return [];
  if (fn === 'batch') return (params.batch || []).filter(j => j && j.args).map(j => [j.args.tag, j.args]);
  if (fn === 'updateMeta') return params.args ? [[params.tag, params.args]] : [];
  if (fn === 'logTag' || fn === 'addTag' || _IDENTITY_DIRECT_FNS_[fn]) return [[params.tag, params]];
  return [];
}
// Väntar på ett namnbyte, högst capMs. true = bytet bekräftades.
async function _renameOutcome_(e, capMs) {
  let timer;
  const ok = await Promise.race([e.done, new Promise(r => { timer = setTimeout(() => r(false), capMs); })]);
  clearTimeout(timer);
  return ok;
}
// Alla väntor löper samtidigt: två hängande namnbyten kostar en gräns, inte två.
async function _awaitRenames_(fn, params, capMs = 45000) {
  await Promise.all(_identityTargets_(fn, params).map(async ([tag, o]) => {
    const e = _renamesInFlight_.get(tag);
    if (!e) return;
    const ok = await _renameOutcome_(e, capMs);
    if (ok && o.expectedName === e.oldName) o.expectedName = e.newName;
  }));
}
// Batchkön: bara jobb för en artikel vars namnbyte väntar på svar hålls kvar
// (i den beständiga kön); alla andra skickas direkt. Efter gränsen släpps även
// de hållna, med det gamla namnet, så servern nekar synligt i stället för att gissa.
function _takeSendableJobs_(queue, now = Date.now(), capMs = 45000) {
  const send = [], hold = [];
  for (const j of queue) {
    const e = j && j.args ? _renamesInFlight_.get(j.args.tag) : null;
    (e && now - e.startedAt < capMs ? hold : send).push(j);
  }
  return { send, hold };
}
// Två namnbyten i följd på samma artikel: det andra skickas först när det
// första fått svar, och förväntar sig då det bekräftade namnet. prev fångas
// innan det egna bytet anmäls, så ett byte väntar aldrig på sig självt.
async function _afterPrevRename_(prev, ident, entry, capMs = 45000) {
  if (!prev) return;
  const ok = await _renameOutcome_(prev, capMs);
  if (ok && ident.expectedName === prev.oldName) {
    ident.expectedName = prev.newName;
    if (entry) entry.oldName = prev.newName;
  }
}
// Hållna jobb skickas så snart namnbytet fått svar (eller gränsen passerats).
function _flushHeldSoon_() {
  if (updateQueue.length && !updateTimer) updateTimer = setTimeout(flushUpdates, 0);
}

// A11: en rad vars kod också sitter på en annan rad har en radnyckel lokalt
// ("S<flik>R<rad>"), men servern ska få den RIKTIGA koden (wireTag, fångad med
// identiteten när användaren agerade). Med koden + flik + rad prövar servern att
// koden faktiskt sitter på raden (STALE_ROW annars); med radnyckeln skulle den
// bara pröva namnet och kunde skriva på grannraden efter en infogad rad.
// Bara det som skickas skrivs om: kö, historik och svar behåller radnyckeln.
function _wireBody_(fn, params) {
  const strip = o => { const c = { ...o }; delete c.wireTag; return c; };
  const body = { fn, ...strip(params), cv: APP_VERSION };
  const swap = (holder, src) => { if (src && src.wireTag && _isSynthKey_(holder.tag)) holder.tag = src.wireTag; };
  swap(body, params);
  if (params.args && typeof params.args === 'object') { swap(body, params.args); body.args = strip(params.args); }
  if (Array.isArray(params.batch)) body.batch = params.batch.map(j => {
    if (!j || !j.args) return j;
    const args = strip(j.args); swap(args, j.args);
    return { ...j, args };
  });
  return body;
}

async function gasCall(fn, params = {}, timeoutMs = 30000) {
  _attachIdentityForSend_(fn, params);
  await _awaitRenames_(fn, params);
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
      // cv = klientversion i VARJE anrop (v160). Backend använder den för att inte
      // ge äldre klienter svar de skulle läsa som framgång (TAG_EXISTS i st. f. existed).
      body: JSON.stringify(_wireBody_(fn, params)),
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
      // Specifika permanent-fel: returnera direkt utan retry.
      // FÖRST felkontraktet från @122: backend märker varje ok:false med
      // transient true/false. Läses det inte fastnar ett PERMANENT fel i
      // retry-loopen och kommer ut som det syntetiska exhausted-svaret nedan —
      // där både res.code och res.staleRow är BORTA. classifyLinkResult tolkar
      // det som 'pending-retry' och användaren får "sparas när du är online
      // igen" om en skrivning som aldrig kan lyckas (rowNum är fortfarande
      // stale). Exakt den falska-löfte-klass hela detta arbete stänger.
      // Regexen nedan är kvar som fallback för svar från en äldre backend.
      if (res && res.ok === false && res.transient === false) return res;
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
  // #4 (synk-audit 2026-06-30): tidigare kastade detta BARA på explicit ok:false.
  // doPost top-catch (Code.js) returnerar {error:...} UTAN ok-fält vid serverkast
  // (Sheet-quota, setValue-undantag) → ok===undefined → undefined===false är false
  // → assertOk släppte igenom → serverfel maskerades som framgång på alla
  // .then(assertOk)-callsites (markAsDone). Kräv nu ok:true explicit; allt annat
  // (ok:false, {error}, null) kastar. P2 (genomlysning 3.0): den sista
  // callsiten (logTag, ny artikel) gick över till gasCallWithRetry +
  // classifyLinkResult, som skiljer nätfel från avvisning — något assertOk
  // aldrig kunde. Funktionen står kvar oanvänd som referens för nya
  // muterande anrop; välj classifyLinkResult i första hand.
  if (!r || r.ok !== true) throw new Error((r && (r.msg || r.error)) || 'Okänt serverfel');
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
// P2 (genomlysning 3.0): pending CREATES — nya artiklar som ännu inte
// bekräftats av servern. Create-vägen var systemets ENDA skrivväg helt utan
// skydd: ett bart gasCall('logTag') utan omförsök, utan kö och utan
// persistens. Den 30 juli 2026 försvann fyra artiklar under ett arbetspass
// MED grön bekräftelse på skärmen — "Bostongurka" skickades med sheetName
// "Okänd" (tom flikväljare, se validateNewItem) och avvisades hårt av
// servern utan att något försökte igen. Nu ligger creates i SAMMA
// localStorage-blob (_PENDING_LS_KEY) som _pendingTagLinks/_pendingLogSingle
// och dras av SAMMA resync-svep (resyncPendingTagLinks) — ingen parallell
// mekanism, ingen ny lagringsnyckel, ingen egen retry-slinga.
// Nyckel = ck (klientgenererad idempotensnyckel, se newCreateKey). Värde =
// { ck, tag, name, type, qty, unit, category, sheetPlace, sheetName, minQty,
//   user, retries }. Skillnad mot _pendingLogSingle: jobbet registreras FÖRE
// anropet, inte först när det failat. En singel-registrering som dör mitt i
// flykten kan skannas om; en create som dör mitt i flykten finns ingen
// annanstans — artikeln är då borta utan spår. Samma persist-före-sändning
// som _inflightBatch i batch-kön (#5), och det är ck som gör en replay säker.
const _pendingCreates = new Map();
// A07: varje skrivning får ett löpnummer (seq) i det ögonblick användaren
// agerar, och det följer jobbet till disk och tillbaka. Regeln som alla köer
// följer: en skrivning för artikel T skickas aldrig medan en ÄLDRE skrivning för
// T är obekräftad. Då kan ett äldre värde aldrig landa efter ett nyare, varken
// efter en omstart, ett tillfälligt fel eller när två köer töms samtidigt.
// Datumbaserat och strikt växande: överlever omstart utan egen lagringsnyckel.
let _lastOpSeq_ = 0;
function _nextOpSeq_() { _lastOpSeq_ = Math.max(_lastOpSeq_ + 1, Date.now()); return _lastOpSeq_; }
function _noteOpSeq_(seq) { if (Number(seq) > _lastOpSeq_) _lastOpSeq_ = Number(seq); }
// Väntar en äldre singelregistrering eller en ny artikel på T på svar?
function _olderOpPending_(tag, seq) {
  const s = _pendingLogSingle.get(tag);
  if (s && (s.seq || 0) < seq) return true;
  for (const c of _pendingCreates.values()) if (c && c.tag === tag && (c.seq || 0) < seq) return true;
  return false;
}
// Töm batchkön tills inget äldre jobb för T återstår. false = det gick inte nu
// (offline, tillfälligt fel eller ett namnbyte som håller jobbet).
async function _awaitOlderQueued_(tag, seq) {
  for (let i = 0; i < 4 && _olderQueued_(tag, seq); i++) {
    if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
    if (!flushInFlight) flushUpdates();
    if (!flushInFlight) break;
    try { await flushInFlight; } catch (_) {}
    if (_lastFlushRequeued_) break;
  }
  return !_olderQueued_(tag, seq);
}
// Ligger en äldre skrivning för T i batchkön (köad eller på väg)?
function _olderQueued_(tag, seq) {
  for (const j of updateQueue) if (j && j.args && j.args.tag === tag && (j.seq || 0) < seq) return true;
  for (const j of (_inflightBatch || [])) if (j && j.args && j.args.tag === tag && (j.seq || 0) < seq) return true;
  return false;
}
// v151: efter så här många misslyckade spar-försök byter historikraden text
// från "sparas när du är online igen" till en uppmaning att skanna om —
// evig tyst retry ska inte se ut som att allt är på väg att ordna sig.
// Enbart meddelandet ändras; jobbet ligger kvar och re-försöks som förut.
const RESYNC_WARN_AFTER = 5;
// Ren urvalsfunktion: vilka pending-länkar ska re-försökas vid online-event?
// Idempotent — returnerar bara poster som inte redan har ett aktivt re-försök.
function selectPendingResync(map) {
  const out = [];
  for (const [k, v] of (map instanceof Map ? map : new Map())) {
    if (v && !v._inflight) out.push({ key: k, job: v });
  }
  return out;
}

// B4 (v151), ren och testbar (samma mönster som selectPendingResync): när en
// syntetisk nyckel ("S<flik>R<rad>") byts mot en riktig tagg efter lyckad
// koppling måste ALLA köade jobb som pekar på den gamla nyckeln följa med —
// annars får de cache-miss i _applyBatchResults_ (pendingSync rensas aldrig →
// evig gulmarkering) och resync av logSingle-jobb återskapar spöknycklar i
// tagCache/metaCache. Muterar jobbobjekten på plats (samma objekt ligger kvar
// i köerna) och fyller i saknade koordinater från coords. Anroparen ansvarar
// för persistering (_persistQueue_/_persistPending_).
// Returnerar { queue, singles, links } = antal om-nycklade jobb per kö.
function rekeyPendingJobs(oldTag, newTag, coords, queueArr, singleMap, linkMap) {
  const c = coords || {};
  const out = { queue: 0, singles: 0, links: 0 };
  if (!oldTag || !newTag || oldTag === newTag) return out;
  // Bundlade updateMeta/updateCount-jobb: nyckelfältet är args.tag.
  for (const j of (queueArr || [])) {
    if (!j || !j.args || j.args.tag !== oldTag) continue;
    j.args.tag = newTag;
    if (j.args.sheetName == null && c.sheetName != null) j.args.sheetName = c.sheetName;
    if (j.args.rowNum == null && c.rowNum != null) j.args.rowNum = c.rowNum;
    out.queue++;
  }
  // Pending singel-registreringar: map-nyckel = tag OCH jobbfält .tag.
  if (singleMap instanceof Map && singleMap.has(oldTag)) {
    const job = singleMap.get(oldTag);
    singleMap.delete(oldTag);
    if (job) {
      job.tag = newTag;
      if (job.sheetName == null && c.sheetName != null) job.sheetName = c.sheetName;
      if (job.rowNum == null && c.rowNum != null) job.rowNum = c.rowNum;
      if (!singleMap.has(newTag)) singleMap.set(newTag, job);
      out.singles++;
    }
  }
  // Pending tag-länkar: map-nyckel = scannedTag (oförändrad), men .currentTag
  // pekar på artikelns cache-nyckel och måste följa med vid swap.
  if (linkMap instanceof Map) for (const job of linkMap.values()) {
    if (!job || job.currentTag !== oldTag) continue;
    job.currentTag = newTag;
    if (job.sheetName == null && c.sheetName != null) job.sheetName = c.sheetName;
    if (job.rowNum == null && c.rowNum != null) job.rowNum = c.rowNum;
    out.links++;
  }
  return out;
}

// B5 (v153), ren och testbar: ska inventeringssteget fyras vid koppling?
// Designregel D4: kopplingen är redan optimistiskt applicerad (altTags-push)
// när Save.linkTag startar → inventeringssteget ska INTE gate:as på server-
// bekräftelse. Fyr direkt vid kopplingsögonblicket, men ALDRIG om:
//   - inställningen är av,
//   - en dialog/overlay är öppen vid fyr-ögonblicket (ingen dialog får klobbas),
//   - användaren hunnit vidare (staleness: > windowMs sedan kopplings-klicket).
function shouldFireInventOnLink(enabled, dialogIsOpen, clickTs, nowMs, windowMs = 5000) {
  if (!enabled) return false;
  if (dialogIsOpen) return false;
  const ts = typeof clickTs === 'number' ? clickTs : nowMs;
  return (nowMs - ts) <= windowMs;
}

// P3a (felsynlighet): beständig räknare för skrivningar som ALDRIG kom fram
// och som ingen mekanism kommer att försöka om. Skild från `warn`-facket i
// badgen: warn = jobb som fortfarande ligger i en kö men gett upp hoppet
// (retries >= RESYNC_WARN_AFTER), _failedWrites = jobb som är slutgiltigt
// avvisade eller tappade och därmed avregistrerade. Räknaren persisteras i
// SAMMA localStorage-blob som köerna (_PENDING_LS_KEY, fältet `failed`) —
// ingen ny nyckelfamilj — och nollas först när användaren tryckt på badgen.
// Varför beständig: fram till nu bars felet enbart av en historikrad (som
// MAX_LOG vräkte ut inom ~30 s) och en statusbanner (som självrensade efter
// 5 s). Ett fel kunde alltså inträffa och vara spårlöst borta innan någon
// tittade upp från etiketten.
let _failedWrites = 0;

// P3a, ren och testbar (speglad ordagrant i failcount.test.js — håll i synk).
// REGELN, i en mening: en misslyckad skrivning räknas som förlorad ENDAST om
// ingen kö/resync kommer att försöka om den. Skälet är att räknaren annars
// larmar vid normal drift — en skanning som görs offline hamnar i
// _pendingLogSingle och skickas vid nästa 'online'-event; den är fördröjd,
// inte förlorad, och har redan sin egen eskalering via RESYNC_WARN_AFTER.
//   cls              = utfallet från classifyLinkResult ('verified' |
//                      'pending-retry' | 'rejected')
//   retryRegistered  = true om jobbet ligger kvar i en kö som faktiskt
//                      re-försöker (updateQueue, _pendingLogSingle,
//                      _pendingTagLinks, _pendingCreates).
function countsAsLostWrite(cls, retryRegistered) {
  if (cls === 'verified') return false;      // skrivningen är bekräftad i arket
  if (retryRegistered === true) return false; // fördröjd, inte förlorad
  return true;                                // avvisad, eller tappad utan kö
}

// P3b, ren och testbar (speglad ordagrant i failcount.test.js — håll i synk).
// Råa feltexter nådde skärmen: "stale row" (Code.js _staleRowGuard_) och
// "Failed to fetch" (webbläsarens nätverkslager) säger ingenting om vad
// användaren ska göra. Servern sätter en stabil `code` på varje avvisning —
// den går före meddelandetexten, som kan formuleras om i backend när som
// helst. Tonen följer den som redan finns i Save.logSingle ("skanna om
// artikeln"): säg vad som hände OCH vad man gör åt det.
// Okänd kod med ett svenskt server-meddelande (t.ex. tag-krock) släpps
// igenom oförändrad — det är redan begripligt, och att svälja det vore att
// byta information mot en tomhet.
function humanizeSaveError(raw, code, ambiguousName) {
  const c = String(code == null ? '' : code).toUpperCase();
  const s = String(raw == null ? '' : raw).trim();
  const low = s.toLowerCase();
  // A03–A06 (v160): servern kunde inte bevisa att raden är rätt artikel, eller
  // artikeln finns inte längre. Inget skrevs. Ny lista behövs innan nästa försök.
  if (c === 'ROW_UNVERIFIED' && ambiguousName === true)
    return 'två artiklar utan kod heter likadant på fliken, ge artikeln ett eget namn eller en kod';
  if (c === 'ROW_UNVERIFIED')
    return 'artikeln har flyttats i arket, ladda om listan och försök igen';
  if (c === 'ITEM_NOT_FOUND')
    return 'artikeln finns inte längre i arket, ladda om listan';
  if (c === 'TAG_EXISTS')
    return 'koden används redan av en annan artikel, ingen ny artikel skapades';
  if (c === 'STALE_ROW' || low.includes('stale row'))
    return 'raden hade flyttat sig i arket, skanna om artikeln';
  if (c === 'NOT_FOUND' || low.startsWith('tagg ej hittad'))
    return 'artikeln hittades inte i arket, skanna om den';
  if (c === 'SHEET_MISSING' || low.startsWith('flik finns inte'))
    return 'fliken finns inte längre i arket, kontrollera artikelns plats';
  if (c === 'SHEET_HEADER_BROKEN' || c === 'NO_NAME_COL' || low.includes('rubrikrad'))
    return 'arkets rubrikrad känns inte igen, välj en annan flik';
  if (c === 'LOCK_TIMEOUT' || low.includes('server upptagen'))
    return 'arket var upptaget, gör om ändringen';
  if (c === 'BAD_ARGS' || c === 'BAD_TAG')
    return 'uppgifterna kunde inte tolkas, gör om ändringen';
  // Transportfel. Safari/iOS-PWA är huvudklienten och har egna texter
  // ("Load failed", "The network connection was lost") — Chromes "Failed to
  // fetch" ensam räcker alltså inte som mönster.
  if (/failed to fetch|load failed|networkerror|network connection was lost|network request failed/.test(low))
    return 'ingen kontakt med arket, gör om ändringen när du är online';
  if (/timeout|timed out|tidsgräns/.test(low))
    return 'arket svarade inte i tid, gör om ändringen';
  if (c === 'SERVER_ERROR' || low === 'serverfel')
    return 'arket svarade med ett fel, gör om ändringen';
  if (!s) return 'okänt fel, skanna om artikeln';
  return s;
}

// U4 (v153), ren och testbar: modell för synk-badgen vid statusraden.
// counts = { links, singles, queue, warn, failed } där warn = antal jobb som
// nått retries >= RESYNC_WARN_AFTER och failed = _failedWrites (P3a).
// Returnerar { visible, warn, text }.
function buildSyncBadgeModel(counts) {
  const c = counts || {};
  const links = c.links || 0, singles = c.singles || 0, queue = c.queue || 0, warn = c.warn || 0;
  const failed = c.failed || 0;
  const total = links + singles + queue;
  // P3a: rött har FÖRETRÄDE och kräver INTE att något ligger kvar i köerna.
  // Den gamla ordningen ("total <= 0 → dold" FÖRE warn-grenen) gjorde varje
  // avvisad skrivning osynlig, eftersom rejected-grenarna i Save.logSingle /
  // Save.create / Save.linkTag avregistrerar jobbet i SAMMA andetag som de
  // failar — total är alltså noll precis i det ögonblick felet uppstår.
  // warn + failed summeras: båda betyder "nådde inte arket", och båda kräver
  // samma sak av användaren (titta i historiken).
  const red = warn + failed;
  if (red > 0) return { visible: true, warn: true, text: red + ' kunde inte sparas – tryck här' };
  if (total <= 0) return { visible: false, warn: false, text: '' };
  const noun = (links === total)
    ? (total === 1 ? 'koppling' : 'kopplingar')
    : (total === 1 ? 'ändring' : 'ändringar');
  return { visible: true, warn: false, text: total + ' ' + noun + ' synkas…' };
}

// U4: uppdatera badgen från köernas faktiska tillstånd. Anropas från samma
// choke-points som persisteringen (_persistPending_/_persistQueue_) — ingen
// polling-timer. try/catch: updateQueue/_inflightBatch deklareras senare i
// filen (TDZ-skydd om någon framtida init-väg persisterar före deklaration).
function _updateSyncBadge_() {
  try {
    const el = document.getElementById('syncBadge');
    if (!el) return;
    let warn = 0;
    for (const j of _pendingLogSingle.values()) if (j && (j.retries || 0) >= RESYNC_WARN_AFTER) warn++;
    for (const j of _pendingTagLinks.values()) if (j && (j.retries || 0) >= RESYNC_WARN_AFTER) warn++;
    // P2b: creates räknas i samma eskalering och i samma total (som "ändringar",
    // via singles-facket) — en ny artikel som inte kommit fram ska synas i
    // statusraden precis som en skanning som inte kommit fram.
    for (const j of _pendingCreates.values()) if (j && (j.retries || 0) >= RESYNC_WARN_AFTER) warn++;
    // A09: ett batchjobb som fått tillfälliga fel om och om igen ska synas på samma sätt.
    for (const j of updateQueue) if (j && (j.retries || 0) >= RESYNC_WARN_AFTER) warn++;
    const m = buildSyncBadgeModel({
      links: _pendingTagLinks.size,
      singles: _pendingLogSingle.size + _pendingCreates.size,
      queue: updateQueue.length + (_inflightBatch ? _inflightBatch.length : 0),
      warn,
      // P3a: permanenta fel överlever att köerna töms — de ligger inte kvar
      // någonstans annars, och det är exakt därför de behöver en egen post.
      failed: _failedWrites
    });
    el.classList.toggle('hidden', !m.visible);
    el.classList.toggle('warn', m.warn);
    el.textContent = m.visible ? (m.warn ? '⚠️ ' + m.text : '⏳ ' + m.text) : '';
    // P3a: den statiska aria-label:n ("Visa vad som väntar på att sparas")
    // döljer textinnehållet för skärmläsare och blev direkt missvisande när
    // badgen kan betyda "kunde inte sparas". Följ texten i stället.
    el.setAttribute('aria-label', m.visible
      ? (m.warn ? m.text + ', visa historiken' : m.text)
      : 'Inget väntar på att sparas');
  } catch (_) {}
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
        rowNum: v.rowNum ?? null, currentTag: v.currentTag ?? null, name: v.name ?? '',
        ...(v.seq ? { seq: v.seq } : {}),
        // v160: identiteten som fångades när användaren agerade följer med jobbet.
        ...(v.id !== undefined ? { id: v.id } : {}),
        ...(v.expectedName !== undefined ? { expectedName: v.expectedName } : {}),
        ...(v.wireTag ? { wireTag: v.wireTag } : {})
      });
    }
    const logSingle = [];
    for (const v of _pendingLogSingle.values()) {
      if (v && v.tag) logSingle.push({
        tag: v.tag, name: v.name ?? '', sheetName: v.sheetName ?? null, rowNum: v.rowNum ?? null,
        retries: v.retries || 0,  // v151: eskaleringsräknaren överlever PWA-kill
        ...(v.seq ? { seq: v.seq } : {}),   // A07: ordningen överlever omstart
        ...(v.id !== undefined ? { id: v.id } : {}),
        ...(v.expectedName !== undefined ? { expectedName: v.expectedName } : {}),
        ...(v.wireTag ? { wireTag: v.wireTag } : {})
      });
    }
    // P2b: creates ligger som TREDJE array i samma blob — samma serialiserings-
    // regel som ovan: bara data-fält, aldrig _le (DOM-nod) eller _inflight
    // (runtime-flagga, ska nollställas av en omstart så svepet kan ta jobbet).
    const creates = [];
    for (const v of _pendingCreates.values()) {
      if (v && v.ck) creates.push({
        ck: v.ck, tag: v.tag ?? null, name: v.name ?? '', type: v.type || 'singel',
        qty: Number(v.qty) || 1, unit: v.unit ?? '', category: v.category ?? '',
        sheetPlace: v.sheetPlace ?? '', sheetName: v.sheetName ?? null,
        minQty: Number(v.minQty) || 0, user: v.user ?? '',
        retries: v.retries || 0
      });
    }
    // P3a: `failed` hör hemma i samma blob (ingen ny nyckel) och måste därför
    // hålla blobben vid liv även när alla tre köerna är tomma — annars raderas
    // felräknaren av nästa lyckade jobb, vilket är precis den tystnad P3
    // ska ta bort.
    if (!tagLinks.length && !logSingle.length && !creates.length && !_failedWrites) { localStorage.removeItem(_PENDING_LS_KEY); _updateSyncBadge_(); return; }
    localStorage.setItem(_PENDING_LS_KEY, JSON.stringify({ tagLinks, logSingle, creates, failed: _failedWrites }));
  } catch (_) {}
  _updateSyncBadge_();   // U4: badge speglar köerna — samma choke-point som persistering
}
// P3a: enda vägen att räkna upp felräknaren. Persisterar via _persistPending_
// (samma choke-point som köerna) — nödvändigt eftersom flera fail-grenar, bl.a.
// datumvägen i commitContainerDate, inte anropar någon persistering alls; en
// ren minnesvariabel hade då dött med appen. Expanderar dessutom historiken:
// ett fel som landar i en kollapsad panel är i praktiken osynligt.
function _bumpFailedWrites_(n) {
  const add = Number(n) || 0;
  if (add <= 0) return;
  _failedWrites += add;
  _persistPending_();
  _expandLog_();
}
function _rehydratePending_() {
  try {
    const raw = localStorage.getItem(_PENDING_LS_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d && Array.isArray(d.tagLinks)) for (const j of d.tagLinks) {
      if (j && j.scannedTag && !_pendingTagLinks.has(j.scannedTag)) { _noteOpSeq_(j.seq); _pendingTagLinks.set(j.scannedTag, j); }
    }
    if (d && Array.isArray(d.logSingle)) for (const j of d.logSingle) {
      if (j && j.tag && !_pendingLogSingle.has(j.tag)) { _noteOpSeq_(j.seq); _pendingLogSingle.set(j.tag, j); }
    }
    // P2b: creates rehydreras på exakt samma villkor (nyckelfältet måste finnas,
    // befintlig post vinner). ck följer med ur lagringen → ett omförsök efter
    // PWA-kill bär SAMMA idempotensnyckel som det ursprungliga försöket.
    if (d && Array.isArray(d.creates)) for (const j of d.creates) {
      if (j && j.ck && !_pendingCreates.has(j.ck)) _pendingCreates.set(j.ck, j);
    }
    // P3a: felräknaren rehydreras ur samma blob. En användare som stänger
    // appen efter ett fel ska mötas av den röda badgen nästa gång hon startar
    // — annars räckte det att låsa telefonen för att felet skulle försvinna.
    if (d && Number(d.failed) > 0) _failedWrites = Number(d.failed);
  } catch (_) {}
}
_rehydratePending_();
if (QA_MODE) window.__qaPending = () => ({
  tagLinks: _pendingTagLinks.size,
  logSingle: _pendingLogSingle.size,
  creates: _pendingCreates.size,
  tagLinksData: [..._pendingTagLinks.values()],
  logSingleData: [..._pendingLogSingle.values()],
  createsData: [..._pendingCreates.values()]
});
// __qaSeedTag: deterministisk mock av tagCache + metaCache utan GAS-anslutning,
// så scan-pipeline-tester (1D-varianter, samma-tagg-spärr) kan köras i ren
// desktop-Chrome. Sätter preloadDone så onScanResult passerar guarden (4523).
if (QA_MODE) window.__qaSeedTag = (tag, itemPatch, metaPatch) => {
  // Respektera EXAKT tag-input — normalisera ej, så test kan seed:a både
  // syntetiska S-prefix-taggar och raw primärtaggar (numeriska EAN-13 m.m.)
  // utan att normTag mutar dem (normTag används av onScanResult-pipelinen
  // för INKOMMANDE skanningar, ej för cache-seed).
  const t = String(tag);
  tagCache.set(t, { name: 'QA', type: 'singel', place: 'Test', sheetName: 'Test', rowNum: 1, ...itemPatch });
  setLocalMeta(t, { qty: 1, unit: 'st', user: 'QA', lastMs: null, ...metaPatch });
  preloadDone = true;
  return { tag: t, cached: tagCache.get(t), meta: metaCache.get(t) };
};
// Direkt access till Save.linkTag + tagCache.get för 2.7-tester (pendingSync
// state för syntetiska, _pendingTagLinks-population, resync-triggers).
if (QA_MODE) {
  window.__qaLinkTag = (scannedTag, target) => Save.linkTag(scannedTag, target);
  window.__qaGetCache = (t) => tagCache.get(t) || null;
  window.__qaLookup = (t) => lookupByTag(t);
  // P5: direkt-test av _maybeInventOnLink utan att gå via search-dialog-callback.
  window.__qaSetInventOnLink = (v) => { inventOnLink = !!v; };
  window.__qaGetInventOnLink = () => inventOnLink;
  window.__qaMaybeInventOnLink = (finalTag, name) => _maybeInventOnLink(finalTag, name);
  // 5.3: queueUpdate + flushUpdates + updateQueue inspektion för batch-synk-
  // tester (catch-grenen tappar data eller ej, online-resync triggas eller ej).
  window.__qaQueueUpdate = (fnName, args) => queueUpdate(fnName, args);
  window.__qaFlushNow = () => flushUpdates();
  window.__qaQueueState = () => ({
    queueLength: updateQueue.length,
    inFlight: !!flushInFlight,
    items: [...updateQueue]
  });
}

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

// P3 (felsynlighet): gemensam slutstation för en misslyckad skrivning.
// opts.code       = serverns felkod (res.code) — grunden för klarspråket.
// opts.ambiguousName = serverns flagga för två tagglösa artiklar med samma namn.
// opts.retryable  = true om jobbet ligger kvar i en kö som re-försöker; då
//                   ska det INTE räknas som förlorat (se countsAsLostWrite).
function markLogFail(le, err, opts) {
  const o = opts || {};
  const human = humanizeSaveError(err && err.message, o.code, o.ambiguousName === true);
  _refreshAfterIdentityError_(o.code);
  if (le) {
    const msg = le.querySelector(".msg");
    const base = msg ? msg.textContent : '';
    markLogWarn(le, base + " – " + human);
  }
  show("Kunde inte spara – " + human, "warn");
  // P3a: den enda grenen som räknas här är den där ingen kö tar över.
  if (countsAsLostWrite('rejected', o.retryable === true)) _bumpFailedWrites_(1);
}

/* ===== Utils ===== */
const qs=(s,p=document)=>p.querySelector(s), qsa=(s,p=document)=>Array.from(p.querySelectorAll(s));
const normTag=x=>{const s=String(x||"").trim();return s.startsWith("S")?s:s.replace(/[^\d]/g,"");};
// Escape för säker interpolation i innerHTML — Sheet-data kan innehålla <, >, ", ', &.
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// F2 (v152): precisionsföljande steg för mängd-steppern [−]/[+]. Hårdkodad ±1
// var obrukbar för decimalsaldon (0,5 + gav 1,5 — ingen väg till 0,6).
// Steget = värdets egen decimalupplösning: heltal → 1, en decimal → 0,1,
// två decimaler → 0,01 (max 6 decimaler). Resultatet avrundas till samma
// decimalantal (ingen 0.30000000000000004), golvas på 0, och behåller
// användarens decimaltecken (komma eller punkt).
// Ren funktion — speglad ORDAGRANT i qtystep.test.js. Håll i synk.
function stepQty(raw, dir) {
  const s0 = String(raw == null ? "" : raw).trim();
  const comma = s0.includes(",");
  const s = s0.replace(",", ".");
  const v = parseFloat(s);
  const cur = isFinite(v) ? v : 0;
  const m = isFinite(v) ? /\.(\d+)$/.exec(s) : null;
  const decimals = m ? Math.min(m[1].length, 6) : 0;
  const next = Math.max(0, cur + dir * Math.pow(10, -decimals));
  const out = next.toFixed(decimals);
  return comma ? out.replace(".", ",") : out;
}

// Preferenser för ikoner i listan (togglas i Inställningar-dialogen).
const prefs = {
  iconTag:     localStorage.getItem('vitaliseraIconTag')     === 'true',
  iconType:    localStorage.getItem('vitaliseraIconType')    === 'true',
  iconComment: localStorage.getItem('vitaliseraIconComment') !== 'false' // default true
};

function renderRowIcons(t, item, hasComment) {
  const out = [];
  if (prefs.iconTag && (!t.startsWith('S') || item.dupTag)) out.push('<span class="rowIcon">🏷️</span>');
  if (prefs.iconType && item.type === 'singel') out.push('<span class="rowIcon">•</span>');
  if (prefs.iconComment && hasComment) {
    out.push(`<span class="infoIcon" data-tag="${esc(t)}">ℹ️</span>`);
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
  if (resolveScan(code)) return true;  // känd kod, även tvetydig (A11/A14)
  return passesScanConsensus(code);
}

// Slår upp en skannad kod i tagCache. Unik träff → { tag, item }, annars null
// (okänd ELLER tvetydig; tvetydigheten hanteras av resolveScan nedan).
function lookupByTag(scanned) {
  const r = resolveScan(scanned);
  return r && !r.ambiguous ? r : null;
}
// A14: ALLA kandidater för en skannad kod, symmetriskt. Arket tappar ledande
// nollor ("01234" → 1234) och en streckkod kan avläsas med eller utan dem, så
// "123" och "00123" jämförs på nollstrippad nyckel åt båda hållen, för huvudkod
// och extra taggar. Exakt träff vinner; finns ingen används nyckelträffarna.
// Mer än en artikel på samma nivå → { ambiguous: [nycklar] }: välj ingen tyst.
// Tidigare: första nyckelträffen vann tyst, och en kod utan nollor hittade
// aldrig en kod med nollor.
function resolveScan(scanned) {
  const s = String(scanned == null ? '' : scanned);
  if (!s) return null;
  if (s.startsWith('S')) return tagCache.has(s) ? { tag: s, item: tagCache.get(s) } : null;
  const key = _tagZeroKey_(s);
  const exact = [], zero = [];
  for (const [k, item] of tagCache.entries()) {
    // Radens riktiga koder: dubblettrader (A11) ligger under radnyckeln med
    // koden i dupTag; tagglösa rader (syntetisk nyckel utan dupTag) har ingen.
    const codes = [];
    if (item && item.dupTag) codes.push(String(item.dupTag));
    else if (!_isSynthKey_(k)) codes.push(k);
    if (item && Array.isArray(item.altTags)) for (const t of item.altTags) { const n = normTag(t); if (n) codes.push(n); }
    if (codes.includes(s)) exact.push(k);
    else if (codes.some(c => _tagZeroKey_(c) === key)) zero.push(k);
  }
  const keys = exact.length ? exact : zero;
  if (!keys.length) return null;
  if (keys.length === 1) return { tag: keys[0], item: tagCache.get(keys[0]) };
  return { ambiguous: keys };
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
// A11: en kod som sitter på flera rader i arket (dubblett som väntar på rättning).
// Nyckel = koden utan ledande nollor → postnycklarna ("S<flik>R<rad>") för raderna.
const dupTagKeys=new Map();
const _tagZeroKey_=t=>String(t).replace(/^0+/,'')||'0';
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
// P5: "Inventera vid koppling" — när PÅ faller koppla→befintlig genom till
// post-skan-flödet (singel logSingle / behållare antal-dialog) direkt efter
// "Tag kopplad". Default AV (befintlig UX bevarad om toggle ej aktiverats).
let inventOnLink = localStorage.getItem('vitaliseraInventOnLink') === '1';
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
// B1 (v152): generaliserad från en hårdkodad fyra-dialoglista som missade
// kommentar-popupen (.dialog.comment, dynamiskt appendad utan hidden-klass),
// qrIntro, qrManual — skanning processades felaktigt bakom öppna overlays.
// Alla dialoger/overlays i appen har class="dialog" och visas genom att
// 'hidden'-klassen tas bort (popupen tas bort ur DOM när den stängs) — utom
// #installOverlay som saknar dialog-klass och därför kollas separat.
// Callsites (3 st, alla i onScanResult) vill alla ignorera skan när NÅGON
// overlay är öppen, så breddningen ändrar ingen avsedd semantik.
const dialogOpen=()=>{
  if(document.querySelector('.dialog:not(.hidden)'))return true;
  const io=document.getElementById('installOverlay');
  return !!(io&&!io.classList.contains('hidden'));
};

/* ===== Logg ===== */
const MAX_LOG = 5;
const undoData = new Map();
const UNDO_WINDOW_MS = 15000;

// P3b: klass som gör en historikrad immun mot MAX_LOG-vräkningen. Fyndet:
// MAX_LOG är 5, och i ett inventeringspass skrivs fem vanliga rader på runt
// trettio sekunder — en varning kunde alltså rulla ut ur historiken innan
// användaren ens hann titta dit. Vanliga rader får fortsätta rulla.
const LOG_WARN_CLASS = 'logWarn';

function appendLog(msg, tag, icon = "⏳") {
  const e = document.createElement("button");
  e.type = "button";
  // Rader som föds som varningar (t.ex. retro-varningen vid avvisad koppling)
  // ska vara immuna direkt, inte först om någon råkar köra dem via markLogWarn.
  e.className = "logEntry clickable" + (icon === "⚠️" ? " " + LOG_WARN_CLASS : "");
  e.innerHTML = `<span class="icon">${esc(icon)}</span><span class="msg">${esc(msg)}</span>`;
  e.onclick = () => openContainerForTag(tag);
  logList.prepend(e);
  _evictLog_();
  // Visa toggle-knappen så snart vi har minst en logg-post
  const tog = qs('#logToggleBtn');
  if (tog) tog.classList.remove('hidden');
  return e;
}

// P3b: vräk bara rader UTAN varningsmarkering, och börja underifrån (äldst).
// Består listan enbart av varningar får den hellre växa förbi MAX_LOG än att
// tysta ett fel — historiken är sista spåret av en skrivning som inte kom fram.
function _evictLog_() {
  if (!logList) return;
  // Övre gräns på varven: ren säkerhetssele mot en oväntad DOM (removeChild
  // som inte minskar barnantalet) — inte en förväntad situation.
  let spins = 0;
  while (logList.children.length > MAX_LOG && spins++ < 200) {
    let victim = null;
    for (let i = logList.children.length - 1; i >= 0; i--) {
      const c = logList.children[i];
      if (!c.classList.contains(LOG_WARN_CLASS)) { victim = c; break; }
    }
    if (!victim) break;          // bara varningar kvar → låt listan växa
    logList.removeChild(victim);
  }
}

// P3b: expandera historiken om den är kollapsad. Går via toggle-knappens egen
// click-handler i stället för att manipulera 'collapsed' direkt, så att
// knappens text och aria-expanded aldrig hamnar ur synk med listan.
function _expandLog_() {
  try {
    const list = document.getElementById('logList');
    const tog = document.getElementById('logToggleBtn');
    if (list && tog && list.classList.contains('collapsed')) tog.click();
  } catch (_) {}
}

// P3b: EN väg att göra en historikrad till varning. Sätter ⚠️, gör raden
// eviction-immun och — viktigast — ser till att raden faktiskt sitter kvar i
// DOM:en. Innan detta kunde en ⏳-rad hinna vräkas ut av MAX_LOG medan svaret
// var i flykten, varpå varningen skrevs in i en frikopplad nod som ingen
// någonsin fick se. Räknar INTE upp felräknaren: den avgörs av
// countsAsLostWrite på callsiten, eftersom en ⚠️-rad lika gärna kan betyda
// "ligger i kö, skickas när du är online".
function markLogWarn(le, text) {
  if (!le) return le;
  le.classList.add(LOG_WARN_CLASS);
  const ic = le.querySelector('.icon'); if (ic) ic.textContent = '⚠️';
  if (text != null) { const m = le.querySelector('.msg'); if (m) m.textContent = String(text); }
  if (logList && le.isConnected === false) { logList.prepend(le); _evictLog_(); }
  return le;
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

// U4 (v153): tap på synk-badgen expanderar historiken (#logList) så ⏳/⚠️-
// raderna blir synliga. Återanvänder toggle-knappens handler (klick) i stället
// för en parallell expander-väg — men bara när listan är kollapsad.
qs('#syncBadge')?.addEventListener('click', () => {
  _expandLog_();
  // P3a: användaren har nu sett historiken → kvittera de permanenta felen.
  // Badgen kan mycket väl förbli röd efteråt: jobb som gett upp hoppet
  // (retries >= RESYNC_WARN_AFTER) ligger fortfarande osparade i köerna, och
  // att nolla dem här vore falsk trygghet. Bara det som redan är slutgiltigt
  // och nu läst kvitteras.
  if (_failedWrites > 0) { _failedWrites = 0; _persistPending_(); }
  _retryParkedJobs_();   // parkerade köjobb får ett nytt försök
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
  const prev = { lastMs: meta.lastMs ?? null, user: meta.user || "", sheetName: cached?.sheetName, rowNum: cached?.rowNum,
    // v160: ångra gäller artikeln som registrerades. Identiteten kommer från
    // registreringen (prevOverride.ident), aldrig från en cache som byggts om.
    ident: (prevOverride && prevOverride.ident) || (_isSynthKey_(tag) ? {} : _captureIdentity_(tag)) };
  undoData.set(tag, prev);

  const undoBtn = document.createElement("span");
  undoBtn.className = "undoLink";
  undoBtn.textContent = "Ångra";
  undoBtn.onclick = (ev) => {
    ev.stopPropagation();
    // §1.3-fix (a): setLocalMeta respekterar nu explicit `lastMs: null` som
    // clear-signal (root-fix rad 1819 — `explicitClear`-flagga slår fjärde
    // else-fallback). Före fixen klobbades null tillbaka till prev.lastMs
    // → Ångra såg ut att inte fungera (lastMs stannade på dagens datum).
    setLocalMeta(tag, { lastMs: prev.lastMs || null, user: prev.user || "" });
    // §1.3-fix (b): markera pendingSync:true så initData-pollens snapshot
    // (rad 2334 filtrerar BARA pendingSync-poster) skyddar lokala rollback
    // tills server bekräftat undo. Annars klobbas lokala metaCache av
    // poll medan undo:n är i flykt → "ångrad" → "inventerad igen".
    const cur = tagCache.get(tag);
    if (cur) tagCache.set(tag, { ...cur, pendingSync: true });
    recomputeMaxLast();
    renderLists();
    const payload = { clearUser: true, userName: prev.user || "", sheetName: prev.sheetName, rowNum: prev.rowNum, ...(prev.ident || {}) };
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
    // A12b: ångran är på väg → andra vägar får inte släcka gult under tiden.
    _undoInFlight.set(tag, (_undoInFlight.get(tag) || 0) + 1);
    let _undoSettled = false;   // .then och .catch kan båda nås; räkna ned en gång
    const _undoDone = () => {
      if (_undoSettled) return;
      _undoSettled = true;
      const n = (_undoInFlight.get(tag) || 1) - 1;
      if (n > 0) _undoInFlight.set(tag, n); else _undoInFlight.delete(tag);
    };
    gasCallWithRetry('updateMeta', {tag, args: payload})
      .then(res => {
        _undoDone();
        const _cls = classifyLinkResult(res);
        if (_cls !== 'verified') {
          // P3: ångra-vägen registrerar INGET jobb för resync — varken kön
          // eller pending-mapparna tar över. Både avvisning och uttömt nätfel
          // är därför slutgiltiga här, och arket står kvar med det värde
          // användaren just backade ur. Det är en äkta divergens och räknas.
          markLogWarn(logEntry, (msg ? msg.textContent : '') +
            ' – ångra nådde inte arket, kontrollera artikeln');
          show("Ångra kunde inte bekräftas", "warn");
          if (countsAsLostWrite(_cls, false)) _bumpFailedWrites_(1);
          // A12b: det ångrade värdet finns inte i arket → gult står kvar även
          // om en annan väg lyckas, tills en bekräftad köskrivning kommer.
          _rejectedSync_.add(tag);
        } else {
          // §1.3-fix (b cleanup): undo verified → rensa pendingSync så raden
          // INTE permanent gulmarkeras (b) satte true:n bara som tillfälligt
          // initData-skydd under undo-flight). renderLists efter cleanup.
          _settleSync_(tag);   // A12b: bara om inget annat väntar eller nekats
          renderLists();
        }
      })
      .catch(err => {
        _undoDone();
        // Samma resonemang som i .then-grenen: inget re-försök finns.
        markLogWarn(logEntry, (msg ? msg.textContent : '') +
          ' – ' + humanizeSaveError(err && err.message));
        show("Ångra kunde inte bekräftas", "warn");
        _bumpFailedWrites_(1);
        _rejectedSync_.add(tag);   // A12b
      });
  };
  logEntry.appendChild(undoBtn);
  setTimeout(() => {
    undoBtn.remove();
    undoData.delete(tag);
  }, UNDO_WINDOW_MS);
}

/* ===== B5 (v153): nyckel-swap S→riktig tagg, med dialog-medveten deferral =====
 * Swappen (flytta tagCache/metaCache-post + re-keya köade jobb) låg tidigare
 * inline i Save.linkTag och kördes ALLTID direkt vid server-success. Nu när
 * inventeringssteget fyrar optimistiskt kan en behållar-dialog vara ÖPPEN på
 * S-nyckeln när servern bekräftar — en omedelbar swap skulle då lämna dialogens
 * closure-tag pekande på en raderad nyckel (spökposter vid nästa spar).
 * Lösning: är dialogen öppen på just den taggen → skjut upp swappen tills
 * dialogen stängs (resetDialog). Pre-swap-läget är fullt funktionellt: den
 * skannade taggen ligger som altTag (P0c) och alla writes bär koordinater. */
const _deferredKeySwaps = new Map();   // oldTag → { newTag, coords }
function _applySyntheticKeySwap_(oldTag, newTag, coords) {
  const c = coords || {};
  const oldData = tagCache.get(oldTag);
  if (oldData) {
    tagCache.delete(oldTag);
    // MERGE över ev. befintlig post på nya nyckeln (15s-pollens initData kan
    // ha hunnit bygga den från server-data medan swappen var uppskjuten) —
    // lokala fält (senaste edits) vinner, saknade fält faller tillbaka på server.
    tagCache.set(newTag, {
      ...(tagCache.get(newTag) || {}),
      ...oldData,
      sheetName: c.sheetName ?? oldData.sheetName ?? null,
      rowNum: c.rowNum ?? oldData.rowNum ?? null,
      // P0c: nya taggen är nu PRIMARY — filtrera den ur altTags.
      altTags: (oldData.altTags || []).filter(t => t !== newTag)
    });
    const oldMeta = metaCache.get(oldTag);
    if (oldMeta) { metaCache.delete(oldTag); metaCache.set(newTag, oldMeta); }
  }
  // B4 (v151) + v153: re-keya ALLA köade jobb — updateQueue OCH den just
  // avsända batchen (_inflightBatch). Batch-payloaden är redan serialiserad
  // när gasCall startade (fetch body JSON.stringify:as synkront), så servern
  // ser gamla taggen + koordinater (resolveItem via rowNum, _verifyTagInRow_
  // 'skip' för S-tagg) — re-keyningen gäller frontendens facit i
  // _applyBatchResults_ (batch[i].args.tag), där _isJobVerifiedOk_ matchar
  // den nya taggen mot serverns writtenTag-eko efter att addTag landat.
  const rekeyed = rekeyPendingJobs(oldTag, newTag, c,
    updateQueue.concat(_inflightBatch || []), _pendingLogSingle, _pendingTagLinks);
  _moveRejectedSync_(oldTag, newTag);   // A12b
  if (rekeyed.queue > 0) _persistQueue_();
  if (rekeyed.singles > 0 || rekeyed.links > 0) _persistPending_();
}
// Kör uppskjutna swappar vars dialog inte längre är öppen. Anropas från
// resetDialog (efter autosave-flushen, så nyss-flushade jobb re-keyas med).
function _runDeferredKeySwaps_() {
  if (!_deferredKeySwaps.size) return;
  for (const [oldTag, d] of [..._deferredKeySwaps.entries()]) {
    if (currentDialogTag === oldTag) continue;   // fortfarande öppen → vänta
    _deferredKeySwaps.delete(oldTag);
    try { _applySyntheticKeySwap_(oldTag, d.newTag, d.coords); } catch (_) {}
  }
}

// B5: spårning av optimistiskt fyrade inventeringar per kopplingsförsök, så
// rejected-grenen i Save.linkTag kan (a) avboka en ännu ej fyrad inventering
// och (b) retro-varna om inventeringen redan gjordes mot en koppling som inte
// gick igenom. Nyckel = scannedTag. Rensas vid verified/rejected; lazy-prune.
const _inventOnLinkState = new Map();  // scannedTag → { fired, cancelled, ts }
function _pruneInventOnLinkState_() {
  const cutoff = Date.now() - 3600000;
  for (const [k, v] of _inventOnLinkState) if (!v || v.ts < cutoff) _inventOnLinkState.delete(k);
}

/* ===== P2 (genomlysning 3.0): rena byggstenar för create-vägen =====
 * Alla fem funktionerna nedan är DOM- och nätfria, av samma skäl som
 * classifyLinkResult/selectPendingResync/rekeyPendingJobs: create-vägen är den
 * väg där ett fel kostar mest (artikeln finns ingen annanstans), och då ska
 * besluten gå att testa utan webbläsare. Speglas i createguard.test.js.
 */

// P2a — BEVISAD orsak till att "Bostongurka" försvann 2026-07-30: flikväljaren
// står på "Välj flik…" (tomt värde) från början, och koden skickade då strängen
// "Okänd" som sheetName. Servern svarar "Flik finns inte: Okänd" — ett
// permanent fel som ingenting försöker igen. Enhet var redan obligatorisk i
// samma dialog; flik ska vara det på exakt samma sätt. Ordningen är medveten:
// alla HÅRDA krav prövas före F3:s mjuka ny-enhet-gate, annars kan användaren
// hinna armera enheten och sedan blockeras av flikvalet.
function validateNewItem(f) {
  const name = String((f && f.name) ?? '').trim();
  const unit = String((f && f.unit) ?? '').trim();
  const sheetName = String((f && f.sheetName) ?? '').trim();
  if (!name) return { ok: false, field: 'name', msg: 'Ange benämning' };
  if (!unit) return { ok: false, field: 'unit', msg: 'Ange enhet' };
  if (!sheetName) return { ok: false, field: 'sheetName', msg: 'Välj vilken flik artikeln ska skapas i' };
  return { ok: true, field: null, msg: '' };
}

// P2d — idempotensnyckel. En create som timeoutar kan ha lyckats server-side
// ändå (30 juli: Oatly och Rårörda lingon skrevs BÅDA, trots timeout) — utan
// nyckel skapar omförsöket en dubblett. Nyckeln genereras EN gång per artikel,
// följer med i jobbet och ut i localStorage, och återanvänds vid varje
// omförsök; en nygenererad nyckel per försök vore lika verkningslös som ingen.
// Servern ska svara med det redan skapade resultatet när den ser nyckeln igen.
// Sant medan ett create-Spara redan behandlas (se dubbeltrycksspärren).
let _createSaveBusy = false;

function newCreateKey() {
  return 'C' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Sant när create-jobbet ska skickas TAGGLÖST. "M<Date.now()>" är ingen tagg
// utan en lokal cache-nyckel för manuellt skapade artiklar. Skickades den som
// tag ändå strippade backends normalizeTag bort M:et och skrev de 13 siffrorna
// som en riktig pseudotagg i TAG-kolumnen — trots att koden här intill påstod
// att artikeln skapas tagglös. Följden: raden fick en tagg som ingen etikett i
// verkligheten motsvarar, och klientens M→S-nyckelbyte (som förutsätter en
// tagglös rad) pekade fel. Nu skickas tag: null och påståendet blir sant.
function isTaglessCreate(tag) { return String(tag == null ? '' : tag).startsWith('M'); }

// Payload till logTag. All metadata går i SJÄLVA create-anropet (Bug A: ett
// separat updateMeta efteråt hittade aldrig raden och tappade fälten tyst).
function buildCreatePayload(job, fallbackUser) {
  const j = job || {};
  return {
    tag: isTaglessCreate(j.tag) ? null : j.tag,
    name: j.name, type: j.type, qty: j.qty,
    user: j.user || fallbackUser || '',
    sheetName: j.sheetName || null,
    unit: j.unit, category: j.category, place: j.sheetPlace, minQty: j.minQty,
    clientKey: j.ck            // P2d: samma nyckel vid varje försök
  };
}

// Optimistisk tagCache-post för en ny artikel. Egen funktion sedan P2b för att
// resync-svepet ska kunna åter-materialisera raden efter en omstart: tagCache
// byggs om från servern vid start, så ett rehydrerat create-jobb hade annars
// synts i statusraden utan att synas i listan.
function buildOptimisticCacheEntry(fields) {
  const { name, type, place, sheetPlace, category, minQty } = fields;
  return { name, type, place, sheetName: place, sheetPlace, category, minQty,
    comment: '', step: '', rowNum: null, altTags: [], pendingSync: true };
}

// Vilken cache-nyckel ska artikeln ha EFTER en bekräftad create?
//   tagglös create  → servern returnerar raden under sin syntetiska nyckel vid
//                     nästa preload ("S<flik>R<rad>", preloadTagsWithMeta) →
//                     byt M→S, annars re-applyas M-posten ovanpå S-posten och
//                     artikeln syns TVÅ gånger.
//   create med tagg → taggen står i TAG-kolumnen och ÄR nyckeln. Före P2 byttes
//                     även denna till en S-nyckel, vilket gjorde cache-posten
//                     till ett spöke: en omskanning av den just skapade taggen
//                     gav miss → "okänd kod" → användaren skapade en dubblett.
function createCacheKey(job, res) {
  const cur = String((job && job.tag != null) ? job.tag : '');
  if (!isTaglessCreate(cur)) return cur;
  if (res && res.new && res.row && res.sheetName) {
    return 'S' + String(res.sheetName).replace(/[^a-zA-Z0-9]/g, '') + 'R' + res.row;
  }
  return cur;
}

// Uppdatera det pending create-jobb som ska ligga kvar för omförsök. Samma
// eskaleringsräknare som _pendingLogSingle (RESYNC_WARN_AFTER) och samma
// _inflight-nollning så selectPendingResync tar jobbet vid nästa svep.
// KRITISKT: ck bevaras — hela idempotensen hänger på det.
function mergePendingCreate(map, job) {
  const ck = job && job.ck;
  const prev = (map instanceof Map && ck) ? map.get(ck) : null;
  const next = prev || { ...(job || {}) };
  next.retries = (next.retries || 0) + 1;
  next._inflight = false;
  return next;
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
    // v160: identitet från jobbet (resync) eller fångad nu (användarens handling).
    const ident = _hasIdentity_(target)
      ? { ...(target.id !== undefined ? { id: target.id } : {}), ...(target.expectedName !== undefined ? { expectedName: target.expectedName } : {}), ...(target.wireTag ? { wireTag: target.wireTag } : {}) }
      : (target._resync && _isSynthKey_(currentTag) ? {} : _captureIdentity_(currentTag));
    const isSynthetic = String(currentTag || '').startsWith('S');
    const le = appendLog(`${name} – tag ${scannedTag} kopplas`, currentTag);

    // P0c-fix: optimistic altTags-push för BÅDA syntetiska och vanliga.
    // Pre-P0c skippade synth-grenen altTags (med argument att key-swap sker
    // först vid server-success). Bi-effekt: under "uppdateras"-window (kan
    // vara 10-20s på mobilt nät GAS-cold-start) returnerar lookupByTag(X)
    // null → re-skan av just kopplad tag öppnar "okänd"-dialog. Robert:
    // "först när historik visade grön bock gick det att skanna" = exakt
    // server-key-swap-tillfället. Lägg X som altTag på S-keyn → lookupByTag-
    // fallback (rad 723-725) returnerar {tag:'S...', item} → cache-hit-
    // grenen i onScanResult öppnar artikel-dialog. Synth-success (rad 1376+)
    // raderar S-key och sätter X som ny key — filtrerar då X ur altTags
    // (annars hamnar X både som primary OCH som alt på sig själv).
    // Rejected-grenen (rad 1413+) filtrerar X ur altTags vid rollback.
    const oldData = tagCache.get(currentTag);
    if (oldData) tagCache.set(currentTag, {
      ...oldData,
      // Idempotent: vid resyncPendingTagLinks (online-retry) körs samma
      // linkTag igen → undvik dubblett scannedTag i altTags (samma mönster
      // som _markPendingRetry nedan).
      altTags: (oldData.altTags || []).includes(scannedTag)
        ? (oldData.altTags || [])
        : [...(oldData.altTags || []), scannedTag],
      pendingSync: true
    });

    // Hjälpare: registrera EJ-bekräftad länk för online-resync + behåll pending.
    // Återanvänds av både catch (oväntat throw) och exhausted-fail-pathen.
    const _markPendingRetry = (msgTail) => {
      // BEHÅLL pendingSync:true + scannedTag i altTags (optimistiskt, men pending).
      // Ingen rollback → renderLists gulmarkerar raden (pendingSync-CSS).
      // P0c: gäller BÅDA synth + non-synth (idempotent altTag-push).
      const cur = tagCache.get(currentTag);
      if (cur) tagCache.set(currentTag, {
        ...cur,
        altTags: (cur.altTags || []).includes(scannedTag)
          ? (cur.altTags || [])
          : [...(cur.altTags || []), scannedTag],
        pendingSync: true
      });
      const _seq = (_pendingTagLinks.get(scannedTag) || {}).seq;
      _pendingTagLinks.set(scannedTag, { scannedTag, sheetName, rowNum, currentTag, name, ...ident, ...(_seq ? { seq: _seq } : {}) });
      _persistPending_();
      // P3b: eviction-immun (raden ska finnas kvar tills resyncen svarat), men
      // INGEN uppräkning av felräknaren — jobbet ligger i _pendingTagLinks och
      // re-försöks vid nästa 'online'. Det är fördröjt, inte förlorat; skulle
      // det ge upp hoppet fångas det av warn-facket (RESYNC_WARN_AFTER).
      markLogWarn(le, `${name} – ej bekräftat – försöker igen${msgTail ? ' (' + msgTail + ')' : ''}`);
    };

    // A10: kopplingen ligger på disk INNAN anropet går iväg. Dör appen under
    // anropet tar nästa start den. _inflight (bara i minnet) hindrar svepet från
    // att skicka den en gång till under samma körning.
    const _prevLink = _pendingTagLinks.get(scannedTag);
    _pendingTagLinks.set(scannedTag, { scannedTag, sheetName, rowNum, currentTag, name, ...ident,
      seq: (_prevLink && _prevLink.seq) || target.seq || _nextOpSeq_(), _inflight: true });
    _persistPending_();

    let res;
    try {
      res = await gasCallWithRetry('addTag',
        { sheetName, rowNum, newTag: scannedTag, tag: currentTag, ...ident },
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
      // A12b: avregistrera kopplingen FÖRE statusregeln nedan, annars räknas
      // den som väntande och artikeln fastnar gul.
      _pendingTagLinks.delete(scannedTag); // bekräftat → ej längre pending
      _persistPending_();
      // A11: en dubblettrad (koden sitter även på en annan rad) behåller sin
      // radnyckel. Den nya koden ligger kvar som extra tagg (altTags ovan), så
      // båda koderna hittar rätt rad, och den gamla koden öppnar fortfarande
      // valet mellan raderna i stället för att bli en okänd kod.
      if (isSynthetic && !tagCache.get(currentTag)?.dupTag) {
        const oldData = tagCache.get(currentTag);
        if (oldData) {
          // B4 (v151): BEHÅLL koordinaterna vid key-swap. addTag skriver taggen
          // i SAMMA rad (raden flyttas inte — verifierat mot Code.js
          // addTagToRow som setValue:ar TAG-cellen på angiven rowNum).
          // target-koordinaterna (de addTag faktiskt skrev mot) prioriteras.
          const _coords = {
            sheetName: sheetName ?? oldData.sheetName ?? null,
            rowNum: rowNum ?? oldData.rowNum ?? null
          };
          // Länken är bekräftad → släpp pendingSync på nuvarande nyckel, om
          // inget annat för artikeln väntar eller nekats (A12b).
          tagCache.set(currentTag, { ...oldData, pendingSync: _syncStillPending_(currentTag) });
          // B5 (v153): är en dialog öppen på just S-nyckeln (optimistiskt
          // inventeringssteg, eller Egenskaper-dialogen där taggen skannades)
          // → skjut upp swappen tills dialogen stängs. Annars swappa direkt
          // (inkl. re-key av updateQueue + _inflightBatch + pending-maps).
          if (currentDialogTag === currentTag) {
            _deferredKeySwaps.set(currentTag, { newTag: res.tag, coords: _coords });
          } else {
            _applySyntheticKeySwap_(currentTag, res.tag, _coords);
          }
        }
      } else {
        _settleSync_(currentTag);   // A12b
      }
      _inventOnLinkState.delete(scannedTag); // B5: bekräftat → ingen retro-varning
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
    // P0c: gäller BÅDA synth + non-synth — båda fick optimistic altTag-push,
    // båda måste rensa scannedTag ur altTags + pendingSync:false vid rejected.
    const cur = tagCache.get(currentTag);
    if (cur) _settleSync_(currentTag, { altTags: (cur.altTags || []).filter(t => t !== scannedTag) });   // A12b
    const failMsg = res && res.collision
      ? `redan kopplad till "${res.existingName}"`
      : humanizeSaveError(res && res.msg, res && res.code, !!(res && res.ambiguousName));
    _refreshAfterIdentityError_(res && res.code);
    // P3b: markLogWarn i stället för inline-ikon — raden blir eviction-immun
    // och räddas tillbaka in i DOM:en om MAX_LOG hann vräka ut den medan
    // addTag var i flykten (kopplingar tar sekunder på mobilt nät).
    markLogWarn(le, `${name} – ${failMsg}`);
    // P3a: kopplingen är avvisad OCH avregistrerad ur _pendingTagLinks (raden
    // ovan) — ingen resync tar över, taggen sitter inte i arket. Räknas.
    if (countsAsLostWrite(cls, false)) _bumpFailedWrites_(1);
    // B5 (v153): kopplingen avvisades. Avboka en ännu ej fyrad optimistisk
    // inventering, och retro-varna (⚠️-historikrad, samma kanal som avvisningen
    // ovan) om inventeringen redan hann göras mot den koppling som nu rullats
    // tillbaka — datumet/saldot på artikeln kan då behöva kontrolleras.
    const _ist = _inventOnLinkState.get(scannedTag);
    if (_ist) {
      _ist.cancelled = true;
      _inventOnLinkState.delete(scannedTag);
      if (_ist.fired) {
        appendLog(`${name} – inventerades vid en koppling som avvisades, kontrollera artikeln`, currentTag, '⚠️');
      }
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
    // v160: identitet från jobbet (resync) eller fångad nu (användarens handling).
    const ident = _hasIdentity_(target)
      ? { ...(target.id !== undefined ? { id: target.id } : {}), ...(target.expectedName !== undefined ? { expectedName: target.expectedName } : {}), ...(target.wireTag ? { wireTag: target.wireTag } : {}) }
      : (target._resync && _isSynthKey_(tag) ? {} : _captureIdentity_(tag));
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
    // A10: registreringen ligger på disk INNAN anropet går iväg (förr först när
    // alla försök misslyckats, upp till två minuter senare). _inflight finns bara
    // i minnet: svepet tar den inte en gång till nu, men väl efter en omstart.
    // A07: seq = när användaren skannade. Ett omförsök behåller sitt.
    const seq = (target._resync && target.seq) || _nextOpSeq_();
    // A12b: ett nyckelbyte under flykten (koppling på tagglös rad + inventera
    // vid koppling) flyttar jobbet och artikeln till den nya taggen. Svaret ska
    // då hanteras under jobbets AKTUELLA nyckel, annars ligger jobbet kvar och
    // artikeln fastnar gul.
    let _lsJob = null;
    const curKey = () => (_lsJob && _lsJob.tag) || tag;
    {
      const job = _pendingLogSingle.get(tag) || { tag, name, sheetName, rowNum, ...ident };
      _lsJob = job;
      job.seq = seq; job._inflight = true; job._le = le;
      _pendingLogSingle.set(tag, job);
      _persistPending_();
    }
    // A07: ligger ett äldre köjobb för artikeln (t.ex. ett saldo) obekräftat
    // skickas registreringen först när det fått svar. Går det inte nu (offline)
    // ligger den kvar och tas av svepet efter nästa lyckade flush.
    _awaitOlderQueued_(tag, seq)
      .then(clear => clear
        ? gasCallWithRetry('logTag', {
            tag, name, type: "singel", qty: 1, user: userName,
            sheetName: sheetName ?? null, rowNum: rowNum ?? null, ...ident
          })
        : { ok: false, exhausted: true, waiting: true, msg: 'väntar på en tidigare ändring' })
      .then(res => {
        const k = curKey();
        // gasCallWithRetry kastar normalt INTE — den returnerar
        // {ok:false,exhausted:true} vid uttömt/nätfel. classifyLinkResult
        // mappar: ok:true → verified; exhausted/inget svar → pending-retry;
        // ok:false utan exhausted (validering m.m.) → rejected. C/#33:
        // {ok:false,staleRow:true} (logTag UPDATE-grenen genom _staleRowGuard_)
        // → rejected → markLogFail (ingen falsk bock på fel rad).
        const cls = classifyLinkResult(res);
        if (cls === 'verified') {
          _pendingLogSingle.delete(k);          // bekräftat → ej längre pending
          _persistPending_();
          // Server bekräftad → släpp pendingSync så server blir sanningskälla
          // igen vid nästa poll (spegel av v125 commitContainerDate verified).
          // B5 (v153): has-guard — vid optimistisk inventering på syntetisk
          // nyckel kan key-swappen (S→riktig tagg) ha hunnit köras under
          // flykten; en villkorslös set skulle då återskapa en spökpost.
          // A12b: men bara om inget annat för artikeln väntar eller nekats.
          _settleSync_(k);
          // Grace-fönster (fältfynd 2026-07-30): utan detta klobbar en preload som
          // startade FÖRE writen den optimistiska raden direkt efter verified —
          // samma mekanism som v147-fixen, som bara täckte batch-vägen.
          _recentlySynced.set(k, Date.now());
          markAsDone(le); addUndoButton(le, k, { ..._undoPrev, ident });
        } else if (cls === 'pending-retry') {
          // Ej bekräftat (offline/uttömt): ingen falsk bock. ⚠️ + diskret
          // status — optimistisk lokal write står kvar (gul rad via
          // pendingSync-mönstret i renderLists). 9.6: REGISTRERA jobbet så
          // resyncPendingTagLinks faktiskt re-försöker det vid online —
          // meddelandet blir SANT. _inflight nollas så nästa event kan ta det.
          const job = _pendingLogSingle.get(k) || { tag: k, name, sheetName, rowNum, ...ident, seq };
          job._inflight = false;
          job._le = le;                 // återanvänd samma rad vid resync
          // v151: räkna misslyckade försök (persisteras) → synlig eskalering
          // i stället för evig tyst retry när samma jobb failar om och om igen.
          // Att bara vänta in ett äldre köjobb (res.waiting) är inget misslyckat
          // försök: registreringen har inte ens skickats.
          if (!(res && res.waiting)) job.retries = (job.retries || 0) + 1;
          _pendingLogSingle.set(k, job);
          _persistPending_();
          const _gaveUpHope = job.retries >= RESYNC_WARN_AFTER;
          // P3b: eviction-immun rad. Ingen uppräkning av felräknaren — jobbet
          // ligger i _pendingLogSingle och re-försöks; warn-facket i badgen
          // täcker eskaleringen när det gett upp hoppet.
          markLogWarn(le, _gaveUpHope
            ? `${name} – kunde inte sparas, skanna om artikeln`
            : `${name} – sparas när du är online igen`);
          // Först vid eskaleringen är det värt att bryta användarens flöde och
          // fälla ut historiken; ett enstaka offline-försök är normal drift.
          if (_gaveUpHope) _expandLog_();
          show(_gaveUpHope
            ? "En artikel kunde inte sparas – skanna om den"
            : "Ingen kontakt — sparas när du är online igen", "warn");
        } else {
          // Äkta server-avvisning (validering / staleRow) → ingen bock,
          // ⚠️ + felmeddelande. Avregistrera — re-försök är meningslöst.
          // P2: rulla tillbaka optimistisk write + släpp pendingSync så listan
          // inte falskt visar "inventerad idag" (spegel av v125 rejected).
          _pendingLogSingle.delete(k);
          _persistPending_();
          // B5 (v153): has-guards av samma skäl som verified-grenen — rulla
          // bara tillbaka om nyckeln fortfarande finns (annars spökpost).
          if (metaCache.has(k)) metaCache.set(k, _prevMeta);
          _settleSync_(k);   // A12b
          recomputeMaxLast(); renderLists();
          markLogFail(le, new Error((res && res.msg) || 'serverfel'), { code: res && res.code, ambiguousName: !!(res && res.ambiguousName) });
        }
        if (typeof onResult === 'function') { try { onResult(cls); } catch (_) {} }
        _flushHeldSoon_();   // A07: köjobb som väntade på registreringen kan gå nu
      })
      .catch(err => {
        const k = curKey();
        // gasCallWithRetry kastar bara vid oväntat fel (ej server-avvisning) →
        // behandla som ej bekräftat (pending-retry), ingen falsk bock.
        const job = _pendingLogSingle.get(k) || { tag: k, name, sheetName, rowNum, ...ident, seq };
        job._inflight = false;
        job._le = le;                   // återanvänd samma rad vid resync
        job.retries = (job.retries || 0) + 1;  // v151: räknas mot RESYNC_WARN_AFTER
        _pendingLogSingle.set(k, job);
        _persistPending_();
        // P3a: retryable — jobbet ligger kvar i _pendingLogSingle (raden ovan)
        // och tas av resync-svepet, så det får INTE räknas som förlorat.
        markLogFail(le, err, { retryable: true });
        if (typeof onResult === 'function') { try { onResult('pending-retry'); } catch (_) {} }
        _flushHeldSoon_();
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
  },

  /**
   * Skapa en ny artikel — P2 (genomlysning 3.0).
   *
   * Före detta gick create-vägen rakt på ett bart gasCall('logTag'): inget
   * omförsök, ingen kö, ingen persistens, och "Skapad: …" visades SYNKRONT
   * innan svaret kommit. Stängdes appen eller svek nätet var artikeln borta
   * utan spår — det var så fyra artiklar försvann 30 juli 2026 bakom en grön
   * bekräftelse. Vägen är nu byggd som de skyddade vägarna:
   *   - gasCallWithRetry (inte gasCall) → nätfel skiljs från server-avvisning
   *   - classifyLinkResult → SAMMA tre utfall som linkTag/logSingle
   *   - _pendingCreates i _PENDING_LS_KEY → överlever att PWA:n dödas
   *   - resyncPendingTagLinks → samma svep, ingen ny listener
   * Skillnad mot logSingle: jobbet registreras FÖRE anropet. En singel kan
   * skannas om; en create som dör mitt i flykten finns ingen annanstans.
   *
   * job: { ck, tag, name, type, qty, unit, category, sheetPlace, sheetName,
   *        minQty, user, retries?, _le?, _inflight? }
   * returnerar: löftet från anropet (callern behöver inte vänta in det)
   */
  createItem(job) {
    // Bältesspänne: utan ck finns ingen idempotens och utan lokal nyckel ingen
    // rad att visa. Callsiten sätter båda — men ett jobb som når hit utan dem
    // ska inte tyst hamna på nyckeln "undefined".
    if (!job.ck) job.ck = newCreateKey();
    if (job.tag == null || job.tag === '') job.tag = 'M' + Date.now();
    const cacheKey = String(job.tag);
    job._inflight = true;                       // svepet ska inte dubbelfyra
    _pendingCreates.set(job.ck, job);
    _persistPending_();                         // persistera FÖRE sändning

    // _le: återanvänd samma historik-rad vid omförsök (ingen ⏳-spam per försök,
    // samma mönster som logSingle:s _resyncLe).
    const le = job._le || appendLog(`${job.name} – tillagd (${job.qty})`, cacheKey);
    job._le = le;
    show("Sparar…");

    // Optimistisk write FÖRE anropet. pendingSync:true gör att initData
    // preserverar posten om preload-pollen träffar innan svaret hunnit fram,
    // och gör att ett rehydrerat jobb åter syns som gul rad efter omstart
    // (tagCache byggs om från servern vid start — utan detta hade artikeln
    // räknats i statusraden utan att synas i listan).
    // Finns posten redan kvar rör vi BARA pendingSync-flaggan: ett svep får
    // inte klobbra en kommentar eller ett saldo som användaren hunnit ändra på
    // den gula raden medan artikeln väntade på arket.
    const prevEntry = tagCache.get(cacheKey);
    tagCache.set(cacheKey, prevEntry ? { ...prevEntry, pendingSync: true } : buildOptimisticCacheEntry({
      name: job.name, type: job.type, place: job.sheetName,
      sheetPlace: job.sheetPlace, category: job.category, minQty: job.minQty
    }));
    if (!metaCache.has(cacheKey)) {
      setLocalMeta(cacheKey, { qty: job.qty, unit: job.unit, lastMs: Date.now(), user: job.user || userName });
    }
    recomputeMaxLast(); renderLists();

    // Ett enda utfallsblock för både svar och oväntat kast: gasCallWithRetry
    // kastar normalt INTE (den returnerar {ok:false,exhausted:true}), men om
    // den gör det ska utfallet behandlas likadant som ett uttömt försök —
    // aldrig som en avvisning, och aldrig som en framgång.
    const applyCreateResult = (res) => {
        const cls = classifyLinkResult(res);
        if (cls === 'verified' && res && res.existed === true) {
          // v160 (A06): koden fanns redan i arket (någon annan hann före). Servern
          // skrev INGENTING. Ta bort vår optimistiska post och hämta listan, så att
          // den artikel som faktiskt finns visas i stället för vår påhittade.
          _pendingCreates.delete(job.ck);
          _persistPending_();
          if (tagCache.has(cacheKey)) tagCache.delete(cacheKey);
          if (metaCache.has(cacheKey)) metaCache.delete(cacheKey);
          recomputeMaxLast(); renderLists();
          markLogWarn(le, `${job.name} – koden fanns redan i arket, ingen ny artikel skapades`);
          // Det användaren skrev in (antal, egenskaper) nådde inte arket och
          // ingen kö försöker om → räknas i den röda statusraden.
          if (countsAsLostWrite('rejected', false)) _bumpFailedWrites_(1);
          show("Koden fanns redan i arket – listan uppdateras", "warn");
          try { preloadShared().then(initData); } catch (_) {}
          return cls;
        }
        if (cls === 'verified') {
          _pendingCreates.delete(job.ck);
          _persistPending_();
          _flushHeldSoon_();   // köjobb för artikeln som väntade på den kan gå nu
          markAsDone(le);
          const newKey = createCacheKey(job, res);
          let settledKey = cacheKey;
          const cur = tagCache.get(cacheKey);
          if (cur) {
            // A12b: pendingSync sätts efter omnycklingen nedan (_settleSync_).
            const updated = { ...cur, rowNum: (res && res.row) || cur.rowNum,
              // v160: artikelns beständiga ID och namnet i arket, för kommande skrivningar.
              ...(res && res.id ? { id: String(res.id) } : {}), serverName: String(job.name || '').trim() };
            if (newKey !== cacheKey && !tagCache.has(newKey)) {
              settledKey = newKey;
              _moveRejectedSync_(cacheKey, newKey);
              tagCache.delete(cacheKey);
              tagCache.set(newKey, updated);
              const m = metaCache.get(cacheKey);
              if (m) { metaCache.delete(cacheKey); metaCache.set(newKey, m); }
              // B4 (v151): köade jobb mot den gamla nyckeln måste följa med,
              // annars får de cache-miss vid flush → evig gulmarkering. Med P2b
              // kan pending-fönstret bli långt nog att användaren hinner
              // redigera den gula raden innan nyckelbytet — då finns det
              // faktiskt jobb att flytta. Create-vägen gjorde aldrig detta.
              rekeyPendingJobs(cacheKey, newKey,
                { sheetName: job.sheetName, rowNum: (res && res.row) || null },
                updateQueue, _pendingLogSingle, _pendingTagLinks);

              _persistQueue_(); _persistPending_();
            } else {
              tagCache.set(cacheKey, updated);
            }
          }
          // v160: jobb köade medan artikeln var gul saknade ID (det fanns inget
          // ännu). Ge dem det nu, så de inte nekas efter en radförskjutning.
          if (res && res.id) {
            for (const k of [cacheKey, newKey]) {
              for (const j of updateQueue) if (j && j.args && j.args.tag === k && j.args.id === undefined) j.args.id = String(res.id);
              const ls = _pendingLogSingle.get(k); if (ls && ls.id === undefined) ls.id = String(res.id);
            }
            _persistQueue_(); _persistPending_();
          }
          // A12b: gul släcks bara om inget annat för artikeln väntar (t.ex. ett
          // saldo som hölls i kön tills artikeln fanns). Efter omnycklingen, så
          // att jobben räknas under den nyckel de nu ligger på.
          if (cur) _settleSync_(settledKey);
          // Grace-fönster (fältfynd 2026-07-30): skydda den färska raden mot en
          // preload som startade FÖRE writen. Samma mönster som logSingle.
          _recentlySynced.set(newKey, Date.now());
          recomputeMaxLast(); renderLists();
          show(`Skapad: ${job.name}`, "ok");    // P2c: först NU, och först här
        } else if (cls === 'pending-retry') {
          // Ej bekräftat (offline/uttömt). Jobbet ligger redan i
          // _pendingCreates → meddelandet nedan är SANT, till skillnad från
          // före P2 då det inte fanns någon som helst kö att vänta på.
          const j = mergePendingCreate(_pendingCreates, job);
          _pendingCreates.set(job.ck, j);
          _persistPending_();
          const _gaveUpHope = (j.retries || 0) >= RESYNC_WARN_AFTER;
          // P3b: samma resonemang som i logSingle — immun rad, ingen
          // uppräkning (jobbet ligger i _pendingCreates), utfällning först
          // vid eskalering.
          markLogWarn(le, _gaveUpHope
            ? `${job.name} – kunde inte skapas, lägg in artikeln igen`
            : `${job.name} – sparas när du är online igen`);
          if (_gaveUpHope) _expandLog_();
          show(_gaveUpHope
            ? "En ny artikel kunde inte sparas – lägg in den igen"
            : "Ingen kontakt — artikeln sparas när du är online igen", "warn");
        } else {
          // Äkta server-avvisning (trasig rubrikrad, flik saknas, validering).
          // Omförsök är meningslöst → avregistrera. Rulla dessutom tillbaka den
          // optimistiska posten: en rad med pendingSync:true överlever varje
          // initData-ombygge, så utan detta blev en avvisad create ett
          // PERMANENT spöke i listan — en artikel som ser sparad ut men inte
          // finns i arket. Exakt den lögnen som kostade oss 30 juli.
          _pendingCreates.delete(job.ck);
          _persistPending_();
          if (tagCache.has(cacheKey)) tagCache.delete(cacheKey);
          if (metaCache.has(cacheKey)) metaCache.delete(cacheKey);
          recomputeMaxLast(); renderLists();
          // markLogFail skriver redan klarspråk i BÅDE historikraden och bannern.
          // Ett show() här skrev över bannern med den råa servertexten — och
          // bannern är just det man ser utan att expandera historiken.
          markLogFail(le, new Error((res && (res.msg || res.error)) || 'serverfel'), { code: res && res.code, ambiguousName: !!(res && res.ambiguousName) });
        }
        return cls;
    };
    return gasCallWithRetry('logTag', buildCreatePayload(job, userName))
      .then(applyCreateResult)
      .catch(err => applyCreateResult({ ok: false, exhausted: true, msg: err && err.message }));
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
  // P2b: creates dras av SAMMA svep, med samma idempotenta urval och under
  // samma _resyncInFlight-guard. Ingen ny listener, ingen parallell mekanism.
  const createJobs = selectPendingResync(_pendingCreates);
  if (!linkJobs.length && !singleJobs.length && !createJobs.length) return;
  _resyncInFlight = true;
  try {
    for (const { key, job } of linkJobs) {
      job._inflight = true;
      try {
        const r = await Save.linkTag(job.scannedTag, {
          name: job.name,
          sheetName: job.sheetName,
          rowNum: job.rowNum,
          currentTag: job.currentTag,
          ...(job.seq ? { seq: job.seq } : {}),
          ...(job.id !== undefined ? { id: job.id } : {}),
          ...(job.expectedName !== undefined ? { expectedName: job.expectedName } : {}),
          ...(job.wireTag ? { wireTag: job.wireTag } : {}),
          _resync: true
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
          ...(job.id !== undefined ? { id: job.id } : {}),
          ...(job.expectedName !== undefined ? { expectedName: job.expectedName } : {}),
          ...(job.wireTag ? { wireTag: job.wireTag } : {}),
          ...(job.seq ? { seq: job.seq } : {}),
          _resync: true,
          _resyncLe: job._le || null
        });
      } catch (_) {
        job._inflight = false; // oväntat → nästa event försöker igen
      }
    }
    for (const { key, job } of createJobs) {
      job._inflight = true;   // markera FÖRE (selectPendingResync hoppar då över)
      try {
        // Re-kör EXAKT samma Save.createItem-väg (ingen separat gasCall-path).
        // createItem self-delete:ar _pendingCreates vid verified/rejected och
        // nollar _inflight + behåller posten vid pending-retry. Idempotensen
        // vilar på job.ck, som bevaras genom både persistering och omförsök:
        // en create som i själva verket lyckades men vars svar tappades ska
        // ge tillbaka den befintliga raden, inte en dubblett (30 juli: Oatly
        // och Rårörda lingon skrevs båda efter timeout).
        Save.createItem(job);
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
  // Startknuff, samma som updateQueue redan får. Utan den syns ett rehydrerat
  // create i synk-badgen men INTE i listan förrän nästa svep — uppmätt upp till
  // 60 s, eftersom checkForUpdate bara hänger på setInterval(60000) och
  // visibilitychange, och ingen av dem fyrar vid start. En användare som inte ser
  // sin artikel skapar den igen, vilket ger exakt den dubblett resten av denna
  // release finns till för att stänga.
  // ⚠ TÄCKER BARA ONLINE-FALLET. resyncPendingTagLinks returnerar direkt när
  // navigator.onLine är falskt, före både urval och renderLists — ett rehydrerat
  // create OFFLINE räknas alltså fortfarande av badgen utan att synas i listan.
  // Den fixen kräver att den optimistiska posten materialiseras när tagCache är
  // fylld (buildOptimisticCacheEntry), inte här i startsekvensen där cachen ännu
  // är tom. Skriv inte om detta som om offline vore löst.
  // Idempotent: _resyncInFlight + _inflight-guarden gör en extra körning ofarlig.
  setTimeout(function () { try { resyncPendingTagLinks(); } catch (_) {} }, 1500);
}

/* ===== Bundlad uppdateringskö ===== */
const updateQueue = [];
let updateTimer = null;
let flushInFlight = null;
// #5 (synk-audit 2026-06-30): updateQueue var ren in-memory → en köad eller
// in-flight meta/count-write (kommentar, saldo, Egenskaper) gick PERMANENT
// förlorad när iOS dödade bakgrunds-PWA:n innan flush hann bekräftas (samma
// dataförlust-klass som 9.6 löste för _pendingLogSingle/_pendingTagLinks).
// Fix: persistera kön OCH den just avsända batchen till localStorage; rehydrera
// vid start och flush:a. _inflightBatch hålls separat så en kill MITT i ett
// gasCall('batch') ändå återställs (updateMeta/updateCount är idempotenta på
// servern → re-sändning skapar inga dubbletter, bara samma setValue igen).
const _QUEUE_LS_KEY = 'vitaliseraUpdateQueue';
let _inflightBatch = null;
function _persistQueue_() {
  try {
    // A07: i den ordning jobben skapades. Förr stod den avsända batchen SIST,
    // så efter en omstart skickades det äldre saldot efter det nyare och vann.
    const all = (_inflightBatch || []).concat(updateQueue).sort((a, b) => (a.seq || 0) - (b.seq || 0));
    if (!all.length) { localStorage.removeItem(_QUEUE_LS_KEY); _updateSyncBadge_(); return; }
    localStorage.setItem(_QUEUE_LS_KEY, JSON.stringify(all.map(j => ({
      fnName: j.fnName, args: j.args, seq: j.seq, ...(j.retries ? { retries: j.retries } : {})
    }))));
  } catch (_) {}
  _updateSyncBadge_();   // U4: badge speglar köerna — samma choke-point som persistering
}
function _rehydrateQueue_() {
  try {
    const raw = localStorage.getItem(_QUEUE_LS_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    // Jobb sparade av en äldre version saknar seq och får ett i lagrad ordning.
    if (Array.isArray(arr)) for (const j of arr) {
      if (!j || !j.fnName || !j.args || !j.args.tag) continue;
      if (j.seq) _noteOpSeq_(j.seq);
      updateQueue.push({ fnName: j.fnName, args: j.args, seq: j.seq || _nextOpSeq_(), ...(j.retries ? { retries: j.retries } : {}) });
    }
    updateQueue.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  } catch (_) {}
}
function queueUpdate(fnName, args) {
  // v160: callsiten skickar identiteten från sin ögonblicksbild (dialog/popup).
  // Saknas den fylls den bara i för riktiga taggar; en syntetisk nyckel slås
  // aldrig upp här, eftersom cachen kan ha byggts om sedan dialogen öppnades.
  if (args && args.tag != null) _attachIdentity_(args, args.tag, false);
  const job = { fnName, args, seq: _nextOpSeq_() };
  updateQueue.push(job);
  _persistQueue_();
  if (!updateTimer) updateTimer = setTimeout(flushUpdates, 1000);
  return job;
}
// Utfallet för ett enskilt köjobb ('verified' | 'rejected'), nyckel = seq. Inte
// beständigt: det är bara historikraden som lyssnar, och den dör med appen.
const _jobHooks_ = new Map();
// Töm kön så långt det går och vänta tills inget är på väg. Slutar när det som
// är kvar inte kan skickas nu (väntar på ett namnbyte eller fick ett tillfälligt fel).
async function waitForPendingSync() {
  if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
  for (let i = 0; i < 6; i++) {
    if (!flushInFlight) flushUpdates();
    if (!flushInFlight) return;
    try { await flushInFlight; } catch (_) {}
    if (_lastFlushRequeued_) return;
  }
}
// A09: lägg tillbaka jobb i kön i ursprunglig ordning (äldst först).
function _requeueJobs_(jobs, countRetry) {
  if (!jobs || !jobs.length) return;
  if (countRetry) for (const j of jobs) j.retries = (j.retries || 0) + 1;
  updateQueue.unshift(...jobs);
  updateQueue.sort((a, b) => (a.seq || 0) - (b.seq || 0));
}
// Bygg batch-payload från updateQueue + töm kön synkront (måste ske före gasCall
// så nya queueUpdate under flight hamnar i nästa batch, inte denna).
// updateMeta-jobb får userName injicerat här (övriga skickar det själva).
function _buildBatch_() {
  // Jobb från en äldre version (rehydrerade utan identitet) får identitet bara
  // för riktiga taggar. En syntetisk nyckel kan nu peka på en annan artikel →
  // skickas utan identitet och nekas synligt av servern (ROW_UNVERIFIED).
  for (const job of updateQueue) if (job && job.args) _attachIdentity_(job.args, job.args.tag, false);
  const { send, hold } = _takeSendableJobs_(updateQueue);
  // A07: väntar en äldre skrivning på samma artikel i en annan kö (singel-
  // registrering, ny artikel) hålls jobbet, och alla senare jobb för artikeln med det.
  const blocked = new Set(hold.map(j => j && j.args && j.args.tag));
  const ready = [];
  for (const j of send) {
    const t = j && j.args && j.args.tag;
    if (j._parked || blocked.has(t) || _olderOpPending_(t, j.seq || 0)) { blocked.add(t); hold.push(j); } else ready.push(j);
  }
  hold.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const batch = ready.map(job =>
    // A13: "rensa datum" (clearUser) ska tömma användarfältet, inte skriva dit den som är inloggad.
    job.fnName === "updateMeta" && !job.args.clearUser
      ? { fnName: job.fnName, args: { ...job.args, userName }, seq: job.seq, ...(job.retries ? { retries: job.retries } : {}) }
      : job
  );
  updateQueue.length = 0;
  updateQueue.push(...hold);   // väntar på sitt namnbyte, ligger kvar i den beständiga kön
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

// Synk-audit 2026-07-01: grace-fönster mot post-confirm-klobb. När en batch
// bekräftats rensas pendingSync, men _revalidateCacheTs_ kan omedelbart dra en
// coalescad preload som startade FÖRE writen (stale). _recentlySynced markerar
// nyss-bekräftade tags så initData-snapshoten bevarar det lokala (korrekta)
// värdet tills server-preloaden garanterat reflekterar writen (backend-guarden
// säkerställer att cachen inte längre förgiftas → server blir korrekt inom kort).
const _recentlySynced = new Map();   // tag → ms vid batch-bekräftelse
const SYNC_GRACE_MS = 20000;         // > max preload-scan (~13s) + poll-cadence-marginal
// Ren, testbar predikat: är ett nyss-synkat värde fortfarande inom grace?
function _isWithinGrace_(syncedMs, nowMs, graceMs) {
  return typeof syncedMs === 'number' && (nowMs - syncedMs) < graceMs;
}
// Slå upp + lazy-pruna utgångna poster.
function _withinSyncGrace_(tag) {
  const t = _recentlySynced.get(tag);
  if (t == null) return false;
  if (_isWithinGrace_(t, Date.now(), SYNC_GRACE_MS)) return true;
  _recentlySynced.delete(tag);
  return false;
}

// Per-index-matchning: tag kan förekomma flera gånger i samma batch (två
// updateMeta-jobb på samma rad). Rensar pendingSync på ÄKTA verifierat
// lyckade (ok + ej stale + writtenTag matchar); allt annat → fail-tag,
// pendingSync behålls (gul + ⚠️ i historik via _renderBatchOutcome_).
function _applyBatchResults_(batch, res) {
  const results = Array.isArray(res?.results) ? res.results : null;
  const failedTags = [];
  // v160: varför varje jobb nekades (för en synlig historikrad per jobb).
  // Egenskap på arrayen → signaturen är oförändrad för alla befintliga anropare.
  failedTags.details = [];
  // A09: jobb som ska försökas igen (tillfälligt fel). De ligger kvar med sin
  // ursprungliga payload och identitet; bara permanenta fel hamnar i failedTags.
  failedTags.retry = [];
  // Inget resultat alls (serverkast utan resultatlista) räknas som tillfälligt,
  // utom när servern uttryckligen sagt att felet är permanent.
  const wholeTransient = !results && !(res && res.ok === false && res.transient === false);
  const retryTags = new Set();
  // A12b: kroken returnerar true om den rullade tillbaka sin lokala ändring.
  const hook = (job, cls) => {
    const h = _jobHooks_.get(job.seq);
    if (h) { _jobHooks_.delete(job.seq); try { return h(cls) === true; } catch (_) {} }
    return false;
  };
  // A12: synkstatusen gäller ARTIKELN, inte jobbet. Gul släcks först när inget
  // jobb för artikeln i denna batch nekades eller ska försökas igen, och ingen
  // annan ändring för den väntar (kö, singelregistrering, koppling, ny artikel).
  const verifiedTags = [], dirtyTags = new Set(), rejectedTags = new Set();
  for (let i = 0; i < batch.length; i++) {
    const tag = batch[i].args.tag;
    const r = results ? results[i] : res;
    // Ett jobb efter ett tillfälligt fel på samma artikel följer med tillbaka i
    // kön, även om det lyckades: annars skulle det äldre värdet skickas om
    // EFTER det nyare och vinna. Omsändningen är ofarlig (samma värde igen).
    const transient = retryTags.has(tag) ||
      (results ? (r == null || (r.ok === false && r.transient === true)) : wholeTransient);
    if (transient) { retryTags.add(tag); dirtyTags.add(tag); failedTags.retry.push(batch[i]); continue; }
    if (!_isJobVerifiedOk_(tag, r)) {
      dirtyTags.add(tag);
      failedTags.push(tag);
      failedTags.details.push({ tag, fnName: batch[i].fnName, code: r && r.code, msg: r && r.msg, ambiguousName: !!(r && r.ambiguousName) });
      // A12b: rullade kroken tillbaka ändringen (datumvägarna) finns inget kvar
      // att varna för; annars står den nekade ändringen kvar lokalt → minns.
      if (!hook(batch[i], 'rejected')) rejectedTags.add(tag);
    } else {
      hook(batch[i], 'verified');
      verifiedTags.push(tag);
      // Synk-audit 2026-07-01 (kommentar-display-bugg): batch bekräftad → pendingSync
      // rensas, MEN _revalidateCacheTs_ kör direkt efter och kan dra en coalescad
      // preload som STARTADE FÖRE vår write (stale, utan ändringen). Då pendingSync
      // redan är false skulle initData rebuilda raden från stale server-data →
      // ikon/värde försvinner ur vyn (datan i arket är intakt). Markera tag som
      // nyss-synkad så initData-snapshoten bevarar det lokala (korrekta) värdet i
      // ett kort grace-fönster tills server-preloaden garanterat reflekterar writen.
      _recentlySynced.set(tag, Date.now());
    }
  }
  // A12b: en ny bekräftad köskrivning släpper ett tidigare avslag, men inte om
  // artikeln fick ett nytt avslag i samma batch.
  for (const tag of verifiedTags) if (!rejectedTags.has(tag)) _rejectedSync_.delete(tag);
  for (const tag of rejectedTags) _rejectedSync_.add(tag);
  // Status för varje artikel i batchen enligt den gemensamma regeln. Batchen
  // själv räknas inte (den är besvarad nu); omförsöken hanteras nedan.
  for (const tag of new Set(batch.map(j => j.args.tag))) {
    if (!retryTags.has(tag)) _settleSync_(tag, null, batch);
  }
  // A12: ett jobb som ska försökas igen ligger ännu inte i kön när krokarna ovan
  // körs (det läggs tillbaka efter detta), så en krok kan ha släckt gult för
  // artikeln. Den väntar fortfarande → gul.
  for (const tag of retryTags) {
    const cur = tagCache.get(tag);
    if (cur && !cur.pendingSync) tagCache.set(tag, { ...cur, pendingSync: true });
  }
  return failedTags;
}
// A12: väntar någon annan ändring för artikeln på svar eller på att skickas?
// A12b: även en batch som är skickad men obesvarad räknas, utom den batch vars
// svar just nu behandlas (exceptBatch), och en ångra som är på väg.
function _tagHasPendingOps_(tag, exceptBatch) {
  if (updateQueue.some(j => j && j.args && j.args.tag === tag)) return true;
  if (_inflightBatch && _inflightBatch !== exceptBatch &&
      _inflightBatch.some(j => j && j.args && j.args.tag === tag)) return true;
  if ((_undoInFlight.get(tag) || 0) > 0) return true;
  if (_pendingLogSingle.has(tag)) return true;
  for (const j of _pendingTagLinks.values()) if (j && j.currentTag === tag) return true;
  for (const j of _pendingCreates.values()) if (j && j.tag === tag) return true;
  return false;
}
// A12b: artiklar där ett köjobb nekades och ändringen INTE rullades tillbaka
// (den lokala versionen visar alltså något som inte finns i arket). Gult får
// inte släckas av en annan väg (registrering, koppling, ångra) förrän en ny
// bekräftad köskrivning för artikeln kommit, eller identiteten släppts
// (ROW_UNVERIFIED/ITEM_NOT_FOUND). Bara i minnet, som pendingSync självt.
const _rejectedSync_ = new Set();
// Ångra registrerar inget köjobb; räknaren gör den synlig för regeln ovan.
const _undoInFlight = new Map();   // tag → antal ångra som väntar på svar
// A12b: EN regel för alla skrivvägar. Gul står kvar så länge något annat för
// artikeln väntar eller har nekats. Anroparen avregistrerar sitt eget jobb
// FÖRE anropet, annars räknas det och artikeln fastnar gul.
function _syncStillPending_(tag, exceptBatch) {
  return _tagHasPendingOps_(tag, exceptBatch) || _rejectedSync_.has(tag);
}
function _settleSync_(tag, extra, exceptBatch) {
  if (!tagCache.has(tag)) return;   // B5: aldrig återskapa en flyttad nyckel
  tagCache.set(tag, { ...tagCache.get(tag), ...(extra || {}), pendingSync: _syncStillPending_(tag, exceptBatch) });
}
function _moveRejectedSync_(oldTag, newTag) {
  if (oldTag !== newTag && _rejectedSync_.delete(oldTag)) _rejectedSync_.add(newTag);
}

// msgLine + status-banner. Vid fail behålls meddelandet (med pendingSync-CSS
// på raderna) tills nästa flush — annars försvinner felet tyst efter 5s.
function _renderBatchOutcome_(failedTags) {
  const msgLine = document.querySelector("#msgLine");
  const retrying = (failedTags && failedTags.retry) ? failedTags.retry.length : 0;
  if (failedTags.length === 0 && retrying > 0) {
    // A09: tillfälligt fel → jobben ligger kvar i kön och skickas igen. Ingen
    // bock (inget är bekräftat), inget fel (inget är förlorat).
    const parked = failedTags.retry.filter(j => j._parked).length;
    const label = parked
      ? `⚠️ ${parked} ${parked === 1 ? 'ändring' : 'ändringar'} väntar, tryck på statusraden för att försöka igen`
      : `⏳ ${retrying} ${retrying === 1 ? 'ändring' : 'ändringar'} försöker igen`;
    if (msgLine) { msgLine.className = "msgLine warn"; msgLine.textContent = label; }
    show(label, "warn");
    return;
  }
  if (failedTags.length > 0) {
    const details = Array.isArray(failedTags.details) ? failedTags.details : [];
    // v160: en historikrad per nekat jobb med orsaken i klartext. Bannern
    // försvinner efter 5 s; historikraden ligger kvar, så en nekad ändring av
    // saldot (t.ex. för att artikeln flyttats i arket) syns tills man sett den.
    let reason = '';
    for (const d of details) {
      const human = humanizeSaveError(d.msg || '', d.code, d.ambiguousName === true);
      if (!reason && (d.code === 'ROW_UNVERIFIED' || d.code === 'ITEM_NOT_FOUND')) reason = human;
      try {
        const nm = (tagCache.get(d.tag) || {}).name || d.tag;
        const what = d.fnName === 'updateCount' ? 'antal' : 'ändring';
        const le = appendLog(`${nm} – ${what} sparades inte – ${human}`, d.tag, "⚠️");
        markLogWarn(le, `${nm} – ${what} sparades inte – ${human}`);
      } catch (_) {}
    }
    if (details.length) _expandLog_();
    for (const d of details) {
      if (d.code === 'ROW_UNVERIFIED' || d.code === 'ITEM_NOT_FOUND') {
        // Inget skrevs, och raden bakom nyckeln kan vara en annan artikel nu.
        // Släpp den gula lokala versionen så att den nya listan visar arkets
        // sanning; vad som inte sparades står kvar i historiken ovan.
        // A12b: avslaget glöms (raden kan vara en annan artikel), men väntar
        // en annan ändring för nyckeln står gult kvar tills den fått svar.
        _rejectedSync_.delete(d.tag);
        const c = tagCache.get(d.tag);
        if (c && c.pendingSync) _settleSync_(d.tag);
        _recentlySynced.delete(d.tag);
      }
      _refreshAfterIdentityError_(d.code);
    }
    const label = `⚠️ ${failedTags.length} ${failedTags.length === 1 ? 'rad' : 'rader'} kunde inte sparas` +
      (reason ? ` – ${reason}` : '');
    if (msgLine) { msgLine.className = "msgLine warn"; msgLine.textContent = label; }
    show(label, "warn", { autoreset: false });
    // P3a: failedTags innehåller sedan A09 BARA permanenta fel (transient:false,
    // staleRow, fel tagg skriven). De tillfälliga ligger kvar i kön (failedTags.retry)
    // och räknas inte. Andra argumentet är därför false: ingen kö tar över ett
    // permanent fel, och det ska överleva att bannern självrensar och att appen stängs.
    if (countsAsLostWrite('rejected', false)) _bumpFailedWrites_(failedTags.length);
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
// A08: bara EN batch åt gången. Den som anropar under en pågående flush får en
// ny körning när den är klar, så varje batch äger sitt tillstånd (_inflightBatch,
// diskposten) tills alla resultat är behandlade och ordningen på servern håller.
let _flushAgain_ = false;
let _lastFlushRequeued_ = false;
const _BATCH_RETRY_MS_ = [2000, 5000, 15000, 30000, 60000];
// Tak: efter så många tillfälliga fel i rad (samma gräns som eskaleringen i
// statusraden) parkeras jobbet. Det ligger kvar i kön och på disk, statusraden
// är röd, men appen slutar skicka det av sig själv. Ett tryck på statusraden
// eller en omstart av appen ger det ett nytt försök.
const _BATCH_RETRY_CAP_ = RESYNC_WARN_AFTER;
function _retryParkedJobs_() {
  for (const j of updateQueue) if (j && j._parked) delete j._parked;
  // Utan villkor: pågår en flush sätter spärren i flushUpdates en ny körning.
  flushUpdates();
}
function flushUpdates() {
  if (flushInFlight) { _flushAgain_ = true; return; }
  if (updateQueue.length === 0) return;

  const batch = _buildBatch_();
  if (!batch.length) return;   // allt väntar på namnbyten; _flushHeldSoon_ skickar sedan
  console.log("Skickar batch:", batch.map(b => b.args.tag));

  // #5: håll batchen persisterad medan den är in-flight — en PWA-kill mitt i
  // gasCall('batch') skulle annars tappa den (varken i updateQueue eller LS).
  _inflightBatch = batch;
  _persistQueue_();

  _lastFlushRequeued_ = false;
  flushInFlight = gasCall('batch', {batch})
    .then(res => {
      _clearSyncBusyUI_();
      const failedTags = _applyBatchResults_(batch, res);
      console.log("Synk klar:", batch.length - failedTags.length - failedTags.retry.length, "ok,", failedTags.length, "fail,", failedTags.retry.length, "igen");
      // #5: batchen besvarad → släpp in-flight-persistensen. A09: jobb med
      // tillfälligt fel läggs tillbaka i kön (samma payload, samma identitet)
      // och skickas igen efter en paus som växer med antalet försök.
      _inflightBatch = null;
      if (failedTags.retry.length) {
        _requeueJobs_(failedTags.retry, true);
        _lastFlushRequeued_ = true;
        // Jobb som nått taket parkeras. Övriga (andra artiklar i samma batch)
        // får sin egen, kortare väntetid och väntar inte på 60-sekundersticken.
        const live = [];
        for (const j of failedTags.retry) {
          if ((j.retries || 0) >= _BATCH_RETRY_CAP_) j._parked = true; else live.push(j);
        }
        if (live.length < failedTags.retry.length) _expandLog_();
        if (live.length) {
          const n = Math.max(...live.map(j => j.retries || 1));
          setTimeout(flushUpdates, _BATCH_RETRY_MS_[Math.min(n, _BATCH_RETRY_MS_.length) - 1]);
        }
      }
      _persistQueue_();
      renderLists();
      _renderBatchOutcome_(failedTags);
      _revalidateCacheTs_();
    })
    .catch(err => {
      _clearSyncBusyUI_();
      console.error("batch fail", err);
      // 5.3: re-queue batchen — annars förlorad permanent. _buildBatch_ tömde
      // updateQueue redan vid flush-start, så vid catch (nätfel/throw) hade
      // jobben försvunnit och pendingSync-gul kvarstod förevigt på raderna
      // tills användaren manuellt triggade en NY ändring. unshift bevarar
      // ordning (sätts först → körs i nästa flush före nya jobb). Idempotens
      // för upprepad fail: re-queue → nästa flush samma batch → fail igen →
      // re-queue igen (no growth, bara samma jobb).
      _requeueJobs_(batch, false);
      _lastFlushRequeued_ = true;
      // #5: batchen är åter i updateQueue → flytta persistensen dit (in-flight
      // tömd) så LS speglar sanningen och en kill nu räddar den via updateQueue.
      _inflightBatch = null;
      _persistQueue_();
      const msgLine = document.querySelector("#msgLine");
      if (msgLine) {
        msgLine.className = "msgLine warn";
        msgLine.textContent = "⚠️ Sparas när du är online igen";
      }
      show("Sparas när du är online igen", "warn", { autoreset: false });
    })
    .finally(() => {
      flushInFlight = null;
      if (_flushAgain_) { _flushAgain_ = false; if (updateQueue.length) setTimeout(flushUpdates, 0); }
      // A07: singelregistreringar som väntade på ett äldre köjobb kan gå nu.
      if (!_lastFlushRequeued_) _kickWaitingSingles_();
    });
}
function _kickWaitingSingles_() {
  for (const j of _pendingLogSingle.values()) {
    if (j && !j._inflight) { setTimeout(() => { try { resyncPendingTagLinks(); } catch (_) {} }, 0); return; }
  }
}
// 5.3: vid 'online' efter offline-fail, försök tömma updateQueue automatiskt
// (idempotent via flushInFlight + tom-check i flushUpdates). Utan detta krävde
// återhämtning en NY användar-mutation för att trigga flush.
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('online', () => {
    if (updateQueue.length > 0 && !flushInFlight) flushUpdates();
  });
  // #5: rehydrera ev. köade/in-flight-jobb som överlevde en PWA-kill och flush:a
  // dem så snart appen startar igen (idempotent backend → inga dubbletter). Den
  // 60s-tick + 'online' + visibilitychange driver annars vidare om nätet saknas.
  _rehydrateQueue_();
  if (updateQueue.length > 0) setTimeout(() => { if (!flushInFlight) flushUpdates(); }, 1500);
  // #5: belt-and-suspenders — persistera kön när sidan göms/avlastas (iOS dödar
  // bakgrunds-PWA aggressivt och fyrar ej alltid någon flush-bar händelse).
  window.addEventListener('pagehide', () => { try { _persistQueue_(); } catch (_) {} });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { try { _persistQueue_(); } catch (_) {} }
  });
  // U4 (v153): initiera badgen från rehydrerade köer (persist-choke-points körs
  // inte vid rehydrering) — pending jobb som överlevt en PWA-kill syns direkt.
  _updateSyncBadge_();
}

/* ===== Meta ===== */
function setLocalMeta(tag,patch){
  const prev=metaCache.get(tag)||{};
  let next={...prev,...patch};
  // §1.3 root-fix: explicit `lastMs: null` i patch är en clear-signal från
  // callern och MÅSTE respekteras FÖRE övriga grenar. Tidigare ordning lät
  // (a) `else if (lastStr fallback)` resolvera till prev.lastStr (= dagens
  // datum) och (b) `else if (prev.lastMs)` klobbra null tillbaka — båda
  // gjorde att Ångra såg ut att inte fungera (lastMs stannade på dagens).
  const explicitClear = Object.prototype.hasOwnProperty.call(patch, 'lastMs') && patch.lastMs === null;
  if(explicitClear){
    next.lastMs=null;
    next.lastStr="";
  } else if(typeof next.lastMs==="number"){
    next.lastMs=toDayMs(next.lastMs);
    next.lastStr=toDayStr(next.lastMs);
  } else if(typeof next.lastStr==="string"&&next.lastStr){
    const ms=parseLocalYMD(next.lastStr);
    next.lastMs=toDayMs(ms);
    next.lastStr=toDayStr(next.lastMs);
  } else if(prev.lastMs){
    next.lastMs=prev.lastMs;
    next.lastStr=prev.lastStr||toDayStr(prev.lastMs);
  } else {
    next.lastMs=null;
    next.lastStr="";
  }
  metaCache.set(tag,next);
}
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

  // P5: "Inventera vid koppling" — sticky toggle (default AV)
  const titleLink = document.createElement('div');
  titleLink.className = 'filterSectionTitle';
  titleLink.textContent = 'Skanning';
  placeList.appendChild(titleLink);
  {
    const row = document.createElement('div');
    row.className = 'placeRow';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.dataset.inventonlink = '1';
    chk.checked = inventOnLink;
    const txt = document.createElement('div');
    txt.className = 'placeTxt';
    txt.textContent = 'Inventera vid koppling';
    row.append(chk, txt);
    row.addEventListener('click', e => { if (e.target !== chk) chk.checked = !chk.checked; });
    placeList.appendChild(row);
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

  // P5: läs och persistera "Inventera vid koppling"
  const inventOnLinkBox = placeList.querySelector('input[data-inventonlink="1"]');
  inventOnLink = !!inventOnLinkBox?.checked;
  localStorage.setItem('vitaliseraInventOnLink', inventOnLink ? '1' : '0');

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
  const _popIdent = _identityOfItem_(tk);   // v160: artikeln som visas NU
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

  // #1 (synk-audit 2026-06-30): denna snabb-popup var appens ENDA muterande väg
  // med 0 av 5 skydd — ingen pendingSync (→ klobbades av 15s-pollens initData som
  // snapshotar BARA pendingSync-rader), fire-and-forget gasCall (kringgick kön),
  // ingen rollback/re-queue/persistens, OCH visade falsk "Kommentar sparad" FÖRE
  // serversvar. = de rapporterade förlorade kommentarerna. Fix: route via samma
  // robusta, nu persisterade (#5) kö-väg som Egenskaper-dialogen (~rad 3660) —
  // pendingSync:true skyddar optimistisk write, queueUpdate batchar + persisteras
  // → överlever PWA-kill + auto-resync, _applyBatchResults_ rensar pendingSync
  // först vid verifierad bekräftelse. userName injiceras av _buildBatch_.
  const _saveComment = (val) => {
    const cur = tagCache.get(tag) || tk;
    tagCache.set(tag, { ...cur, comment: val, pendingSync: true });
    renderLists();
    queueUpdate('updateMeta', { tag, comment: val, sheetName: tk.sheetName ?? cur.sheetName ?? null, rowNum: tk.rowNum ?? cur.rowNum ?? null, ..._popIdent });
    show(val ? "Kommentar sparas…" : "Kommentar rensas…", "ok");
    closeDialogLocal();
  };
  saveBtn.onclick = () => _saveComment((textarea.value || "").trim());
  clearBtn.onclick = () => _saveComment("");
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
// Bygg + append en sökträff-knapp. Delas av sektion "Valda flikar" + "Övriga
// flikar" i den tvådelade sökningen (Robert 2026-07-01). Tap=öppna, långtryck=redigera.
function _appendSearchHit_(info){
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
// Sektionsrubrik i sökresultaten (återanvänder searchAiHeader-stilen → ingen CSS-ändring).
function _appendSearchHeader_(text){
  const h = document.createElement('div');
  h.className = 'searchAiHeader';
  h.textContent = text;
  searchResults.appendChild(h);
}
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
      const isLow = isLowQty(meta.qty, val.minQty);
      if(!isLow) continue;
    }
    passingTags.push(tag);
    passing.push([tag, val]);
    const nameKey = name.toLocaleLowerCase('sv');
    if(!nameToTag.has(nameKey)) nameToTag.set(nameKey, tag);
  }

  const suggestions = Search.articles(qn, passing);

  // Tvådelad sökning (Robert 2026-07-01): plats-filtret dolde träffar i andra
  // flikar (ibland hjälpsamt, ibland frustrerande). Sektion 1 = valda flikar (som
  // förr). Sektion 2 = ÖVRIGA flikar (komplementet till activePlaces) — visas BARA
  // när ett plats-filter är aktivt OCH ger extra träffar. onlyLow appliceras i båda
  // för konsekvens. Sektionerna är disjunkta per plats → inga dubbletter.
  let otherSuggestions = [];
  if(activePlaces){
    const others = [];
    for(const [tag, val] of tagCache.entries()){
      const name = val?.name||""; if(!name) continue;
      if(activePlaces.has(val.place||"Okänd")) continue;   // valda flikar visas i sektion 1
      if(onlyLow){
        const meta = metaCache.get(tag)||{};
        const isLow = (val.minQty||0) && (meta.qty < val.minQty);
        if(!isLow) continue;
      }
      others.push([tag, val]);
    }
    otherSuggestions = Search.articles(qn, others);
  }
  const twoSections = otherSuggestions.length > 0;

  const shownTags = new Set();
  // Sektion 1 (valda flikar). Rubriken sätts EFTER render, och BARA om minst en
  // träff faktiskt visades — annars stod "Valda flikar" över en tom lista när
  // träffen bara fanns i övriga flikar (= huvudfallet feature:n löser).
  let sec1Count = 0;
  for(const info of suggestions){
    if(shownTags.has(info.tag)) continue;
    shownTags.add(info.tag);
    _appendSearchHit_(info);
    sec1Count++;
  }
  if(twoSections && sec1Count > 0){
    const h = document.createElement('div');
    h.className = 'searchAiHeader';
    h.textContent = 'Valda flikar';
    searchResults.insertBefore(h, searchResults.firstChild);
  }
  // Sektion 2 (övriga flikar) — rubrik läggs först när första träffen faktiskt visas.
  if(twoSections){
    let sec2Started = false;
    for(const info of otherSuggestions){
      if(shownTags.has(info.tag)) continue;
      if(!sec2Started){ _appendSearchHeader_('Övriga flikar'); sec2Started = true; }
      shownTags.add(info.tag);
      _appendSearchHit_(info);
    }
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
    if (item?.pendingSync || _withinSyncGrace_(t)) pendingSnapshot.push({ t, item, meta: metaCache.get(t) });
  }

  tagCache.clear();
  metaCache.clear();
  placeSet.clear();
  dupTagKeys.clear();

  // A11: samma kod på flera rader får inte skriva över varandra (då blev en av
  // artiklarna osynlig). Varje sådan rad får radens egen nyckel "S<flik>R<rad>",
  // samma form som tagglösa rader, och skrivs alltså via flik, rad och identitet.
  const _codeRows = new Map();
  for (const rec of records) {
    if (!Array.isArray(rec) || !rec[1] || !rec[11]) continue;
    const c = normTag(rec[0]);
    if (!c || c.startsWith("S")) continue;
    const k = _tagZeroKey_(c);
    _codeRows.set(k, (_codeRows.get(k) || 0) + 1);
  }

  records.forEach(rec => {
    // Index 16 = beständigt artikel-ID (v160). Saknas hos äldre backend → undefined.
    const [t, name, type, qty, unit, last, user, place, minQty, step, comment, rowNum, altTags, category, synonyms, sheetPlace, articleId] = rec;
    if (!name) return;
    const code = normTag(t);
    const plc = normPlace(place);
    const isDup = !!code && !code.startsWith("S") && rowNum && _codeRows.get(_tagZeroKey_(code)) > 1;
    const nt = isDup ? 'S' + String(plc).replace(/[^a-zA-Z0-9]/g, '') + 'R' + rowNum : code;
    if (isDup) {
      const k = _tagZeroKey_(code);
      dupTagKeys.set(k, [...(dupTagKeys.get(k) || []), nt]);
    }

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
      synonyms: Array.isArray(synonyms) ? synonyms : [],
      id: articleId ? String(articleId) : null,
      serverName: String(name).trim(),
      dupTag: isDup ? code : null
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
    // A11: en post under en kod som nu sitter på flera rader (t.ex. från en kö
    // sparad av v161) visas under radnycklarna. När den är synkad behövs den inte.
    if (!server && !item?.pendingSync && !_isSynthKey_(t) && dupTagKeys.has(_tagZeroKey_(t))) continue;
    let merged = server ? { ...server, ...item } : item;
    // Identiteten: servern vet bäst vad artikeln heter i arket NU (någon kan ha
    // bytt namn direkt i arket). Men bara om det är SAMMA artikel: under en
    // syntetisk nyckel kan servern nu ha en annan artikel, och då behåller den
    // lokala posten sin egen identitet.
    if (server && _adoptServerIdentity_(t, item, server)) {
      merged = { ...merged, id: server.id, serverName: server.serverName };
    }
    tagCache.set(t, merged);
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
// F1 (v154), ren och testbar (missing.test.js): lågt-saldo-predikatet som
// styr röd markering + "bara lågt saldo"-filtren. Identisk semantik med de
// tidigare inline-uttrycken (truthy minQty && qty < minQty) — qty 0 mot
// minQty >= 1 gav rött REDAN före Saknas-knappen, ingen ny logik behövdes.
function isLowQty(qty, minQty) { return !!(minQty && qty < minQty); }

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

    const isLow = isLowQty(meta.qty, item.minQty);
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
  // B5 (v153): kör uppskjutna nyckel-swappar (S→riktig tagg) nu när dialogen
  // rivs. MÅSTE ligga EFTER autosave-flushen ovan: flushen köar ev. sista jobb
  // under den gamla S-nyckeln, och swappen re-keyar dem direkt efteråt.
  _runDeferredKeySwaps_();
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
  dlgTitle.textContent="";dlgTitle.contentEditable="false";dlgTitle.oninput=null;dlgTitle.onblur=null;dlgInfo.innerHTML="";dlgBtns.innerHTML="";newItemFields.classList.add("hidden");dlgInputWrap.classList.add("hidden");dlgInput.value="";dlgInput.disabled=false;dlgInputSuffix.textContent="";manualName.value="";manualName.oninput=null;manualQty.value="";{const _mq=qs('#manualMinQty');if(_mq)_mq.value="";}if(_aiSuggestTimer){clearTimeout(_aiSuggestTimer);_aiSuggestTimer=null;}dlg.querySelectorAll('.tagScanRow,.extraFields,.aiChip,.commentBlock,.qtyConfirm').forEach(el=>el.remove());
}

/* ===== Behållare-dialog ===== */
/* ===== Singel-bekräftelsedialog ===== */
function prepareSingleDialog(item, tag) {
  resetDialog();
  currentDialogTag = tag;
  // v160 (A03): identiteten fångas när dialogen ÖPPNAS och följer med varje
  // skrivning härifrån. Pollern kan bygga om cachen medan dialogen är öppen.
  const _dlgIdent = _identityOfItem_(item);
  const meta = metaCache.get(tag) || {};
  const toYMD = d => { if (!d) return ""; const dt = new Date(d); if (isNaN(dt)) return ""; return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`; };

  dlgTitle.textContent = item.name || "Okänd artikel";
  dlgTitle.contentEditable = "false";
  const ha=document.getElementById('help-article'); if(ha){ha.classList.remove('open'); ha.innerHTML='<b>Föregående inventering</b> visar senast sparade uppgifter. Under <b>Ny inventering</b> registrerar du dagens.<br><b>Registrera inventering</b> bekräftar dagens inventering med ditt namn och datum.<br><b>Saknas</b> sätter saldot till noll med dagens datum och ditt namn. Artikeln räknas som inventerad idag och blir röd i listan om den borde finnas under kurs.<br><b>Nytt datum</b> ändrar inventeringsdatum; rensa fältet för att avinventera artikeln.<br>"⚙️ Egenskaper" öppnar kommentar, kategori, enhet, typ, min-mängd och tag.';}

  const todayYMD = toYMD(Date.now());
  const oldDate = toYMD(meta.lastMs);
  // U5 (v152): gamla och nya värden var oetiketterade — föregående saldo/person/
  // datum stod direkt ovanför "Nytt datum:" (prefyllt med idag) och blandades
  // ihop med den nya registreringen. Nu två tydligt separerade block.
  dlgInfo.innerHTML = `
    <div class="invPrev">
      <div class="invLabel">Föregående inventering</div>
      <div class="metaTop">
        <span class="metaQty">${esc(meta.qty ?? 0)} ${esc(meta.unit ?? "")}</span>
        ${meta.user ? `<span class="metaBy"> • ${esc(meta.user)}</span>` : ""}
        ${oldDate ? `<span class="metaBy"> • ${esc(oldDate)}</span>` : ""}
      </div>
    </div>
    <div class="invNew">
      <div class="invLabel">Ny inventering</div>
      <div class="metaDate">Nytt datum:<input type="date" id="singleDateEdit" value="${esc(todayYMD)}"></div>
    </div>
  `;

  dlgBtns.innerHTML = `
    <button id="cancelSingle" class="btn cancel">Stäng</button>
    <button id="missingSingle" class="btn missing">Saknas</button>
    <button id="editSingle" class="btn icon-btn" aria-label="Egenskaper" title="Egenskaper"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
    <button id="confirmSingle" class="btn">Registrera inventering</button>
    <div id="msgLine" class="msgLine"></div>
  `;

  dlg.classList.remove("hidden");

  const dateInput = qs("#singleDateEdit");
  dateInput.addEventListener('change', () => {
    const newVal = dateInput.value;
    // #3 (synk-audit 2026-06-30): denna datum-väg var oobserverad fire-and-forget
    // — gasCall UTAN .then/.catch (fel sväljs HELT), ingen pendingSync (optimistisk
    // write klobbades av 15s-pollen), och visade "Datum uppdaterat"/"rensat"
    // oavsett utfall (falsk framgång → tyst tappad avinventering/datumändring).
    // Fix: spegla commitContainerDate — gasCallWithRetry + classifyLinkResult,
    // pendingSync:true skyddar optimistisk write, villkorat meddelande (success
    // först vid verified), rollback vid äkta server-avvisning. OBS: clear-grenen
    // (userName:'') KAN EJ gå via batch — _buildBatch_ injicerar global userName
    // för updateMeta → skulle skriva tillbaka användaren istf. blanka. (A13: det
    // gäller inte längre, _buildBatch_ hoppar över clearUser-jobb; datumet köas.)
    const cur = tagCache.get(tag) || {};
    const _prevMeta = metaCache.get(tag) || {};
    const innerArgs = newVal
      ? { lastYMD: newVal, userName, sheetName: cur.sheetName ?? null, rowNum: cur.rowNum ?? null }
      : { clearTimestamp: true, clearUser: true, userName: '', sheetName: cur.sheetName ?? null, rowNum: cur.rowNum ?? null };
    if (newVal) {
      const ms = new Date(newVal + 'T12:00:00').getTime();
      setLocalMeta(tag, { lastMs: ms, user: userName });
    } else {
      setLocalMeta(tag, { lastMs: null, user: '' });
    }
    tagCache.set(tag, { ...cur, pendingSync: true });
    recomputeMaxLast(); renderLists();
    const ml = qs("#msgLine"); if (ml) { ml.className = 'msgLine ok'; ml.textContent = newVal ? 'Datum sparas…' : 'Avinventeras…'; }
    // Historikrad, precis som commitContainerDate gör. Utan den fäller ett
    // misslyckat datum ut historiken och räknar upp den röda statusraden — men
    // där finns ingen rad att se. Handboken lovar på tre ställen att man ska
    // kunna trycka på raden och se vad som hände; det måste vara sant.
    const le = appendLog(newVal
      ? `${item.name} – datum ${newVal}`
      : `${item.name} – datum rensat (avinventerad)`, tag);
    // A13: datumet går genom den beständiga kön, som i commitContainerDate. Det
    // ligger på disk direkt, överlever att appen stängs och skickas om av sig
    // självt när nätet är tillbaka. _buildBatch_ skriver inte dit inloggat namn
    // för clearUser, så "rensa datum" tömmer användarfältet även via kön.
    const job = queueUpdate('updateMeta', { tag, ...innerArgs, ..._dlgIdent });
    let settled = false;
    _jobHooks_.set(job.seq, cls => {
      settled = true;
      const ml2 = qs("#msgLine");
      if (cls === 'verified') {
        // Utan detta står historikraden kvar med ⏳ för alltid.
        markAsDone(le);
        if (ml2) { ml2.className = 'msgLine ok'; ml2.textContent = newVal ? 'Datum uppdaterat' : 'Datum rensat, artikeln avinventerad'; }
        return;
      }
      metaCache.set(tag, _prevMeta);
      tagCache.set(tag, { ...(tagCache.get(tag) || {}), pendingSync: _syncStillPending_(tag) });
      recomputeMaxLast(); renderLists();
      markLogWarn(le, `${item.name} – datumet sparades inte`);
      if (ml2) { ml2.className = 'msgLine warn'; ml2.textContent = 'Kunde inte spara datumet'; }
      return true;   // A12b: tillbakarullat
    });
    (async () => {
      try { await waitForPendingSync(); } catch (_) {}
      if (!settled) {
        const ml2 = qs("#msgLine");
        markLogWarn(le, `${item.name} – datumet sparas när du är online igen`);
        if (ml2) { ml2.className = 'msgLine warn'; ml2.textContent = 'Datumet sparas när du är online igen'; }
      }
    })();
  });

  qs("#confirmSingle").onclick = () => {
    dlg.classList.add("hidden");
    Save.logSingle(tag, { name: item.name, sheetName: item.sheetName, rowNum: item.rowNum, ..._dlgIdent });
    statusDefault();
  };

  // F1 (v154): "Saknas" = en inventering med resultatet noll. Åker på EXAKT
  // samma persisterade kö-väg som behållar-saldot (queueUpdate → batch →
  // updateCount). Servern stämplar qty=0 + dagens datum + användarnamn i
  // SAMMA anrop (Code.js updateCount → updateRowWithCols, verifierat
  // 2026-07-04: qty-guarden är `!== undefined && !== null` så 0 skrivs,
  // TIMESTAMP sätts alltid, USER när icke-tom) — inga dubbla serveranrop.
  qs("#missingSingle").onclick = () => {
    dlg.classList.add("hidden");
    markSingleMissing(tag, item.name || "Okänd artikel",
      { ...buildMissingPayload(tag, item, userName), ..._dlgIdent });
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

// F1 (v154): markera en singel-artikel som saknad. Optimistisk lokal write +
// pendingSync-skydd mot poll-klobb (samma mönster som saveBtn-saldovägen
// ~4029), sedan den BEFINTLIGA persisterade kö-vägen queueUpdate('updateCount')
// — batchning, retry, rehydrering och rollback oförändrade (synk-kärnan orörd).
// Historikraden får sitt utfall från JUST det köjobbet (_jobHooks_, som
// _applyBatchResults_ anropar): verifierat sparat → ✅, nekat → ⚠️. Inget svar
// än → ⚠️ "sparas när du är online igen" tills svaret kommer (ingen falsk bock).
function markSingleMissing(tag, name, payload) {
  setLocalMeta(tag, { qty: 0, lastMs: Date.now(), user: userName });
  tagCache.set(tag, { ...(tagCache.get(tag) || {}), pendingSync: true });
  recomputeMaxLast();
  renderLists();
  const le = appendLog(`${name} – markerad som saknad – sparas…`, tag);
  show(`${name}: markerad som saknad – sparas…`, "ok");
  const job = queueUpdate('updateCount', payload);
  // Utfallet kommer från just det här jobbet, när det än besvaras: efter ett
  // hållet namnbyte, efter ett tillfälligt fel som försökts igen eller efter
  // att nätet kommit tillbaka. ⚠️ blir då ✅ (eller står kvar om det nekades;
  // nekandet har då redan fått en egen historikrad av _renderBatchOutcome_).
  let settled = false;
  _jobHooks_.set(job.seq, cls => {
    settled = true;
    const ic = le.querySelector('.icon'), m = le.querySelector('.msg');
    if (cls === 'verified') {
      le.classList.remove(LOG_WARN_CLASS);
      if (ic) ic.textContent = '✅';
      if (m) m.textContent = `${name} – markerad som saknad`;
    } else {
      markLogWarn(le, `${name} – markerad som saknad – sparades inte`);
    }
  });
  (async () => {
    try { await waitForPendingSync(); } catch (_) {}
    // Inte besvarat än (offline, tillfälligt fel eller ett namnbyte som håller
    // jobbet): det ligger kvar i den beständiga kön, meddelandet är SANT.
    // P3b: eviction-immun rad. Ingen uppräkning av felräknaren (kön försöker igen).
    if (!settled) markLogWarn(le, `${name} – markerad som saknad – sparas när du är online igen`);
  })();
  return le;
}

function prepareContainerDialog(item, tag, opts = {}) {
  resetDialog();
  // v154 (reviewer-uppföljning v153): sätt currentDialogTag HÄR i stället för
  // att lita på att varje anropare gör det — sökresultatens editMode-callsites
  // (renderSearchResults m.fl.) anropade direkt utan att sätta den, så key-swap-
  // deferralens guard (rad ~1501: currentDialogTag === oldTag) täckte inte den
  // vägen. Måste ligga EFTER resetDialog (closeDialog nollar; autosave-flushen
  // i resetDialog ska se den GAMLA dialogens tag). Alla anropare som redan
  // sätter den (openContainerForTag, swipe, koppla-flödet) sätter SAMMA tag
  // före anropet → redundant men ofarligt.
  currentDialogTag = tag;
  // v160 (A03): identiteten fångas när dialogen ÖPPNAS och skickas uttryckligen
  // från varje skrivning nedan (saldo, datum, egenskaper, namn, koppling,
  // radering). Muteras bara av ett bekräftat namnbyte i SAMMA dialog.
  const _dlgIdent = _identityOfItem_(item);
  const ha=document.getElementById('help-article'); if(ha){ha.classList.remove('open'); ha.innerHTML='<b>Föregående inventering</b> visar senast sparade saldo, person och datum. Under <b>Ny inventering</b> registrerar du dagens.<br>Tryck <b>−</b> eller <b>+</b> för att räkna upp/ner. Steget följer siffrans decimaler: 3 blir 4, men 0,5 blir 0,6. Du kan också tappa siffran och skriva in en helt ny total.<br><b>Spara</b> bekräftar mängden och stänger dialogen.<br><b>Nytt datum</b> ändrar inventeringsdatum; rensa fältet för att avinventera.<br>Tryck på artikelnamnet för att byta namn.<br>"⚙️ Egenskaper" visar kommentar, kategori, enhet, typ, min-mängd och tag (tag sparas direkt när du skannar).<br>Byter du enhet mellan till exempel kg och g erbjuder appen att räkna om saldot. Ser ett nytt saldo orimligt stort eller litet ut jämfört med förra gången frågar appen en extra gång innan det sparas.';}

  const editMode = opts.editMode === true;
  // Reset per dialog: editMode (Egenskaper från singel) öppnar expanderat,
  // alla andra ingångar börjar kollapsade så det blir konsekvent UX.
  extraFieldsExpanded = editMode;
  const meta = metaCache.get(tag) || {};
  // P0a-fix: vissa callsites (localItem i onScanResult-cache-hit-grenen,
  // m.fl.) plockar inte med sheetPlace + category när de bygger item-objektet
  // som passas till prepareContainerDialog. dialogItem={...item}-spread ärver
  // då undefined → rad 3205/3230 ser "(ingen)" som selected. UX-bug (visar
  // tomt trots Sheet-värde) + kantfall för dataförlust (om användaren faktiskt
  // rör dropdown skrivs blur-saven över med ny tom-värde). Robert verifierade
  // att blur-triggered save bara skickar faktiskt ändrade fält → INTE aktiv
  // dataförlust så länge användaren inte rör dropdown. Fallback till tagCache
  // (sanningskällan från initData rad 2456-2457) säkerställer att load-vägen
  // alltid har dessa fält. Sändar-sidan (localItem) lämnas oförändrad — mer
  // future-proof att lappa mottagaren än alla 9 callsites.
  const cachedRow = tagCache.get(tag) || {};
  const _sn = item.sheetName || cachedRow.sheetName || null;
  const _rn = item.rowNum || cachedRow.rowNum || null;
  const dialogItem = {
    ...item,
    qty: meta.qty ?? 0,
    unit: meta.unit ?? "",
    user: meta.user ?? "",
    // null (EJ Date.now()) för aldrig inventerad: ?? Date.now() gjorde oldDate=idag →
    // decideDateCommit 'none' → Spara med oförändrat saldo blev TYST no-op (fältfynd
    // 2026-07-30, deterministiskt reproducerat). null → oldDate='' → 'set' → stämplas.
    lastMs: meta.lastMs ?? null,
    minQty: item.minQty ?? cachedRow.minQty ?? 0,
    comment: item.comment ?? cachedRow.comment ?? "",
    sheetPlace: item.sheetPlace ?? cachedRow.sheetPlace ?? "",
    category: item.category ?? cachedRow.category ?? ""
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
      const _oldName = dialogItem.name;
      const _ident = { ..._dlgIdent };   // expectedName = det gamla namnet i arket
      const _prevRename = _renamesInFlight_.get(tag);
      // Skrivningar på samma artikel väntar in svaret (se _awaitRenames_).
      const _endRename = _beginRename_(tag, _oldName, n);
      const _entry = _renamesInFlight_.get(tag);
      if (_ident.expectedName && _ident.expectedName !== _oldName) {
        // Det gamla namnet i arket (serverName) kan skilja sig från det visade.
        _entry.oldName = _ident.expectedName;
      }
      // Svarar namnbytet aldrig ska de hållna jobben ändå gå iväg efter gränsen.
      setTimeout(_flushHeldSoon_, 45100);
      dialogItem.name = n;
      tagCache.set(tag, { ...tagCache.get(tag), name: n });
      // D (samma klass): .catch(console.log) svalde fel TYST — användaren såg
      // det nya namnet i UI:t men det kunde aldrig ha sparats. Verifierat via
      // classifyLinkResult; ej-bekräftat → ⚠️-banner (ingen tyst förlust).
      // gasCallWithRetry → exhausted/nätfel skiljs från äkta server-avvisning.
      const _sheetName = dialogItem.sheetName, _rowNum = dialogItem.rowNum;
      _afterPrevRename_(_prevRename, _ident, _entry)
        .then(() => gasCallWithRetry('updateName', {tag, newName: n, sheetName: _sheetName, rowNum: _rowNum, ..._ident}))
        .then(res => {
          const _cls = classifyLinkResult(res);
          _endRename(_cls === 'verified');
          if (_cls === 'verified') {
            // Arket heter nu n → kommande skrivningar ska förvänta sig n.
            const c = tagCache.get(tag);
            if (c) tagCache.set(tag, { ...c, serverName: n });
            _dlgIdent.expectedName = n;   // dialogens följande skrivningar
            if (_ident.expectedName) _renameIdentityInQueues_(tag, _ident.expectedName, n);
          } else if (_cls === 'rejected') {
            // Servern sa nej (raden kunde inte bekräftas eller finns inte) →
            // visa inte ett namn som aldrig sparades.
            const c = tagCache.get(tag);
            if (c && c.name === n) tagCache.set(tag, { ...c, name: _oldName });
            if (dialogItem.name === n) dialogItem.name = _oldName;
            if (dlgTitle && dlgTitle.textContent.trim() === n) dlgTitle.textContent = _oldName;
            renderLists();
            _refreshAfterIdentityError_(res && res.code);
            show("Namnbytet sparades inte: " + humanizeSaveError((res && res.msg) || '', res && res.code, !!(res && res.ambiguousName)), "warn");
          } else {
            show("Namnbyte kunde inte bekräftas — försök igen", "warn");
          }
          _flushHeldSoon_();
        })
        .catch(() => { _endRename(false); _flushHeldSoon_(); show("Namnbyte kunde inte bekräftas — försök igen", "warn"); });
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
  // P7: plats|kategori-rad mellan namn och meta-rad. Icke-redigerbar.
  // Samma stil som "Linda A"-raden (.metaBy). Saknas båda → dölj raden.
  const _p7Place = (dialogItem.sheetPlace || "").trim();
  const _p7Cat = (dialogItem.category || "").trim();
  const _p7Parts = [];
  if (_p7Place) _p7Parts.push(esc(_p7Place));
  if (_p7Cat) _p7Parts.push(esc(_p7Cat));
  const _p7Line = _p7Parts.length
    ? `<div class="metaBy" style="margin-bottom:4px">${_p7Parts.join(' | ')}</div>`
    : '';
  // U5 (v152): samma tvåblocks-struktur som i prepareSingleDialog — föregående
  // inventering (dämpad) tydligt skild från den nya registreringen.
  dlgInfo.innerHTML = `
    ${_p7Line}
    <div class="invPrev">
      <div class="invLabel">Föregående inventering</div>
      <div class="metaTop">
        <span class="metaQty">${esc(dialogItem.qty)} ${esc(dialogItem.unit)}</span>
        ${dialogItem.user ? `<span class="metaBy"> • ${esc(dialogItem.user)}</span>` : ""}
        ${oldDate ? `<span class="metaBy"> • ${esc(oldDate)}</span>` : ""}
      </div>
    </div>
    <div class="invNew">
      <div class="invLabel">Ny inventering</div>
      <div class="metaDate">Nytt datum:<input type="date" id="containerDateEdit" value="${esc(isoDate)}"></div>
    </div>
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
    const _prevCommitted = _lastCommittedDate;
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
    // A13: datumet går genom den beständiga kön (samma väg som saldo och
    // "saknas"): det ligger på disk direkt, överlever att appen stängs och
    // skickas om av sig självt när nätet är tillbaka. Utfallet kommer från just
    // det här jobbet. Nekar servern rullas ändringen tillbaka och datumet räknas
    // inte längre som sparat, så samma datum kan sättas igen direkt.
    const _committed = _lastCommittedDate;
    const job = queueUpdate('updateMeta', { tag, ...args, ..._dlgIdent });
    let settled = false;
    _jobHooks_.set(job.seq, cls => {
      settled = true;
      if (cls === 'verified') {
        recomputeMaxLast(); renderLists();
        markAsDone(le);
        return;
      }
      metaCache.set(tag, _prevMeta);
      tagCache.set(tag, { ..._prevItem, pendingSync: _syncStillPending_(tag) });
      if (_lastCommittedDate === _committed) _lastCommittedDate = _prevCommitted;
      recomputeMaxLast(); renderLists();
      const _msg = le && le.querySelector('.msg');
      markLogWarn(le, (_msg ? _msg.textContent : '') + ' – sparades inte');
      return true;   // A12b: tillbakarullat
    });
    (async () => {
      try { await waitForPendingSync(); } catch (_) {}
      if (!settled) {
        const _msg = le && le.querySelector('.msg');
        markLogWarn(le, (_msg ? _msg.textContent : '') + ' – sparas när du är online igen');
      }
    })();
    return true;
  };

  const containerDateInput = qs("#containerDateEdit");
  if (containerDateInput) {
    containerDateInput.addEventListener('change', () => {
      if (commitContainerDate(containerDateInput.value)) {
        setMsg(containerDateInput.value
          ? 'Datum uppdaterat' : 'Datum rensat, artikeln avinventerad', 'ok');
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

  // Unika enheter för enhets-select. F3 (v155): grupperade per familj
  // (Vikt/Volym/Styck/Övriga) via buildUnitOptionsHTML — innehållet är
  // fortfarande exakt de enheter som förekommer i datat (collectUnits).
  const currentUnit = (dialogItem.unit || "").trim();
  const unitList = collectUnits();
  if (currentUnit && !unitList.includes(currentUnit)) unitList.unshift(currentUnit);
  const unitOptions = buildUnitOptionsHTML(unitList, currentUnit);

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
    <div id="unitNewGate" class="unitNote" style="display:none">
      Ny enhet gör det svårare att tolka saldot senare. Finns ingen passande i listan?
      <button id="unitNewUseBtn" class="btn" type="button">Använd nya enheten</button>
    </div>
    <div id="unitConvOffer" class="unitConv" style="display:none">
      <div id="unitConvText"></div>
      <div class="unitConvBtns">
        <button id="unitConvNo" class="btn cancel" type="button">Nej, behåll siffran</button>
        <button id="unitConvYes" class="btn" type="button">Ja, räkna om</button>
      </div>
    </div>
    <div id="unitHint" class="unitNote" style="display:none"></div>

    <label>Typ</label>
    <select id="typeEdit">
      <option value="singel"${(item.type||"singel")==="singel"?" selected":""}>Singel</option>
      <option value="behållare"${(item.type||"")==="behållare"?" selected":""}>Behållare</option>
    </select>

    <label>Mängd som ska finnas under kurs</label>
    <input id="minQtyEdit" type="number" inputmode="decimal" value="${esc(dialogItem.minQty)}">

    <label>Tag <span style="font-weight:400;font-size:0.8em;opacity:0.7">(sparas direkt vid skanning)</span></label>
    <div class="tagRow">
      <input id="tagDisplay" type="text" value="${esc(tag.startsWith('S') ? (tagCache.get(tag)?.dupTag || '(ingen tag)') : tag)}" readonly title="Klicka för att se hela taggen">
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

  // F3 (v155): mjuk gate för "+ Ny enhet". Funktionsnivå-scopad så BÅDE
  // unitSel-blocket nedan och autoSaveExtra (~4230) ser samma flagga.
  let unitNewConfirmed = false;

  // Enhet: visa ny-textinput när "+ Ny enhet…" valts.
  // F3 (v155): dessutom enhetsgovernance — mjuk gate för ny enhet (lager 1),
  // behållarenhets-avrådan (lager 2 light), omräkningserbjudande inom samma
  // mätfamilj + varning vid familjebyte (lager 3). Allt klient-side; själva
  // enhets-committen går oförändrat via autoSaveExtra → queueUpdate.
  const unitSel = extra.querySelector("#unitEdit");
  const unitNew = extra.querySelector("#unitNew");
  if (unitSel && unitNew) {
    const unitNewGate = extra.querySelector("#unitNewGate");
    const unitNewUseBtn = extra.querySelector("#unitNewUseBtn");
    const unitConvOffer = extra.querySelector("#unitConvOffer");
    const unitConvText = extra.querySelector("#unitConvText");
    const unitConvYes = extra.querySelector("#unitConvYes");
    const unitConvNo = extra.querySelector("#unitConvNo");
    const unitHint = extra.querySelector("#unitHint");
    // Senast sedda enheten — jämförelsepunkt för familje-/omräkningslogiken.
    let unitPrev = currentUnit;

    // "Ja, räkna om": konvertera saldot via EXAKT samma optimistiska mönster
    // och persisterade kö-väg som saveBtn-saldovägen (~4090) — synk-kärnan
    // orörd. Servern stämplar datum+användare i samma updateCount, så den
    // lokala spegeln gör detsamma.
    const applyUnitConversion = (newQty, newUnit) => {
      setLocalMeta(tag, { qty: newQty, lastMs: Date.now(), user: userName });
      tagCache.set(tag, { ...(tagCache.get(tag) || {}), pendingSync: true });
      recomputeMaxLast(); renderLists();
      dialogItem.qty = newQty;
      const prevQtyEl = dlgInfo.querySelector('.invPrev .metaQty');
      if (prevQtyEl) prevQtyEl.textContent = `${formatQtySv(newQty)} ${newUnit}`;
      if (!isSingle) dlgInput.value = String(newQty).replace('.', ',');
      setMsg(`Saldot omräknat: ${formatQtySv(newQty)} ${newUnit}`, "ok");
      queueUpdate('updateCount', { tag, newCount: newQty, userName, sheetName: _sn, rowNum: _rn, ..._dlgIdent });
    };

    const evalUnitChange = (newUnitRaw) => {
      if (unitConvOffer) unitConvOffer.style.display = "none";
      if (unitHint) { unitHint.style.display = "none"; unitHint.textContent = ""; }
      const nu = (newUnitRaw || "").trim();
      if (!nu || nu === unitPrev) return;
      const old = unitPrev;
      unitPrev = nu;
      const hints = [];
      // Lager 3: samma mätfamilj (massa/volym) + numeriskt saldo > 0 → erbjud omräkning.
      const curQty = Number(metaCache.get(tag)?.qty);
      const conv = (isFinite(curQty) && curQty > 0) ? convertQty(curQty, old, nu) : null;
      if (conv != null && unitConvOffer && unitConvText && unitConvYes && unitConvNo) {
        unitConvText.textContent = `Räkna om saldot? ${formatQtySv(curQty)} ${old} = ${formatQtySv(conv)} ${nu}`;
        unitConvOffer.style.display = "block";
        unitConvYes.onclick = () => { unitConvOffer.style.display = "none"; applyUnitConversion(conv, nu); };
        unitConvNo.onclick = () => { unitConvOffer.style.display = "none"; };
      } else if (old && unitFamily(old) !== unitFamily(nu)) {
        // Familjebyte (kg→l, kg→förp, till/från okänd): tillåtet, men saldot
        // räknas inte om — säg det så siffran inte feltolkas.
        hints.push("Enheterna mäter olika saker, saldot räknas inte om.");
      }
      // Lager 2 light: behållarenhet utan mängdinformation → mjuk avrådan.
      if (isContainerUnit(nu)) {
        hints.push(`En enhet som "${nu}" säger inte hur mycket varje förpackning rymmer. Skriv gärna mängden per styck i kommentaren, så blir saldot lättare att tolka senare.`);
      }
      if (hints.length && unitHint) {
        unitHint.textContent = hints.join(" ");
        unitHint.style.display = "block";
      }
    };

    unitSel.addEventListener("change", () => {
      const isNew = unitSel.value === "__new__";
      unitNew.style.display = isNew ? "block" : "none";
      if (unitNewGate) unitNewGate.style.display = isNew ? "block" : "none";
      if (isNew) {
        unitNewConfirmed = false;
        unitNew.value = "";
        unitNew.focus();
        if (unitConvOffer) unitConvOffer.style.display = "none";
        if (unitHint) { unitHint.style.display = "none"; unitHint.textContent = ""; }
      } else {
        evalUnitChange(unitSel.value);
      }
    });
    if (unitNewUseBtn) {
      unitNewUseBtn.onclick = () => {
        const typed = (unitNew.value || "").trim();
        if (!typed) { unitNew.focus(); return; }
        unitNewConfirmed = true;
        if (unitNewGate) unitNewGate.style.display = "none";
        evalUnitChange(typed);
        scheduleAutoSave();
      };
    }
    // Review-fix (minor): redigeras texten EFTER "Använd nya enheten" måste
    // gaten armas om — annars autosparas den OMSKRIVNA enheten obekräftad.
    // Speglar ny artikel-dialogens oninput-mönster. Registreras FÖRE
    // scheduleAutoSave-input-listenern (loopen längre ner) så re-armeringen
    // hinner före debounce-schemaläggningen.
    unitNew.addEventListener("input", () => {
      if (unitNewConfirmed) {
        unitNewConfirmed = false;
        if (unitNewGate) unitNewGate.style.display = "block";
      }
    });
  }

  // Skanna tag-knapp. `cached` lyfts till funktionsnivå så scanTagBtn-handlern
  // kan referera den utan ReferenceError-risk (var tidigare block-scoped i tagDisplay-blocket).
  const scanTagBtn = extra.querySelector("#scanTagBtn");
  const tagDisplay = extra.querySelector("#tagDisplay");
  const cached = tagCache.get(tag);
  if (tagDisplay) {
    tagDisplay.addEventListener("click", () => {
      const primary = tag.startsWith("S") ? (cached?.dupTag || null) : tag;
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
        // B5 (v153): samma optimistiska fyr som övriga kopplingsvägar. Här är
        // artikeldialogen dock redan öppen igen (cancelTagScan visar den innan
        // callbacken körs) → dialogOpen()-guarden undertrycker steget medvetet:
        // användaren står redan i artikelns dialog och kan inventera där.
        _fireInventOnLink(tag, targetName, scannedTag);
        const result = await Save.linkTag(scannedTag, {
          name: targetName,
          sheetName: _sn || (cached?.place),
          rowNum: _rn || (cached?.rowNum),
          currentTag: tag,
          ..._dlgIdent
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

  // Stepper [−]/[+] stegar med värdets egen decimalupplösning (se stepQty).
  // Användaren kan också tappa siffran och skriva en ny total direkt. Spara
  // skickar den slutliga siffran till samma updateCount-API som förut.
  const qtyDecBtn = qs("#qtyDec");
  const qtyIncBtn = qs("#qtyInc");
  const adjustQty = (dir) => {
    dlgInput.value = stepQty(dlgInput.value, dir);
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
      Save.logSingle(tag, { name: dialogItem.name, sheetName: _sn, rowNum: _rn, ..._dlgIdent });
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
    // F3 lager 4 (v155): rimlighetsspärr FÖRE all commit (datum + saldo +
    // queueUpdate — synk-kärnan orörd). Avviker nya saldot mer än 100× från
    // förra (båda > 0) visas ett bekräftelsesteg med båda värdena i stället
    // för att spara direkt. "Ja, spara" kör exakt samma commit-väg; "Ändra"
    // lämnar allt ocommittat och fokuserar fältet. 0→stort och tomt→värde
    // spärras INTE (första inventering är legitim) — se isImplausibleQtyChange.
    const commitCount = () => {
      // Spara ev. även datum-ändring (no-op om redan committat).
      if (containerDateInput) commitContainerDate(containerDateInput.value);
      doCommitCount();
    };
    if (isImplausibleQtyChange(oldCount, newCount)) {
      dlg.querySelectorAll('.qtyConfirm').forEach(e => e.remove());
      const u = (metaCache.get(tag)?.unit || dialogItem.unit || "").trim();
      const box = document.createElement('div');
      box.className = 'qtyConfirm';
      box.innerHTML = `
        <div class="qtyConfirmText">Nytt saldo: <b>${esc(formatQtySv(newCount))}${u ? ' ' + esc(u) : ''}</b>. Förra: <b>${esc(formatQtySv(oldCount))}${u ? ' ' + esc(u) : ''}</b>. Stämmer det?</div>
        <div class="qtyConfirmBtns">
          <button type="button" class="btn cancel" id="qtyConfirmEdit">Ändra</button>
          <button type="button" class="btn" id="qtyConfirmYes">Ja, spara</button>
        </div>`;
      dlgBtns.parentNode.insertBefore(box, dlgBtns);
      box.querySelector('#qtyConfirmYes').onclick = () => { box.remove(); commitCount(); };
      box.querySelector('#qtyConfirmEdit').onclick = () => { box.remove(); dlgInput.focus(); };
      setMsg("Kontrollera saldot innan det sparas.", "warn");
      return;
    }
    commitCount();
    return;

    // doCommitCount är en function declaration och HOISTAS — därför kan
    // commitCount ovan anropa den trots att definitionen står efter return.
    // Innehållet är den ORÖRDA v152-saldovägen (flyttad, inte ändrad).
    function doCommitCount() {
    // #2 (synk-audit 2026-06-30): saldot saknade pendingSync (klobbades av 15s-
    // pollens initData som snapshotar BARA pendingSync-rader), körde bare gasCall
    // UTAN retry, visade success FÖRE serversvar, och assertOk-glipan (#4) lät
    // t.o.m. ett serverkast passera som ✓ → tappade inventeringar. Fix: route via
    // samma robusta, nu persisterade (#5) kö-väg som Egenskaper/kommentar.
    // pendingSync:true skyddar den optimistiska qty-writen mot poll-klobb;
    // queueUpdate batchar updateCount (idempotent setValue på servern),
    // persisteras → överlever PWA-kill + auto-resync; _applyBatchResults_ rensar
    // pendingSync först vid VERIFIERAD bekräftelse, ⚠️-banner vid fel.
    // Historik-loggen (appendLog) utgår här precis som för Egenskaper-edits —
    // radens gul→vit + den globala synk-bannern är sanningskällan, ingen falsk
    // per-rad-bock. userName skickas i payloaden (batch injicerar bara för
    // updateMeta, ej updateCount).
    setLocalMeta(tag, { qty: newCount, lastMs: Date.now(), user: userName });
    tagCache.set(tag, { ...(tagCache.get(tag) || {}), pendingSync: true });
    recomputeMaxLast(); renderLists();
    show(`${dialogItem.name}: ny mängd ${newCount} – sparas…`, "ok");
    closeDialog();

    queueUpdate('updateCount', { tag, newCount, userName, sheetName: _sn, rowNum: _rn, ..._dlgIdent });
    }
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
    // F3 (v155): mjuk gate — interaktiva saves väntar tills den nya enheten
    // uttryckligen bekräftats ("Använd nya enheten"). Teardown-flushen
    // (isFlush) committar ÄNDÅ, så en ifylld men obekräftad enhet tappas
    // aldrig vid stängning/kortbyte — gaten är mjuk, inte hård.
    // Review-fix (blocker 1): timern har redan FÖRBRUKAT _pendingAutoSaveFlush
    // (nollas i scheduleAutoSave-timeouten FÖRE detta anrop) — utan åter-
    // armering här skulle en stängning >300ms efter sista tangenttrycket sakna
    // flush-handtag och tappa HELA payloaden (enhet + kommentar/min-mängd)
    // tyst. Säkert: gaten ligger efter autoSaveCommitDecision, så vi vet att
    // closure-dialogen fortfarande är den levande (ingen stale re-arm).
    if (unitRaw === "__new__" && unit && !unitNewConfirmed && isFlush !== true) {
      _pendingAutoSaveFlush = flushAutoSave;
      return;
    }
    if (catRaw === "__new__" && !category) return;
    if (placeRaw === "__new__" && !sheetPlace) return;

    tagCache.set(tag, { ...tagCache.get(tag), comment, unit, minQty, type: typeVal, category, sheetPlace, pendingSync: true });

    // B6 (v152): spegla enhetsbytet direkt i mängdfältets suffix — sattes
    // tidigare bara en gång vid dialogbygget, så suffixet visade gammal enhet
    // tills dialogen öppnades om. Ofarligt vid teardown-flush (resetDialog
    // nollar textContent) och för singel (dlgInputWrap är dold).
    dlgInputSuffix.textContent = unit;

    const patch = { unit };
    if (date) patch.lastStr = date;
    setLocalMeta(tag, patch);
    recomputeMaxLast();

    setMsg("Sparat ✓", "ok");

    renderLists();

    const payload = { tag, comment, unit, minQty, type: typeVal, category, place: sheetPlace, userName, sheetName: _sn, rowNum: _rn, ..._dlgIdent };
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
        // Köade ändringar skickas före raderingen, så att de inte står kvar och
        // pekar på en artikel som inte längre finns. Att en skrivning hamnar på fel
        // rad när deleteRow flyttat raderna hindras numera av identitetskontrollen
        // på servern (artikel-id/namn/tagg, A03–A06), inte av ordningen här.
        if (updateQueue.length > 0 || flushInFlight) {
          setMsg("Synkar pending ändringar…", "");
          await waitForPendingSync();
        }
        const res = await gasCall('deleteItem', { tag, sheetName: _sn, rowNum: _rn, ..._dlgIdent });
        if (!res || res.ok === false) {
          setMsg(res?.msg || "Kunde inte radera", "warn");
          _refreshAfterIdentityError_(res && res.code);
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
    // v160: identiteten följer med förslaget, så att kopplingen gäller artikeln
    // som visades även om listan byggs om innan användaren trycker.
    results.push({ tag: h.tag, name: h.label, sheetName: val?.sheetName, rowNum: val?.rowNum, ident: _identityOfItem_(val) });
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

// P5 → B5 (v153): "Inventera vid koppling" är nu OPTIMISTISK (designregel D4).
// Steget fyrar vid kopplingsögonblicket — INTE efter server-svar (som kunde
// dröja 10-30+ s på GAS-cold-start/mobilnät och aldrig fyrade vid pending-
// retry). finalTag = artikelns AKTUELLA cache-nyckel vid fyr-ögonblicket:
// för vanliga artiklar = currentTag, för syntetiska = S-nyckeln (key-swappen
// skjuts upp medan dialogen är öppen, se _deferredKeySwaps).
// Både logSingle (pendingSync/retry-kön) och behållar-dialogens saves går via
// den verifierade kövägen med koordinater → inget tappas vid senare serverfel.
// Returnerar true om steget faktiskt utfördes (för retro-varningsspårningen).
function _maybeInventOnLink(finalTag, name, clickTs) {
  if (!shouldFireInventOnLink(inventOnLink, dialogOpen(), clickTs, Date.now())) return false;
  const cached = tagCache.get(finalTag);
  if (!cached) return false;
  if (cached.type === 'singel') {
    // B5-residual (v153): koordinater via buildLogSingleTarget — utan
    // sheetName/rowNum kan backend inte lösa upp syntetiska nycklar (samma
    // mönster som skan-grenen, verifierat mot Code.js resolveItem/logTag).
    Save.logSingle(finalTag, { ...buildLogSingleTarget(cached.name || name, cached), ..._identityOfItem_(cached) });
    return true;
  }
  if (cached.type === 'behållare') {
    const meta = metaCache.get(finalTag) || {};
    const localItem = {
      name: cached.name || name,
      type: cached.type,
      place: cached.place,
      sheetName: cached.sheetName,
      rowNum: cached.rowNum,
      qty: meta.qty || 0,
      unit: meta.unit || '',
      user: meta.user || '',
      last: meta.lastMs,
      comment: cached.comment || '',
      minQty: cached.minQty || 0,
      step: cached.step || '',
      sheetPlace: cached.sheetPlace,
      category: cached.category
    };
    // Sätt currentDialogTag (som openContainerForTag gör) — krävs för att
    // Save.linkTag ska kunna skjuta upp key-swappen medan dialogen är öppen,
    // och ger swipe/autosave-orphan-skydd samma sanning som övriga ingångar.
    currentDialogTag = finalTag;
    prepareContainerDialog(localItem, finalTag);
    return true;
  }
  return false;
}

// B5: fyr-hjälpare för callsites. Anropas SYNKRONT vid kopplings-klicket
// (samma ögonblick som "kopplas"-historikraden skapas via Save.linkTag).
// Kort defer (150 ms) så källdialogens closeDialog-RAF hinner gömma dialogen
// innan dialogOpen()-guarden utvärderas — annars skulle guarden alltid slå.
// Guards (dialogOpen + staleness ~5 s från klicket) utvärderas VID FYR.
function _fireInventOnLink(finalTag, name, scannedTag) {
  if (!inventOnLink) return;
  const clickTs = Date.now();
  const st = { fired: false, cancelled: false, ts: clickTs };
  if (scannedTag) { _pruneInventOnLinkState_(); _inventOnLinkState.set(scannedTag, st); }
  setTimeout(() => {
    if (st.cancelled) return;   // linkTag hann avvisas → fyr inte
    st.fired = _maybeInventOnLink(finalTag, name, clickTs) === true;
  }, 150);
}

function showLinkTagDialog(scannedTag) {
  resetDialog();
  dlgTitle.textContent = "Okänd tag";
  // Sätt hjälptext för DENNA dialog — annars läcker texten från tidigare dialog
  // (t.ex. prepareNewItemDialog som sätter "Fyll i benämning, typ...").
  const ha = document.getElementById('help-article');
  if (ha) {
    ha.classList.remove('open');
    ha.innerHTML = 'Den här streckkoden känner appen inte igen.<br><b>Använd förslag</b> = skapa ny artikel med namn från OpenFoodFacts.<br><b>Skapa ny artikel</b> = fyll i alla fält manuellt.<br><b>Koppla till befintlig</b> = sök upp en artikel du redan har och koppla denna kod till den.<br>Om appen visar "Du har redan liknande" — tryck en av dem för snabb koppling.<br>Är <b>Inventera vid koppling</b> påslaget i inställningarna öppnas inventeringssteget direkt när du kopplat.';
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
          similarHtml += `<button type="button" class="btn cancel offMatchBtn" data-tag="${esc(m.tag)}" data-sheet="${esc(m.sheetName||'')}" data-row="${esc(m.rowNum||'')}" data-name="${esc(m.name)}" data-id="${esc((m.ident && m.ident.id) || '')}" data-ename="${esc((m.ident && m.ident.expectedName) || '')}" data-wtag="${esc((m.ident && m.ident.wireTag) || '')}" style="display:block;margin-top:4px;font-size:0.9em;width:100%">Koppla till "${esc(m.name)}"</button>`;
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
        // B5 (v153): OFF-vägen saknade inventeringssteget helt — nu samma
        // optimistiska beteende som övriga kopplingsvägar (fyr vid koppling).
        _fireInventOnLink(matchTag, matchName, scannedTag);
        const result = await Save.linkTag(scannedTag, {
          name: matchName,
          sheetName,
          rowNum,
          currentTag: matchTag,
          ...(btn.dataset.id ? { id: btn.dataset.id } : {}),
          ...(btn.dataset.ename ? { expectedName: btn.dataset.ename } : {}),
          ...(btn.dataset.wtag ? { wireTag: btn.dataset.wtag } : {})
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
      const hasTag = !tag.startsWith("S") || !!val?.dupTag;
      btn.innerHTML = `<span class="sr-name">${esc(name)}</span><span class="sr-date">${hasTag ? "har tag" : "ingen tag"}</span>`;
      btn.onclick = async () => {
        closeSearchDialog();
        const isSynthetic = tag.startsWith("S");
        const target = {
          name,
          sheetName: val.sheetName || val.place,
          rowNum: val.rowNum,
          currentTag: tag,
          ..._identityOfItem_(val)   // v160: artikeln som visades i sökträffen
        };
        if (!isSynthetic) {
          // Mönster A: optimistisk UI-respons (gul/pending-rad) innan svar.
          // Bug 2.7: banner får INTE påstå "kopplad" före await — neutral
          // progress; definitivt utfall (inkl pending) efter await.
          show("Kopplar tag…");
          renderLists();
          cooldown(tagToLink);
          // B5 (v153): inventeringssteget fyrar optimistiskt VID kopplingen
          // (designregel D4) — inte efter server-svar. finalTag = tag
          // (artikelns primärnyckel, oförändrad för icke-syntetiska).
          _fireInventOnLink(tag, name, tagToLink);
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
        // Mönster B: syntetisk artikel — key-swap sker vid server-svar, men
        // B5 (v153): inventeringssteget fyrar optimistiskt på S-nyckeln redan
        // vid kopplingen. Är dialogen öppen när servern bekräftar skjuts
        // swappen upp (_deferredKeySwaps); köade jobb re-keyas då efteråt.
        show("Kopplar tag…");
        _fireInventOnLink(tag, name, tagToLink);
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
/* ===== F3 (v155): Enhetsgovernance — familjetabell, konvertering, rimlighet =====
 * Kanonisk familjetabell byggd från de enheter som FAKTISKT förekommer i Sheetet
 * (inventerat 2026-07-05 över alla kompatibla flikar): st, rullar, förp, paket,
 * påsar, säckar, askar, buntar, tuber, flaskor, flaska, burkar, set, Godislåda,
 * gram, g, hg, kg, ml, dl, liter. Uppslag är skiftlägesokänsligt. En enhet som
 * inte finns i tabellen får familjen 'okänd' och beter sig som idag (ingen
 * omräkning, ingen gruppering utöver "Övriga enheter").
 * Faktorer = basenhet per familj (massa: gram, volym: ml) så omräkning inom
 * familjen blir from/to-kvot. Testfiler: units.test.js + implausible.test.js
 * (funktionerna nedan är kopierade ordagrant dit — håll i synk). */
const UNIT_FACTORS = {
  massa: { 'g': 1, 'gram': 1, 'hg': 100, 'kg': 1000 },
  volym: { 'ml': 1, 'cl': 10, 'dl': 100, 'l': 1000, 'liter': 1000 }
};
const UNIT_STYCK = ['st','förp','paket','påsar','rullar','askar','buntar','säckar','tuber','flaskor','flaska','burkar','kartonger','set','godislåda'];

function _unitKey(u){ return String(u == null ? '' : u).trim().toLowerCase(); }

function unitFamily(u){
  const k = _unitKey(u);
  if (!k) return 'okänd';
  if (Object.prototype.hasOwnProperty.call(UNIT_FACTORS.massa, k)) return 'massa';
  if (Object.prototype.hasOwnProperty.call(UNIT_FACTORS.volym, k)) return 'volym';
  if (UNIT_STYCK.indexOf(k) !== -1) return 'styck';
  return 'okänd';
}

// Behållarenheter (lager 2 light): styck-enheter som döljer den verkliga
// mängden — allt i styck-familjen utom 'st' (som ÄR själva antalet).
function isContainerUnit(u){
  const k = _unitKey(u);
  return k !== 'st' && UNIT_STYCK.indexOf(k) !== -1;
}

// Omräkning inom SAMMA mätfamilj (massa/volym). null = ej omräkningsbart
// (styck/okänd, olika familjer, samma enhet, eller icke-numeriskt värde).
function convertQty(value, fromUnit, toUnit){
  // Tom/null spärras explicit — Number('') är 0, inte NaN, och 0 vore fel svar.
  const raw = String(value == null ? '' : value).replace(',', '.').trim();
  if (raw === '') return null;
  const v = Number(raw);
  if (!isFinite(v)) return null;
  const fk = _unitKey(fromUnit), tk = _unitKey(toUnit);
  if (fk === tk) return null;
  const fam = unitFamily(fromUnit);
  if (fam !== 'massa' && fam !== 'volym') return null;
  if (unitFamily(toUnit) !== fam) return null;
  // Avrunda bort flyttalsdrift (0.007 kg → 7 g exakt, inte 6.999…).
  return Math.round(v * (UNIT_FACTORS[fam][fk] / UNIT_FACTORS[fam][tk]) * 1e6) / 1e6;
}

// Svensk sifferformatering för dialogtexter: decimalkomma + hårt mellanslag
// som tusentalsavgränsare ("7 200", "7,2"). Icke-numeriskt → strängen som är.
function formatQtySv(n){
  const v = Number(String(n == null ? '' : n).replace(',', '.'));
  if (!isFinite(v)) return String(n == null ? '' : n);
  const s = String(Math.round(v * 1e6) / 1e6);
  const neg = s.charAt(0) === '-';
  const parts = (neg ? s.slice(1) : s).split('.');
  const int = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '-' : '') + int + (parts[1] ? ',' + parts[1] : '');
}

/* Lager 4: rimlighetsspärr. true = nytt saldo avviker mer än 100× från förra
 * (åt något håll) och BÅDA är > 0. 0→stort, tomt→värde och icke-numeriskt är
 * legitima (första inventering/nollning) → false. Exakt 100× är tillåtet
 * (strikt >). Asymmetrin är medveten: falskt positiv kostar ett knapptryck,
 * falskt negativ kostar korrupt data ("7 200 kg pasta"). */
function isImplausibleQtyChange(prev, next){
  const p = Number(String(prev == null ? '' : prev).replace(',', '.'));
  const n = Number(String(next == null ? '' : next).replace(',', '.'));
  if (!isFinite(p) || !isFinite(n)) return false;
  if (p <= 0 || n <= 0) return false;
  const ratio = n / p;
  return ratio > 100 || ratio < 0.01;
}

// Grupperade <option>-rader för enhetsväljarna: en <optgroup> per familj i
// fast ordning. Bara familjer som faktiskt har enheter i listan renderas.
// "(ingen)"/"Välj enhet…" och "+ Ny enhet…" läggs av anroparen utanför.
function buildUnitOptionsHTML(unitList, currentUnit){
  const groups = { massa: [], volym: [], styck: [], 'okänd': [] };
  for (const u of unitList) groups[unitFamily(u)].push(u);
  const byFactor = fam => (a, b) => UNIT_FACTORS[fam][_unitKey(a)] - UNIT_FACTORS[fam][_unitKey(b)];
  const bySv = (a, b) => a.localeCompare(b, 'sv');
  groups.massa.sort(byFactor('massa'));
  groups.volym.sort(byFactor('volym'));
  groups.styck.sort(bySv);
  groups['okänd'].sort(bySv);
  const LABELS = { massa: 'Vikt', volym: 'Volym', styck: 'Styck och förpackningar', 'okänd': 'Övriga enheter' };
  const opt = u => `<option value="${esc(u)}"${u === currentUnit ? ' selected' : ''}>${esc(u)}</option>`;
  return ['massa', 'volym', 'styck', 'okänd']
    .filter(f => groups[f].length)
    .map(f => `<optgroup label="${LABELS[f]}">${groups[f].map(opt).join('')}</optgroup>`)
    .join('');
}
/* ===== slut F3-modul ===== */

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
  // F3 (v155): grupperat per familj (Vikt/Volym/Styck/Övriga), samma
  // buildUnitOptionsHTML som Egenskaper-dialogen.
  sel.innerHTML =
    '<option value="">Välj enhet…</option>' +
    buildUnitOptionsHTML(units, '') +
    '<option value="__new__">+ Ny enhet…</option>';
  if (newInput) { newInput.style.display = 'none'; newInput.value = ''; }
  const note = qs('#manualUnitNote');
  if (note) { note.style.display = 'none'; note.textContent = ''; }
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
  const ha=document.getElementById('help-article'); if(ha){ha.classList.remove('open'); ha.innerHTML='Fyll i benämning, typ, enhet, flik, plats och kategori. <b>Benämning, enhet och flik är obligatoriska</b> — utan flik vet arket inte var raden ska hamna.<br><b>Flik</b> = vilket Sheet-blad raden skapas i. <b>Plats</b> = fysisk placering (kolumn B).<br><b>Singel</b> = en enhet per etikett (t.ex. en sax).<br><b>Behållare</b> = variabel mängd (t.ex. papper, krydda, batterier).<br>Enhetslistan är grupperad i vikt, volym och styck. Välj helst en befintlig enhet — en ny enhet gör saldot svårare att tolka senare.<br>Saknas enhet, flik, plats eller kategori i listan — välj <b>+ Ny …</b> och skriv in.<br>Tryck "Skanna tag" för att koppla en QR-kod till artikeln.';}

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
  // F3 (v155): mjuk gate för ny enhet vid Spara (armas om vid varje enhetsbyte)
  // + behållarenhets-avrådan i #manualUnitNote (lager 2 light).
  let newUnitArmed = false;
  const unitSel = qs('#manualUnit');
  const unitNewInput = qs('#manualUnitNew');
  const unitNote = qs('#manualUnitNote');
  const setUnitNote = (txt, warn) => {
    if (!unitNote) return;
    unitNote.textContent = txt || '';
    unitNote.classList.toggle('warn', !!warn);
    unitNote.style.display = txt ? 'block' : 'none';
  };
  if (unitSel && unitNewInput) {
    unitSel.onchange = () => {
      newUnitArmed = false;
      const isNew = unitSel.value === '__new__';
      unitNewInput.style.display = isNew ? 'block' : 'none';
      if (isNew) { unitNewInput.value = ''; unitNewInput.focus(); }
      if (!isNew && isContainerUnit(unitSel.value)) {
        setUnitNote(`En enhet som "${unitSel.value}" säger inte hur mycket varje förpackning rymmer. Förtydliga gärna mängden per styck i artikelns kommentar.`, false);
      } else {
        setUnitNote('', false);
      }
    };
    unitNewInput.oninput = () => { newUnitArmed = false; };
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
    const type=manualType.value;
    const qty=parseFloat((manualQty.value||"1").replace(",","."))||1;
    const unitRaw=(qs('#manualUnit')?.value||"").trim();
    const unit = unitRaw === '__new__'
      ? (qs('#manualUnitNew')?.value||'').trim()
      : unitRaw;
    // P2a: flikvalet är lika obligatoriskt som enheten. Tidigare föll ett tomt
    // val tillbaka på strängen "Okänd", som servern avvisar med "Flik finns
    // inte: Okänd" — permanent, utan omförsök. Så förlorades "Bostongurka"
    // 2026-07-30. Alla hårda krav prövas FÖRE F3:s mjuka ny-enhet-gate.
    const place=(qs('#manualPlace')?.value||"").trim();
    const v = validateNewItem({ name, unit, sheetName: place });
    if(!v.ok){
      show(v.msg,"warn");
      if(v.field==='sheetName') qs('#manualPlace')?.focus();
      return;
    }
    // F3 (v155): mjuk gate för ny enhet — första Spara-trycket visar en
    // varningstext i dialogen, andra trycket sparar. Armering nollas om
    // enheten byts eller texten redigeras.
    if(unitRaw==='__new__'&&!newUnitArmed){
      newUnitArmed=true;
      setUnitNote(`Ny enhet ("${unit}") gör det svårare att tolka saldot senare. Finns ingen passande i listan? Tryck Spara igen för att använda den ändå.`, true);
      return;
    }
    const spRaw=(qs('#manualSheetPlace')?.value||"").trim();
    const sheetPlace = spRaw === '__new__'
      ? (qs('#manualSheetPlaceNew')?.value||'').trim()
      : spRaw;
    const catRaw=(qs('#manualCategory')?.value||"").trim();
    const category = catRaw === '__new__'
      ? (qs('#manualCategoryNew')?.value||'').trim()
      : catRaw;
    const minQty=parseFloat((qs('#manualMinQty')?.value||'0').replace(',','.'))||0;
    // P2b/P2d: hela create-jobbet byggs som ETT objekt med en idempotensnyckel
    // och lämnas till Save.createItem, som registrerar det i _pendingCreates
    // (persisterat) innan den skickar. Bygget här gör bara DOM-avläsningen.
    // job.tag = currentTag: "M<ms>" för en manuellt skapad artikel (skickas
    // TAGGLÖS till servern, se isTaglessCreate) eller den skannade taggen —
    // "Skanna tag"-knappen kan ha ersatt currentTag, därför läses den här och
    // inte från dialogens ursprungliga argument.
    // Spärr mot dubbeltryck. closeDialog döljer dialogen först i en rAF, så två
    // tryck inom ~16 ms hann tidigare bygga VAR SIN ck och därmed skapa två rader.
    // Serverns idempotens hjälper inte: skilda nycklar är per definition skilda
    // skapanden. Detta är en dubblettväg i den release som stänger dubbletter.
    if (_createSaveBusy) return;
    _createSaveBusy = true;
    setTimeout(function () { _createSaveBusy = false; }, 1500);
    const ck = newCreateKey();
    Save.createItem({
      ck,
      tag: currentTag, name, type, qty, unit, category,
      sheetPlace, sheetName: place, minQty, user: userName, retries: 0
    });
    // P2c: ingen "Skapad: …" här. Den sattes tidigare SYNKRONT, före svaret —
    // grön bekräftelse på en artikel som kunde vara på väg ingenstans. Nu säger
    // createItem "Sparar…" och byter till "Skapad: …" först i den verifierade
    // grenen (eller till en ärlig varning i de andra två).
    closeDialog();cooldown(currentTag);
    // closeDialog nollställer statusraden i en egen requestAnimationFrame, som
    // annars skulle radera "Sparar…" direkt. Skriv därför om texten i en rAF
    // som registreras EFTER den — men bara om artikeln fortfarande väntar på
    // svar, så ett redan anlänt utfall inte skrivs över med "Sparar…".
    requestAnimationFrame(()=>{ if(_pendingCreates.has(ck)) show("Sparar…"); });
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
// S5 (v152): Secure — sajten serveras alltid över HTTPS (GitHub Pages), så
// cookien ska aldrig kunna skickas över okrypterad HTTP.
function setCookie(k,v,days){document.cookie=k+'='+encodeURIComponent(v)+'; max-age='+(days*86400)+'; path=/; SameSite=Lax; Secure';}
function ensureName(cb){
  const saved=getCookie("vitaliseraUser")||localStorage.getItem("vitaliseraUser");
  const exp=Number(getCookie("vitaliseraExpiry")||localStorage.getItem("vitaliseraExpiry")||0);
  if(saved&&Date.now()<exp){userName=saved;if(typeof cb==="function")cb();return true;}
  nameDialog.classList.remove("hidden"); userNameInput.value=saved||""; saveNameBtn.onclick=()=>{const n=(userNameInput.value||"").trim();if(!n)return;userName=n;
    localStorage.setItem("vitaliseraUser",n);localStorage.setItem("vitaliseraExpiry",Date.now()+NAME_TTL_DAYS*86400000);
    setCookie("vitaliseraUser",n,NAME_TTL_DAYS);setCookie("vitaliseraExpiry",String(Date.now()+NAME_TTL_DAYS*86400000),NAME_TTL_DAYS);
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
// A11: en skannad kod sitter på flera artiklar (dubblett i arket). Samma
// #searchDialog och samma sökträffar som vanlig sökning; tryck = öppna artikeln.
function openDuplicateChoice(keys) {
  const items = keys.map(k => [k, tagCache.get(k)]).filter(([, v]) => v);
  if (!items.length) return;
  openSearchDialog();
  try { searchInput.blur(); } catch (_) {}
  const h2 = searchDialog.querySelector('h2');
  const origTitle = h2.textContent;
  const labels = items.map(([, v]) => `${v.name} (${v.sheetName})`);
  const list = labels.length === 2 ? labels.join(' och ') : labels.join(', ');
  h2.textContent = `Koden sitter på ${labels.length} artiklar: ${list}. Välj vilken.`;
  _linkModeCleanup = () => { h2.textContent = origTitle; };
  searchResults.innerHTML = '';
  items.forEach(([k], i) => _appendSearchHit_({ tag: k, label: labels[i] }));
}

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
// onScanResult lyft från startCamera-scope till moduleScope så __qaScan kan
// kalla EXAKT samma pipeline utan kamera-permission (alla referenser — v,
// scanBox, lastCode, busy, dialogOpen, preloadDone, lookupByTag, Save,
// tagCache, metaCache, normTag, acceptScan, cooldown, prepareContainerDialog
// etc — är redan moduleScope, inga closure-beroenden av startCamera).
// B3 (v151), ren och testbar: bygg logSingle-target för skan-grenarna.
// Koordinaterna MÅSTE med när de finns — utan sheetName/rowNum kan backend
// resolveItem inte slå upp syntetiska nycklar ("S<flik>R<rad>"): normalizeTag
// strippar bokstäverna till en pseudo-tag av bara siffror, och logTag skapar
// då en DUBBLETTRAD i default-fliken med falsk ok:true (eller skriver fel rad
// vid sifferkollision) — inventeringen når aldrig rätt rad. Verifierat mot
// Code.js resolveItem/logTag/findTagAcrossSheets 2026-07-04. Hanterar både
// cache-formen (rowNum) och lookup-svarets form (row, från makeItemFromCols).
function buildLogSingleTarget(name, item) {
  const it = item || {};
  const rn = it.rowNum != null ? it.rowNum : (it.row != null ? it.row : null);
  return { name, sheetName: it.sheetName != null ? it.sheetName : null, rowNum: rn };
}

// F1 (v154), ren och testbar (testfil: missing.test.js): bygg updateCount-
// payloaden för "Saknas" i singel-dialogen. newCount är ALLTID 0 — servern
// (Code.js updateCount → updateRowWithCols) skriver 0:an (qty-guarden är
// `!== undefined && !== null`), stämplar TIMESTAMP = new Date() och USER i
// samma anrop. Samma koordinat-fallback som buildLogSingleTarget ovan:
// cache-formen (rowNum) och lookup-svarets form (row) — koordinaterna krävs
// för syntetiska nycklar ("S<flik>R<rad>") som backend inte kan tag-söka.
function buildMissingPayload(tag, item, user) {
  const it = item || {};
  const rn = it.rowNum != null ? it.rowNum : (it.row != null ? it.row : null);
  return {
    tag,
    newCount: 0,
    userName: user,
    sheetName: it.sheetName != null ? it.sheetName : null,
    rowNum: rn
  };
}

async function onScanResult(res) {
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

    // A11/A14: koden passar flera artiklar (samma kod, eller samma siffror med
    // olika ledande nollor och ingen exakt träff) → välj ingen tyst, låt användaren välja.
    const found=resolveScan(scanned);
    if(found&&found.ambiguous){
      await flashFeedback("Koden sitter på flera artiklar");
      cooldown(scanned); busy=false;
      if (dialogOpen()) return;
      openDuplicateChoice(found.ambiguous);
      return;
    }
    const hit=found;
    // P4: 1D-streckkoder kan rapporteras med olika .text mellan frames för
    // SAMMA fysiska kod (UPC-A 12-digit ↔ EAN-13 med leading-0-pad, andra
    // format-tvetydigheter). lookupByTag normaliserar via leading-0-fallback
    // (rad 726-735), så två olika `scanned`-strängar mappar samma primaryTag.
    // Snabb-gaten `scanned===lastCode` (rad 4550) är strikt match och missar
    // detta → samma artikel registrerades 2-3× per skan av en 1D-kod (QR-
    // koder har Reed-Solomon → identisk .text per frame → snabb-gaten räcker).
    // Dedupe på primaryTag fångar varianterna utan att hindra äkta nya skan.
    if (hit && hit.tag === lastCode) { busy=false; return; }
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
        // B3 (v151): skicka med koordinaterna från cachen — annars kan backend
        // inte lösa upp syntetiska nycklar (se buildLogSingleTarget ovan).
        Save.logSingle(primaryTag, { ...buildLogSingleTarget(name, cached), ..._identityOfItem_(cached) });
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
    // B2 (v152): okänd tagg → alltid koppla/skapa-dialogen. Den gamla online-
    // lookup-fallbacken som låg efter denna rad var DÖD kod: toppguarden
    // `if(!preloadDone) return` (början av onScanResult) garanterar att
    // preloadDone är true här, så `if(preloadDone){...return}` tog alltid
    // denna väg och gasCall('lookup')-grenen kunde aldrig nås. Borttagen.
    busy=false;showLinkTagDialog(scanned);
}
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
  reader.decodeFromVideoDevice(cam.deviceId, v, onScanResult);
  // Parallell crop-decode för bättre detection på små streckkoder
  startCropDecode(onScanResult);
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

/* ===== Handbok + onboarding =====
 * Följer appens dialogmönster: .dialog + hidden-klass, stäng via knapp/Escape.
 * qrIntro visas automatiskt första gången (localStorage-flaggan qrIntroSeen,
 * i stil med installOverlaySeen). qrManual är den fullständiga, utskrivbara
 * handboken, nåbar från Inställningar och från onboardingen. */
(function docs(){
  const QR_INTRO_KEY = 'qrIntroSeen';
  const intro = qs('#qrIntro'), manual = qs('#qrManual');
  if (!intro || !manual) return;

  function introHidden(){ try { return localStorage.getItem(QR_INTRO_KEY) === '1'; } catch (_) { return false; } }

  function openQrManual(){
    manual.classList.remove('hidden');
    manual.scrollTop = 0;
  }
  function closeQrManual(){ manual.classList.add('hidden'); }

  function openQrIntro(){
    const hide = qs('#qrIntroHide'); if (hide) hide.checked = introHidden();
    intro.classList.remove('hidden');
    intro.scrollTop = 0;
  }
  function closeQrIntro(){
    intro.classList.add('hidden');
    const hide = qs('#qrIntroHide');
    try { localStorage.setItem(QR_INTRO_KEY, hide && hide.checked ? '1' : '0'); } catch (_) {}
  }

  // Entry points
  qs('#openManualBtn')?.addEventListener('click', () => {
    try { closeSettingsDialog(); } catch (_) {}
    openQrManual();
  });
  qs('#qrManualClose')?.addEventListener('click', closeQrManual);
  qs('#qrIntroStart')?.addEventListener('click', closeQrIntro);
  qs('#qrIntroManual')?.addEventListener('click', () => { closeQrIntro(); openQrManual(); });

  // Escape stänger handbok/onboarding (överst → först)
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!manual.classList.contains('hidden')) { closeQrManual(); e.preventDefault(); return; }
    if (!intro.classList.contains('hidden')) { closeQrIntro(); e.preventDefault(); return; }
  });

  // Utskrift av handboken. I standalone-PWA fungerar inte window.print() direkt,
  // så vi öppnar en vanlig flik med ?print=manual som skriver ut sig själv.
  qs('#qrManualPrint')?.addEventListener('click', () => {
    const standalone = navigator.standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches;
    if (standalone) { window.open(location.pathname + '?print=manual', '_blank'); return; }
    printManual();
  });
  function printManual(){
    document.documentElement.classList.add('print-manual');
    const cleanup = () => document.documentElement.classList.remove('print-manual');
    window.addEventListener('afterprint', cleanup, { once: true });
    setTimeout(() => { try { window.print(); } catch (_) {} setTimeout(cleanup, 1000); }, 60);
  }

  // Första gången: visa onboardingen. Krockar inte med install-overlayn.
  // Vi räknar ut samma villkor som den inline-skriptet (standalone + seen)
  // deterministiskt, i stället för att läsa DOM-klassen vid osäker timing.
  // Ska install-overlayn visas väntar vi tills den stängts, annars direkt.
  function maybeShowQrIntro(){
    if (_isPrintTab || introHidden()) return;
    if (new URLSearchParams(location.search).get('print') === 'manual') return;
    const isStandalone = navigator.standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches;
    let installSeen = false;
    try { installSeen = !!localStorage.getItem('installOverlaySeen'); } catch (_) {}
    const io = qs('#installOverlay');
    // Samma villkor som install-overlayns inline-skript: visas den, väntar vi.
    const installWillShow = !isStandalone && !installSeen && io;
    if (installWillShow) {
      // Observern reagerar bara på ändringar: overlayn visas (hidden tas bort,
      // ingen träff) och stängs sedan (hidden läggs till → visa intro). Robust
      // mot skript-ordning eftersom vi inte litar på DOM-state just nu.
      const obs = new MutationObserver(() => {
        if (io.classList.contains('hidden')) { obs.disconnect(); setTimeout(openQrIntro, 300); }
      });
      obs.observe(io, { attributes: true, attributeFilter: ['class'] });
    } else {
      openQrIntro();
    }
  }

  // ?print=manual: minimal flik som bara skriver ut handboken.
  if (new URLSearchParams(location.search).get('print') === 'manual') {
    openQrManual();
    setTimeout(printManual, 450);
  } else {
    // Vänta på DOMContentLoaded: #installOverlay + dess inline-skript ligger
    // EFTER app.js i index.html, så de finns inte när app.js körs. En setTimeout(0)
    // hann före dem (parsern gav upp tråden), därför band vi till DOMContentLoaded.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', maybeShowQrIntro, { once: true });
    } else {
      maybeShowQrIntro();
    }
  }
})();
