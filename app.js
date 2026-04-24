/*
 * QR-INVENTERING – PWA KLIENTDEL
 * Extraherad från GAS app.html, google.script.run → fetch/gasCall
 */

/* ===== GAS API wrapper ===== */
const GAS_URL = 'https://script.google.com/macros/s/AKfycbwkwxkn6CT3EVctM_xTdYJ3FHfOMYyRqQCp_-zIfODY4ZLx9RISGAVYVnWBbbLY4emMbg/exec';

async function gasCall(fn, params = {}) {
  const res = await fetch(GAS_URL, {
    method: 'POST',
    body: JSON.stringify({ fn, ...params }),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error('Server error: ' + res.status);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Ogiltigt svar från servern');
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
  if (prefs.iconTag && !t.startsWith('S')) out.push('🏷️');
  if (prefs.iconType && item.type === 'singel') out.push('•');
  if (prefs.iconComment && hasComment) {
    out.push(`<span class="infoIcon" data-tag="${t}">ℹ️</span>`);
  }
  return out.length ? ' ' + out.join('') : '';
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
filterDialog=qs('#filterDialog'), placeList=qs('#placeList'),
applyFilterBtn=qs('#applyFilterBtn'), clearFilterBtn=qs('#clearFilterBtn'), cancelFilterBtn=qs('#cancelFilterBtn'),
searchFab=qs('#searchFab'), searchDialog=qs('#searchDialog'),
searchInput=qs('#searchInput'), searchResults=qs('#searchResults'), closesearchFab=qs('#closesearchFab');

// Tidig kontroll: visa namn-dialog direkt om ej sparat namn
setTimeout(() => ensureName(() => {}), 0);

/* ===== STATE ===== */
let reader,lastCode="",userName=null,lastCamera=null;
let busy=false,preloadDone=false,cameraOn=false;
const tagCache=new Map(),metaCache=new Map();const placeSet=new Set();
let maxLastMs=null;const COOLDOWN_MS=1200;let activePlaces=null;
let onlyLow=false;
let hasStarted = false;
let cameraVisible = false;
let visibleTags = [];
let currentDialogTag = null;
let extraFieldsExpanded = false;
let invertGroups = localStorage.getItem('vitaliseraInvertGroups') === '1';
let groupByCategory = localStorage.getItem('vitaliseraGroupByCategory') === '1';

/* ===== Status ===== */
function statusDefault(){
  s.className = "";
  if (cameraVisible && cameraOn) s.textContent = "Skannar…";
  else if (hasStarted && !cameraVisible) s.textContent = "Välj artikel i listan";
  else s.textContent = "Välj artikel i listan";
}
function show(msg,cls,{autoreset=true,delay=2500}={}){s.className=cls||"";s.textContent=msg;clearTimeout(show._t);if(autoreset)show._t=setTimeout(()=>statusDefault(),delay);}

/* ===== Kamera-visning ===== */
function hideCamera(){
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
function beep(freq=880,dur=0.09){if(!actx)return false;try{const t=actx.currentTime;const o=actx.createOscillator(),g=actx.createGain();o.type='sine';o.frequency.setValueAtTime(freq,t);g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(0.25,t+0.01);g.gain.exponentialRampToValueAtTime(0.0001,t+dur);o.connect(g).connect(actx.destination);o.start(t);o.stop(t+dur+0.02);return true;}catch{return false;}}
async function flashFeedback(txt){try{ensureAudioCtx();if(!beep()){blip.currentTime=0;await blip.play();}}catch{}show(txt);const laser=qs('#scanLaser');if(laser)laser.style.animationPlayState="paused";try{v.pause();}catch{}overlay.classList.add('flashOverlay');await new Promise(r=>setTimeout(r,900));overlay.classList.remove('flashOverlay');try{v.play();}catch{}if(laser)laser.style.animationPlayState="running";}
const cooldown=t=>{lastCode=t;setTimeout(()=>lastCode="",COOLDOWN_MS);};
const dialogOpen=()=>!dlg.classList.contains('hidden')||!nameDialog.classList.contains('hidden')||!filterDialog.classList.contains('hidden')||!searchDialog.classList.contains('hidden');

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
  return e;
}
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
        statusDefault();
      }, 5000);

      gasCall('cacheTs').then(ts => {
        if (ts > (window._lastCacheTs || 0)) {
          window._lastCacheTs = ts;
          console.log("Servercache uppdaterad, hämtar ny data...");
          gasCall('preload').then(initData);
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

/* ===== Filter (flik = plats) ===== */
function loadPlaceFilter(){
  try{
    const raw = localStorage.getItem('vitaliseraPlaceFilter');
    if(!raw){ activePlaces = null; }
    else {
      const arr = JSON.parse(raw);
      activePlaces = Array.isArray(arr) && arr.length ? new Set(arr) : null;
    }
  }catch{ activePlaces = null; }
  try{ onlyLow = localStorage.getItem('vitaliseraOnlyLow') === '1'; }catch{ onlyLow = false; }
}
function savePlaceFilter(){
  if(!activePlaces || activePlaces.size === 0) localStorage.removeItem('vitaliseraPlaceFilter');
  else localStorage.setItem('vitaliseraPlaceFilter', JSON.stringify([...activePlaces]));
  localStorage.setItem('vitaliseraOnlyLow', onlyLow ? '1' : '0');
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

function openFilterDialog() {
  placeList.innerHTML = "";

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

  const title1 = document.createElement('div');
  title1.style.marginTop = '12px';
  title1.style.fontWeight = '600';
  title1.textContent = 'Visa från';
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

  const titleIcons = document.createElement('div');
  titleIcons.style.marginTop = '12px';
  titleIcons.style.fontWeight = '600';
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

  overlay.classList.add("blurred");
  filterDialog.classList.remove("hidden");
}
function closeFilterDialog() {
  filterDialog.classList.add("hidden");
  overlay.classList.remove("blurred");
}

settingsBtn?.addEventListener('click', openFilterDialog);
clearFilterBtn?.addEventListener('click', () => {
  const onlyLowBox = placeList.querySelector('input[data-onlylow="1"]');
  if (onlyLowBox) onlyLowBox.checked = false;
  const boxes = placeList.querySelectorAll('input[type="checkbox"][data-place]');
  const allChecked = [...boxes].every(b => b.checked);
  boxes.forEach(b => b.checked = !allChecked);
  clearFilterBtn.textContent = allChecked ? 'Välj alla' : 'Avmarkera alla';
});
applyFilterBtn?.addEventListener('click', () => {
  const onlyLowBox = placeList.querySelector('input[data-onlylow="1"]');
  onlyLow = !!onlyLowBox?.checked;

  const groupByCatBox = placeList.querySelector('input[data-groupbycat="1"]');
  groupByCategory = !!groupByCatBox?.checked;
  localStorage.setItem('vitaliseraGroupByCategory', groupByCategory ? '1' : '0');

  const boxes = placeList.querySelectorAll('input[type="checkbox"][data-place]');
  const selPlaces = new Set();
  boxes.forEach(b => { if (b.checked) selPlaces.add(b.dataset.place); });
  activePlaces = (selPlaces.size === boxes.length) ? null : selPlaces;

  placeList.querySelectorAll('input[type="checkbox"][data-icon]').forEach(b => {
    const key = b.dataset.icon;
    prefs[key] = !!b.checked;
    localStorage.setItem('vitalisera' + key.charAt(0).toUpperCase() + key.slice(1), String(!!b.checked));
  });

  savePlaceFilter();
  show("Laddar inventeringslistor...", null, { autoreset: false });
  renderLists();
  closeFilterDialog();
  statusDefault();
});
cancelFilterBtn?.addEventListener('click', () => closeFilterDialog());

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
  const rows=[];
  const directNames=new Set();
  // Kandidater för ev. AI-sökning: namn som passerar filter men INTE matchar substring
  const aiCandidates=[];
  const nameToTag=new Map();
  for(const [tag,val] of tagCache.entries()){
    const name=val?.name||""; if(!name) continue;
    if(activePlaces && !activePlaces.has(val.place||"Okänd")) continue;
    if(onlyLow){
      const meta = metaCache.get(tag)||{};
      const isLow = (val.minQty||0) && (meta.qty < val.minQty);
      if(!isLow) continue;
    }
    const isMatch = name.toLocaleLowerCase('sv').includes(qn);
    if(isMatch){
      directNames.add(name);
      const btn=document.createElement('button');
      btn.type="button"; btn.className="statusRow";
      btn.innerHTML=`<span class="sr-name">${esc(name)}</span><span class="sr-date">${esc(metaCache.get(tag)?.lastStr||"")}</span>`;
      const _tag = tag;
      addSafeTap(btn,
        () => { closeSearchDialog(); openContainerForTag(_tag); },
        () => { closeSearchDialog(); const c = tagCache.get(_tag); if (c) prepareContainerDialog(c, _tag, { editMode: true }); }
      );
      rows.push(btn);
    } else {
      aiCandidates.push(name);
      nameToTag.set(name, tag);
    }
  }
  rows.slice(0,200).forEach(b=>searchResults.appendChild(b));

  // AI-sökning: kör bara om få direkta träffar och query är substantiell.
  if(qn.length >= 3 && rows.length < 8 && aiCandidates.length > 0){
    const loading = document.createElement('div');
    loading.className = 'searchAiLoading';
    loading.innerHTML = '<span class="aiSpinner"></span> Söker med AI…';
    searchResults.appendChild(loading);
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
        const tag = nameToTag.get(r.name);
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
function preloadData() {
  gasCall('preload').then(initData);
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
    const [t, name, type, qty, unit, last, user, place, minQty, step, comment, rowNum, altTags, category] = rec;
    if (!name) return;
    const nt = normTag(t);
    const plc = normPlace(place);
    const isSynthetic = nt.startsWith("S");

    tagCache.set(nt, {
      name,
      type,
      place: plc,
      category: String(category || "").trim(),
      minQty: Number(minQty) || 0,
      step: String(step || "").trim(),
      comment: String(comment || "").trim(),
      rowNum: rowNum || null,
      sheetName: plc,
      altTags: Array.isArray(altTags) ? altTags : []
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
      <span class="sr-min">Min</span>
      <span class="sr-lastcount">Senast</span>
      <span class="sr-date">Datum</span>`;
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
      <span class="sr-min">${esc(item.minQty ?? "")}</span>
      <span class="sr-lastcount">${esc(meta.qty ?? "")}</span>
      <span class="sr-date">${esc(meta.lastStr || "")}</span>`;

    addSafeTap(row, (e) => { if (!e.target.closest('.infoIcon')) openContainerForTag(t); });

    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const windowStart = now - INVENTORY_WINDOW_DAYS * DAY_MS;
    const windowEnd   = now + INVENTORY_WINDOW_DAYS * DAY_MS;

    const isInv =
      meta.lastMs &&
      meta.lastMs >= windowStart &&
      meta.lastMs <= windowEnd;

    (isInv ? invItems : ejItems).push({ row, category: (item.category || "").trim() });
  }

  const makeCatHeader = (label) => {
    const h = document.createElement("div");
    h.className = "categoryHeader";
    h.textContent = label;
    return h;
  };
  const appendByCategory = (target, items) => {
    if (!groupByCategory) {
      for (const { row } of items) target.appendChild(row);
      return;
    }
    const buckets = new Map();
    const noCat = [];
    for (const entry of items) {
      if (!entry.category) { noCat.push(entry.row); continue; }
      if (!buckets.has(entry.category)) buckets.set(entry.category, []);
      buckets.get(entry.category).push(entry.row);
    }
    const cats = [...buckets.keys()].sort((a, b) => a.localeCompare(b, 'sv'));
    for (const c of cats) {
      target.appendChild(makeCatHeader(c));
      for (const row of buckets.get(c)) target.appendChild(row);
    }
    if (noCat.length) {
      target.appendChild(makeCatHeader("(Ingen kategori)"));
      for (const row of noCat) target.appendChild(row);
    }
  };

  listInv.innerHTML = "";
  listEj.innerHTML = "";
  listInv.appendChild(makeHeader());
  listEj.appendChild(makeHeader());
  appendByCategory(listInv, invItems);
  appendByCategory(listEj, ejItems);
  visibleTags = _visible;

  const headerInv = listInv.closest(".group")?.querySelector(".groupTitle");
  const headerEj  = listEj.closest(".group")?.querySelector(".groupTitle");
  let filterText = "";
  if (!activePlaces) filterText = " (Alla)";
  else if (activePlaces.size > 0) filterText = " (" + Array.from(activePlaces).join(", ") + ")";
  if (headerInv) headerInv.textContent = "Inventerat" + filterText;
  if (headerEj)  headerEj.textContent  = "Ej inventerat" + filterText;

  applyGroupOrder();
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
  const onToggle = () => {
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
function resetDialog(){dlgTitle.textContent="";dlgTitle.contentEditable="false";dlgTitle.oninput=null;dlgTitle.onblur=null;dlgInfo.innerHTML="";dlgBtns.innerHTML="";newItemFields.classList.add("hidden");dlgInput.classList.add("hidden");dlgInput.value="";dlgInput.disabled=false;manualName.value="";manualName.oninput=null;manualQty.value="";if(_aiSuggestTimer){clearTimeout(_aiSuggestTimer);_aiSuggestTimer=null;}dlg.querySelectorAll('.tagScanRow,.extraFields,.aiChip').forEach(el=>el.remove());}

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
    <button id="editSingle" class="btn cancel">Fler fält</button>
    <button id="cancelSingle" class="btn cancel">Stäng</button>
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
    <button id="incBtn" class="btn">Öka mängd</button>
    <button id="newBtn" class="btn">Ny total</button>
    <button id="toggleMore" class="btn">Fler fält</button>
    <button id="cancelUpdate" class="btn cancel">Stäng</button>
    <div id="msgLine" class="msgLine"></div>
  `;

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

  const extra = document.createElement("div");
  extra.className = "extraFields";
  extra.innerHTML = `
    <label>Kommentar</label>
    <textarea id="commentEdit" rows="2">${esc(dialogItem.comment || "")}</textarea>

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

    <button id="saveMetaBtn" class="btn">Spara fält</button>

    <div class="deleteRow">
      <button id="deleteItemBtn" class="btn delete" type="button">Radera artikel</button>
    </div>
  `;
  dlg.querySelectorAll(".extraFields").forEach(e => e.remove());
  dlg.appendChild(extra);
  extra.style.display = extraFieldsExpanded ? "block" : "none";
  toggleMore.textContent = extraFieldsExpanded ? "Färre fält" : "Fler fält";

  toggleMore.onclick = () => {
    const vis = extra.style.display !== "none";
    extra.style.display = vis ? "none" : "block";
    toggleMore.textContent = vis ? "Fler fält" : "Färre fält";
    extraFieldsExpanded = !vis;
  };

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

  // Spara övriga fält
  const saveBtn = extra.querySelector("#saveMetaBtn");
  saveBtn.onclick = () => {
    setMsg("", "");
    const commentEl = qs("#commentEdit");
    const unitEl = qs("#unitEdit");
    const minEl = qs("#minQtyEdit");
    const dateEl = qs("#dateEdit");

    [commentEl, unitEl, minEl, dateEl].filter(Boolean).forEach(el => markError(el, false));

    const date = dateEl ? normDate(dateEl.value) : "";
    const minQty = parseFloat((minEl.value || "0").replace(",", "."));
    let hasErr = false;

    if (dateEl && !date) { markError(dateEl, true); hasErr = true; }
    if (!validNumber(minQty) || minQty < 0) { markError(minEl, true); hasErr = true; }
    if (hasErr) { setMsg("Kontrollera fälten markerade i rött.", "warn"); return; }

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

    setBtnBusy(saveBtn, true);

    tagCache.set(tag, { ...tagCache.get(tag), comment, unit, minQty, type: typeVal, category, pendingSync: true });

    const patch = { unit };
    if (date) patch.lastStr = date;
    setLocalMeta(tag, patch);
    recomputeMaxLast();

    setMsg("Sparad lokalt – synkroniseras…", "ok");
    show("Sparad lokalt – synkroniseras…", "warn", { autoreset: false });

    renderLists();

    const payload = { tag, comment, unit, minQty, type: typeVal, category, userName, sheetName: _sn, rowNum: _rn };
    if (date) payload.lastYMD = date;
    queueUpdate("updateMeta", payload);

    setBtnBusy(saveBtn, false);
  };

  cancelBtn.onclick = () => { closeDialog(); show("Avbrutet", "warn"); };

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
  reader = new ZXing.BrowserMultiFormatReader();
  const cams = await reader.listVideoInputDevices();
  let cam = lastCamera || cams.find(d => /back|rear|environment/i.test(d.label)) || cams[0];
  lastCamera = cam;
  if (!cam) { show("Ingen kamera", "warn"); cancelTagScan(); return; }
  cameraOn = true;

  reader.decodeFromVideoDevice(cam.deviceId, v, async res => {
    if (!res || !res.resultPoints || !tagScanCallback) return;
    const scanned = normTag(res.text || "");
    if (!scanned || scanned === lastCode) return;

    const pts = res.resultPoints || [];
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

    await flashFeedback("Tag avläst: " + scanned);
    const cb = tagScanCallback;
    cancelTagScan();
    cb(scanned);
  });
}

function cancelTagScan() {
  tagScanCallback = null;
  hideCamera();
  dlg.classList.remove("hidden");
  overlay.classList.add("blurred");
  statusDefault();
}

/* ===== "Koppla till befintlig" vid okänd tag ===== */
function showLinkTagDialog(scannedTag) {
  resetDialog();
  dlgTitle.textContent = "Okänd tag";
  dlgInfo.innerHTML = `Tag <b>${esc(scannedTag)}</b> hittades inte.`;
  dlgBtns.innerHTML = `
    <button id="createNewFromScan" class="btn">Skapa ny artikel</button>
    <button id="linkExistingBtn" class="btn">Koppla till befintlig</button>
    <button id="cancelLinkBtn" class="btn cancel">Avbryt</button>
  `;
  qs("#createNewFromScan").onclick = () => { prepareNewItemDialog(scannedTag); };
  qs("#cancelLinkBtn").onclick = () => { closeDialog(); cooldown(scannedTag); };
  qs("#linkExistingBtn").onclick = () => {
    closeDialog();
    openLinkSearchDialog(scannedTag);
  };
  openDialog();
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
        show("Kopplar tag…");
        gasCall('addTag', {sheetName: val.sheetName || val.place, rowNum: val.rowNum, newTag: tagToLink})
          .then(res => {
            if (res.ok) {
              const oldData = tagCache.get(tag);
              if (oldData) {
                if (tag.startsWith("S")) {
                  // Syntetisk artikel fick sin första riktiga tag → byt cache-nyckel
                  tagCache.delete(tag);
                  tagCache.set(res.tag, { ...oldData, sheetName: null, rowNum: null, altTags: oldData.altTags || [] });
                  const oldMeta = metaCache.get(tag);
                  if (oldMeta) { metaCache.delete(tag); metaCache.set(res.tag, oldMeta); }
                } else {
                  // Befintlig artikel fick ytterligare alt-tag → appenda
                  oldData.altTags = [...(oldData.altTags || []), res.tag];
                }
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
  const opt0=document.createElement('option'); opt0.value=''; opt0.textContent='Välj plats…'; sel.appendChild(opt0);
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
  const ha=document.getElementById('help-article'); if(ha){ha.classList.remove('open'); ha.innerHTML='Fyll i benämning, typ, enhet, plats och kategori. <b>Enhet är obligatorisk.</b><br><b>Singel</b> = en enhet per etikett (t.ex. en sax).<br><b>Behållare</b> = variabel mängd (t.ex. papper, krydda, batterier).<br>Saknas enhet eller kategori i listan — välj <b>+ Ny …</b> och skriv in.<br>Tryck "Skanna tag" för att koppla en QR-kod till artikeln.';}

  const isManual=String(scanned).startsWith('M');
  dlgInfo.innerHTML=isManual?'Skapa ny artikel manuellt:' : `Ingen matchning för <b>${esc(scanned)}</b>. Ange uppgifter:`;
  newItemFields.classList.remove("hidden");
  populatePlaceDropdown();
  populateNewUnitDropdown();
  populateNewCategoryDropdown(qs('#manualPlace')?.value || '');
  const placeSel = qs('#manualPlace');
  if (placeSel) {
    placeSel.onchange = () => populateNewCategoryDropdown(placeSel.value);
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
  const aiChip=document.createElement('div');
  aiChip.className='aiChip hidden';
  newItemFields.parentNode.insertBefore(aiChip, dlgBtns);
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

  dlgBtns.innerHTML=`<button id="saveNewBtn" class="btn">Spara</button><button id="cancelNewBtn" class="btn cancel">Stäng</button>`;
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
    const catRaw=(qs('#manualCategory')?.value||"").trim();
    const category = catRaw === '__new__'
      ? (qs('#manualCategoryNew')?.value||'').trim()
      : catRaw;
    const le=appendLog(`${name} – tillagd (${qty})`,currentTag);
    show("Sparar…");
    // Optimistisk write FÖRE gasCall. pendingSync:true gör att initData preserverar posten
    // om preload-pollen råkar träffa innan logTag-svaret hunnit fram.
    tagCache.set(currentTag,{name,type,place,sheetName:place,category,minQty:0,comment:'',step:'',rowNum:null,altTags:[],pendingSync:true});
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
        if (unit || category) gasCall('updateMeta', {tag: currentTag, args: metaArgs});
      })
      .catch(err => markLogFail(le, err));
    closeDialog();cooldown(currentTag);
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
function stopReader(){try{reader&&reader.reset();}catch{}cameraOn=false;statusDefault();}
async function startCamera(){
  stopReader(); reader=new ZXing.BrowserMultiFormatReader();
  const cams=await reader.listVideoInputDevices();
  let cam=lastCamera||cams.find(d=>/back|rear|environment/i.test(d.label))||cams[0];
  lastCamera=cam; if(!cam){show("Ingen kamera","warn");return;}
  cameraOn=true; statusDefault();
  reader.decodeFromVideoDevice(cam.deviceId,v,async res=>{
    if(!res||!res.resultPoints||busy||dialogOpen())return;
    if(!preloadDone){show("Laddar artiklar...",null,{autoreset:false});return;}
    const pts=res.resultPoints||[]; const vw=v.videoWidth||1,vh=v.videoHeight||1;
    const c=v.getBoundingClientRect(); const k=Math.max(c.width/vw,c.height/vh);
    const dispW=vw*k,dispH=vh*k; const offX=c.left+(c.width-dispW)/2, offY=c.top+(c.height-dispH)/2;
    const X=pts.map(p=>offX+p.x*k), Y=pts.map(p=>offY+p.y*k);
    const srect=scanBox.getBoundingClientRect(); const inset=8;
    const inX=x=>x>=srect.left+inset&&x<=srect.right-inset, inY=y=>y>=srect.top+inset&&y<=srect.bottom-inset;
    if(!X.every(inX)||!Y.every(inY))return;
    const bw=Math.max(...X)-Math.min(...X), bh=Math.max(...Y)-Math.min(...Y);
    if(Math.max(bw,bh)<Math.max(srect.width*0.12,srect.height*0.12))return;
    const scanned=normTag(res.text||""); if(!scanned||scanned===lastCode)return;
    busy=true; scanBox.classList.add("flash"); setTimeout(()=>scanBox.classList.remove("flash"),220);

    const hit=lookupByTag(scanned);
    if(hit){
      const primaryTag=hit.tag, cached=hit.item;
      const {name,type}=cached; await flashFeedback(name);
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
  });
}

/* ===== Preload ===== */
window._lastCacheTs = 0;
loadPlaceFilter();

// Stale-while-revalidate: rendera från localStorage direkt om möjligt,
// hämta sen färsk server-data i bakgrunden.
let hadCachedPreload = false;
try {
  const raw = localStorage.getItem(PRELOAD_CACHE_KEY);
  if (raw) {
    const cached = JSON.parse(raw);
    if (Array.isArray(cached?.data)) {
      initData(cached.data, { fromCache: true });
      hadCachedPreload = true;
      show("Uppdaterar i bakgrunden…", null, { autoreset: false });
    }
  }
} catch (e) { console.warn('preloadCache read failed', e); }

if (!hadCachedPreload) show("Laddar inventeringslistor...", null, { autoreset: false });

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
preloadWithRetry().then(res => {
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
}).finally(() => {
  // Tyst polling av servercache — startas först när bootstrap är klart så vi
  // inte får race mellan preloadWithRetry och pollern under GAS cold-start.
  setInterval(() => {
    gasCall('cacheTs').then(ts => {
      if (ts > (window._lastCacheTs || 0)) {
        window._lastCacheTs = ts;
        console.log("Servercache uppdaterad, laddar om data tyst...");
        gasCall('preload').then(initData);
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
    const shift = kbHeight > 80 ? kbHeight : 0;
    document.documentElement.style.setProperty('--kb-offset', shift + 'px');
    if (shift > 0) {
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
