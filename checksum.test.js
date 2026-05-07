/* node checksum.test.js — verifierar EAN/UPC checksum-funktionerna mot
   Roberts faktiska feldekodningar och kända giltiga koder. */

// Kopierat från app.js — håll i synk.
function isValidEAN13(code) {
  if (!/^\d{13}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(code[i]) * (i % 2 === 0 ? 1 : 3);
  return ((10 - (sum % 10)) % 10) === Number(code[12]);
}
function isValidUPCA(code) {
  if (!/^\d{12}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += Number(code[i]) * (i % 2 === 0 ? 3 : 1);
  return ((10 - (sum % 10)) % 10) === Number(code[11]);
}
function isValidEAN8(code) {
  if (!/^\d{8}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(code[i]) * (i % 2 === 0 ? 3 : 1);
  return ((10 - (sum % 10)) % 10) === Number(code[7]);
}

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n     ', e.message); fail++; }
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'eq'}: ${actual} !== ${expected}`);
}

console.log('checksum-validering');

// EAN-13 — Roberts exempel. OBSERVATION: min testning visar att Roberts
// "fel checksum"-påstående var fel — alla tre felläsningar passerar
// EAN-13/UPC-A checksum matematiskt. zxing validerade redan, så fel-
// läsningarna är rena bitmönsterkollisioner med ANDRA giltiga koder.
t('Korrekt EAN-13: 5704420047236', () => eq(isValidEAN13('5704420047236'), true));
t('Roberts felläsning 1: 2764120047236 ÄR matematiskt giltig (zxing-validerad)', () => eq(isValidEAN13('2764120047236'), true));
t('Roberts felläsning 3: 3052748011401 ÄR matematiskt giltig (zxing-validerad)', () => eq(isValidEAN13('3052748011401'), true));
t('Roberts felläsning 2: 787428047236 ej EAN-13 (12 siffror)', () => eq(isValidEAN13('787428047236'), false));
t('Roberts felläsning 2: 787428047236 ÄR giltig UPC-A — checksum hjälper INTE här', () => eq(isValidUPCA('787428047236'), true));

// EAN-13 — kända giltiga koder
t('EAN-13: 4006381333931 (Faber-Castell)', () => eq(isValidEAN13('4006381333931'), true));
t('UPC-A: 036000291452 (känt giltigt)', () => eq(isValidUPCA('036000291452'), true));
t('UPC-A: 036000291453 (fel checksum)', () => eq(isValidUPCA('036000291453'), false));

// EAN-8 — kända giltiga
t('EAN-8: 73513537 (känt giltigt)', () => eq(isValidEAN8('73513537'), true));
t('EAN-8: 73513538 (fel checksum)', () => eq(isValidEAN8('73513538'), false));

// Felfall
t('null → false', () => eq(isValidEAN13(null), false));
t('undefined → false', () => eq(isValidEAN13(undefined), false));
t('icke-siffror → false', () => eq(isValidEAN13('abcdefghijklm'), false));
t('för kort → false', () => eq(isValidEAN13('123'), false));
t('för lång → false', () => eq(isValidEAN13('12345678901234'), false));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
