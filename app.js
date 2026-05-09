/*
 * QR-INVENTERING – PWA KLIENTDEL
 * Extraherad från GAS app.html, google.script.run → fetch/gasCall
 */

/* ===== Service Worker + update-banner ===== */
// APP_VERSION bumpas synkat med sw.js CACHE och index.html app.js?v=
// Används för att räkna ut vilka changelog-entries som är "nya" för användaren.
const APP_VERSION = 96;

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
    let _swReloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (_swReloading) return;
      _swReloading = true;
      location.reload();
    });

    // Kolla efter ny version regelbundet OCH när PWA:n blir synlig.
    // Två parallella mekanismer: (1) SW-baserad reg.update() — men den lider
    // av iOS Safari HTTP-cache som ibland fastnar i flera dagar, (2) en
    // ren fetch av changelog.json som kringgår SW-cachen helt och visar
    // banner direkt om latest > APP_VERSION. Backup till SW-flödet.
    const checkForUpdate = () => {
      navigator.serviceWorker.getRegistration().then(reg => {
        reg?.update().catch(() => {});
      }).catch(() => {});
      pollVersionViaChangelog();
    };
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
  // Mjuk uppdatering om SW-flödet kunde detektera ny SW (reg.waiting finns).
  // Annars (bannern triggades via changelog-poll) — hård reset: avregistrera
  // SW, rensa caches, reload. Det kringgår iOS HTTP-cache-fastlåsning.
  btn.addEventListener('click', () => {
    if (reg?.waiting) reg.waiting.postMessage('SKIP_WAITING');
    else forceUpdate();
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

async function gasCall(fn, params = {}) {
  // 30s timeout: GAS cold-start kan ta ~10s, mobilnät-tap kan tappa förbindelsen
  // helt utan native error. Utan timeout hänger UI:n i evighet.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
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
    if (err.name === 'AbortError') throw new Error('Timeout — servern svarade inte inom 30s');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Kastar om svaret har ok:false. Används för alla muterande anrop så att .then() inte
// råkar markera operationen som lyckad när servern faktiskt returnerade ett fel.
function assertOk(r) {
  if (r && r.ok === false) throw new Error(r.msg || r.error || 'Okänt serverfel');
  return r;
}

/* ===== AI-assistenter =====
 * Backend tolererar att secret saknas (om AI_SHARED_SECRET inte satt i Script Properties).
 * localStorage-nyckel 'vitaliseraAiSecret' kan sättas manuellt av admin om skydd behövs.
 */
const _aiSuggestCache = new Map(); // 'name|place' → {category,unit,type}
const _aiSearchCache = new Map();  // query.lowercase → [{name,reason}]
function _aiGetSecret() { try { return localStorage.getItem('vitaliseraAiSecret') || ''; } catch (_) { return ''; } }

async function aiSuggest(name, place) {
  const n = (name || '').trim();
  const p = (place || '').trim();
  if (n.length < 3) return null;
  const key = n.toLowerCase() + '|' + p.toLowerCase();
  if (_aiSuggestCache.has(key)) return _aiSuggestCache.get(key);
  try {
    const res = await gasCall('aiSuggest', { name: n, place: p, secret: _aiGetSecret() });
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
function lookupByTag(scanned) {
  if (tagCache.has(scanned)) return { tag: scanned, item: tagCache.get(scanned) };
  for (const [primary, item] of tagCache.entries()) {
    if (item.altTags && item.altTags.includes(scanned)) return { tag: primary, item };
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
dlgInput=qs('#dialogInput'), dlgBtns=qs('#dialogBtns'),
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
  try{ reader && reader.reset(); }catch{}
  try{
    const so = v.srcObject;
    if (so){ so.getTracks?.forEach(t=>t.stop()); v.srcObject = null; }
  }catch{}
  try{ v.pause(); }catch{}
  cameraOn = false;
  cameraVisible = false;
  qs('#cameraBox')?.classList.add('hidden');
  startBtn.textContent = "Skanna QR";
  statusDefault();
}

async function showCamera(){
  qs('#cameraBox')?.classList.remove('hidden');
  cameraVisible = true;
  startBtn.textContent = "Dölj skanner";
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
const cooldown=t=>{lastCode=t;setTimeout(()=>lastCode="",COOLDOWN_MS);};
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
function addUndoButton(logEntry, tag) {
  const cached = tagCache.get(tag);
  const meta = metaCache.get(tag) || {};
  const prev = { lastMs: meta.lastMs, user: meta.user, sheetName: cached?.sheetName, rowNum: cached?.rowNum };
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
    gasCall('updateMeta', {tag, args: payload});
    const icon = logEntry.querySelector(".icon");
    if (icon) icon.textContent = "↩️";
    const msg = logEntry.querySelector(".msg");
    if (msg) msg.textContent = msg.textContent.replace("uppdaterad", "ångrad");
    undoBtn.remove();
    undoData.delete(tag);
    show("Ångrad", "warn");
  };
  logEntry.appendChild(undoBtn);
  setTimeout(() => {
    undoBtn.remove();
    undoData.delete(tag);
  }, UNDO_WINDOW_MS);
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
function flushUpdates() {
  if (updateQueue.length === 0) return;

  const batch = updateQueue.map(job => {
    if (job.fnName === "updateMeta") {
      return { fnName: job.fnName, args: { ...job.args, userName } };
    }
    return job;
  });

  updateQueue.length = 0;
  updateTimer = null;

  console.log("Skickar batch:", batch.map(b => b.args.tag));

  flushInFlight = gasCall('batch', {batch})
    .then(res => {
      busy = false;
      overlay.classList.remove("blurred");
      overlay.style.pointerEvents = "";

      // Backend returnerar {ok, results:[{tag, ok, msg}]}. Matcha per index eftersom
      // tag kan förekomma flera gånger i samma batch (två metaMetadata-jobb på samma rad).
      const results = Array.isArray(res?.results) ? res.results : [];
      const failedTags = [];
      for (let i = 0; i < batch.length; i++) {
        const tag = batch[i].args.tag;
        const r = results[i];
        if (!r || r.ok === false) {
          failedTags.push(tag);
        } else {
          const cur = tagCache.get(tag);
          if (cur) tagCache.set(tag, { ...cur, pendingSync: false });
        }
      }

      console.log("Synk klar:", batch.length - failedTags.length, "ok,", failedTags.length, "fail");

      renderLists();

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
        // Vid fail: behåll status-meddelandet (med pendingSync-CSS på listraderna)
        // tills nästa flush rensar det. Annars försvinner felet tyst efter 5s.
        if (failedTags.length === 0) statusDefault();
      }, 5000);

      gasCall('cacheTs').then(ts => {
        if (ts > (window._lastCacheTs || 0)) {
          window._lastCacheTs = ts;
          console.log("Servercache uppdaterad, hämtar ny data...");
          preloadShared().then(initData);
        }
      });
    })
    .catch(err => {
      busy = false;
      overlay.classList.remove("blurred");
      overlay.style.pointerEvents = "";

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
function renderSearchResults(q){
  const qn=(q||"").toLocaleLowerCase('sv').trim();
  searchResults.innerHTML="";
  if(_searchAiTimer){ clearTimeout(_searchAiTimer); _searchAiTimer=null; }
  if(!qn) return;

  // Bygg ordlista (namn + synonymer) av filterpassade items.
  // wordMap: norm(ord) → { tag, label, syn? }
  const wordMap = new Map();
  const passingTags = [];
  for(const [tag, val] of tagCache.entries()){
    const name = val?.name||""; if(!name) continue;
    if(activePlaces && !activePlaces.has(val.place||"Okänd")) continue;
    if(onlyLow){
      const meta = metaCache.get(tag)||{};
      const isLow = (val.minQty||0) && (meta.qty < val.minQty);
      if(!isLow) continue;
    }
    passingTags.push(tag);
    const nameKey = name.toLocaleLowerCase('sv');
    if(!wordMap.has(nameKey)) wordMap.set(nameKey, { tag, label: name });
    if(Array.isArray(val.synonyms)){
      for(const s of val.synonyms){
        const sn = String(s||"").trim(); if(!sn) continue;
        const sk = sn.toLocaleLowerCase('sv');
        if(!wordMap.has(sk)) wordMap.set(sk, { tag, label: name, syn: sn });
      }
    }
  }

  const wordlist = [...wordMap.keys()];
  const suggestions = (typeof Autocomplete !== 'undefined')
    ? Autocomplete.suggest(qn, wordlist, { matchMode: 'substring', maxSuggestions: 200, minPrefixHits: 8, fuzzyThreshold: 2.5 })
    : [];

  const shownTags = new Set();
  for(const sug of suggestions){
    const info = wordMap.get(sug.word); if(!info) continue;
    if(shownTags.has(info.tag)) continue;
    shownTags.add(info.tag);
    const btn = document.createElement('button');
    btn.type = "button"; btn.className = "statusRow";
    const synHint = info.syn ? ` <span class="sr-syn">(${esc(info.syn)})</span>` : '';
    const fuzzyHint = sug.source === 'fuzzy' ? ` <span class="sr-syn">(liknande)</span>` : '';
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
        const info = wordMap.get(String(r.name||"").toLocaleLowerCase('sv'));
        const tag = info?.tag;
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
  _preloadInflight = gasCall('preload').finally(() => { _preloadInflight = null; });
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
let _aiSuggestTimer = null;
function resetDialog(){
  // Bort med stale fokus innan vi bygger nytt innehåll. På iOS PWA kan en
  // kvardröjande focus från föregående dialog/input få nästa textarea
  // (t.ex. commentEdit) att felaktigt få fokus och dra upp tangentbordet.
  try { document.activeElement?.blur?.(); } catch {}
  dlgTitle.textContent="";dlgTitle.contentEditable="false";dlgTitle.oninput=null;dlgTitle.onblur=null;dlgInfo.innerHTML="";dlgBtns.innerHTML="";newItemFields.classList.add("hidden");dlgInput.classList.add("hidden");dlgInput.value="";dlgInput.disabled=false;manualName.value="";manualName.oninput=null;manualQty.value="";if(_aiSuggestTimer){clearTimeout(_aiSuggestTimer);_aiSuggestTimer=null;}dlg.querySelectorAll('.tagScanRow,.extraFields,.aiChip').forEach(el=>el.remove());
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
  const ha=document.getElementById('help-article'); if(ha){ha.classList.remove('open'); ha.innerHTML='<b>Registrera inventering</b> bekräftar dagens inventering med ditt namn och datum.<br><b>Nytt datum</b> ändrar inventeringsdatum; rensa fältet för att avinventera artikeln.<br>"Fler fält" öppnar kommentar, kategori, enhet, typ, min-mängd och tag.';}

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
    <button id="editSingle" class="btn cancel">Fler fält</button>
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
    const le = appendLog(`${item.name} – uppdateras`, tag);
    show("Uppdaterar…");
    gasCall('logTag', {tag, name: item.name, type: "singel", qty: 1, user: userName, sheetName: item.sheetName, rowNum: item.rowNum})
      .then(assertOk)
      .then(() => { markAsDone(le); addUndoButton(le, tag); })
      .catch(err => markLogFail(le, err));
    setLocalMeta(tag, { lastMs: Date.now(), user: userName });
    recomputeMaxLast();
    renderLists();
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
  const ha=document.getElementById('help-article'); if(ha){ha.classList.remove('open'); ha.innerHTML='<b>Öka mängd</b> = lägg till det du skriver i fältet.<br><b>Ny total</b> = ersätt totalen med det du skriver.<br><b>Nytt datum</b> ändrar inventeringsdatum; rensa fältet för att avinventera.<br>Tryck på artikelnamnet för att byta namn.<br>"Fler fält" visar kommentar, kategori, enhet, typ, min-mängd och tag (tag sparas direkt när du skannar).';}

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
      gasCall('updateName', {tag, newName: n, sheetName: dialogItem.sheetName, rowNum: dialogItem.rowNum}).catch(console.log);
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
    <p class="metaText">Lägg till eller ange ny total${unitSuffix ? ` (${esc(unitSuffix)})` : ""}:</p>
  `;

  dlgInput.classList.remove("hidden");
  dlgInput.style.display = "block";
  dlgInput.value = dialogItem.qty;
  dlgInput.placeholder = unitSuffix ? `Mängd (${unitSuffix})` : "Mängd";

  dlgBtns.innerHTML = `
    <button id="cancelUpdate" class="btn cancel">Stäng</button>
    <button id="toggleMore" class="btn icon-btn" aria-label="Egenskaper" title="Egenskaper"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
    <button id="incBtn" class="btn">Öka mängd</button>
    <button id="newBtn" class="btn">Ny total</button>
    <div id="msgLine" class="msgLine"></div>
  `;
  const _commentInitial = (dialogItem.comment || "").trim();
  const commentBlock = document.createElement('div');
  commentBlock.className = 'commentBlock';
  commentBlock.innerHTML = `
    <label for="commentEdit">Kommentar</label>
    <textarea id="commentEdit" rows="2">${esc(_commentInitial)}</textarea>
  `;
  dlg.querySelectorAll('.commentBlock').forEach(e => e.remove());
  dlgBtns.parentNode.insertBefore(commentBlock, dlgBtns.nextSibling);

  const incBtn = qs("#incBtn"), newBtn = qs("#newBtn"), toggleMore = qs("#toggleMore"),
        cancelBtn = qs("#cancelUpdate"), msgLine = qs("#msgLine");

  const containerDateInput = qs("#containerDateEdit");
  if (containerDateInput) {
    containerDateInput.addEventListener('change', () => {
      const newVal = containerDateInput.value;
      if (!newVal) {
        gasCall('updateMeta', {tag, args: {clearTimestamp: true, clearUser: true, userName: ''}});
        setLocalMeta(tag, { lastMs: 0, user: '' });
        recomputeMaxLast(); renderLists();
        setMsg('Datum rensat — artikeln avinventerad', 'ok');
      } else {
        const ms = new Date(newVal + 'T12:00:00').getTime();
        gasCall('updateMeta', {tag, args: {lastYMD: newVal, userName}});
        setLocalMeta(tag, { lastMs: ms, user: userName });
        recomputeMaxLast(); renderLists();
        setMsg('Datum uppdaterat', 'ok');
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
  dlg.appendChild(extra);
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

  // Skanna tag-knapp
  const scanTagBtn = extra.querySelector("#scanTagBtn");
  const tagDisplay = extra.querySelector("#tagDisplay");
  if (tagDisplay) {
    tagDisplay.addEventListener("click", () => {
      const cached = tagCache.get(tag);
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
      startTagScanMode((scannedTag) => {
        setMsg("Sparar tag…", "");
        gasCall('addTag', {sheetName: _sn || (cached?.place), rowNum: _rn || (cached?.rowNum), newTag: scannedTag})
          .then(res => {
            if (res.ok) {
              tagDisplay.value = res.tag;
              tagDisplay.style.opacity = "1";
              const oldData = tagCache.get(tag);
              if (oldData) {
                if (tag.startsWith("S")) {
                  tagCache.delete(tag);
                  tagCache.set(res.tag, { ...oldData, sheetName: null, rowNum: null, altTags: oldData.altTags || [] });
                  const oldMeta = metaCache.get(tag);
                  if (oldMeta) { metaCache.delete(tag); metaCache.set(res.tag, oldMeta); }
                } else {
                  oldData.altTags = [...(oldData.altTags || []), res.tag];
                }
              }
              setMsg("Tag kopplad!", "ok");
              renderLists();
            } else if (res.collision) {
              setMsg(`Taggen är redan kopplad till "${res.existingName}"`, "warn");
            } else {
              setMsg(res.msg || "Kunde inte spara tag", "warn");
            }
          })
          .catch(err => setMsg("Fel: " + (err.message || err), "warn"));
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
    dlg.querySelectorAll("button, input, textarea").forEach(e => e.disabled = true);
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

  incBtn.onclick = () => {
    commitName();
    setMsg("", ""); markError(dlgInput, false);
    const add = parseFloat((dlgInput.value || "").replace(",", "."));
    if (!validNumber(add)) { markError(dlgInput, true); setMsg("Ogiltigt tal i fältet.", "warn"); return; }
    const newCount = (Number(dialogItem.qty) || 0) + add;
    const le = appendLog(`${dialogItem.name} – ny mängd ${newCount}`);

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

  newBtn.onclick = () => {
    commitName();
    setMsg("", ""); markError(dlgInput, false);
    const val = parseFloat((dlgInput.value || "").replace(",", "."));
    if (!validNumber(val)) { markError(dlgInput, true); setMsg("Ogiltigt tal i fältet.", "warn"); return; }
    const newCount = val;
    const le = appendLog(`${dialogItem.name} – total ändrad till ${newCount}`);

    setLocalMeta(tag, { qty: newCount, lastMs: Date.now(), user: userName });
    recomputeMaxLast(); renderLists();
    show(`${dialogItem.name}: total ändrad till ${newCount}.`, "ok");
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
  const autoSaveExtra = () => {
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
  const scheduleAutoSave = () => {
    clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(autoSaveExtra, 300);
  };

  // Selects → change-event. Text/textarea/number → blur-event.
  // Kommentar-fältet ligger utanför .extraFields (i commentBlock), använd qs().
  ['#placeEdit', '#categoryEdit', '#unitEdit', '#typeEdit'].forEach(sel => {
    extra.querySelector(sel)?.addEventListener('change', scheduleAutoSave);
  });
  ['#minQtyEdit', '#placeNew', '#categoryNew', '#unitNew'].forEach(sel => {
    extra.querySelector(sel)?.addEventListener('blur', scheduleAutoSave);
  });
  qs('#commentEdit')?.addEventListener('blur', scheduleAutoSave);

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
      // Frys hela dialogen under radering — annars kan Spara-klick lägga till updateMeta
      // i kön EFTER att raden raderats, och raderar i princip vad som nu ligger på samma row.
      const frozen = dlg.querySelectorAll("button, input, textarea, select");
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
  if (!name || typeof Autocomplete === 'undefined') return [];
  const wordMap = new Map();
  for (const [tag, val] of tagCache.entries()) {
    if (!val?.name) continue;
    const k = val.name.toLocaleLowerCase('sv');
    if (!wordMap.has(k)) {
      wordMap.set(k, { tag, name: val.name, sheetName: val.sheetName, rowNum: val.rowNum });
    }
  }
  if (!wordMap.size) return [];
  const wordlist = [...wordMap.keys()];

  // Per-ord-sökning: "Lasagne Plattor" söker både "lasagne" och "plattor"
  // separat så det matchar "Lasagneplattor" (ihopskrivet) i tagCache.
  // Skippa korta stoppord (<3 tecken) för att slippa brus.
  const norm = name.toLocaleLowerCase('sv').trim();
  const queryWords = norm.split(/\s+/).filter(w => w.length >= 3);
  const queries = queryWords.length ? [norm, ...queryWords] : [norm];

  const seen = new Set();
  const results = [];
  for (const q of queries) {
    const suggestions = Autocomplete.suggest(q, wordlist, {
      matchMode: 'substring',
      maxSuggestions: max,
      minPrefixHits: 0
    });
    for (const s of suggestions) {
      if (seen.has(s.word)) continue;
      seen.add(s.word);
      const info = wordMap.get(s.word);
      if (info) results.push(info);
      if (results.length >= max) break;
    }
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
    closeDialog();
    openLinkSearchDialog(scannedTag);
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
    // Sök befintliga artiklar som kan matcha (kanske redan finns en "Kaffe"-tag)
    const similar = findSimilarItems(suggestion.name);
    let similarHtml = '';
    if (similar.length) {
      similarHtml = `<div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(0,0,0,.1)"><i style="font-size:0.85em;display:block;margin-bottom:4px">Du har redan liknande:</i>`;
      for (const m of similar) {
        similarHtml += `<button type="button" class="btn cancel offMatchBtn" data-tag="${esc(m.tag)}" data-sheet="${esc(m.sheetName||'')}" data-row="${esc(m.rowNum||'')}" data-name="${esc(m.name)}" style="display:block;margin-top:4px;font-size:0.9em;width:100%">Koppla till "${esc(m.name)}"</button>`;
      }
      similarHtml += `</div>`;
    }
    target.innerHTML = `<b>OpenFoodFacts föreslår:</b><br>${esc(label)}<br><button type="button" id="useOffSuggestion" class="btn" style="margin-top:8px">Använd förslag</button>${similarHtml}`;

    // Wire upp matches-knapparna: klick → addTag mot vald artikel
    target.querySelectorAll('.offMatchBtn').forEach(btn => {
      btn.onclick = () => {
        const sheetName = btn.dataset.sheet || null;
        const rowNum = btn.dataset.row ? Number(btn.dataset.row) : null;
        const matchTag = btn.dataset.tag;
        const matchName = btn.dataset.name;
        // Optimistisk uppdatering: lokala mutation + UI-respons direkt
        const oldData = tagCache.get(matchTag);
        if (oldData) oldData.altTags = [...(oldData.altTags || []), scannedTag];
        closeDialog();
        cooldown(scannedTag);
        show(`Tag kopplad till "${matchName}"`, 'ok');
        // Server-anrop i bakgrunden — rulla tillbaka vid fail
        gasCall('addTag', { sheetName, rowNum, newTag: scannedTag }).then(res => {
          if (!res?.ok) {
            if (oldData) oldData.altTags = (oldData.altTags || []).filter(t => t !== scannedTag);
            show(res?.collision ? `Redan kopplad till "${res.existingName}"` : 'Kunde inte koppla — rullade tillbaka', 'warn');
          }
        }).catch(() => {
          if (oldData) oldData.altTags = (oldData.altTags || []).filter(t => t !== scannedTag);
          show('Nätverksfel — kopplingen rullades tillbaka', 'warn');
        });
      };
    });

    // Pre-warm AI-förslag i bakgrunden direkt — när användaren klickar
    // "Använd förslag" är resultatet ofta redan klart, så vi slipper
    // 600ms-debouncen och GAS cold-start-fördröjningen.
    const aiPrewarm = aiSuggest(suggestion.name, '').catch(() => null);

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
  });
}

function openLinkSearchDialog(tagToLink) {
  searchInput.value = "";
  searchResults.innerHTML = "";
  overlay.classList.add("blurred");
  searchDialog.classList.remove("hidden");
  searchInput.focus();

  const h2 = searchDialog.querySelector("h2");
  const origTitle = h2.textContent;
  h2.textContent = "Välj artikel att koppla tag till";

  const origHandler = searchInput.oninput;
  const origFabClick = closesearchFab.onclick;
  // Central cleanup — körs av closeSearchDialog oavsett om man avbryter eller slutför.
  _linkModeCleanup = () => {
    h2.textContent = origTitle;
    searchInput.oninput = origHandler;
    closesearchFab.onclick = origFabClick;
  };
  searchInput.oninput = (e) => {
    const qn = (e.target.value || "").toLocaleLowerCase('sv').trim();
    searchResults.innerHTML = "";
    if (!qn) return;
    let count = 0;
    for (const [tag, val] of tagCache.entries()) {
      if (count >= 50) break;
      const name = val?.name || "";
      if (!name || !name.toLocaleLowerCase('sv').includes(qn)) continue;
      const btn = document.createElement('button');
      btn.type = "button"; btn.className = "statusRow";
      const hasTag = !tag.startsWith("S");
      btn.innerHTML = `<span class="sr-name">${esc(name)}</span><span class="sr-date">${hasTag ? "har tag" : "ingen tag"}</span>`;
      btn.onclick = () => {
        closeSearchDialog();
        const isSynthetic = tag.startsWith("S");
        if (!isSynthetic) {
          // Optimistisk: appenda alt-tag direkt + UI-respons. Rulla tillbaka vid fail.
          const oldData = tagCache.get(tag);
          if (oldData) oldData.altTags = [...(oldData.altTags || []), tagToLink];
          show(`Tag kopplad till "${name}"`, "ok");
          renderLists();
          cooldown(tagToLink);
          gasCall('addTag', {sheetName: val.sheetName || val.place, rowNum: val.rowNum, newTag: tagToLink})
            .then(res => {
              if (!res.ok) {
                if (oldData) oldData.altTags = (oldData.altTags || []).filter(t => t !== tagToLink);
                renderLists();
                show(res.collision ? `Redan kopplad till "${res.existingName}"` : (res.msg || "Kunde inte koppla — rullade tillbaka"), "warn");
              }
            })
            .catch(err => {
              if (oldData) oldData.altTags = (oldData.altTags || []).filter(t => t !== tagToLink);
              renderLists();
              show("Nätverksfel — rullade tillbaka: " + (err.message || err), "warn");
            });
          return;
        }
        // Syntetisk artikel: kräver server-svar för att få den nya tag-nyckeln
        show("Kopplar tag…");
        gasCall('addTag', {sheetName: val.sheetName || val.place, rowNum: val.rowNum, newTag: tagToLink})
          .then(res => {
            if (res.ok) {
              const oldData = tagCache.get(tag);
              if (oldData) {
                tagCache.delete(tag);
                tagCache.set(res.tag, { ...oldData, sheetName: null, rowNum: null, altTags: oldData.altTags || [] });
                const oldMeta = metaCache.get(tag);
                if (oldMeta) { metaCache.delete(tag); metaCache.set(res.tag, oldMeta); }
              }
              show(`Tag kopplad till "${name}"`, "ok");
              renderLists();
            } else if (res.collision) {
              show(`Taggen är redan kopplad till "${res.existingName}"`, "warn");
            } else {
              show(res.msg || "Kunde inte koppla tag", "warn");
            }
            cooldown(tagToLink);
          })
          .catch(err => { show("Fel: " + (err.message || err), "warn"); cooldown(tagToLink); });
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
    const le=appendLog(`${name} – tillagd (${qty})`,currentTag);
    show("Sparar…");
    // Optimistisk write FÖRE gasCall. pendingSync:true gör att initData preserverar posten
    // om preload-pollen råkar träffa innan logTag-svaret hunnit fram.
    tagCache.set(currentTag,{name,type,place,sheetName:place,sheetPlace,category,minQty:0,comment:'',step:'',rowNum:null,altTags:[],pendingSync:true});
    setLocalMeta(currentTag,{qty,unit,lastMs:Date.now(),user:userName});
    recomputeMaxLast();renderLists();
    gasCall('logTag', {tag: currentTag, name, type, qty, user: userName, sheetName: place||null})
      .then(assertOk)
      .then((res) => {
        markAsDone(le);
        const cur=tagCache.get(currentTag);
        if(cur) tagCache.set(currentTag,{...cur,rowNum:res?.row||cur.rowNum,pendingSync:false});
        renderLists();
        const metaArgs = {userName};
        if (unit) metaArgs.unit = unit;
        if (category) metaArgs.category = category;
        if (sheetPlace) metaArgs.place = sheetPlace;
        if (unit || category || sheetPlace) gasCall('updateMeta', {tag: currentTag, args: metaArgs});
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
        const le=appendLog(`${name} – uppdateras`,primaryTag); show("Uppdaterar…");
        gasCall('logTag', {tag: primaryTag, name, type: "singel", qty: 1, user: userName})
          .then(assertOk)
          .then(() => {markAsDone(le);addUndoButton(le,primaryTag);})
          .catch(err => markLogFail(le, err));
        setLocalMeta(primaryTag,{lastMs:Date.now(),user:userName}); recomputeMaxLast(); renderLists(); cooldown(primaryTag); busy=false; return;
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
        const le=appendLog(`${item.name} – uppdateras`,scanned); show("Uppdaterar…");
        gasCall('logTag', {tag: scanned, name: item.name, type: "singel", qty: 1, user: userName})
          .then(assertOk)
          .then(() => {markAsDone(le);addUndoButton(le,scanned);})
          .catch(err => markLogFail(le, err));
        tagCache.set(scanned,{name:item.name,type:"singel",place:normPlace(item.place)});
        setLocalMeta(scanned,{lastMs:Date.now(),user:userName}); recomputeMaxLast(); renderLists(); cooldown(scanned); busy=false; return;
      }
      setLocalMeta(scanned,{qty:item.qty,unit:item.unit,user:item.user,lastMs:item.last||Date.now()}); recomputeMaxLast(); renderLists(); prepareContainerDialog(item,scanned);
      tagCache.set(scanned, { name: item.name, type: "behållare", place: normPlace(item.place) });
    });
  };
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
    try { return await gasCall('preload'); }
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
