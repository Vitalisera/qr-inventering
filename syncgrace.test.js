/* node syncgrace.test.js — verifierar grace-fönstret mot post-confirm-klobb.

   Bakgrund (synk-audit 2026-07-01, "förlorade kommentarer"): när en batch
   bekräftats rensas pendingSync, men _revalidateCacheTs_ kör direkt efter och
   kan dra en COALESCAD preload som startade FÖRE writen (stale, utan ändringen).
   Med pendingSync redan false skulle initData rebuilda raden från stale server-
   data → ikon/värde försvinner ur vyn (datan i arket är intakt). _recentlySynced
   markerar nyss-bekräftade tags; initData-snapshoten bevarar dem inom grace.

   _isWithinGrace_ nedan är KOPIERAD ORDAGRANT från app.js. Håll i synk.
   (Samma mönster som swupdate/findtag/latency.test.js — app.js kan ej köras i
   Node pga browser-globaler, så den testbara logiken extraheras till en ren fn.) */

// ---- Kopierat ordagrant från app.js ----
function _isWithinGrace_(syncedMs, nowMs, graceMs) {
  return typeof syncedMs === 'number' && (nowMs - syncedMs) < graceMs;
}
// ---- slut kopia ----

let pass = 0, fail = 0;
function eq(got, want, msg) {
  if (got === want) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + ' (fick ' + got + ', ville ' + want + ')'); }
}

const G = 20000;

// Inom grace → snapshoten BEVARAR lokala värdet (skyddar mot stale-preload-klobb)
eq(_isWithinGrace_(1000, 1000, G), true,  'samma ms = inom grace');
eq(_isWithinGrace_(1000, 1001, G), true, '1ms efter = inom grace');
eq(_isWithinGrace_(1000, 1000 + 19999, G), true, '19999ms efter = inom grace (precis under)');

// Utanför grace → server tar över (backend-guarden gör server korrekt vid det laget)
eq(_isWithinGrace_(1000, 1000 + 20000, G), false, 'exakt grace = utanför (strikt <)');
eq(_isWithinGrace_(1000, 1000 + 25000, G), false, '25s efter = utanför grace');

// Felfall: ej satt / ogiltig typ → ej skyddad (faller tillbaka på pendingSync-grenen)
eq(_isWithinGrace_(undefined, 5000, G), false, 'undefined syncedMs = false');
eq(_isWithinGrace_(null, 5000, G), false, 'null syncedMs = false');
eq(_isWithinGrace_('1000', 5000, G), false, 'sträng syncedMs = false (kräver number)');

// Defensivt: framtida syncedMs (klockskev) → negativ diff < grace → true (ofarligt, kort skydd)
eq(_isWithinGrace_(10000, 9000, G), true, 'framtida syncedMs (klockskev) = true (ofarligt)');

console.log('\n' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
