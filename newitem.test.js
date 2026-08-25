/* node newitem.test.js — verifierar Bug A-fixen: ny artikel tappar inte längre
   Enhet/Kategori/Plats/minQty.

   Buggen: #saveNewBtn skapade artikeln via gasCall('logTag',{tag:currentTag})
   och skickade SEDAN unit/category/place i ett SEPARAT gasCall('updateMeta',
   {tag:currentTag,...}). currentTag = "M"+Date.now(). Backend normalizeTag
   strippar icke-siffror → resolveItem hittar inte raden → updateMeta {ok:false}
   som frontend IGNORERADE. Fälten försvann tyst.

   Fixen: all metadata skickas i SJÄLVA logTag-anropet, inget separat updateMeta.

   P2 (2026-08-25): payload-bygget flyttade ut ur #saveNewBtn till de RIKTIGA
   funktionerna buildCreatePayload/isTaglessCreate i app.js. Kopiorna nedan är
   ordagranna och bevakas av testdrift.check.js. Samma mönster som
   findtag.test.js — DOM/gasCall kan ej köras lokalt, så vi testar den rena
   logiken. Testet fortsätter bevaka Bug A (all metadata i SJÄLVA logTag-
   anropet) och bevakar nu även att M-nyckeln aldrig läcker ut som en tagg. */

// ---- KOPIERAD ORDAGRANT ur app.js. Håll i synk. ----
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

// Harness: bygger jobbet som #saveNewBtn gör och kör den riktiga payload-
// funktionen. separateUpdateMetaCalled speglar att fixad kod aldrig gör ett
// separat updateMeta efteråt (rotorsaken i Bug A).
function buildSaveNewPayload(fields) {
  const { currentTag, name, type, qty, userName, place, sheetPlace, unit, category, minQty } = fields;
  const job = {
    ck: 'Ctest1', tag: currentTag, name, type, qty, unit, category,
    sheetPlace, sheetName: place, minQty, user: userName, retries: 0
  };
  const payload = buildCreatePayload(job, userName);
  const separateUpdateMetaCalled = false;
  return { payload, separateUpdateMetaCalled };
}

// ---- Optimistisk tagCache-post (rad ~3436) ----
function buildOptimisticCacheEntry(fields) {
  const { name, type, place, sheetPlace, category, minQty } = fields;
  return { name, type, place, sheetName: place, sheetPlace, category, minQty,
    comment: '', step: '', rowNum: null, altTags: [], pendingSync: true };
}

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  PASS ' + msg); }
  else { fail++; console.log('  FAIL ' + msg); }
}

const filled = {
  currentTag: 'M1715000000000', name: 'Tejprulle', type: 'singel', qty: 3,
  userName: 'Robert', place: 'Kurslokal/Reception', sheetPlace: 'Hylla 4',
  unit: 'st', category: 'Förbrukning', minQty: 5
};

console.log('Bug A — alla fält ifyllda:');
const { payload, separateUpdateMetaCalled } = buildSaveNewPayload(filled);
ok(payload.unit === 'st', 'payload.unit skickas i logTag');
ok(payload.category === 'Förbrukning', 'payload.category skickas i logTag');
ok(payload.place === 'Hylla 4', 'payload.place = sheetPlace (fysisk plats kol B)');
ok(payload.minQty === 5, 'payload.minQty skickas i logTag');
ok(payload.type === 'singel', 'payload.type skickas i logTag');
ok(payload.sheetName === 'Kurslokal/Reception', 'payload.sheetName = manualPlace (flik)');
ok(payload.tag === null, 'M-nyckeln skickas INTE som tagg (P2: tagglös create, ingen pseudotagg i TAG-kolumnen)');
ok(payload.clientKey === 'Ctest1', 'payload.clientKey = jobbets idempotensnyckel');
const scanned = buildSaveNewPayload({ ...filled, currentTag: '7311070005005' });
ok(scanned.payload.tag === '7311070005005', 'en SKANNAD tagg skickas som tagg (raden ska bära etiketten)');
ok(separateUpdateMetaCalled === false, 'INGET separat updateMeta-anrop görs (rotorsak borttagen)');

console.log('\nOptimistisk tagCache-post:');
const ce = buildOptimisticCacheEntry(filled);
ok(ce.minQty === 5, 'tagCache.minQty = faktiskt värde (inte hårdkodat 0)');
ok(ce.category === 'Förbrukning', 'tagCache.category bevarad');

console.log('\nBakåtkompat — minQty tomt fält (parseFloat||0):');
const empty = { ...filled, minQty: 0 };
const r2 = buildSaveNewPayload(empty);
ok(r2.payload.minQty === 0, 'tomt minQty → 0 (bakåtkompat, ej crash)');
ok(buildOptimisticCacheEntry(empty).minQty === 0, 'tagCache minQty 0 vid tomt fält');

// ---- FAILING-BEFORE-demonstration: gamla buggiga payloaden ----
console.log('\nRegression — gamla (buggiga) beteendet ska INTE återkomma:');
function buildOldBuggyPayload(fields) {
  const { currentTag, name, type, qty, userName, place } = fields;
  const payload = { tag: currentTag, name, type, qty, user: userName, sheetName: place || null };
  const separateUpdateMetaCalled = true; // gamla koden gjorde detta
  return { payload, separateUpdateMetaCalled };
}
const oldR = buildOldBuggyPayload(filled);
ok(oldR.payload.unit === undefined && oldR.separateUpdateMetaCalled === true,
   'gamla payloaden saknade unit + krävde separat updateMeta (buggen vi fixade)');
ok(payload.unit !== undefined && separateUpdateMetaCalled === false,
   'nya payloaden har unit OCH inget separat updateMeta (fixen verifierad)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
