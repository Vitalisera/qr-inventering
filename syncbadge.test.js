/* node syncbadge.test.js — U4 (v153): synk-badgens räknelogik.

   Badgen vid statusraden visar hur många jobb som väntar på bekräftelse
   (_pendingTagLinks + _pendingLogSingle + updateQueue inkl. _inflightBatch)
   och byter till ⚠️-variant när något jobb nått retries >= RESYNC_WARN_AFTER.

   buildSyncBadgeModel nedan är KOPIERAD ORDAGRANT från app.js. Håll i synk.
   (Samma mönster som rekeypending/syncgrace-testerna — app.js kan ej köras
   i Node pga browser-globaler, så den testbara logiken extraheras till en ren fn.) */

// ---- Kopierat ordagrant från app.js ----
function buildSyncBadgeModel(counts) {
  const c = counts || {};
  const links = c.links || 0, singles = c.singles || 0, queue = c.queue || 0, warn = c.warn || 0;
  const total = links + singles + queue;
  if (total <= 0) return { visible: false, warn: false, text: '' };
  if (warn > 0) return { visible: true, warn: true, text: warn + ' kunde inte sparas' };
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
   { visible: true, warn: true, text: '1 kunde inte sparas' }, '1 uppgivet jobb → ⚠️-variant');
eq(buildSyncBadgeModel({ links: 1, singles: 2, queue: 3, warn: 2 }),
   { visible: true, warn: true, text: '2 kunde inte sparas' }, 'flera uppgivna → antal i warn-text');

// --- Warn utan pending totalsumma kan inte inträffa (warn-jobb ligger kvar i
//     map:arna), men modellen ska ändå vara ofarlig: total 0 → dold ---
eq(buildSyncBadgeModel({ links: 0, singles: 0, queue: 0, warn: 5 }),
   { visible: false, warn: false, text: '' }, 'warn utan total → dold (defensivt)');

// --- Negativa/trasiga värden coercas via ||0 ---
eq(buildSyncBadgeModel({ links: undefined, singles: null, queue: 1, warn: NaN }),
   { visible: true, warn: false, text: '1 ändring synkas…' }, 'undefined/null/NaN → 0 utan krasch');

console.log('\n' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
