/* node units.test.js — F3 (v155): enhetsgovernance, lager 1 + 3.

   Familjetabellen (UNIT_FACTORS/UNIT_STYCK) är byggd från de enheter som
   FAKTISKT förekommer i Sheetet (inventerat 2026-07-05): st, rullar, förp,
   paket, påsar, säckar, askar, buntar, tuber, flaskor, flaska, burkar, set,
   Godislåda, gram, g, hg, kg, ml, dl, liter. Testerna täcker:
   - unitFamily: uppslag för ALLA verkliga enheter + skiftläge + okänd
   - isContainerUnit: styck-familjen utom 'st'
   - convertQty: inom massa/volym (inkl. alias gram/liter), null för
     styck/okänd/familjebyte/samma enhet/icke-numeriskt
   - formatQtySv: decimalkomma + hårt mellanslag som tusentalsavgränsare
   - buildUnitOptionsHTML: optgroup per familj i fast ordning, selected-flagga

   Funktionerna nedan är KOPIERADE ORDAGRANT från app.js. Håll i synk.
   (Samma mönster som qtystep/scanlogsingle — app.js kan ej köras i Node
   pga browser-globaler, så den testbara logiken speglas som rena fn.) */

// ---- Kopierat ordagrant från app.js ----
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const UNIT_FACTORS = {
  massa: { 'g': 1, 'gram': 1, 'hg': 100, 'kg': 1000 },
  volym: { 'ml': 1, 'cl': 10, 'dl': 100, 'l': 1000, 'liter': 1000 }
};
const UNIT_STYCK = ['st','förp','paket','påsar','rullar','askar','buntar','säckar','tuber','flaskor','flaska','burkar','kartonger','set','godislåda'];

function _unitKey(u){ return String(u == null ? '' : u).trim().toLowerCase(); }

function unitFamily(u){
  const k = _unitKey(u);
  if (!k) return 'okänd';
  if (Object.prototype.hasOwnProperty.call(UNIT_FACTORS.massa, k)) return 'massa';
  if (Object.prototype.hasOwnProperty.call(UNIT_FACTORS.volym, k)) return 'volym';
  if (UNIT_STYCK.indexOf(k) !== -1) return 'styck';
  return 'okänd';
}

function isContainerUnit(u){
  const k = _unitKey(u);
  return k !== 'st' && UNIT_STYCK.indexOf(k) !== -1;
}

function convertQty(value, fromUnit, toUnit){
  // Tom/null spärras explicit — Number('') är 0, inte NaN, och 0 vore fel svar.
  const raw = String(value == null ? '' : value).replace(',', '.').trim();
  if (raw === '') return null;
  const v = Number(raw);
  if (!isFinite(v)) return null;
  const fk = _unitKey(fromUnit), tk = _unitKey(toUnit);
  if (fk === tk) return null;
  const fam = unitFamily(fromUnit);
  if (fam !== 'massa' && fam !== 'volym') return null;
  if (unitFamily(toUnit) !== fam) return null;
  return Math.round(v * (UNIT_FACTORS[fam][fk] / UNIT_FACTORS[fam][tk]) * 1e6) / 1e6;
}

function formatQtySv(n){
  const v = Number(String(n == null ? '' : n).replace(',', '.'));
  if (!isFinite(v)) return String(n == null ? '' : n);
  const s = String(Math.round(v * 1e6) / 1e6);
  const neg = s.charAt(0) === '-';
  const parts = (neg ? s.slice(1) : s).split('.');
  const int = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '-' : '') + int + (parts[1] ? ',' + parts[1] : '');
}

function buildUnitOptionsHTML(unitList, currentUnit){
  const groups = { massa: [], volym: [], styck: [], 'okänd': [] };
  for (const u of unitList) groups[unitFamily(u)].push(u);
  const byFactor = fam => (a, b) => UNIT_FACTORS[fam][_unitKey(a)] - UNIT_FACTORS[fam][_unitKey(b)];
  const bySv = (a, b) => a.localeCompare(b, 'sv');
  groups.massa.sort(byFactor('massa'));
  groups.volym.sort(byFactor('volym'));
  groups.styck.sort(bySv);
  groups['okänd'].sort(bySv);
  const LABELS = { massa: 'Vikt', volym: 'Volym', styck: 'Styck och förpackningar', 'okänd': 'Övriga enheter' };
  const opt = u => `<option value="${esc(u)}"${u === currentUnit ? ' selected' : ''}>${esc(u)}</option>`;
  return ['massa', 'volym', 'styck', 'okänd']
    .filter(f => groups[f].length)
    .map(f => `<optgroup label="${LABELS[f]}">${groups[f].map(opt).join('')}</optgroup>`)
    .join('');
}
// ---- slut kopia ----

let pass = 0, fail = 0;
function eq(got, want, msg) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + ' (fick ' + g + ', ville ' + w + ')'); }
}

console.log('unitFamily — alla verkliga enheter ur Sheetet får en familj');
for (const u of ['g','gram','hg','kg']) eq(unitFamily(u), 'massa', u + ' → massa');
for (const u of ['ml','dl','liter']) eq(unitFamily(u), 'volym', u + ' → volym');
for (const u of ['st','rullar','förp','paket','påsar','säckar','askar','buntar','tuber','flaskor','flaska','burkar','set']) {
  eq(unitFamily(u), 'styck', u + ' → styck');
}
eq(unitFamily('Godislåda'), 'styck', 'Godislåda → styck (skiftlägesokänsligt)');
eq(unitFamily('KG'), 'massa', 'KG → massa (versaler)');
eq(unitFamily(' kg '), 'massa', 'kg med whitespace → massa');
eq(unitFamily('hinkar'), 'okänd', 'okänd enhet → okänd');
eq(unitFamily(''), 'okänd', 'tom sträng → okänd');
eq(unitFamily(null), 'okänd', 'null → okänd');

console.log('');
console.log('isContainerUnit — behållarenheter (lager 2 light)');
eq(isContainerUnit('förp'), true, 'förp är behållarenhet');
eq(isContainerUnit('paket'), true, 'paket är behållarenhet');
eq(isContainerUnit('Godislåda'), true, 'Godislåda är behållarenhet');
eq(isContainerUnit('st'), false, 'st är INTE behållarenhet');
eq(isContainerUnit('kg'), false, 'kg är INTE behållarenhet');
eq(isContainerUnit('hinkar'), false, 'okänd enhet är INTE behållarenhet');
eq(isContainerUnit(null), false, 'null är INTE behållarenhet');

console.log('');
console.log('convertQty — omräkning inom mätfamilj');
eq(convertQty(7.2, 'kg', 'g'), 7200, '7,2 kg → 7 200 g');
eq(convertQty(7200, 'g', 'kg'), 7.2, '7 200 g → 7,2 kg');
eq(convertQty(3, 'kg', 'gram'), 3000, 'alias: 3 kg → 3 000 gram');
eq(convertQty(5, 'hg', 'g'), 500, '5 hg → 500 g');
eq(convertQty(2, 'liter', 'ml'), 2000, 'alias: 2 liter → 2 000 ml');
eq(convertQty(1500, 'ml', 'l'), 1.5, '1 500 ml → 1,5 l');
eq(convertQty(3, 'dl', 'cl'), 30, '3 dl → 30 cl');
eq(convertQty(0.007, 'kg', 'g'), 7, 'flyttalsstädning: 0,007 kg → exakt 7 g');
eq(convertQty('7,2', 'kg', 'g'), 7200, 'decimalkomma-sträng accepteras');
eq(convertQty(1, 'kg', 'l'), null, 'familjebyte kg → l: null');
eq(convertQty(5, 'st', 'förp'), null, 'styck → styck: null (ingen faktor)');
eq(convertQty(5, 'kg', 'hinkar'), null, 'massa → okänd: null');
eq(convertQty(5, 'kg', 'kg'), null, 'samma enhet: null');
eq(convertQty(5, 'KG', 'Kg'), null, 'samma enhet olika skiftläge: null');
eq(convertQty('abc', 'kg', 'g'), null, 'icke-numeriskt: null');
eq(convertQty(null, 'kg', 'g'), null, 'null-värde: null');
eq(convertQty(2, 'liter', 'liter'), null, 'liter → liter: null');
eq(convertQty(1, 'liter', 'l'), 1, 'aliaser med samma faktor: 1 liter → 1 l');

console.log('');
console.log('formatQtySv — svensk sifferformatering');
eq(formatQtySv(7200), '7 200', '7200 → "7 200" (hårt mellanslag)');
eq(formatQtySv(7.2), '7,2', '7.2 → "7,2"');
eq(formatQtySv(1234567.89), '1 234 567,89', 'miljontal med decimaler');
eq(formatQtySv(0.5), '0,5', '0.5 → "0,5"');
eq(formatQtySv(42), '42', 'inga onödiga tecken för små heltal');
eq(formatQtySv('7,2'), '7,2', 'komma-sträng in → komma-sträng ut');
eq(formatQtySv('abc'), 'abc', 'icke-numeriskt returneras som det är');

console.log('');
console.log('buildUnitOptionsHTML — optgroup per familj');
const html = buildUnitOptionsHTML(['st','kg','g','liter','förp','hinkar','ml'], 'kg');
eq(/<optgroup label="Vikt"><option value="g">g<\/option><option value="kg" selected>kg<\/option><\/optgroup>/.test(html), true, 'Vikt-grupp: g före kg (faktorordning), kg selected');
eq(/<optgroup label="Volym"><option value="ml">ml<\/option><option value="liter">liter<\/option><\/optgroup>/.test(html), true, 'Volym-grupp: ml före liter');
eq(/<optgroup label="Styck och förpackningar">/.test(html), true, 'Styck-grupp finns');
eq(/<optgroup label="Övriga enheter"><option value="hinkar">hinkar<\/option><\/optgroup>/.test(html), true, 'Okänd enhet hamnar under Övriga');
eq(html.indexOf('Vikt') < html.indexOf('Volym') && html.indexOf('Volym') < html.indexOf('Styck'), true, 'fast gruppordning Vikt → Volym → Styck');
eq(buildUnitOptionsHTML([], ''), '', 'tom lista → tom sträng (inga tomma optgroups)');
eq(buildUnitOptionsHTML(['st'], ''), '<optgroup label="Styck och förpackningar"><option value="st">st</option></optgroup>', 'bara familjer med innehåll renderas');
const xss = buildUnitOptionsHTML(['<b>x</b>'], '');
eq(xss.indexOf('<b>') === -1, true, 'enhetsnamn HTML-escapas (XSS)');

console.log('');
console.log(pass + ' pass, ' + fail + ' fail');
if (fail) process.exit(1);
