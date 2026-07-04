/* node qtystep.test.js — F2 (v152): mängd-stepperns [−]/[+] stegar med
   värdets egen decimalupplösning i stället för hårdkodad ±1.

   Bakgrund: adjustQty stegade alltid ±1, vilket var obrukbart för
   decimalsaldon — 0,5 följt av + gav 1,5 och det fanns ingen väg till 0,6.
   Steget = decimalupplösningen: heltal → 1, en decimal → 0,1, två → 0,01
   (max 6). Resultatet avrundas till samma decimalantal (flyttalsstädning),
   golvas på 0 och behåller användarens decimaltecken (komma eller punkt).

   stepQty nedan är KOPIERAD ORDAGRANT från app.js. Håll i synk.
   (Samma mönster som scanlogsingle/syncgrace/swupdate — app.js kan ej köras
   i Node pga browser-globaler, så den testbara logiken speglas som ren fn.) */

// ---- Kopierat ordagrant från app.js ----
function stepQty(raw, dir) {
  const s0 = String(raw == null ? "" : raw).trim();
  const comma = s0.includes(",");
  const s = s0.replace(",", ".");
  const v = parseFloat(s);
  const cur = isFinite(v) ? v : 0;
  const m = isFinite(v) ? /\.(\d+)$/.exec(s) : null;
  const decimals = m ? Math.min(m[1].length, 6) : 0;
  const next = Math.max(0, cur + dir * Math.pow(10, -decimals));
  const out = next.toFixed(decimals);
  return comma ? out.replace(".", ",") : out;
}
// ---- slut kopia ----

let pass = 0, fail = 0;
function eq(got, want, msg) {
  if (got === want) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + ' (fick "' + got + '", ville "' + want + '")'); }
}

// Heltal → steg 1 (oförändrat beteende mot tidigare)
eq(stepQty("3", 1), "4", "heltal: 3 + → 4");
eq(stepQty("3", -1), "2", "heltal: 3 − → 2");

// En decimal → steg 0,1 (kärnfallet som var trasigt: 0,5 + gav förut 1,5)
eq(stepQty("0,5", 1), "0,6", "en decimal, komma: 0,5 + → 0,6");
eq(stepQty("0,5", -1), "0,4", "en decimal, komma: 0,5 − → 0,4");
eq(stepQty("0.5", 1), "0.6", "en decimal, punkt: 0.5 + → 0.6");

// Två decimaler → steg 0,01
eq(stepQty("1,25", 1), "1,26", "två decimaler: 1,25 + → 1,26");
eq(stepQty("1,25", -1), "1,24", "två decimaler: 1,25 − → 1,24");

// Flyttalsstädning — utan avrundning hade 0.3 − 0.1 blivit 0.19999999999999998
eq(stepQty("0,3", -1), "0,2", "flyttalsstädning: 0,3 − → 0,2 (ej 0,19999…)");
eq(stepQty("0,3", 1), "0,4", "flyttalsstädning: 0,3 + → 0,4 (ej 0,30000…04)");

// Min 0 — går aldrig under noll
eq(stepQty("0", -1), "0", "golv: 0 − → 0");
eq(stepQty("0,1", -1), "0,0", "golv med decimal: 0,1 − → 0,0");
eq(stepQty("-2", 1), "0", "negativt inmatat värde golvas: -2 + → 0");

// Decimaltecknet bevaras som användaren skrev det — och "2,0" HAR en synlig
// decimal, så upplösningen (och steget) är 0,1 enligt spec.
eq(stepQty("2,0", 1), "2,1", "komma bevaras: 2,0 + → 2,1 (endecimalsupplösning)");
eq(stepQty("2.0", 1), "2.1", "punkt bevaras: 2.0 + → 2.1 (endecimalsupplösning)");

// Tomt/ogiltigt → utgå från 0 med steg 1 (samma som gamla parseFloat||0)
eq(stepQty("", 1), "1", "tomt fält: + → 1");
eq(stepQty(null, 1), "1", "null: + → 1");
eq(stepQty("abc", 1), "1", "ogiltig text: + → 1");
eq(stepQty("abc", -1), "0", "ogiltig text: − → 0");

// Kantfall: avslutande punkt utan siffror räknas som heltal
eq(stepQty("5.", 1), "6", "avslutande punkt utan decimal: 5. + → 6");

// Decimaltak: fler än 6 decimaler kapas till steg 0,000001 (ingen 1e-7-drift)
eq(stepQty("0,12345678", 1), "0,123458", "max 6 decimaler");

console.log('');
console.log(pass + ' pass, ' + fail + ' fail');
if (fail) process.exit(1);
