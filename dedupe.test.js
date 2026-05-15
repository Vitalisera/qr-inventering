/* node dedupe.test.js — verifierar de två dubblett-fixarna.

   BUG B: addTagToRow pushade en dubblett när Sheets coerce:at en befintlig
   tag och tappat ledande nolla ("0959773" → "959773"). Strikt includes()
   missade matchen → "959773|0959773|". Fix: leading-zero-normaliserad nyckel.
   Samma nyckel deduplicerar även befintliga dubbletter i migrateTagColumnToPipe.

   DUBBLETT-I-LISTAN: manuell artikel optimistiskt cachad under "M<ts>"-nyckel.
   Servern returnerar den vid nästa preload under syntetisk nyckel
   "S<flik>R<rad>" → artikeln syns två gånger. Fix: byt M→S med EXAKT samma
   formel som backend (Code.js preloadTagsWithMeta) via res.sheetName+res.row.

   Pure-logiken nedan är kopierad ordagrant från Code.js / app.js.
   Håll i synk. (Samma mönster som findtag.test.js — GAS kan ej köras lokalt.) */

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`  FAIL ${label}\n    fick:      ${a}\n    förväntat: ${e}`); }
}

/* ===== (a) Bug B — addTagToRow leading-zero-dedupe =====
   Kopierat ordagrant från Code.js addTagToRow (raderna kring tags.some). */
function addTagDedupe(tags, wanted) {
  const _zk = s => (String(s).replace(/^0+/, '') || '0');
  const wantedKey = _zk(wanted);
  if (!tags.some(t => _zk(t) === wantedKey)) tags.push(wanted);
  return tags;
}

console.log('(a) Bug B — addTagToRow leading-zero-dedupe');
// coerce:ad cell tappat ledande nolla, wanted har den → INGEN dubblett
eq(addTagDedupe(['959773'], '0959773'), ['959773'], 'coerce:ad befintlig, ingen dubblett');
// omvänt: cell har ledande nolla, wanted utan → INGEN dubblett
eq(addTagDedupe(['0959773'], '959773'), ['0959773'], 'befintlig med nolla, ingen dubblett');
// exakt dubblett → en
eq(addTagDedupe(['0959773'], '0959773'), ['0959773'], 'exakt dubblett → en');
// olika tags → båda kvar
eq(addTagDedupe(['0959773'], '0959774'), ['0959773', '0959774'], 'olika tags → båda');
// tom cell → wanted läggs till
eq(addTagDedupe([], '0959773'), ['0959773'], 'tom cell → läggs till');
// all-zero edge: "000" vs "0" → samma nyckel "0"
eq(addTagDedupe(['000'], '0'), ['000'], 'all-zero → samma nyckel, ingen dubblett');

/* ===== (b) migrateTagColumnToPipe-dedupe =====
   Kopierat ordagrant från Code.js migrateTagColumnToPipe (deduped-blocket). */
function migrateDedupe(tags) {
  const _zk = s => (String(s).replace(/^0+/, '') || '0');
  const _byKey = {};
  const _order = [];
  for (const t of tags) {
    const k = _zk(t);
    if (!(k in _byKey)) { _byKey[k] = t; _order.push(k); }
    else if (String(t).length > String(_byKey[k]).length) { _byKey[k] = t; }
  }
  return _order.map(k => _byKey[k]);
}

console.log('(b) migrateTagColumnToPipe-dedupe');
// klassisk dubblett "0959773|0959773|" → en, ledande nolla bevarad
eq(migrateDedupe(['0959773', '0959773']), ['0959773'], 'exakt dubblett → en');
// blandad coerce:ad + ledande-nolla → en, LÄNGSTA (med nolla) behålls
eq(migrateDedupe(['959773', '0959773']), ['0959773'], 'kollision → längsta (bevarar nolla)');
eq(migrateDedupe(['0959773', '959773']), ['0959773'], 'kollision omvänd ordning → längsta');
// flera distinkta + en dubblett → ordning bevarad, dubblett borta
eq(migrateDedupe(['0959773', '0959774', '0959773']), ['0959773', '0959774'], 'distinkta + dubblett');
// inga dubbletter → oförändrad
eq(migrateDedupe(['0959773', '0959774']), ['0959773', '0959774'], 'inga dubbletter → oförändrad');

/* ===== (c) M→S-nyckelbyte =====
   Kopierat ordagrant från app.js prepareNewItemDialog logTag-success +
   backend-formeln från Code.js preloadTagsWithMeta (effectiveTag) +
   normTag (app.js rad 326). Verifierar att klientens rekonstruerade nyckel
   är BIT-IDENTISK med den servern genererar för samma rad. */
const normTag = x => { const s = String(x || "").trim(); return s.startsWith("S") ? s : s.replace(/[^\d]/g, ""); };

// backend (Code.js preloadTagsWithMeta rad 630)
function backendSyntheticKey(sheetName, rowIndexZeroBased) {
  return "S" + sheetName.replace(/[^a-zA-Z0-9]/g, '') + "R" + (rowIndexZeroBased + 2);
}
// klient (app.js, ur res.sheetName + res.row)
function clientReconstructKey(currentTag, res) {
  let newKey = currentTag;
  if (res && res.new && res.row && res.sheetName) {
    newKey = "S" + String(res.sheetName).replace(/[^a-zA-Z0-9]/g, '') + "R" + res.row;
  }
  return newKey;
}

console.log('(c) M→S-nyckelbyte — klient rekonstruerar EXAKT backend-nyckel');
// Backend la rad i flik "Kurslokal/Reception" på sheet-rad 42 (= dataindex 40).
// res.row = sh.getLastRow() = 42. preload: i=40 → "R"+(40+2)=R42. Måste matcha.
{
  const sheet = "Kurslokal/Reception";
  const sheetRow = 42;            // logTag: sh.getLastRow()
  const preloadI = sheetRow - 2;  // preloadTagsWithMeta dataindex
  const serverKey = normTag(backendSyntheticKey(sheet, preloadI));
  const clientKey = normTag(clientReconstructKey("M1700000000000", { new: true, row: sheetRow, sheetName: sheet }));
  eq(clientKey, serverKey, 'klient-nyckel === server-nyckel (slash i fliknamn strippas)');
  eq(clientKey, "SKurslokalReceptionR42", 'exakt förväntad nyckel');
}
// Fliknamn med svenska tecken + mellanslag → [^a-zA-Z0-9] strippar identiskt båda sidor
{
  const sheet = "Steg 2 & 3";
  const sheetRow = 7;
  const serverKey = normTag(backendSyntheticKey(sheet, sheetRow - 2));
  const clientKey = normTag(clientReconstructKey("M999", { new: true, row: sheetRow, sheetName: sheet }));
  eq(clientKey, serverKey, 'fliknamn med å/mellanslag/& → identisk strippning');
}
// Fail-fall: res saknar sheetName (gammal backend) → nyckel oförändrad (M), ingen krasch
{
  const k = clientReconstructKey("M555", { new: true, row: 9 });
  eq(k, "M555", 'utan res.sheetName → behåll M (graceful, ingen dubblett-garanti men ingen krasch)');
}
// Fail-fall: updated (ej new) → ingen rekey (raden fanns redan, har riktig tag/identitet)
{
  const k = clientReconstructKey("M555", { updated: true, new: false, row: 3, sheetName: "X" });
  eq(k, "M555", 'updated:true (ej new) → ingen rekey');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
