'use strict';
/* statusmodel.test.js — A12: en artikels synkstatus (gul = ej sparad) ska spegla
 * ALLA dess operationer, inte det senast behandlade svaret. Mot den FAKTISKA
 * app.js (appvm.js) och den FAKTISKA Code.js (riggen bakom fetch).
 *   (a) Saldo och kommentar på samma artikel i samma batch, servern nekar det ena:
 *       artikeln får inte se färdigsparad ut, oavsett ordning.
 *   (b) Ett svar på en äldre batch medan ett nyare jobb för artikeln väntar i kön:
 *       artikeln får inte se färdigsparad ut förrän även det nyare är bekräftat.
 *   (c) Kontroll: allt lyckas → artikeln blir sparad.
 * Kör: node statusmodel.test.js
 */
const path = require('path');
const { loadApp } = require('./appvm');
const { makeRig, HEADERS, COL, row } = require(path.join(__dirname, '..', 'QR-aktuell', 'test', 'gas-rig'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const S = 'Lager', T = '7310001';

function mkRig() {
  const rig = makeRig();
  rig.addSheet(S, HEADERS, [row('Kratta', 5, T), row('Spade', 2, '7310002')]);
  return rig;
}
async function ready(a) { for (let i = 0; i < 200 && !a.run('preloadDone'); i++) await a.settle(10); }
async function drain(a, rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await a.settle(5);
    const f = a.run('flushInFlight');
    if (f) { try { await f; } catch (_) {} }
  }
  await a.settle(5);
}
// Som callsiterna: optimistisk lokal ändring (gul) och sedan köjobbet.
const count = (n, r) => `tagCache.set('${T}', { ...tagCache.get('${T}'), pendingSync: true });
  queueUpdate('updateCount', { tag: '${T}', newCount: ${n}, userName, sheetName: '${S}', rowNum: ${r}, expectedName: 'Kratta' })`;
// rowNum 3 = Spades rad: servern nekar (STALE_ROW, koden sitter inte där).
const meta = (c, r) => `tagCache.set('${T}', { ...tagCache.get('${T}'), pendingSync: true });
  queueUpdate('updateMeta', { tag: '${T}', comment: '${c}', sheetName: '${S}', rowNum: ${r}, expectedName: 'Kratta' })`;
const pending = a => !!a.run(`tagCache.get('${T}').pendingSync`);
const flush = a => a.run('clearTimeout(updateTimer); updateTimer = null; flushUpdates()');

(async () => {
  for (const [label, first, second] of [
    ['kommentar nekas, saldo lyckas', meta('x', 3), count(4, 2)],
    ['saldo lyckas, kommentar nekas', count(4, 2), meta('x', 3)],
  ]) {
    console.log(`A12 (a) samma batch: ${label}`);
    const rig = mkRig();
    const a = loadApp({ rig }); a.run('userName = "Testare"');
    await ready(a);
    a.run(first); a.run(second);
    flush(a); await drain(a);
    ok(rig.cell(S, 2, COL.QTY) === 4 && rig.cell(S, 2, COL.COMMENT) === '' && rig.cell(S, 3, COL.COMMENT) === '',
      `servern: saldot sparades, kommentaren nekades (saldo ${rig.cell(S, 2, COL.QTY)}, kommentar "${rig.cell(S, 2, COL.COMMENT)}")`);
    ok(pending(a), 'artikeln ser INTE färdigsparad ut (en ändring gick förlorad)');
    a.stop();
  }

  console.log('A12 (b) äldre svar medan ett nyare jobb väntar');
  {
    const rig = mkRig();
    const a = loadApp({ rig }); a.run('userName = "Testare"');
    await ready(a);
    a.fetchMode = 'hang';
    a.run(count(1, 2)); flush(a); await a.settle(5);
    a.run(count(2, 2));                               // nyare jobb, ligger i kön
    a.run('clearTimeout(updateTimer); updateTimer = null');
    a.fetchMode = 'rig';
    a.releaseHung(); await a.settle(20);
    const f = a.run('flushInFlight'); if (f) { try { await f; } catch (_) {} }
    ok(a.run('updateQueue.length') === 1, 'det nyare jobbet väntar fortfarande i kön');
    ok(pending(a), 'artikeln ser INTE färdigsparad ut medan det nyare jobbet väntar');
    flush(a); await drain(a);
    ok(rig.cell(S, 2, COL.QTY) === 2 && !pending(a), `när även det nyare är bekräftat: sparad (saldo ${rig.cell(S, 2, COL.QTY)})`);
    a.stop();
  }

  console.log('A12 (c) kontroll: allt lyckas');
  {
    const rig = mkRig();
    const a = loadApp({ rig }); a.run('userName = "Testare"');
    await ready(a);
    a.run(meta('ok', 2)); a.run(count(3, 2));
    flush(a); await drain(a);
    ok(rig.cell(S, 2, COL.COMMENT) === 'ok' && rig.cell(S, 2, COL.QTY) === 3 && !pending(a), 'båda sparade och artikeln är inte längre gul');
    a.stop();
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
