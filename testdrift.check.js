#!/usr/bin/env node
/* testdrift.check.js — TESTDRIFTVAKT
 *
 * VARFÖR: de flesta testfilerna i qr-pwa/ laddar inte riktig kod via require.
 * De innehåller ORDAGRANNA KOPIOR av funktioner ur app.js eller
 * ../QR-aktuell/Code.js (ofta med kommentaren "KOPIERAD ORDAGRANT ... håll i
 * synk"). En ändring i produktionskoden kan därför aldrig göra ett test rött —
 * testet kör vidare på gårdagens kopia. Den här vakten jämför varje speglad
 * funktion mot originalet och larmar när de glidit isär.
 *
 * KÖRS SÅ HÄR:
 *     node testdrift.check.js            # rapport + exit 0/1
 *     node testdrift.check.js --verbose  # visar även normaliserad form
 *
 * Exit 0 = allt i synk. Exit 1 = minst en kopia har glidit.
 *
 * VAD SOM JÄMFÖRS: funktionsdeklarationer (`function namn(...) { ... }`) i en
 * *.test.js vars namn också finns som funktionsdeklaration i app.js eller
 * ../QR-aktuell/Code.js. Kroppar och parameterlistor jämförs NORMALISERAT:
 * kommentarer strippas och whitespace kollapsas. Strängar, mallsträngar,
 * reguljära uttryck och kommentarer hanteras av en gemensam scanner så att
 * varken klamrar eller "//" inuti en sträng förvirrar extraheringen.
 *
 * MEDVETEN HARNESS-ANPASSNING: en testkopia som avsiktligt avviker (t.ex. läser
 * ett fält i stället för att anropa SpreadsheetApp) kan tystas genom att skriva
 *
 *     // testdrift: medveten harness-anpassning
 *
 * på raden direkt före `function`-raden i TESTFILEN. Då rapporteras funktionen
 * som "undantagen" i stället för som drift. Använd sparsamt — undantaget döljer
 * ALL framtida drift i den funktionen.
 *
 * KÄNDA LUCKOR (medvetna, för att undvika falska larm):
 * - Kopierade DATATABELLER (t.ex. UNIT_FACTORS/UNIT_STYCK i units.test.js)
 *   jämförs inte via funktionsvägen, utan via const-vägen nedan.
 * - Pil-funktioner tilldelade till const/let jämförs inte: testfilerna använder
 *   dem nästan bara som lokala hjälpare inuti tester, och namnkrockar mot
 *   produktionskoden skulle ge falska larm.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const PROD_FILES = [
  path.join(DIR, 'app.js'),
  path.join(DIR, '..', 'QR-aktuell', 'Code.js'),
];
const MARKER = 'testdrift: medveten harness-anpassning';

/* ------------------------------------------------------------------ *
 * 1. Gemensam scanner: klassificerar varje tecken i källan.
 *    Returnerar en array av "maskar" (en per tecken) med värdena
 *    'code' | 'comment' | 'string' | 'regex'. Allt annat i verktyget
 *    bygger på den här masken, så klamrar och "//" inuti strängar
 *    aldrig kan förvirra vare sig kommentarstrippning eller
 *    klammermatchning.
 * ------------------------------------------------------------------ */
function scan(src) {
  const mask = new Array(src.length).fill('code');
  // Föregående betydelsebärande tecken avgör om "/" inleder en regex
  // eller är division. Efter t.ex. `= ( , : ; ! & | ? return` → regex.
  let prevSig = '';
  let prevWord = '';
  const REGEX_OK_AFTER = new Set([
    '', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-',
    '*', '%', '<', '>', '~', '^',
  ]);
  const REGEX_OK_WORDS = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
    'case', 'do', 'else', 'yield', 'await',
  ]);

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];

    // Radkommentar
    if (c === '/' && c2 === '/') {
      while (i < src.length && src[i] !== '\n') { mask[i] = 'comment'; i++; }
      continue;
    }
    // Blockkommentar
    if (c === '/' && c2 === '*') {
      mask[i] = mask[i + 1] = 'comment';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { mask[i] = 'comment'; i++; }
      if (i < src.length) { mask[i] = mask[i + 1] = 'comment'; i += 2; }
      continue;
    }
    // Sträng (', ", `)
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      mask[i] = 'string';
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { mask[i] = 'string'; mask[i + 1] = 'string'; i += 2; continue; }
        if (src[i] === quote) { mask[i] = 'string'; i++; break; }
        // Mallsträngens ${...} innehåller riktig kod — men för vårt syfte
        // (klammermatchning + jämförelse) räcker det att behandla hela
        // literalen som en enhet. Vi räknar därför inte klamrar där inne,
        // vilket är korrekt eftersom de alltid är balanserade.
        mask[i] = 'string';
        i++;
      }
      prevSig = quote; prevWord = '';
      continue;
    }
    // Reguljärt uttryck
    if (c === '/' && (REGEX_OK_AFTER.has(prevSig) || REGEX_OK_WORDS.has(prevWord))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '\n') break;              // regex kan inte spänna rader
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        j++;                                     // konsumera avslutande "/"
        while (j < src.length && /[a-z]/.test(src[j])) j++;   // flaggor
        for (let k = i; k < j; k++) mask[k] = 'regex';
        i = j;
        prevSig = '/'; prevWord = '';
        continue;
      }
      // Inte en regex trots allt → falla igenom som vanlig kod.
    }

    if (!/\s/.test(c)) {
      if (/[A-Za-z0-9_$]/.test(c)) {
        let j = i;
        while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
        prevWord = src.slice(i, j);
        prevSig = src[j - 1];
        for (let k = i; k < j; k++) mask[k] = 'code';
        i = j;
        continue;
      }
      prevSig = c;
      prevWord = '';
    }
    i++;
  }
  return mask;
}

/* ------------------------------------------------------------------ *
 * 2. Extrahera funktionsdeklarationer med klammermatchning.
 * ------------------------------------------------------------------ */
const FN_RE = /(^|[^A-Za-z0-9_$.])function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;

function extractFunctions(src, mask) {
  const out = new Map();
  FN_RE.lastIndex = 0;
  let m;
  while ((m = FN_RE.exec(src)) !== null) {
    const kwStart = m.index + m[1].length;
    if (mask[kwStart] !== 'code') continue;             // "function" inuti sträng/kommentar
    const name = m[2];
    const parenOpen = src.indexOf('(', kwStart);
    const parenClose = matchPair(src, mask, parenOpen, '(', ')');
    if (parenClose < 0) continue;
    // Hitta kroppens "{"
    let b = parenClose + 1;
    while (b < src.length && (mask[b] !== 'code' || /\s/.test(src[b]))) b++;
    if (src[b] !== '{') continue;
    const bodyEnd = matchPair(src, mask, b, '{', '}');
    if (bodyEnd < 0) continue;

    const params = src.slice(parenOpen, parenClose + 1);
    const body = src.slice(b, bodyEnd + 1);
    const rec = {
      name,
      start: kwStart,
      params,
      body,
      paramMask: mask.slice(parenOpen, parenClose + 1),
      bodyMask: mask.slice(b, bodyEnd + 1),
      line: src.slice(0, kwStart).split('\n').length,
    };
    // Vid namnkrock inom samma fil: behåll den första (ingen krock i praktiken).
    if (!out.has(name)) out.set(name, rec);
    FN_RE.lastIndex = bodyEnd;
  }
  return out;
}

function matchPair(src, mask, from, open, close) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (mask[i] !== 'code') continue;
    if (src[i] === open) depth++;
    else if (src[i] === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/* ------------------------------------------------------------------ *
 * 3. Toppnivå-const med objekt-/array-initierare (datatabeller).
 *    Bara column-0-deklarationer i BÅDA filerna, för att slippa
 *    lokala hjälpvariabler inuti tester.
 * ------------------------------------------------------------------ */
const CONST_RE = /^(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([[{])/gm;

function extractTables(src, mask) {
  const out = new Map();
  CONST_RE.lastIndex = 0;
  let m;
  while ((m = CONST_RE.exec(src)) !== null) {
    if (mask[m.index] !== 'code') continue;
    const name = m[1];
    const openIdx = m.index + m[0].length - 1;
    const open = m[2];
    const close = open === '[' ? ']' : '}';
    const end = matchPair(src, mask, openIdx, open, close);
    if (end < 0) continue;
    if (!out.has(name)) {
      out.set(name, {
        name,
        body: src.slice(openIdx, end + 1),
        bodyMask: mask.slice(openIdx, end + 1),
        params: '',
        paramMask: [],
        line: src.slice(0, m.index).split('\n').length,
      });
    }
    CONST_RE.lastIndex = end;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 4. Normalisering.
 *    MINIMAL med flit: kommentarer bort, whitespace kollapsad. Inget
 *    citatteckenbyte, ingen semikolonstrippning — varje extra regel är
 *    en ny buggkälla och kopiorna är ordagranna, så de behövs inte.
 *    Whitespace tas bort helt runt skiljetecken och kollapsas till ett
 *    mellanslag mellan två ord-tecken (så `a  +\n  b` == `a + b`).
 * ------------------------------------------------------------------ */
function stripComments(text, mask) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    // Kommentaren ersätts med ett mellanslag så att `a/*x*/b` inte blir `ab`.
    out += mask[i] === 'comment' ? (text[i] === '\n' ? '\n' : ' ') : text[i];
  }
  return out;
}

function canonical(text, mask) {
  const stripped = stripComments(text, mask);
  // Kollapsa whitespace utanför strängar/regexar.
  let out = '';
  let pendingSpace = false;
  for (let i = 0; i < stripped.length; i++) {
    const kind = mask[i];
    const ch = stripped[i];
    if ((kind === 'code' || kind === 'comment') && /\s/.test(ch)) { pendingSpace = true; continue; }
    if (pendingSpace) {
      const prev = out[out.length - 1] || '';
      // Mellanslag behövs bara mellan två ord-/tal-tecken (`return x`).
      if (/[A-Za-z0-9_$]/.test(prev) && /[A-Za-z0-9_$]/.test(ch)) out += ' ';
      pendingSpace = false;
    }
    out += ch;
  }
  return out.trim();
}

/** Rader utan kommentarer, trimmade — används bara för läsbar diff. */
function displayLines(text, mask) {
  return stripComments(text, mask)
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(l => l.length > 0);
}

/* ------------------------------------------------------------------ *
 * 5. Enkel LCS-diff för rapporten.
 * ------------------------------------------------------------------ */
function diffLines(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(['=', a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(['-', a[i]]); i++; }
    else { out.push(['+', b[j]]); j++; }
  }
  while (i < n) out.push(['-', a[i++]]);
  while (j < m) out.push(['+', b[j++]]);
  return out;
}

/** Visa bara ändrade rader plus lite kontext. */
function renderDiff(prodLines, testLines, indent = '      ') {
  const d = diffLines(prodLines, testLines);
  const keep = new Set();
  d.forEach((e, idx) => {
    if (e[0] !== '=') { for (let k = idx - 1; k <= idx + 1; k++) if (k >= 0 && k < d.length) keep.add(k); }
  });
  const rows = [];
  let skipped = false;
  d.forEach((e, idx) => {
    if (!keep.has(idx)) { skipped = true; return; }
    if (skipped) { rows.push(indent + '  ...'); skipped = false; }
    const sign = e[0] === '=' ? '  ' : (e[0] === '-' ? '- ' : '+ ');
    rows.push(indent + sign + e[1]);
  });
  return rows.join('\n');
}

/* ------------------------------------------------------------------ *
 * 6. Huvudflöde.
 * ------------------------------------------------------------------ */
function loadFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const mask = scan(src);
  return { src, mask, fns: extractFunctions(src, mask), tables: extractTables(src, mask) };
}

function hasMarker(src, startIdx) {
  // Leta efter markörkommentaren på raderna omedelbart före deklarationen.
  const before = src.slice(0, startIdx).split('\n');
  for (let k = before.length - 1; k >= 0 && k >= before.length - 3; k--) {
    const line = before[k].trim();
    if (line === '') continue;
    if (line.includes(MARKER)) return true;
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    break;
  }
  return false;
}

function main() {
  const verbose = process.argv.includes('--verbose');

  const prods = [];
  for (const f of PROD_FILES) {
    if (!fs.existsSync(f)) {
      console.error('SAKNAS: produktionsfilen ' + f + ' hittades inte.');
      process.exit(2);
    }
    prods.push({ file: f, label: path.relative(DIR, f), ...loadFile(f) });
  }

  const testFiles = fs.readdirSync(DIR).filter(f => f.endsWith('.test.js')).sort();
  if (!testFiles.length) { console.error('Inga *.test.js hittades i ' + DIR); process.exit(2); }

  const inSync = [];
  const drifted = [];
  const waived = [];
  const noMirror = [];

  for (const tf of testFiles) {
    const t = loadFile(path.join(DIR, tf));
    const usesRequire = /\brequire\s*\(/.test(stripComments(t.src, t.mask));
    const candidates = [...t.fns.values(), ...t.tables.values()];
    let mirrors = 0;

    for (const cand of candidates) {
      // Hitta originalet: samma namn i någon produktionsfil.
      let prodHit = null;
      for (const p of prods) {
        const hit = p.fns.get(cand.name) || p.tables.get(cand.name);
        if (hit) { prodHit = { p, hit }; break; }
      }
      if (!prodHit) continue;
      mirrors++;

      const prodCanon = canonical(prodHit.hit.params, prodHit.hit.paramMask) +
                        canonical(prodHit.hit.body, prodHit.hit.bodyMask);
      const testCanon = canonical(cand.params, cand.paramMask) +
                        canonical(cand.body, cand.bodyMask);

      const entry = {
        test: tf, name: cand.name,
        prodFile: prodHit.p.label, prodLine: prodHit.hit.line, testLine: cand.line,
      };

      if (prodCanon === testCanon) { inSync.push(entry); continue; }
      if (hasMarker(t.src, cand.start != null ? cand.start : 0)) { waived.push(entry); continue; }

      entry.diff = renderDiff(
        displayLines(prodHit.hit.params, prodHit.hit.paramMask).concat(displayLines(prodHit.hit.body, prodHit.hit.bodyMask)),
        displayLines(cand.params, cand.paramMask).concat(displayLines(cand.body, cand.bodyMask))
      );
      if (verbose) { entry.prodCanon = prodCanon; entry.testCanon = testCanon; }
      drifted.push(entry);
    }

    if (mirrors === 0) noMirror.push({ file: tf, usesRequire });
  }

  /* ---------- Rapport ---------- */
  const B = '='.repeat(72);
  console.log(B);
  console.log('TESTDRIFTVAKT — speglade funktioner i qr-pwa/*.test.js');
  console.log('Original: ' + prods.map(p => p.label).join(', '));
  console.log(B);

  console.log('\n▸ I SYNK (' + inSync.length + ')');
  if (!inSync.length) console.log('   (inga)');
  const bySyncFile = new Map();
  for (const e of inSync) {
    if (!bySyncFile.has(e.test)) bySyncFile.set(e.test, []);
    bySyncFile.get(e.test).push(e.name);
  }
  for (const [f, names] of bySyncFile) console.log('   ' + f + ': ' + names.join(', '));

  if (waived.length) {
    console.log('\n▸ UNDANTAGNA (medveten harness-anpassning) (' + waived.length + ')');
    for (const e of waived) console.log('   ' + e.test + ' :: ' + e.name + '()');
  }

  console.log('\n▸ DRIFTAT ISÄR (' + drifted.length + ')');
  if (!drifted.length) console.log('   (inga)');
  for (const e of drifted) {
    console.log('\n   ✗ ' + e.name + '()');
    console.log('     original: ' + e.prodFile + ':' + e.prodLine);
    console.log('     kopia:    ' + e.test + ':' + e.testLine);
    console.log('     diff ("-" = original, "+" = testkopia):');
    console.log(e.diff);
    if (verbose) {
      console.log('     [normaliserat original] ' + e.prodCanon);
      console.log('     [normaliserad kopia   ] ' + e.testCanon);
    }
  }

  console.log('\n▸ TESTFILER UTAN SPEGLADE FUNKTIONER (' + noMirror.length + ')');
  if (!noMirror.length) console.log('   (inga)');
  for (const f of noMirror) {
    console.log('   ' + f.file + (f.usesRequire
      ? '   (laddar riktig kod via require — ingen kopia att drifta)'
      : '   ⚠️  INGEN KOPIA HITTAD — betyder INTE att filen är säker, se nedan'));
  }
  // Vakten jämför bara funktioner som har SAMMA NAMN i test och produktion. En
  // testfil som modellerar produktionsbeteende under egna namn (dedupe.test.js
  // gör det: addTagDedupe, migrateDedupe, backendSyntheticKey) är helt osynlig
  // för vakten — trots att filens egen rubrik säger "kopierad ordagrant, håll i
  // synk". Att skriva "inga kopior hittade" utan denna reservation vore att
  // utfärda exakt det falska lugn verktyget finns för att avskaffa.
  if (noMirror.some(f => !f.usesRequire)) {
    console.log('');
    console.log('   ⚠️  BLIND FLÄCK: vakten ser bara kopior som HETER samma sak som originalet.');
    console.log('      Omdöpta eller parafraserade modeller av produktionskod jämförs ALDRIG,');
    console.log('      och inte heller pil-funktioner tilldelade const. Filerna ovan kan alltså');
    console.log('      innehålla drift som vakten inte kan se — läs deras egna rubriker.');
  }

  console.log('\n' + B);
  console.log('SUMMA: ' + inSync.length + ' i synk, ' + drifted.length + ' driftade, ' +
              waived.length + ' undantagna, ' + noMirror.length + ' filer utan speglar ' +
              '(' + testFiles.length + ' testfiler totalt).');
  console.log(B);

  process.exit(drifted.length ? 1 : 0);
}

// Körs som skript: rapport. Laddas med require (t.ex. identity.test.js): bara verktygen.
if (require.main === module) main();
module.exports = { loadFile, canonical };
