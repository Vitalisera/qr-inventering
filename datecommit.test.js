'use strict';
/* datecommit.test.js — A13: datumändringen i artikeldialogen (behållare), mot den
 * FAKTISKA app.js (appvm.js) och den FAKTISKA Code.js (riggen bakom fetch).
 *   (a) Utan nät: datumet ligger på disk och når arket efter en omstart med nät,
 *       utan att användaren gör om ändringen.
 *   (b) Servern nekar: ändringen rullas tillbaka, och samma datum kan sättas igen
 *       direkt (förr blev det andra försöket en tyst no-op).
 *   (c) Rensa datum (avinventera) via kön: användarfältet töms, inget namn skrivs dit.
 * Kör: node datecommit.test.js
 */
const path = require('path');
const { loadApp } = require('./appvm');
const { makeRig, HEADERS, COL, row } = require(path.join(__dirname, '..', 'QR-aktuell', 'test', 'gas-rig'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const S = 'Lager', T = '7320001', NAME = 'Pappmuggar';

function mkRig(typ = 'behållare') {
  const rig = makeRig();
  const r = row(NAME, 40, T); r[COL['typ'] - 1] = typ;
  r[COL['datum för saldo'] - 1] = new Date('2026-09-01T12:00:00');
  r[COL['användare'] - 1] = 'Anna';
  rig.addSheet(S, HEADERS, [r]);
  return rig;
}
const ymd = v => { if (!v || typeof v.getFullYear !== 'function') return String(v || ''); return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`; };
async function ready(a) { for (let i = 0; i < 200 && !a.run('preloadDone'); i++) await a.settle(10); }
function start(rig, ls) { const a = loadApp({ rig, ls }); a.run('userName = "Testare"'); return a; }
async function drain(a, rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await a.settle(5);
    a.run('if (updateQueue.length && !flushInFlight) { clearTimeout(updateTimer); updateTimer = null; flushUpdates(); }');
    const f = a.run('flushInFlight');
    if (f) { try { await f; } catch (_) {} }
  }
  await a.settle(10);
}
// Öppna dialogen och fånga datumfältets change-lyssnare (stubbe-DOM).
function openDateDialog(a) {
  a.run(`(() => { const el = qs('#containerDateEdit'); el.addEventListener = (ev, f) => { el['__' + ev] = f; }; })()`);
  a.run(`openContainerForTag('${T}')`);
}
// Singeldialogen (standardtypen) har ett eget datumfält med samma brist.
function openSingleDialog(a) {
  a.run(`(() => { const el = qs('#singleDateEdit'); el.addEventListener = (ev, f) => { el['__' + ev] = f; }; })()`);
  a.run(`prepareSingleDialog(tagCache.get('${T}'), '${T}')`);
}
const setSingleDate = (a, v) => a.run(`(() => { const el = qs('#singleDateEdit'); el.value = '${v}'; el.__change(); })()`);
const setDate = (a, v) => a.run(`(() => { const el = qs('#containerDateEdit'); el.value = '${v}'; el.__change(); })()`);
const dateSends = a => a.calls.filter(x => (x.fn === 'updateMeta' && x.args && 'lastYMD' in x.args) ||
  (x.fn === 'batch' && x.batch.some(j => j.fnName === 'updateMeta' && 'lastYMD' in j.args))).length;

(async () => {
  console.log('A13 (a) utan nät, omstart, nätet tillbaka');
  {
    const rig = mkRig();
    const a = start(rig);
    await ready(a);
    openDateDialog(a);
    a.fetchMode = 'hang';
    setDate(a, '2026-10-15');
    await a.settle(1200);                     // köns 1-sekundstimer hinner gå
    const ls = Object.fromEntries(a.ls);
    a.stop();
    ok(ymd(rig.cell(S, 2, COL['datum för saldo'])) === '2026-09-01', 'innan nätet är tillbaka har arket kvar det gamla datumet');
    const b = start(rig, ls);
    await ready(b);
    await drain(b);
    ok(ymd(rig.cell(S, 2, COL['datum för saldo'])) === '2026-10-15', `efter omstart med nät når datumet arket (arket har ${ymd(rig.cell(S, 2, COL['datum för saldo']))})`);
    b.stop();
  }

  console.log('A13 (b) servern nekar, samma datum igen');
  {
    const rig = mkRig();
    const a = start(rig);
    await ready(a);
    openDateDialog(a);
    const rej = { ok: false, code: 'STALE_ROW', transient: false, staleRow: true, msg: 'Raden har ändrats' };
    let reject = true;
    const before = a.run(`metaCache.get('${T}').lastMs`);
    a.serve = (fn, p) => {
      if (reject && (fn === 'updateMeta' || fn === 'batch')) { reject = false; return fn === 'batch' ? { ok: false, results: p.batch.map(() => rej) } : rej; }
      return rig.api(fn, p);
    };
    setDate(a, '2026-10-20');
    await drain(a);
    ok(ymd(rig.cell(S, 2, COL['datum för saldo'])) === '2026-09-01', 'första försöket nekades, arket orört');
    ok(a.run(`metaCache.get('${T}').lastMs`) === before, 'appen rullade tillbaka till det gamla datumet');
    ok(a.run('_failedWrites') === 1, `felräknaren räknade nekandet exakt en gång (${a.run('_failedWrites')})`);
    const n1 = dateSends(a);
    setDate(a, '2026-10-20');                 // samma värde igen, som rådet säger
    await drain(a);
    ok(dateSends(a) === n1 + 1, `samma datum skickas igen (${dateSends(a) - n1} nytt anrop)`);
    ok(ymd(rig.cell(S, 2, COL['datum för saldo'])) === '2026-10-20', `andra försöket når arket (arket har ${ymd(rig.cell(S, 2, COL['datum för saldo']))})`);
    a.stop();
  }

  console.log('A13 (c) rensa datum');
  {
    const rig = mkRig();
    const a = start(rig);
    await ready(a);
    openDateDialog(a);
    setDate(a, '');
    await drain(a);
    ok(rig.cell(S, 2, COL['datum för saldo']) === '' && rig.cell(S, 2, COL['användare']) === '',
      `datum och användare tömda (datum "${ymd(rig.cell(S, 2, COL['datum för saldo']))}", användare "${rig.cell(S, 2, COL['användare'])}")`);
    a.stop();
  }

  console.log('A13 (d) singeldialogen: utan nät, omstart, nätet tillbaka');
  {
    const rig = mkRig('singel');
    const a = start(rig);
    await ready(a);
    openSingleDialog(a);
    a.fetchMode = 'hang';
    setSingleDate(a, '2026-10-16');
    await a.settle(1200);
    const ls = Object.fromEntries(a.ls);
    a.stop();
    const b = start(rig, ls);
    await ready(b);
    await drain(b);
    ok(ymd(rig.cell(S, 2, COL['datum för saldo'])) === '2026-10-16', `singel: efter omstart med nät når datumet arket (arket har ${ymd(rig.cell(S, 2, COL['datum för saldo']))})`);
    b.stop();
  }

  console.log('A13 (e) singeldialogen: servern nekar');
  {
    const rig = mkRig('singel');
    const a = start(rig);
    await ready(a);
    openSingleDialog(a);
    const rej = { ok: false, code: 'STALE_ROW', transient: false, staleRow: true, msg: 'Raden har ändrats' };
    let reject = true;
    const before = a.run(`metaCache.get('${T}').lastMs`);
    a.serve = (fn, p) => {
      if (reject && (fn === 'updateMeta' || fn === 'batch')) { reject = false; return fn === 'batch' ? { ok: false, results: p.batch.map(() => rej) } : rej; }
      return rig.api(fn, p);
    };
    setSingleDate(a, '2026-10-21');
    await drain(a);
    ok(ymd(rig.cell(S, 2, COL['datum för saldo'])) === '2026-09-01', 'singel: nekat, arket orört');
    ok(a.run(`metaCache.get('${T}').lastMs`) === before && !a.run(`tagCache.get('${T}').pendingSync`), 'singel: appen rullade tillbaka och artikeln är inte gul');
    ok(a.run('_failedWrites') === 1, `singel: felräknaren räknade nekandet exakt en gång (${a.run('_failedWrites')})`);
    a.stop();
  }

  console.log('A13 (f) singeldialogen: rensa datum');
  {
    const rig = mkRig('singel');
    const a = start(rig);
    await ready(a);
    openSingleDialog(a);
    setSingleDate(a, '');
    await drain(a);
    ok(rig.cell(S, 2, COL['datum för saldo']) === '' && rig.cell(S, 2, COL['användare']) === '',
      `singel: datum och användare tömda (datum "${ymd(rig.cell(S, 2, COL['datum för saldo']))}", användare "${rig.cell(S, 2, COL['användare'])}")`);
    a.stop();
  }

  console.log('A13 (g) samma batch: datumet nekas, saldot får tillfälligt fel');
  {
    // Datumets nekande-krok körs inne i batchsvaret, innan saldojobbet lagts
    // tillbaka i kön. Artikeln får inte se sparad ut medan saldot väntar.
    const rig = mkRig();
    const a = start(rig);
    await ready(a);
    openDateDialog(a);
    a.fetchMode = 'offline';
    setDate(a, '2026-10-15');
    await a.settle(30);
    a.run(`tagCache.set('${T}', { ...tagCache.get('${T}'), pendingSync: true });
      queueUpdate('updateCount', { tag: '${T}', newCount: 7, userName, sheetName: '${S}', rowNum: 2, expectedName: '${NAME}' })`);
    let once = true;
    a.serve = (fn, p) => {
      if (fn === 'batch' && once) {
        once = false;
        return { ok: false, results: p.batch.map(j => j.fnName === 'updateMeta'
          ? { ok: false, code: 'STALE_ROW', transient: false, staleRow: true, msg: 'stale row' }
          : { ok: false, code: 'SERVER_ERROR', transient: true, msg: 'lock' }) };
      }
      return rig.api(fn, p);
    };
    a.fetchMode = 'rig';
    await a.settle(5);
    a.run('clearTimeout(updateTimer); updateTimer = null; flushUpdates()');
    const f = a.run('flushInFlight'); if (f) { try { await f; } catch (_) {} }
    await a.settle(5);
    ok(a.run('updateQueue.length') === 1 && rig.cell(S, 2, COL.QTY) === 40, 'saldot väntar i kön och har inte nått arket');
    ok(a.run(`tagCache.get('${T}').pendingSync`) === true, 'artikeln är fortfarande gul');
    await drain(a);
    ok(rig.cell(S, 2, COL.QTY) === 7 && !a.run(`tagCache.get('${T}').pendingSync`), `efter omförsöket: saldot i arket (${rig.cell(S, 2, COL.QTY)}) och artikeln inte gul`);
    a.stop();
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
