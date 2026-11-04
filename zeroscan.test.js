'use strict';
/* zeroscan.test.js — A14: ledande nollor i streckkoder, mot den FAKTISKA app.js
 * (appvm.js) och den FAKTISKA Code.js (riggen bakom fetch).
 *   (1) 123→A och 00123→B: skanning av 000123 väljer ingen tyst. Inget sparas,
 *       sökrutan frågar vilken artikel det gäller (samma val som A11).
 *   (2) 123→A och 00123→B: skanning av 123 är en exakt träff och registrerar A.
 *   (3) Bara 00123 finns: skanning av 123 hittar den (ingen "okänd kod").
 *   (4) Bara 123 finns: skanning av 00123 hittar den.
 *   (5) Samma fall med koden som EXTRA tagg (altTags), inte huvudkod.
 *   (S) Servern: uppslaget 'lookup' ger samma svar för (1)–(4).
 * Bevis = vilken rad i riggens ark som fick registreringen, inte ok-svaret.
 * Kör: node zeroscan.test.js            (båda backendarna: 2655c04 = live @126, och HEAD)
 *      GAS_CODE_PATH=<fil> node zeroscan.test.js   (bara den backend)
 */
const path = require('path');
const fs = require('fs');

if (!process.env.GAS_CODE_PATH) {
  const { execFileSync, spawnSync } = require('child_process');
  const os = require('os');
  const qa = path.join(__dirname, '..', 'QR-aktuell');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroscan-'));
  const at = rev => { const f = path.join(dir, `Code.${rev}.js`); fs.writeFileSync(f, execFileSync('git', ['-C', qa, 'show', `${rev}:Code.js`])); return f; };
  const head = execFileSync('git', ['-C', qa, 'rev-parse', '--short', 'HEAD']).toString().trim();
  let bad = 0;
  for (const [label, file] of [['live @126 (2655c04)', at('2655c04')], [`HEAD (${head})`, at('HEAD')]]) {
    console.log(`\n=== Backend: ${label} ===`);
    const r = spawnSync(process.execPath, [__filename], { env: { ...process.env, GAS_CODE_PATH: file }, stdio: 'inherit' });
    if (r.status !== 0) bad++;
  }
  console.log(bad ? `\n${bad} backend(ar) FAIL` : '\nBåda backendarna: 0 FAIL');
  process.exit(bad ? 1 : 0);
}
// Serverdelen (S) märks per backend utifrån vad koden faktiskt gör, som i dupscan:
// en backend vars _matchTagInScanned_ bara jämför nollstrippat när den SÖKTA koden
// har nollor (live 2655c04) är asymmetrisk → fall (3) är en känd lucka där, inte FAIL.
const BACKEND_SRC = fs.readFileSync(process.env.GAS_CODE_PATH, 'utf8');
const SERVER_HAS_A14 = !/if \(wantedNum !== wanted\)/.test((BACKEND_SRC.match(/function _matchTagInScanned_[\s\S]*?\n}\n/) || [''])[0]);
const { loadApp } = require('./appvm');
const { makeRig, HEADERS, COL, row } = require(path.join(__dirname, '..', 'QR-aktuell', 'test', 'gas-rig'));

let pass = 0, fail = 0, known = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const S1 = 'Kurslokal/Reception', S2 = 'Köksutrustning';
const US = COL['användare'];

function mkRig(rows1, rows2) {
  const rig = makeRig();
  rig.addSheet(S1, HEADERS, rows1);
  rig.addSheet(S2, HEADERS, rows2);
  return rig;
}
async function ready(a) { for (let i = 0; i < 200 && !a.run('preloadDone'); i++) await a.settle(10); }
function start(rig) {
  const a = loadApp({ rig });
  a.run('userName = "Testare"');
  a.run(`(() => { const q = document.querySelector, g = document.getElementById;
    document.querySelector = s => s === '.dialog:not(.hidden)' ? null : q(s);
    document.getElementById = s => s === 'installOverlay' ? null : g(s); })()`);
  a.run(`globalThis.__linkDlg = []; const _sl = showLinkTagDialog; showLinkTagDialog = (t, ...r) => { __linkDlg.push(t); };`);
  return a;
}
async function scan(a, code) {
  a.run('lastCode = null; busy = false');
  const p = a.run(`onScanResult({ text: '${code}', resultPoints: [], getBarcodeFormat: () => 'QR_CODE' })`);
  await a.settle(1000);
  try { await p; } catch (_) {}
}
async function drain(a, rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await a.settle(5);
    const f = a.run('flushInFlight');
    if (f) { try { await f; } catch (_) {} }
  }
  await a.settle(5);
}
const writes = (a, from) => a.calls.slice(from).filter(x => x.fn === 'logTag' || x.fn === 'batch' || x.fn === 'updateCount' || x.fn === 'updateMeta');
const who = (rig, sh, r) => String(rig.cell(sh, r, US) || '');

// Kör en skanning i en färsk app mot ett färskt ark och returnerar vad som hände.
async function scenario(rows1, rows2, code) {
  const rig = mkRig(rows1, rows2);
  const a = start(rig);
  await ready(a);
  const before = a.calls.length;
  await scan(a, code);
  await drain(a);
  const out = {
    rig,
    sent: writes(a, before),
    title: String(a.run("searchDialog.querySelector('h2').textContent")),
    linkDlg: JSON.parse(a.run('JSON.stringify(__linkDlg)')),
  };
  a.stop();
  return out;
}

(async () => {
  console.log('A14 (1) 123→A, 00123→B: skanning 000123 väljer ingen tyst');
  {
    const r = await scenario([row('Artikel A', 1, '123|')], [row('Artikel B', 1, '00123|')], '000123');
    ok(r.sent.length === 0, `inget sparas (${r.sent.length} skrivanrop ${JSON.stringify(r.sent.map(x => ({ fn: x.fn, tag: x.tag })))})`);
    ok(who(r.rig, S1, 2) === '' && who(r.rig, S2, 2) === '', `ingen rad registrerad (A="${who(r.rig, S1, 2)}", B="${who(r.rig, S2, 2)}")`);
    ok(/Välj/.test(r.title) && r.title.includes('Artikel A') && r.title.includes('Artikel B'), `sökrutan frågar vilken artikel: "${r.title}"`);
  }

  console.log('A14 (2) 123→A, 00123→B: skanning 123 = exakt träff A');
  {
    const r = await scenario([row('Artikel A', 1, '123|')], [row('Artikel B', 1, '00123|')], '123');
    ok(who(r.rig, S1, 2) === 'Testare' && who(r.rig, S2, 2) === '', `bara A registrerades (A="${who(r.rig, S1, 2)}", B="${who(r.rig, S2, 2)}")`);
    ok(!/Välj/.test(r.title), `ingen valfråga vid exakt träff ("${r.title}")`);
    const c = r.sent.find(x => x.fn === 'logTag');
    ok(!!c && c.tag === '123', `skrivningen bär den skannade koden 123 (tag=${c && c.tag})`);
  }
  {
    const r = await scenario([row('Artikel A', 1, '123|')], [row('Artikel B', 1, '00123|')], '00123');
    ok(who(r.rig, S2, 2) === 'Testare' && who(r.rig, S1, 2) === '', `spegelfallet: skanning 00123 = exakt träff B (A="${who(r.rig, S1, 2)}", B="${who(r.rig, S2, 2)}")`);
  }

  console.log('A14 (3) bara 00123 finns: skanning 123 hittar den');
  {
    const r = await scenario([row('Artikel B', 1, '00123|')], [row('Annat', 1, '999|')], '123');
    ok(r.linkDlg.length === 0, `ingen "okänd kod"-dialog (${JSON.stringify(r.linkDlg)})`);
    ok(who(r.rig, S1, 2) === 'Testare', `B registrerades ("${who(r.rig, S1, 2)}")`);
    ok(r.sent.some(x => x.fn === 'logTag' && x.sheetName === S1 && Number(x.rowNum) === 2) && r.sent.every(x => x.fn !== 'logTag' || x.sheetName === S1),
      'skrivningen går till B:s rad: ' + JSON.stringify(r.sent.map(x => ({ fn: x.fn, tag: x.tag, sheetName: x.sheetName, rowNum: x.rowNum }))));
  }

  console.log('A14 (4) bara 123 finns: skanning 00123 hittar den');
  {
    const r = await scenario([row('Artikel A', 1, '123|')], [row('Annat', 1, '999|')], '00123');
    ok(r.linkDlg.length === 0, `ingen "okänd kod"-dialog (${JSON.stringify(r.linkDlg)})`);
    ok(who(r.rig, S1, 2) === 'Testare', `A registrerades ("${who(r.rig, S1, 2)}")`);
  }

  console.log('A14 (5) samma regler för extra taggar (altTags)');
  {
    const r = await scenario([row('Artikel A', 1, '555|123|')], [row('Artikel B', 1, '00123|')], '000123');
    ok(r.sent.length === 0 && who(r.rig, S1, 2) === '' && who(r.rig, S2, 2) === '' && /Välj/.test(r.title),
      `extra tagg 123 + huvudkod 00123, skanning 000123: inget sparas, valfråga ("${r.title}", ${r.sent.length} skrivanrop)`);
  }
  {
    const r = await scenario([row('Artikel A', 1, '555|123|')], [row('Artikel B', 1, '00123|')], '123');
    ok(who(r.rig, S1, 2) === 'Testare' && who(r.rig, S2, 2) === '', `extra tagg 123 exakt: A registrerades (A="${who(r.rig, S1, 2)}", B="${who(r.rig, S2, 2)}")`);
  }
  {
    const r = await scenario([row('Artikel A', 1, '555|00123|')], [row('Annat', 1, '999|')], '123');
    ok(r.linkDlg.length === 0 && who(r.rig, S1, 2) === 'Testare', `bara extra tagg 00123, skanning 123: A hittas (${JSON.stringify(r.linkDlg)}, A="${who(r.rig, S1, 2)}")`);
  }

  console.log(`A14 (S) servern: uppslaget lookup (${SERVER_HAS_A14 ? 'backend med A14' : 'backend UTAN A14'})`);
  {
    const name = res => { const it = res && (res.item || res.result || res); return it && it.name ? it.name : null; };
    const sOk = (c, m) => {
      if (c || SERVER_HAS_A14) return ok(c, m);
      known++; console.log('  KÄND LUCKA (backend utan A14) ' + m);
    };
    const both = () => mkRig([row('Artikel A', 1, '123|')], [row('Artikel B', 1, '00123|')]);
    let rig = both();
    const l1 = rig.api('lookup', { tag: '000123' });
    sOk(name(l1) === null, `(1) lookup 000123 med 123 och 00123: ingen gissning (${JSON.stringify(name(l1))})`);
    const l2 = rig.api('lookup', { tag: '123' });
    sOk(name(l2) === 'Artikel A', `(2) lookup 123: exakt A (${JSON.stringify(name(l2))})`);
    const l2b = rig.api('lookup', { tag: '00123' });
    sOk(name(l2b) === 'Artikel B', `(2b) lookup 00123: exakt B (${JSON.stringify(name(l2b))})`);
    rig = mkRig([row('Artikel B', 1, '00123|')], [row('Annat', 1, '999|')]);
    const l3 = rig.api('lookup', { tag: '123' });
    sOk(name(l3) === 'Artikel B', `(3) lookup 123 när bara 00123 finns: hittar B (${JSON.stringify(name(l3))})`);
    rig = mkRig([row('Artikel A', 1, '123|')], [row('Annat', 1, '999|')]);
    const l4 = rig.api('lookup', { tag: '00123' });
    sOk(name(l4) === 'Artikel A', `(4) lookup 00123 när bara 123 finns: hittar A (${JSON.stringify(name(l4))})`);
  }

  console.log(`\nzeroscan: ${pass} PASS, ${fail} FAIL${known ? `, ${known} KÄND LUCKA` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
