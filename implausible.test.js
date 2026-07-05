/* node implausible.test.js — F3 lager 4 (v155): rimlighetsspärr vid Spara.

   isImplausibleQtyChange(prev, next) → true BARA när nya saldot avviker mer
   än 100× från förra (åt något håll) och BÅDA är > 0. Motivering (asymmetri):
   falskt positiv kostar ett knapptryck, falskt negativ kostar korrupt data
   ("7 200 kg pasta"-klassen, kg/g-förväxling). Första inventering (0→stort,
   tomt→värde) och nollning spärras ALDRIG. Exakt 100× tillåts (strikt >).

   Funktionen nedan är KOPIERAD ORDAGRANT från app.js. Håll i synk. */

// ---- Kopierat ordagrant från app.js ----
function isImplausibleQtyChange(prev, next){
  const p = Number(String(prev == null ? '' : prev).replace(',', '.'));
  const n = Number(String(next == null ? '' : next).replace(',', '.'));
  if (!isFinite(p) || !isFinite(n)) return false;
  if (p <= 0 || n <= 0) return false;
  const ratio = n / p;
  return ratio > 100 || ratio < 0.01;
}
// ---- slut kopia ----

let pass = 0, fail = 0;
function eq(got, want, msg) {
  if (got === want) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + ' (fick ' + got + ', ville ' + want + ')'); }
}

console.log('Kärnfallet — kg/g-förväxlingen');
eq(isImplausibleQtyChange(7.2, 7200), true, '7,2 → 7 200 (1000×): orimligt');
eq(isImplausibleQtyChange(7200, 7.2), true, '7 200 → 7,2 (1/1000): orimligt');
eq(isImplausibleQtyChange(5, 600), true, '5 → 600 (120×): orimligt');
eq(isImplausibleQtyChange(600, 5), true, '600 → 5 (1/120): orimligt');

console.log('');
console.log('Normala ändringar spärras inte');
eq(isImplausibleQtyChange(5, 7), false, '5 → 7: rimligt');
eq(isImplausibleQtyChange(10, 500), false, '10 → 500 (50×): rimligt');
eq(isImplausibleQtyChange(500, 10), false, '500 → 10 (1/50): rimligt');
eq(isImplausibleQtyChange(3, 3), false, 'oförändrat: rimligt');

console.log('');
console.log('Kantfall: exakt 100× tillåts (strikt >)');
eq(isImplausibleQtyChange(1, 100), false, '1 → 100 (exakt 100×): tillåtet');
eq(isImplausibleQtyChange(100, 1), false, '100 → 1 (exakt 1/100): tillåtet');
eq(isImplausibleQtyChange(1, 100.01), true, '1 → 100,01 (strax över): orimligt');
eq(isImplausibleQtyChange(100.01, 1), true, '100,01 → 1 (strax under 1/100): orimligt');

console.log('');
console.log('Kantfall: noll och tomt är legitima (första inventering/nollning)');
eq(isImplausibleQtyChange(0, 5000), false, '0 → 5 000: första inventering, tillåtet');
eq(isImplausibleQtyChange('', 5000), false, 'tomt → 5 000: tillåtet');
eq(isImplausibleQtyChange(null, 5000), false, 'null → 5 000: tillåtet');
eq(isImplausibleQtyChange(5000, 0), false, '5 000 → 0: nollning (Saknas), tillåtet');
eq(isImplausibleQtyChange(0, 0), false, '0 → 0: tillåtet');

console.log('');
console.log('Kantfall: icke-numeriskt och negativt');
eq(isImplausibleQtyChange('abc', 5000), false, 'icke-numeriskt förra: tillåtet');
eq(isImplausibleQtyChange(5, 'abc'), false, 'icke-numeriskt nytt: tillåtet (fångas av talvalidering före)');
eq(isImplausibleQtyChange(-5, 5000), false, 'negativt förra: spärras inte här');
eq(isImplausibleQtyChange(5, -5000), false, 'negativt nytt: spärras inte här');

console.log('');
console.log('Kantfall: decimalkomma-strängar (samma parsning som Spara-fältet)');
eq(isImplausibleQtyChange('7,2', '7200'), true, '"7,2" → "7200": orimligt');
eq(isImplausibleQtyChange('7,2', '7,5'), false, '"7,2" → "7,5": rimligt');
eq(isImplausibleQtyChange('0,05', '6'), true, '0,05 → 6 (120×): orimligt');

console.log('');
console.log(pass + ' pass, ' + fail + ' fail');
if (fail) process.exit(1);
