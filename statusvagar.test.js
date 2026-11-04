'use strict';
/* statusvagar.test.js — A12b: regeln från A12 (gul släcks först när INGET annat
 * för artikeln väntar eller har nekats) ska gälla ALLA skrivvägar, inte bara
 * batchsvaren. Mot den FAKTISKA app.js (appvm.js) och Code.js (riggen).
 *
 * Vägar: singelregistrering (Save.logSingle), ångra (addUndoButton), koppling
 * (Save.linkTag, vanlig och syntetisk rad) och ny artikel (Save.createItem).
 * För varje väg, ett annat jobb för samma artikel som:
 *   Q  väntar i kön (eller hålls bakom vägen enligt A07) och går iväg efteråt,
 *   I  redan är skickat och väntar på svar (batch under sändning),
 *   F  nekades av servern innan vägens svar kom.
 * Artikeln ska vara gul när vägens svar kommit, och bli ogul när allt
 * faktiskt är klart (kontrollfallet, så att ingen väg fastnar gul).
 * Kör: node statusvagar.test.js
 */
const path = require('path');
const { loadApp } = require('./appvm');
const { makeRig, HEADERS, COL, row } = require(path.join(__dirname, '..', 'QR-aktuell', 'test', 'gas-rig'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const S = 'Lager', T = '7310001', NEWT = '7318888', LINKT = '7317777';

function mkRig() {
  const rig = makeRig();
  // Rad 4 saknar kod → syntetisk nyckel i appen.
  rig.addSheet(S, HEADERS, [row('Kratta', 5, T), row('Spade', 2, '7310002'), row('Hink', 3, '')]);
  return rig;
}
async function ready(a) { for (let i = 0; i < 200 && !a.run('preloadDone'); i++) await a.settle(10); }
async function drain(a, rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await a.settle(5);
    a.run('if (updateQueue.length && !flushInFlight) { clearTimeout(updateTimer); updateTimer = null; flushUpdates(); }');
    const f = a.run('flushInFlight'); if (f) { try { await f; } catch (_) {} }
  }
  await a.settle(20);
}
const pending = (a, k) => !!a.run(`(tagCache.get(${JSON.stringify(k)}) || {}).pendingSync`);
const noAuto = a => a.run('clearTimeout(updateTimer); updateTimer = null');
// Släpp ett hängt anrop (fetchMode 'hang') med riggens riktiga svar.
async function release(a, fn) {
  for (let i = 0; i < 50; i++) {
    const i2 = a.hung.findIndex(h => h.body.fn === fn);
    if (i2 >= 0) { const [h] = a.hung.splice(i2, 1); h.resolve(); await a.settle(30); return true; }
    await a.settle(10);
  }
  return false;
}
async function releaseAll(a) { a.fetchMode = 'rig'; while (a.hung.length) { a.hung.splice(0).forEach(h => h.resolve()); await a.settle(30); } await drain(a); }
const hasHung = (a, fn) => a.hung.some(h => h.body.fn === fn);
// Som callsiterna: optimistisk lokal ändring (gul) och sedan köjobbet.
const count = (k, n) => a => { a.run(`tagCache.set(${JSON.stringify(k)}, { ...tagCache.get(${JSON.stringify(k)}), pendingSync: true });
  queueUpdate('updateCount', { tag: ${JSON.stringify(k)}, newCount: ${n}, userName, ..._dlgIdentOf_(${JSON.stringify(k)}) })`); noAuto(a); };
// rowNum 3 = Spades rad: servern nekar (STALE_ROW, koden sitter inte där).
const rejectMeta = async a => {
  a.run(`tagCache.set('${T}', { ...tagCache.get('${T}'), pendingSync: true });
    queueUpdate('updateMeta', { tag: '${T}', comment: 'x', sheetName: '${S}', rowNum: 3, expectedName: 'Kratta' })`);
  await drain(a);
};

function start(rig) {
  const a = loadApp({ rig }); a.run('userName = "Testare"');
  a.run(`globalThis._dlgIdentOf_ = k => { const it = tagCache.get(k) || {}; return { sheetName: it.sheetName, rowNum: it.rowNum, ..._identityOfItem_(it) }; }`);
  // Fånga ångra-knappen (addUndoButton skapar den med document.createElement).
  a.run(`(() => { const orig = document.createElement; globalThis.__els = [];
    document.createElement = function (t) { const e = orig(t); __els.push(e); return e; }; })()`);
  return a;
}
const synthKey = a => a.run(`[...tagCache.entries()].find(([k, v]) => v.name === 'Hink')[0]`);

// Varje väg: key(a) = artikelns nyckel, prep(a) = förberedelse i rig-läge,
// go(a) = startar vägen, fn = anropet vägen gör, after(a) = nyckeln efter svaret.
const PATHS = {
  singel: {
    key: () => T, fn: 'logTag',
    go: a => a.run(`Save.logSingle('${T}', { name: 'Kratta', sheetName: '${S}', rowNum: 2 })`),
  },
  ångra: {
    key: () => T, fn: 'updateMeta',
    prep: async a => { a.run(`Save.logSingle('${T}', { name: 'Kratta', sheetName: '${S}', rowNum: 2 })`); await drain(a); },
    go: a => a.run(`(() => { const b = [...__els].reverse().find(e => e.className === 'undoLink' && typeof e.onclick === 'function'); b.onclick({ stopPropagation() {} }); })()`),
  },
  koppling: {
    key: () => T, fn: 'addTag',
    go: a => a.run(`(() => { const it = tagCache.get('${T}'); globalThis.__lk = Save.linkTag('${LINKT}', { name: it.name, sheetName: it.sheetName, rowNum: it.rowNum, currentTag: '${T}', ..._identityOfItem_(it) }); })()`),
  },
  'koppling syntetisk': {
    key: a => synthKey(a), fn: 'addTag', after: () => LINKT,
    go: a => a.run(`(() => { const k = ${JSON.stringify(synthKey(a))}; const it = tagCache.get(k); globalThis.__lk = Save.linkTag('${LINKT}', { name: it.name, sheetName: it.sheetName, rowNum: it.rowNum, currentTag: k, ..._identityOfItem_(it) }); })()`),
  },
  'ny artikel': {
    key: () => NEWT, fn: 'logTag',
    go: a => a.run(`Save.createItem({ ck: 'ck-a12b', tag: '${NEWT}', name: 'Räfsa', type: 'behållare', qty: 3, unit: 'st', category: '', sheetPlace: '', sheetName: '${S}', minQty: 0, user: 'Testare' })`),
  },
};

(async () => {
  for (const [name, P] of Object.entries(PATHS)) {
    // Q: vägen är på väg; ett nyare saldo köas. Det saldot hålls (A07) eller
    // ligger i kön tills vägen svarat, och skickas sedan (hängt) → under sändning.
    {
      console.log(`A12b ${name} (Q): ett saldo köas medan vägens anrop väntar`);
      const rig = mkRig(); const a = start(rig); await ready(a);
      if (P.prep) await P.prep(a);
      const k0 = P.key(a);
      a.fetchMode = 'hang';
      P.go(a); await a.settle(20);
      count(k0, 9)(a);
      const rel = await release(a, P.fn);
      await a.settle(30);
      const k1 = P.after ? P.after(a) : k0;
      ok(rel && pending(a, k1), `${name}: vägens svar kom, saldot är inte bekräftat → gul (nyckel ${k1})`);
      a.fetchMode = 'rig';
      while (a.hung.length) { a.hung.splice(0).forEach(h => h.resolve()); await a.settle(30); }
      await drain(a);
      ok(!pending(a, k1) && !a.run('updateQueue.length'), `${name}: när även saldot är bekräftat → ogul`);
      a.stop();
    }
    // I: ett saldo är redan skickat (batch hängd) när vägen startar och svarar.
    // Singel och ny artikel väntar enligt A07 in äldre köjobb, så där kan vägens
    // svar inte komma före batchens; fallet finns bara för ångra och koppling.
    if (name === 'ångra' || name.startsWith('koppling')) {
      console.log(`A12b ${name} (I): ett saldo är skickat och väntar på svar`);
      const rig = mkRig(); const a = start(rig); await ready(a);
      if (P.prep) await P.prep(a);
      const k0 = P.key(a);
      a.fetchMode = 'hang';
      count(k0, 8)(a);
      a.run('flushUpdates()'); await a.settle(20);
      const batchHung = hasHung(a, 'batch');
      P.go(a); await a.settle(20);
      const rel = await release(a, P.fn);
      await a.settle(30);
      const k1 = P.after ? P.after(a) : k0;
      ok(batchHung && rel && pending(a, k1), `${name}: vägens svar kom medan saldot är på väg → gul`);
      a.fetchMode = 'rig';
      while (a.hung.length) { a.hung.splice(0).forEach(h => h.resolve()); await a.settle(30); }
      await drain(a);
      ok(!pending(a, k1), `${name}: när batchen bekräftats → ogul`);
      a.stop();
    }
    // F: ett metadatajobb för artikeln nekades innan vägens svar kom.
    if (name === 'singel' || name === 'ångra' || name === 'koppling') {
      console.log(`A12b ${name} (F): ett metadatajobb nekades innan`);
      const rig = mkRig(); const a = start(rig); await ready(a);
      if (P.prep) await P.prep(a);
      await rejectMeta(a);
      ok(rig.cell(S, 2, COL.COMMENT) === '' && pending(a, T), `${name}: förutsättning: kommentaren nekades, artikeln gul`);
      P.go(a); await drain(a);
      ok(pending(a, T), `${name}: vägen lyckades men kommentaren är förlorad → fortfarande gul`);
      // Kontroll: en ny bekräftad ändring i kön för artikeln släpper avslaget.
      a.run(`tagCache.set('${T}', { ...tagCache.get('${T}'), pendingSync: true });
        queueUpdate('updateMeta', { tag: '${T}', comment: 'y', ..._dlgIdentOf_('${T}') })`);
      await drain(a);
      ok(rig.cell(S, 2, COL.COMMENT) === 'y' && !pending(a, T), `${name}: kommentaren sparad igen → ogul`);
      a.stop();
    }
  }

  // Kontroll per väg: inget annat väntar → vägen ensam gör artikeln ogul
  // (jobbet som just blev klart får inte räknas som väntande).
  for (const [name, P] of Object.entries(PATHS)) {
    console.log(`A12b ${name} (ensam): inget annat väntar`);
    const rig = mkRig(); const a = start(rig); await ready(a);
    if (P.prep) await P.prep(a);
    P.go(a); await drain(a);
    try { await a.run('globalThis.__lk'); } catch (_) {}
    await a.settle(30);
    const k1 = P.after ? P.after(a) : P.key(a);
    ok(!pending(a, k1), `${name}: ensam och bekräftad → ogul (nyckel ${k1})`);
    a.stop();
  }

  // Avvisade vägar rullar tillbaka sin egen ändring, men ett köat saldo för
  // artikeln väntar fortfarande → gul tills det fått svar.
  for (const [name, go, fn] of [
    ['singel avvisad', a => a.run(`Save.logSingle('${T}', { name: 'Kratta', sheetName: '${S}', rowNum: 3 })`), 'logTag'],
    ['koppling avvisad (koden sitter på Spade)', a => a.run(`(() => { const it = tagCache.get('${T}'); Save.linkTag('7310002', { name: it.name, sheetName: it.sheetName, rowNum: it.rowNum, currentTag: '${T}', ..._identityOfItem_(it) }); })()`), 'addTag'],
  ]) {
    console.log(`A12b ${name} (Q)`);
    const rig = mkRig(); const a = start(rig); await ready(a);
    a.fetchMode = 'hang';
    go(a); await a.settle(20);
    count(T, 7)(a);
    const rel = await release(a, fn);
    await a.settle(30);
    ok(rel && pending(a, T), `${name}: vägen avvisades, saldot väntar → gul`);
    a.fetchMode = 'rig';
    while (a.hung.length) { a.hung.splice(0).forEach(h => h.resolve()); await a.settle(30); }
    await drain(a);
    ok(!pending(a, T) && rig.cell(S, 2, COL.QTY) === 7, `${name}: saldot sparat (${rig.cell(S, 2, COL.QTY)}) → ogul`);
    a.stop();
  }

  // Granskning 1: koppling på tagglös rad + registrering (inventera vid
  // koppling). Kopplingen svarar först och byter nyckel; registreringens svar
  // ska då hanteras under den nya nyckeln, annars fastnar artikeln gul.
  {
    console.log('A12b koppling syntetisk + singel: nyckelbyte under registreringens flykt');
    const rig = mkRig(); const a = start(rig); await ready(a);
    const k = synthKey(a);
    a.fetchMode = 'hang';
    a.run(`(() => { const it = tagCache.get('${k}'); Save.linkTag('${LINKT}', { name: it.name, sheetName: it.sheetName, rowNum: it.rowNum, currentTag: '${k}', ..._identityOfItem_(it) }); })()`);
    await a.settle(20);
    a.run(`(() => { const it = tagCache.get('${k}'); Save.logSingle('${k}', { name: it.name, sheetName: it.sheetName, rowNum: it.rowNum, ..._identityOfItem_(it) }); })()`);
    await a.settle(30);
    await release(a, 'addTag');
    ok(pending(a, LINKT), 'kopplingen klar, registreringen väntar → gul under nya taggen');
    await release(a, 'logTag');
    await releaseAll(a);
    ok(!pending(a, LINKT) && a.run('_pendingLogSingle.size') === 0, 'registreringen bekräftad → ogul och inget kvar i _pendingLogSingle');
    ok(a.calls.filter(c => c.fn === 'logTag').length === 1, 'registreringen skickades en gång');
    a.stop();
  }
  // Granskning 2: "markera som saknad" har en krok men rullar inte tillbaka.
  {
    console.log('A12b markSingleMissing nekas');
    const rig = mkRig(); const a = start(rig); await ready(a);
    a.run(`markSingleMissing('${T}', 'Kratta', { tag: '${T}', newCount: 0, userName, sheetName: '${S}', rowNum: 3, expectedName: 'Kratta' })`);
    await drain(a);
    ok(rig.cell(S, 2, COL.QTY) === 5 && a.run(`metaCache.get('${T}').qty`) === 0 && pending(a, T),
      `nekad: arket ${rig.cell(S, 2, COL.QTY)}, lokalt 0 → gul`);
    a.stop();
  }
  // Nekad ångra: värdet finns inte i arket → en senare registrering släcker inte.
  {
    console.log('A12b ångra nekas, sedan singelregistrering');
    const rig = mkRig(); const a = start(rig); await ready(a);
    await PATHS['ångra'].prep(a);
    a.serve = (fn, p) => fn === 'updateMeta' ? { ok: false, msg: 'nekad', code: 'STALE_ROW', transient: false } : rig.api(fn, p);
    PATHS['ångra'].go(a); await drain(a);
    a.serve = null;
    a.run(`Save.logSingle('${T}', { name: 'Kratta', sheetName: '${S}', rowNum: 2 })`); await drain(a);
    ok(pending(a, T), 'ångran nekades, registreringen lyckades → fortfarande gul');
    a.stop();
  }

  console.log(`\n${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
