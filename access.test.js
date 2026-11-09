'use strict';
/* access.test.js — A01: åtkomstfrågan mot den FAKTISKA app.js (appvm.js) och den
 * FAKTISKA Code.js (riggen bakom fetch) med grinden spärrad.
 *
 *   Del 1: v163 (git show 1412909:app.js). Servern svarar UNAUTHORIZED med
 *          transient:true. Visar att jobbet behålls och att återförsöken har en
 *          växande väntetid och slutar vid taket. v163 ändras inte.
 *   Del 2: den här versionen (v164). UNAUTHORIZED pausar synken tills man svarat
 *          rätt. Ett anrop per väg medan frågan står öppen, inga räknade försök,
 *          en enda dialog, och efter rätt svar når allt arket.
 *
 * Kör: node access.test.js
 * Rött mot gammalt: APP_UNDER_TEST=<sökväg till v163:s app.js> node access.test.js
 *   kör del 2 mot den filen (del 1 hoppas då över) och ska ge FAIL.
 * Svaren här är påhittade testsvar. Inget riktigt svar finns i koden.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadApp } = require('./appvm');
const { makeRig, HEADERS, COL, row } = require(path.join(__dirname, '..', 'QR-aktuell', 'test', 'gas-rig'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const S = 'Lager';
const QKEY = 'vitaliseraUpdateQueue', PKEY = 'vitaliseraPendingSync', TKEY = 'vitaliseraAccessToken';
const SVAR = 'testsvar-123';
const BACKOFF = [2000, 5000, 15000, 30000, 60000];
const SCALE = 0.001;   // 60 s backoff tar 60 ms i provet

function mkRig() {
  const rig = makeRig();
  rig.addSheet(S, HEADERS, [row('Kratta', 5, '7310001'), row('Spade', 2, '7310002'), row('Hink', 0, '7310003')]);
  rig.props.set('ACCESS_ANSWER_NEW', SVAR);   // grinden spärras vid första anropet
  return rig;
}
function start(rig, appPath) {
  const a = loadApp({ rig, appPath, timeScale: SCALE, ls: { vitaliseraUser: 'Testare', vitaliseraExpiry: String(Date.now() + 864e5) } });
  a.run('userName = "Testare"');
  // DOM-stubben: dialogernas synlighet följs här. Namnfrågan är stängd.
  const opened = { n: 0 };
  a.run('document.querySelector("#nameDialog")').classList.contains = k => k === 'hidden';
  const dc = a.run('document.querySelector("#accessDialog")').classList;
  dc.remove = () => { opened.n++; };
  a.opened = opened;
  return a;
}
const qty = (rig, r) => rig.cell(S, r, COL.QTY);
const callsOf = (a, fn) => a.calls.filter(c => c.fn === fn).length;
const queued = a => [...(a.persisted(QKEY) || [])];
async function settle(a, ms) { await a.settle(ms); }

async function partV163(appPath) {
  console.log('Del 1: v163 mot spärrad grind (UNAUTHORIZED, transient:true)');
  {
    const rig = mkRig();
    const a = start(rig, appPath);
    a.run(`queueUpdate('updateCount', { tag: '7310001', newCount: 9, userName: 'Testare', sheetName: '${S}', rowNum: 2, expectedName: 'Kratta' })`);
    a.run('clearTimeout(updateTimer); updateTimer = null; flushUpdates()');
    await settle(a, 400);   // 400 ms = 400 s i appens tid, långt efter sista backoff
    const nBatch = callsOf(a, 'batch');
    const backoff = a.delays.filter(d => d.fn === 'flushUpdates' && BACKOFF.includes(d.ms)).map(d => d.ms);
    ok(nBatch === 5, 'batchen skickas 5 gånger och sedan inte mer (' + nBatch + ')');
    ok(JSON.stringify(backoff) === JSON.stringify([2000, 5000, 15000, 30000]),
      'väntetiden mellan försöken växer: ' + backoff.join(', ') + ' ms');
    const q = queued(a);
    ok(q.length === 1 && q[0].args.tag === '7310001' && q[0].retries === 5,
      'jobbet ligger kvar på disk efter 5 försök (retries ' + (q[0] && q[0].retries) + ')');
    ok(a.run('updateQueue.length === 1 && updateQueue[0]._parked === true'), 'och är parkerat i minnet (väntar på nästa ändring eller omstart)');
    await settle(a, 300);
    ok(callsOf(a, 'batch') === 5, 'parkerat jobb skickas inte igen av sig självt (inget tätt loopande)');
    ok(qty(rig, 2) === 5, 'arket orört (saldo ' + qty(rig, 2) + ')');
    a.stop();
  }
  {
    const rig = mkRig();
    const a = start(rig, appPath);
    a.run(`Save.logSingle('7310003', { name: 'Hink', sheetName: '${S}', rowNum: 4, expectedName: 'Hink' })`);
    await settle(a, 200);
    const n = callsOf(a, 'logTag');
    const waits = a.delays.filter(d => [800, 2000, 5000].includes(d.ms) && d.fn !== 'flushUpdates').map(d => d.ms);
    ok(n === 4, 'singelskanning: 4 försök (1 + 3 återförsök) och sedan stopp (' + n + ')');
    ok(waits.slice(0, 3).join(',') === '800,2000,5000', 'återförsöken väntar 800, 2000, 5000 ms (' + waits.join(', ') + ')');
    const p = a.persisted(PKEY) || {};
    ok((p.logSingle || []).some(j => j.tag === '7310003'), 'skanningen ligger kvar i kön på disk');
    a.stop();
  }
}

async function partV164(appPath) {
  console.log('Del 2: ' + (appPath ? appPath : 'v164') + ' mot spärrad grind');
  const rig = mkRig();
  const a = start(rig, appPath);
  a.run(`queueUpdate('updateCount', { tag: '7310001', newCount: 9, userName: 'Testare', sheetName: '${S}', rowNum: 2, expectedName: 'Kratta' })`);
  a.run('clearTimeout(updateTimer); updateTimer = null; flushUpdates()');
  a.run(`Save.logSingle('7310003', { name: 'Hink', sheetName: '${S}', rowNum: 4, expectedName: 'Hink' })`);
  await settle(a, 400);   // 400 s i appens tid
  ok(callsOf(a, 'batch') === 1, 'batch: ett anrop, sedan väntar den på inloggning (' + callsOf(a, 'batch') + ')');
  ok(callsOf(a, 'logTag') === 1, 'singelskanning: ett anrop, sedan väntar den (' + callsOf(a, 'logTag') + ')');
  ok(a.opened.n === 1, 'en enda dialog trots två nekade anrop (' + a.opened.n + ')');
  const before = a.calls.length;
  try { a.run('_revalidateCacheTs_()'); } catch (_) {}
  await settle(a, 50);
  ok(a.calls.length === before, 'pollningen av cacheTs skickar inget medan frågan står öppen');
  const q = queued(a);
  const inflight = q.find(j => j.args && j.args.tag === '7310001');
  ok(!!inflight && !(inflight.retries > 0) && !inflight._parked, 'jobbet ligger kvar på disk, inget försök räknat, inte parkerat');
  const p = a.persisted(PKEY) || {};
  ok((p.logSingle || []).some(j => j.tag === '7310003' && !(j.retries > 0)), 'skanningen ligger kvar i kön, inget försök räknat');
  ok(!a.calls.some(c => 'answer' in c), 'inget anrop har hittills skickat något svar');

  let r;
  try { r = await a.run('_submitAccessAnswer_("fel svar")'); } catch (e) { r = { err: e.message }; }
  ok(r && r.ok === false && r.code === 'WRONG_ANSWER', 'fel svar: WRONG_ANSWER, frågan står kvar (' + JSON.stringify(r) + ')');
  await settle(a, 50);
  ok(callsOf(a, 'batch') === 1, 'fel svar släpper inte iväg något');

  try { r = await a.run(`_submitAccessAnswer_("  ${SVAR.toUpperCase()} ")`); } catch (e) { r = { err: e.message }; }
  ok(r && r.ok === true, 'rätt svar (versaler och mellanslag spelar ingen roll) godtas');
  await settle(a, 100);
  ok(qty(rig, 2) === 9, 'efter inloggning når saldot arket (' + qty(rig, 2) + ')');
  ok(qty(rig, 4) === 1, 'efter inloggning når singelskanningen arket (' + qty(rig, 4) + ')');
  ok(queued(a).length === 0 && !((a.persisted(PKEY) || {}).logSingle || []).length, 'köerna är tomma, i minnet och på disk');
  ok(!!a.ls.get(TKEY) && a.ls.get('vitaliseraUser') === 'Testare', 'beviset sparat, namnet ligger kvar');
  const auth = a.calls.filter(c => c.fn === 'auth');
  ok(auth.length === 2 && auth.every(c => !('accessToken' in c)), 'auth skickas utan bevis');
  ok(a.calls.filter(c => 'answer' in c).every(c => c.fn === 'auth'), 'svaret följer bara med auth-anropet');
  ok(![...a.ls.values()].some(v => String(v).toLowerCase().includes(SVAR)), 'svaret finns inte någonstans i localStorage');
  ok(!!a.ls.get(TKEY) && a.calls.filter(c => c.fn === 'batch').slice(-1)[0].accessToken === a.ls.get(TKEY), 'omsändningen bär det nya beviset');

  console.log('Del 2b: svaret byts på servern, beviset blir ogiltigt');
  rig.props.set('ACCESS_ANSWER_NEW', 'testsvar-456');
  a.run(`queueUpdate('updateCount', { tag: '7310002', newCount: 4, userName: 'Testare', sheetName: '${S}', rowNum: 3, expectedName: 'Spade' })`);
  a.run('clearTimeout(updateTimer); updateTimer = null; flushUpdates()');
  await settle(a, 200);
  ok(a.opened.n === 2 && !a.ls.get(TKEY), 'frågan visas igen och det gamla beviset raderas');
  ok(qty(rig, 3) === 2, 'inget skrivs med det gamla beviset');
  try { r = await a.run('_submitAccessAnswer_("testsvar-456")'); } catch (e) { r = { err: e.message }; }
  await settle(a, 100);
  ok(r && r.ok === true && qty(rig, 3) === 4, 'nytt svar: jobbet når arket (' + qty(rig, 3) + ')');
  a.stop();

  console.log('Del 2c: grinden öppen (inget svar inlagt): ingen fråga');
  {
    const rig2 = makeRig();
    rig2.addSheet(S, HEADERS, [row('Kratta', 5, '7310001')]);
    const b = start(rig2, appPath);
    b.run(`queueUpdate('updateCount', { tag: '7310001', newCount: 3, userName: 'Testare', sheetName: '${S}', rowNum: 2, expectedName: 'Kratta' })`);
    b.run('clearTimeout(updateTimer); updateTimer = null; flushUpdates()');
    await settle(b, 100);
    ok(qty(rig2, 2) === 3 && b.opened.n === 0, 'saldot sparas direkt och ingen fråga visas');
    b.stop();
  }
}

(async () => {
  const under = process.env.APP_UNDER_TEST;
  try {
    if (under) {
      await partV164(path.resolve(under));
    } else {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-v163-'));
      const v163 = path.join(dir, 'app.js');
      fs.writeFileSync(v163, execFileSync('git', ['show', '1412909:app.js'], { cwd: __dirname }));
      await partV163(v163);
      await partV164(null);
    }
  } catch (e) {
    fail++; console.log('  FAIL kraschade: ' + (e && e.message));
  }
  console.log(`\n${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
