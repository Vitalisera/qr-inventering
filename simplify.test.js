/* node simplify.test.js — verifierar simplifyOffName mot OpenFoodFacts-typiska namn */

function simplifyOffName(name) {
  if (!name) return '';
  const original = String(name).trim();
  let s = original
    .replace(/\b\d+([.,]\d+)?\s?(cl|ml|dl|l|g|kg|st|x|pcs|tabletter|bites|pack)\b/gi, '')
    .replace(/\b(plåtburk|burk|pant|påse|flaska|låda|paket|tub|spray|pack|kartong|tetra|återvinning|original|taste|flavour|flavor)\b/gi, '')
    .replace(/[,;(].*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const words = s.split(' ').filter(Boolean);
  const trimmed = words.slice(0, 4).join(' ').trim();
  return trimmed || original;
}

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n     ', e.message); fail++; }
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'eq'}: '${actual}' !== '${expected}'`);
}

console.log('simplifyOffName');

t('Coca-Cola Original Taste 33cl burk pant → Coca-Cola', () =>
  eq(simplifyOffName('Coca-Cola Original Taste 33cl burk pant'), 'Coca-Cola'));

t('Marabou Mjölkchoklad 200g → Marabou Mjölkchoklad', () =>
  eq(simplifyOffName('Marabou Mjölkchoklad 200g'), 'Marabou Mjölkchoklad'));

t('Nutella, hazelnut spread 750g → Nutella', () =>
  eq(simplifyOffName('Nutella, hazelnut spread 750g'), 'Nutella'));

t('Fanta Lemon 33cl plåtburk → Fanta Lemon', () =>
  eq(simplifyOffName('Fanta Lemon 33cl plåtburk'), 'Fanta Lemon'));

t('Långt namn klipps till 4 ord', () =>
  eq(simplifyOffName('Felix Ketchup utan tillsatt socker svensktillverkad'), 'Felix Ketchup utan tillsatt'));

t('Ingen metadata - oförändrat (max 4 ord)', () =>
  eq(simplifyOffName('Pasta'), 'Pasta'));

t('Bara enheter - fall tillbaka på original', () =>
  eq(simplifyOffName('33cl burk'), '33cl burk'));

t('null → tom sträng', () => eq(simplifyOffName(null), ''));
t('undefined → tom sträng', () => eq(simplifyOffName(undefined), ''));
t('tom sträng → tom sträng', () => eq(simplifyOffName(''), ''));

t('Med förpackningstyp och mängd: Rödbetor 250g burk → Rödbetor', () =>
  eq(simplifyOffName('Rödbetor 250g burk'), 'Rödbetor'));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
