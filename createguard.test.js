/* node createguard.test.js — P2: skydd för create-vägen (nya artiklar).
 *
 * VARFÖR: den 30 juli 2026 försvann fyra artiklar under ett arbetspass, med
 * grön bekräftelse på skärmen. Create-vägen var systemets enda skrivväg helt
 * utan skydd: ett bart gasCall('logTag') utan omförsök, utan kö och utan
 * persistens, och en tom flikväljare skickades som strängen "Okänd" (servern:
 * "Flik finns inte: Okänd" — permanent fel, inget försökte igen). P2 ger vägen
 * samma skydd som batch-kön och tag-kopplingarna redan har.
 *
 * Det här testet bevakar de fyra beslut som avgör om en ny artikel kan gå
 * förlorad igen:
 *   1. En create utan giltig flik skickas ALDRIG (validateNewItem).
 *   2. Ett pending create-jobb överlever att appen dödas (persist → rehydrera).
 *   3. Idempotensnyckeln ck ÅTERANVÄNDS vid omförsök (annars är den värdelös).
 *   4. Cache-nyckeln efter bekräftad create pekar rätt (M→S bara för tagglösa).
 *
 * Funktionerna nedan är KOPIERADE ORDAGRANT ur app.js och bevakas av
 * testdrift.check.js. DOM/nät finns inte i Node, så localStorage och
 * badge-uppdateringen stubbas — men persisteringskoden som körs är den riktiga.
 */

'use strict';

/* ---------- harness-stubbar (ej speglad produktionskod) ---------- */
const _store = new Map();
const localStorage = {
  getItem: k => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: k => { _store.delete(k); }
};
// Pil-funktion med flit: vakten jämför inte const-pilar, och badgen kräver DOM.
const _updateSyncBadge_ = () => {};

let _pendingTagLinks = new Map();
let _pendingLogSingle = new Map();
let _pendingCreates = new Map();
const _PENDING_LS_KEY = 'vitaliseraPendingSync';

/* ---------- KOPIERAD ORDAGRANT ur app.js. Håll i synk. ---------- */
function validateNewItem(f) {
  const name = String((f && f.name) ?? '').trim();
  const unit = String((f && f.unit) ?? '').trim();
  const sheetName = String((f && f.sheetName) ?? '').trim();
  if (!name) return { ok: false, field: 'name', msg: 'Ange benämning' };
  if (!unit) return { ok: false, field: 'unit', msg: 'Ange enhet' };
  if (!sheetName) return { ok: false, field: 'sheetName', msg: 'Välj vilken flik artikeln ska skapas i' };
  return { ok: true, field: null, msg: '' };
}

function isTaglessCreate(tag) { return String(tag == null ? '' : tag).startsWith('M'); }

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

function createCacheKey(job, res) {
  const cur = String((job && job.tag != null) ? job.tag : '');
  if (!isTaglessCreate(cur)) return cur;
  if (res && res.new && res.row && res.sheetName) {
    return 'S' + String(res.sheetName).replace(/[^a-zA-Z0-9]/g, '') + 'R' + res.row;
  }
  return cur;
}

function mergePendingCreate(map, job) {
  const ck = job && job.ck;
  const prev = (map instanceof Map && ck) ? map.get(ck) : null;
  const next = prev || { ...(job || {}) };
  next.retries = (next.retries || 0) + 1;
  next._inflight = false;
  return next;
}

function selectPendingResync(map) {
  const out = [];
  for (const [k, v] of (map instanceof Map ? map : new Map())) {
    if (v && !v._inflight) out.push({ key: k, job: v });
  }
  return out;
}

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
        tag: v.tag, name: v.name ?? '', sheetName: v.sheetName ?? null, rowNum: v.rowNum ?? null,
        retries: v.retries || 0   // v151: eskaleringsräknaren överlever PWA-kill
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
    if (!tagLinks.length && !logSingle.length && !creates.length) { localStorage.removeItem(_PENDING_LS_KEY); _updateSyncBadge_(); return; }
    localStorage.setItem(_PENDING_LS_KEY, JSON.stringify({ tagLinks, logSingle, creates }));
  } catch (_) {}
  _updateSyncBadge_();   // U4: badge speglar köerna — samma choke-point som persistering
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
    // P2b: creates rehydreras på exakt samma villkor (nyckelfältet måste finnas,
    // befintlig post vinner). ck följer med ur lagringen → ett omförsök efter
    // PWA-kill bär SAMMA idempotensnyckel som det ursprungliga försöket.
    if (d && Array.isArray(d.creates)) for (const j of d.creates) {
      if (j && j.ck && !_pendingCreates.has(j.ck)) _pendingCreates.set(j.ck, j);
    }
  } catch (_) {}
}

/* ---------- pytteliten testharness (samma stil som övriga filer) ---------- */
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  PASS ' + msg); }
  else { fail++; console.log('  FAIL ' + msg); }
}
function eq(got, want, msg) { ok(JSON.stringify(got) === JSON.stringify(want), `${msg} (fick ${JSON.stringify(got)})`); }

const FULL = { name: 'Bostongurka', unit: 'st', sheetName: 'Mat' };

/* ================================================================== *
 * 1. P2a — en create utan giltig flik skickas ALDRIG
 * ================================================================== */
console.log('P2a — flikvalet är obligatoriskt:');
ok(validateNewItem(FULL).ok === true, 'komplett artikel passerar');

const noSheet = validateNewItem({ name: 'Bostongurka', unit: 'st', sheetName: '' });
ok(noSheet.ok === false, 'tom flik → avvisas (30 juli: sheetName "Okänd" → "Flik finns inte")');
ok(noSheet.field === 'sheetName', 'felet pekar ut flikfältet så det kan fokuseras');
ok(/flik/i.test(noSheet.msg), 'meddelandet nämner fliken');
ok(validateNewItem({ ...FULL, sheetName: '   ' }).ok === false, 'blanksteg är inte ett flikval');
ok(validateNewItem({ ...FULL, sheetName: undefined }).ok === false, 'saknat fält är inte ett flikval');
ok(validateNewItem(null).ok === false, 'null-indata kraschar inte, avvisas');

ok(validateNewItem({ ...FULL, name: '' }).field === 'name', 'tom benämning avvisas först');
ok(validateNewItem({ ...FULL, unit: '' }).field === 'unit', 'tom enhet avvisas (oförändrat krav)');
// Ordningen är lastbärande: alla HÅRDA krav ska prövas före F3:s mjuka
// ny-enhet-gate, annars kan användaren armera enheten och sedan blockeras.
ok(validateNewItem({ name: '', unit: '', sheetName: '' }).field === 'name',
   'första bristen rapporteras — inte en godtycklig av dem');

// Ingen giltig flik ⇒ ingen payload byggs alls. Regressionsvakt mot att
// "Okänd"-fallbacken smyger tillbaka som default.
const guarded = validateNewItem({ ...FULL, sheetName: '' }).ok
  ? buildCreatePayload({ ck: 'C1', tag: 'M1', ...FULL, sheetName: '' }, 'Robert')
  : null;
ok(guarded === null, 'utan flik byggs ingen logTag-payload');
ok(buildCreatePayload({ ck: 'C1', tag: 'M1', sheetName: '' }, 'R').sheetName === null,
   'skulle en tom flik ändå nå payloaden blir sheetName null — aldrig strängen "Okänd"');

/* ================================================================== *
 * 2. P2b — ett pending create överlever en omstart
 * ================================================================== */
console.log('\nP2b — pending create överlever att appen dödas:');
_store.clear();
_pendingCreates = new Map();
_pendingLogSingle = new Map();
_pendingTagLinks = new Map();

const job = {
  ck: 'Cabc123', tag: 'M1756000000000', name: 'Bostongurka', type: 'behållare',
  qty: 2, unit: 'burkar', category: 'Skafferi', sheetPlace: 'Hylla 4',
  sheetName: 'Mat', minQty: 1, user: 'Robert', retries: 0,
  _le: { fakeDomNode: true },   // ska INTE persisteras
  _inflight: true               // ska INTE persisteras
};
_pendingCreates.set(job.ck, job);
_persistPending_();

const raw = localStorage.getItem(_PENDING_LS_KEY);
ok(raw !== null, 'jobbet skrevs till localStorage FÖRE serversvar');
const blob = JSON.parse(raw);
ok(Array.isArray(blob.creates) && blob.creates.length === 1, 'creates är en tredje array i SAMMA blob');
ok('tagLinks' in blob && 'logSingle' in blob, 'de två befintliga köerna finns kvar i blobben');
ok(blob.creates[0]._le === undefined && blob.creates[0]._inflight === undefined,
   'DOM-nod och runtime-flagga persisteras inte');

// Simulera PWA-kill: allt i minnet försvinner, localStorage består.
_pendingCreates = new Map();
_pendingLogSingle = new Map();
_pendingTagLinks = new Map();
_rehydratePending_();

ok(_pendingCreates.size === 1, 'jobbet finns igen efter omstart');
const revived = _pendingCreates.get('Cabc123');
ok(!!revived, 'nyckeln är fortfarande ck');
eq([revived.name, revived.sheetName, revived.qty, revived.unit, revived.user],
   ['Bostongurka', 'Mat', 2, 'burkar', 'Robert'],
   'alla fält som behövs för att skapa raden överlevde');
ok(revived.sheetPlace === 'Hylla 4' && revived.category === 'Skafferi' && revived.minQty === 1,
   'metadata överlevde (Bug A: allt går i SJÄLVA logTag-anropet)');
ok(revived._inflight === undefined,
   '_inflight är borta → svepet plockar upp jobbet i stället för att hoppa över det');
eq(selectPendingResync(_pendingCreates).map(x => x.key), ['Cabc123'],
   'samma urvalsfunktion som de två befintliga köerna hittar det rehydrerade jobbet');

// Tomma köer ska rensa nyckeln helt (annars läcker en tom blob).
_pendingCreates = new Map();
_persistPending_();
ok(localStorage.getItem(_PENDING_LS_KEY) === null, 'bekräftad create → blobben tas bort');

/* ================================================================== *
 * 3. P2d — samma idempotensnyckel återanvänds vid omförsök
 * ================================================================== */
console.log('\nP2d — idempotensnyckeln återanvänds:');
_store.clear();
_pendingCreates = new Map();

const j0 = { ck: 'Cxyz789', tag: 'M1756000000001', name: 'Oatly', type: 'behållare',
             qty: 6, unit: 'st', category: '', sheetPlace: '', sheetName: 'Mat',
             minQty: 0, user: 'Robert', retries: 0 };
_pendingCreates.set(j0.ck, j0);
const p1 = buildCreatePayload(j0, 'Robert');

// Försök 1 timeoutar (kan ha lyckats server-side ändå — det gjorde det för
// Oatly och Rårörda lingon 30 juli).
const j1 = mergePendingCreate(_pendingCreates, j0);
_pendingCreates.set(j1.ck, j1);
const p2 = buildCreatePayload(_pendingCreates.get('Cxyz789'), 'Robert');

ok(p1.clientKey === 'Cxyz789' && p2.clientKey === 'Cxyz789',
   'omförsöket bär SAMMA clientKey — servern kan känna igen replayen');
ok(j1.retries === 1, 'retries räknas upp (eskalering mot RESYNC_WARN_AFTER)');
ok(j1._inflight === false, '_inflight nollas → nästa svep tar jobbet');
ok(_pendingCreates.size === 1, 'omförsöket skapar inte ett andra jobb');

// Omstart mitt i: nyckeln måste överleva lagringen också, annars vore
// idempotensen bruten just i det fall den behövs mest.
_persistPending_();
_pendingCreates = new Map();
_rehydratePending_();
const p3 = buildCreatePayload(_pendingCreates.get('Cxyz789'), 'Robert');
ok(p3.clientKey === 'Cxyz789', 'clientKey överlever PWA-kill');
ok(p3.tag === null, 'manuell artikel skickas fortfarande tagglös efter omstart');
eq(_pendingCreates.get('Cxyz789').retries, 1, 'retries-räknaren överlever PWA-kill');

// Ett ANNAT jobb ska ha en annan nyckel (ck får inte vara delad/konstant).
const other = mergePendingCreate(_pendingCreates, { ck: 'Cother', name: 'Rårörda lingon' });
ok(other.ck === 'Cother' && other.retries === 1, 'ett nytt jobb får sin egen nyckel och egen räknare');

/* ================================================================== *
 * 4. Cache-nyckel efter bekräftad create
 * ================================================================== */
console.log('\nCache-nyckel efter bekräftad create:');
const resNew = { ok: true, new: true, row: 42, sheetName: 'Steg 2 & 3' };
ok(createCacheKey({ tag: 'M1756000000000' }, resNew) === 'SSteg23R42',
   'tagglös create → syntetisk nyckel med EXAKT backends formel (annars dubblettrad i listan)');
ok(createCacheKey({ tag: '7311070005005' }, resNew) === '7311070005005',
   'skannad tagg BEHÅLLER sin nyckel — det gamla nyckelbytet gjorde posten till ett spöke och en omskanning gav "okänd kod"');
ok(createCacheKey({ tag: 'M1756000000000' }, { ok: true, updated: true, new: false, row: 7 }) === 'M1756000000000',
   'utan new/row/sheetName byts ingen nyckel (ingen gissad fliknamnsformel)');
ok(createCacheKey({ tag: 'M1' }, null) === 'M1', 'inget svar → ingen nyckelbyte, ingen krasch');
ok(isTaglessCreate('M1756000000000') === true && isTaglessCreate('7311070005005') === false,
   'M-prefix skiljer lokal cache-nyckel från riktig tagg');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
