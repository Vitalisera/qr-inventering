/* node inventonlink.test.js — B5 (v153): guard-logiken för optimistiskt
   "Inventera vid koppling" (designregel D4).

   Steget fyrar vid kopplingsögonblicket, men ALDRIG om inställningen är av,
   om en dialog är öppen vid fyr-ögonblicket (ingen dialog får klobbas), eller
   om användaren hunnit vidare (staleness-fönster ~5 s från kopplings-klicket).

   shouldFireInventOnLink nedan är KOPIERAD ORDAGRANT från app.js. Håll i synk. */

// ---- Kopierat ordagrant från app.js ----
function shouldFireInventOnLink(enabled, dialogIsOpen, clickTs, nowMs, windowMs = 5000) {
  if (!enabled) return false;
  if (dialogIsOpen) return false;
  const ts = typeof clickTs === 'number' ? clickTs : nowMs;
  return (nowMs - ts) <= windowMs;
}
// ---- slut kopia ----

let pass = 0, fail = 0;
function eq(got, want, msg) {
  if (got === want) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + ' (fick ' + got + ', ville ' + want + ')'); }
}

const T0 = 1000000;

// --- Grundfall: på, ingen dialog, färskt klick → fyr ---
eq(shouldFireInventOnLink(true, false, T0, T0 + 150), true, 'på + ingen dialog + 150 ms → fyr');
eq(shouldFireInventOnLink(true, false, T0, T0), true, 'synkron fyr (0 ms) → fyr');

// --- Inställningen av → aldrig ---
eq(shouldFireInventOnLink(false, false, T0, T0), false, 'inställning av → fyr ej');

// --- Dialog öppen vid fyr-ögonblicket → aldrig (ingen dialog får klobbas) ---
eq(shouldFireInventOnLink(true, true, T0, T0 + 150), false, 'dialog öppen → fyr ej');

// --- Staleness: > 5 s sedan kopplings-klicket → användaren har gått vidare ---
eq(shouldFireInventOnLink(true, false, T0, T0 + 5000), true, 'exakt 5 s → fyr (inklusiv gräns)');
eq(shouldFireInventOnLink(true, false, T0, T0 + 5001), false, '> 5 s → fyr ej (stale)');
eq(shouldFireInventOnLink(true, false, T0, T0 + 60000), false, '1 min senare (t.ex. sen resync) → fyr ej');

// --- Eget fönster ---
eq(shouldFireInventOnLink(true, false, T0, T0 + 900, 1000), true, 'eget fönster 1 s, 900 ms → fyr');
eq(shouldFireInventOnLink(true, false, T0, T0 + 1100, 1000), false, 'eget fönster 1 s, 1100 ms → fyr ej');

// --- clickTs saknas (QA-hooken skickar ingen) → behandlas som nu → fyr ---
eq(shouldFireInventOnLink(true, false, undefined, T0), true, 'clickTs undefined → som färskt klick');
eq(shouldFireInventOnLink(true, false, null, T0), true, 'clickTs null → som färskt klick');

console.log('\n' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
