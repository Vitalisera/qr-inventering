/* node syncbadge.test.js — U4 (v153): synk-badgens räknelogik.

   Badgen vid statusraden visar hur många jobb som väntar på bekräftelse
   (_pendingTagLinks + _pendingLogSingle + _pendingCreates + updateQueue inkl.
   _inflightBatch) och byter till ⚠️-variant när något inte kommit fram.

   P3a ändrade den röda grenen på två sätt: den räknar nu warn + failed
   (warn = köade jobb som nått retries >= RESYNC_WARN_AFTER, failed =
   _failedWrites, permanenta fel som ingen försöker om), och den visas OAVSETT
   om något ligger kvar i köerna. Det andra är hela poängen — se failcount.test.js
   för varför den gamla ordningen gjorde varje avvisad skrivning osynlig.

   buildSyncBadgeModel nedan är KOPIERAD ORDAGRANT från app.js. Håll i synk.
   (Samma mönster som rekeypending/syncgrace-testerna — app.js kan ej köras
   i Node pga browser-globaler, så den testbara logiken extraheras till en ren fn.) */

// ---- Kopierat ordagrant från app.js ----
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

// ---- slut kopia ----

let pass = 0, fail = 0;
function eq(got, want, msg) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + ' (fick ' + g + ', ville ' + w + ')'); }
}

// --- Tomt = dold ---
eq(buildSyncBadgeModel({ links: 0, singles: 0, queue: 0, warn: 0 }),
   { visible: false, warn: false, text: '' }, 'inga jobb → dold');
eq(buildSyncBadgeModel(null),
   { visible: false, warn: false, text: '' }, 'null counts → dold utan krasch');
eq(buildSyncBadgeModel({}),
   { visible: false, warn: false, text: '' }, 'tomt objekt → dold utan krasch');

// --- Bara kopplingar → "koppling(ar)" ---
eq(buildSyncBadgeModel({ links: 1, singles: 0, queue: 0, warn: 0 }),
   { visible: true, warn: false, text: '1 koppling synkas…' }, '1 länk → "1 koppling synkas…"');
eq(buildSyncBadgeModel({ links: 3, singles: 0, queue: 0, warn: 0 }),
   { visible: true, warn: false, text: '3 kopplingar synkas…' }, '3 länkar → plural kopplingar');

// --- Blandat eller icke-länk → "ändring(ar)" ---
eq(buildSyncBadgeModel({ links: 0, singles: 1, queue: 0, warn: 0 }),
   { visible: true, warn: false, text: '1 ändring synkas…' }, '1 singel → "1 ändring synkas…"');
eq(buildSyncBadgeModel({ links: 0, singles: 0, queue: 2, warn: 0 }),
   { visible: true, warn: false, text: '2 ändringar synkas…' }, '2 kö-jobb → "2 ändringar synkas…"');
eq(buildSyncBadgeModel({ links: 1, singles: 1, queue: 1, warn: 0 }),
   { visible: true, warn: false, text: '3 ändringar synkas…' }, 'blandat → totalsumma som ändringar');

// --- Warn-variant vinner ---
eq(buildSyncBadgeModel({ links: 0, singles: 2, queue: 0, warn: 1 }),
   { visible: true, warn: true, text: '1 kunde inte sparas – tryck här' }, '1 uppgivet jobb → ⚠️-variant');
eq(buildSyncBadgeModel({ links: 1, singles: 2, queue: 3, warn: 2 }),
   { visible: true, warn: true, text: '2 kunde inte sparas – tryck här' }, 'flera uppgivna → antal i warn-text');

// --- P3a: den gamla regeln "warn utan total → dold (defensivt)" var SJÄLV
//     tystnaden. Den byggde på premissen att ett warn-jobb alltid ligger kvar
//     i en map, men de permanenta felen (failed) avregistreras ur mapparna i
//     samma andetag som de failar — total är noll precis då felet finns.
//     Regeln är därför inverterad: rött visas oavsett totalsumma. ---
eq(buildSyncBadgeModel({ links: 0, singles: 0, queue: 0, warn: 5 }),
   { visible: true, warn: true, text: '5 kunde inte sparas – tryck här' }, 'warn utan total → SYNS (P3a)');
eq(buildSyncBadgeModel({ links: 0, singles: 0, queue: 0, failed: 1 }),
   { visible: true, warn: true, text: '1 kunde inte sparas – tryck här' }, 'failed utan total → syns');
eq(buildSyncBadgeModel({ links: 0, singles: 1, queue: 0, warn: 1, failed: 2 }),
   { visible: true, warn: true, text: '3 kunde inte sparas – tryck här' }, 'warn + failed summeras');
eq(buildSyncBadgeModel({ links: 0, singles: 3, queue: 0, warn: 0, failed: 0 }),
   { visible: true, warn: false, text: '3 ändringar synkas…' }, 'inget rött → gul synkas-text som förr');

// --- Negativa/trasiga värden coercas via ||0 ---
eq(buildSyncBadgeModel({ links: undefined, singles: null, queue: 1, warn: NaN }),
   { visible: true, warn: false, text: '1 ändring synkas…' }, 'undefined/null/NaN → 0 utan krasch');

console.log('\n' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
