'use strict';
/* dupscan.test.js — A11 klientdelen, mot den FAKTISKA app.js (appvm.js) och den
 * FAKTISKA Code.js (riggen bakom fetch). Livefallet: "Stora kaffebryggaren" med
 * koden 0959773 på Kurslokal/Reception OCH Köksutrustning.
 *   (1) initData och preload-cachen skriver inte över på kod: två rader = två poster.
 *   (2) Skanning av en kod som sitter på flera rader väljer ingen tyst: inget sparas,
 *       sökrutan öppnas med en fråga om vilken artikel det gäller.
 *   (3) En skrivning till en av dubbletterna går till rätt rad och bär id/expectedName.
 * Kör: node dupscan.test.js
 */
const path = require('path');
const { loadApp } = require('./appvm');
const { makeRig, HEADERS, COL, row } = require(path.join(__dirname, '..', 'QR-aktuell', 'test', 'gas-rig'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const A = 'Kurslokal/Reception', B = 'Köksutrustning', NAME = 'Stora kaffebryggaren';

function mkRig() {
  const rig = makeRig();
  rig.addSheet(A, HEADERS, [row(NAME, 1, '0959773|')]);
  rig.addSheet(B, HEADERS, [row('Visp', 3, '1110001|'), row(NAME, 1, '0959773|')]);
  return rig;
}
async function ready(a) {
  for (let i = 0; i < 200 && !a.run('preloadDone'); i++) await a.settle(10);
}
function start(rig, ls) {
  const a = loadApp({ rig, ls });
  a.run('userName = "Testare"');
  // Stubbe-DOM: ingen dialog är öppen (annars avbryter onScanResult direkt).
  a.run(`(() => { const q = document.querySelector, g = document.getElementById;
    document.querySelector = s => s === '.dialog:not(.hidden)' ? null : q(s);
    document.getElementById = s => s === 'installOverlay' ? null : g(s); })()`);
  return a;
}
const entries = a => JSON.parse(a.run(`JSON.stringify([...tagCache.entries()].filter(([k, v]) => v.name === ${JSON.stringify(NAME)}).map(([k, v]) => ({ k, sheetName: v.sheetName, rowNum: v.rowNum })))`));
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

(async () => {
  console.log('A11 klient: (1) båda dubbletterna syns');
  const rig = mkRig();
  const a = start(rig);
  await ready(a);
  const e1 = entries(a);
  ok(e1.length === 2, `färsk lista: ${NAME} finns som ${e1.length} post(er) ${JSON.stringify(e1)}`);
  ok(e1.some(e => e.sheetName === A && e.rowNum == 2) && e1.some(e => e.sheetName === B && e.rowNum == 3),
    'båda raderna (Kurslokal/Reception rad 2, Köksutrustning rad 3) har egna poster');

  const ls = Object.fromEntries(a.ls);
  const c = start(rig, ls);
  c.fetchMode = 'hang';            // bara preload-cachen i localStorage räknas
  await ready(c);
  ok(entries(c).length === 2, `från preload-cachen: ${NAME} finns som ${entries(c).length} post(er)`);
  c.stop();

  console.log('A11 klient: (2) skanning av en kod på två rader väljer ingen tyst');
  for (const code of ['0959773', '959773']) {
    const before = a.calls.length;
    await scan(a, code);
    const sent = a.calls.slice(before).filter(x => x.fn === 'logTag' || x.fn === 'batch' || x.fn === 'updateCount');
    const title = String(a.run("searchDialog.querySelector('h2').textContent"));
    ok(sent.length === 0, `skanning ${code}: inget sparas (${sent.length} skrivanrop)`);
    ok(/Välj/.test(title) && title.includes(A) && title.includes(B), `skanning ${code}: sökrutan frågar vilken artikel: "${title}"`);
    a.run('closeSearchDialog()');
  }
  ok(rig.cell(A, 2, COL['användare']) === '' && rig.cell(B, 3, COL['användare']) === '', 'ingen av raderna fick en registrering');

  console.log('A11 klient: (3) skrivning till en av dubbletterna går till rätt rad');
  const kB = entries(a).find(e => e.sheetName === B && e.rowNum == 3);
  const before = a.calls.length;
  a.run(`openContainerForTag(${JSON.stringify(kB && kB.k)}); qs('#confirmSingle').onclick()`);
  await drain(a);
  const call = a.calls.slice(before).find(x => x.fn === 'logTag');
  ok(!!call && call.sheetName === B && Number(call.rowNum) === 3 && call.expectedName === NAME,
    'registreringen bär flik, rad och förväntat namn: ' + JSON.stringify(call && { tag: call.tag, sheetName: call.sheetName, rowNum: call.rowNum, expectedName: call.expectedName }));
  ok(rig.cell(B, 3, COL['användare']) === 'Testare' && rig.cell(A, 2, COL['användare']) === '',
    `bara Köksutrustning rad 3 registrerades (A="${rig.cell(A, 2, COL['användare'])}", B="${rig.cell(B, 3, COL['användare'])}")`);
  ok(rig.findByTag('0959773').length === 2, 'ingen ny rad skapades');
  a.stop();

  console.log(`\n${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
