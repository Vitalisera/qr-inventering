/* node missing.test.js — F1 (v154): "Saknas"-knappen i singel-dialogen.

   Verifierar (1) att buildMissingPayload bygger exakt den updateCount-payload
   som den befintliga kö-vägen (queueUpdate → batch → Code.js updateCount)
   förväntar sig — newCount 0, userName, koordinat-fallback för både
   cache-formen (rowNum) och lookup-svarets form (row) — och (2) att
   isLowQty-predikatet (röd markering + "bara lågt saldo"-filtren) redan
   täcker Saknas-fallet: qty 0 mot minQty >= 1 ger rött utan ny logik.

   Dessutom modelleras Code.js-kontraktet som Saknas vilar på:
   updateRowWithCols qty-guard är `qty !== undefined && qty !== null`,
   så 0 SKA skrivas (verifierat mot Code.js 2026-07-04). Om backend någon
   gång byter guarden till truthy-check bryts Saknas tyst — testet nedan
   dokumenterar kontraktet.

   buildMissingPayload och isLowQty nedan är KOPIERADE ORDAGRANT från app.js.
   Håll i synk. (Samma mönster som singelconfirm/qtystep/findtag.test.js —
   DOM kan ej köras i Node, så den testbara logiken extraheras.) */

// ---- Kopierat ordagrant från app.js ----
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
function isLowQty(qty, minQty) { return !!(minQty && qty < minQty); }
// ---- slut kopia ----

// Modell av Code.js updateRowWithCols qty-guard (KOPIERAD SEMANTIK,
// Code.js rad ~518): skrivs qty-cellen för ett givet värde?
function qtyWillBeWritten(qty) { return qty !== undefined && qty !== null; }

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n     ', e.message); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'eq'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

console.log('buildMissingPayload — updateCount-payload för Saknas');

t('cache-form (rowNum): full payload med newCount 0', () => {
  const p = buildMissingPayload('12345', { sheetName: 'Verktygslåda', rowNum: 7, name: 'Hammare' }, 'Linda A');
  eq(p.tag, '12345', 'tag');
  eq(p.newCount, 0, 'newCount');
  eq(p.userName, 'Linda A', 'userName');
  eq(p.sheetName, 'Verktygslåda', 'sheetName');
  eq(p.rowNum, 7, 'rowNum');
});

t('lookup-form (row): row används som rowNum-fallback', () => {
  const p = buildMissingPayload('998', { sheetName: 'Steg 2 & 3', row: 12 }, 'Robert');
  eq(p.rowNum, 12, 'rowNum från row');
});

t('rowNum vinner över row när båda finns', () => {
  const p = buildMissingPayload('55', { rowNum: 3, row: 9 }, 'X');
  eq(p.rowNum, 3, 'rowNum prioriteras');
});

t('saknade koordinater → null (inte undefined, JSON-säkert)', () => {
  const p = buildMissingPayload('777', {}, 'X');
  eq(p.sheetName, null, 'sheetName null');
  eq(p.rowNum, null, 'rowNum null');
});

t('null item kraschar inte', () => {
  const p = buildMissingPayload('1', null, 'X');
  eq(p.newCount, 0, 'newCount');
  eq(p.rowNum, null, 'rowNum');
});

t('syntetisk S-nyckel passerar orörd (koordinaterna gör jobbet)', () => {
  const p = buildMissingPayload('SVerktygsladaR5', { sheetName: 'Verktygslåda', rowNum: 5 }, 'X');
  eq(p.tag, 'SVerktygsladaR5', 'tag orörd');
  eq(p.sheetName, 'Verktygslåda', 'sheetName med');
});

t('rowNum 0 (falsy men != null) bevaras — != null-guarden, inte truthy', () => {
  const p = buildMissingPayload('1', { rowNum: 0 }, 'X');
  eq(p.rowNum, 0, 'rowNum 0 bevaras');
});

console.log('Code.js-kontraktet: qty 0 skrivs av updateRowWithCols');

t('0 passerar qty-guarden (Saknas-fallet)', () => {
  assert(qtyWillBeWritten(0) === true, '0 ska skrivas');
});

t('null/undefined skrivs inte (oförändrade celler)', () => {
  assert(qtyWillBeWritten(null) === false, 'null skippas');
  assert(qtyWillBeWritten(undefined) === false, 'undefined skippas');
});

console.log('isLowQty — röd markering täcker Saknas-fallet');

t('qty 0, minQty 1 → rött (Saknas-fallet)', () => {
  assert(isLowQty(0, 1) === true);
});

t('qty 0, minQty 0 → inte rött (ska inte finnas något)', () => {
  assert(isLowQty(0, 0) === false);
});

t('qty 0, minQty saknas (undefined) → inte rött', () => {
  assert(isLowQty(0, undefined) === false);
});

t('qty 2, minQty 3 → rött (vanligt lågt saldo)', () => {
  assert(isLowQty(2, 3) === true);
});

t('qty 3, minQty 3 → inte rött (exakt nivå räcker)', () => {
  assert(isLowQty(3, 3) === false);
});

t('qty 5, minQty 3 → inte rött', () => {
  assert(isLowQty(5, 3) === false);
});

t('qty undefined (artikel utan meta) → inte rött', () => {
  assert(isLowQty(undefined, 3) === false, 'undefined < 3 är false');
});

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
