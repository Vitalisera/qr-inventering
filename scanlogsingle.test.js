/* node scanlogsingle.test.js — B3 (v151): skan-grenarnas logSingle-payload
   MÅSTE bära sheetName/rowNum när cachen (eller lookup-svaret) har dem.

   Bakgrund: utan koordinater kan backend resolveItem inte slå upp syntetiska
   nycklar ("S<flik>R<rad>") — normalizeTag strippar bokstäverna till en
   pseudo-tag av bara siffror och logTag skapar då en DUBBLETTRAD i default-
   fliken med falsk ok:true (eller skriver fel rad vid sifferkollision).
   Skan-grenarna i onScanResult skickade tidigare bara { name }.

   buildLogSingleTarget nedan är KOPIERAD ORDAGRANT från app.js. Håll i synk.
   (Samma mönster som syncgrace/swupdate/findtag.test.js — app.js kan ej köras
   i Node pga browser-globaler, så den testbara logiken extraheras till en ren fn.) */

// ---- Kopierat ordagrant från app.js ----
function buildLogSingleTarget(name, item) {
  const it = item || {};
  const rn = it.rowNum != null ? it.rowNum : (it.row != null ? it.row : null);
  return { name, sheetName: it.sheetName != null ? it.sheetName : null, rowNum: rn };
}
// ---- slut kopia ----

let pass = 0, fail = 0;
function eq(got, want, msg) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + ' (fick ' + g + ', ville ' + w + ')'); }
}

// Cache-formen (tagCache-post, hit.item i skan-grenen): sheetName + rowNum
eq(buildLogSingleTarget('Sax', { sheetName: 'Verktygslåda', rowNum: 12 }),
   { name: 'Sax', sheetName: 'Verktygslåda', rowNum: 12 },
   'cache-post: koordinater följer med');

// Lookup-svarets form (makeItemFromCols i Code.js): sheetName + row (EJ rowNum)
eq(buildLogSingleTarget('Tejp', { sheetName: 'Steg 2 & 3', row: 7, name: 'Tejp' }),
   { name: 'Tejp', sheetName: 'Steg 2 & 3', rowNum: 7 },
   'lookup-svar: row mappas till rowNum');

// rowNum vinner över row om båda finns (cache-formen är auktoritativ)
eq(buildLogSingleTarget('X', { sheetName: 'A', rowNum: 3, row: 99 }),
   { name: 'X', sheetName: 'A', rowNum: 3 },
   'rowNum prioriteras över row');

// rowNum 0/tom: 0 är ingen giltig rad i Sheets men får inte tappas tyst av
// falsy-koll — != null släpper igenom 0 (backend avvisar; ärligare än null)
eq(buildLogSingleTarget('X', { sheetName: 'A', rowNum: 0 }),
   { name: 'X', sheetName: 'A', rowNum: 0 },
   'rowNum 0 bevaras (ingen falsy-stripp)');

// Saknade koordinater → null (exakt vad Save.logSingle skickade förut)
eq(buildLogSingleTarget('Y', { name: 'Y' }),
   { name: 'Y', sheetName: null, rowNum: null },
   'utan koordinater: null/null (oförändrat beteende)');

// Felfall: null/undefined item kraschar inte
eq(buildLogSingleTarget('Z', null),
   { name: 'Z', sheetName: null, rowNum: null },
   'null item = null-koordinater, ingen krasch');
eq(buildLogSingleTarget('Z', undefined),
   { name: 'Z', sheetName: null, rowNum: null },
   'undefined item = null-koordinater, ingen krasch');

console.log('\n' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
