'use strict';
/* queue.test.js — A07–A10: offlinekön mot den FAKTISKA app.js (appvm.js) och den
 * FAKTISKA Code.js (riggen bakom fetch). Inga kopior av köfunktionerna.
 * Kör: node queue.test.js
 */
const path = require('path');
const { loadApp } = require('./appvm');
const { makeRig, HEADERS, COL, row } = require(path.join(__dirname, '..', 'QR-aktuell', 'test', 'gas-rig'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const S = 'Lager';
const QKEY = 'vitaliseraUpdateQueue', PKEY = 'vitaliseraPendingSync';
const apps = [];

function mkRig() {
  const rig = makeRig();
  rig.addSheet(S, HEADERS, [row('Kratta', 5, '7310001'), row('Spade', 2, '7310002'), row('Hink', 0, '7310003')]);
  return rig;
}
function start(rig, ls) {
  const a = loadApp({ rig, ls });
  a.run('userName = "Testare"');
  apps.push(a);
  return a;
}
const qty = (rig, r) => rig.cell(S, r, COL.QTY);
const count = (tag, n, r, name) => `queueUpdate('updateCount', { tag: '${tag}', newCount: ${n}, userName: 'Testare', sheetName: '${S}', rowNum: ${r}, expectedName: '${name}' })`;
const snapshot = a => Object.fromEntries(a.ls);
const queuedTags = a => (a.persisted(QKEY) || []).map(j => j.args && j.args.tag);
async function drain(a, rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await a.settle(5);
    const f = a.run('flushInFlight');
    if (f) { try { await f; } catch (_) {} }
  }
  await a.settle(5);
}

(async () => {
  console.log('A07: ordningen efter omstart');
  {
    const rig = mkRig();
    const a = start(rig);
    a.fetchMode = 'hang';
    a.run(count('7310001', 1, 2, 'Kratta'));
    a.run('clearTimeout(updateTimer); updateTimer = null; flushUpdates()');
    await a.settle(5);
    a.run(count('7310001', 2, 2, 'Kratta'));
    // Servern hann skriva saldo 1, men svaret kom aldrig fram: appen dödades.
    rig.api('batch', { batch: a.hung.find(h => h.body.fn === 'batch').body.batch, cv: 160 });
    const ls = snapshot(a); a.stop();
    const b = start(rig, ls);
    b.run('flushUpdates()'); await drain(b);
    ok(qty(rig, 2) === 2, 'omstart mitt i en flush: det nyare saldot (2) vinner över det äldre (1), arket har ' + qty(rig, 2));
    b.stop();
  }

  console.log('A08: överlappande flush');
  {
    const rig = mkRig();
    const a = start(rig);
    a.fetchMode = 'hang';
    a.run(count('7310001', 7, 2, 'Kratta'));
    a.run('clearTimeout(updateTimer); updateTimer = null; flushUpdates()');
    await a.settle(5);
    a.run(count('7310002', 9, 3, 'Spade'));
    a.run('clearTimeout(updateTimer); updateTimer = null; flushUpdates()');
    await a.settle(5);
    const batches = a.hung.filter(h => h.body.fn === 'batch');
    ok(batches.length === 1, 'en andra flush startar inte medan den första är på väg (' + batches.length + ' samtidiga)');
    batches[0].resolve(); a.hung.splice(a.hung.indexOf(batches[0]), 1);
    await a.settle(20);
    const tags = queuedTags(a);
    ok(tags.includes('7310002') || qty(rig, 3) === 9, 'när den första batchen fått svar ligger jobb 2 fortfarande kvar på disk');
    a.fetchMode = 'rig'; a.releaseHung(); await drain(a);
    ok(qty(rig, 2) === 7 && qty(rig, 3) === 9, 'båda jobben når arket');
    a.stop();
  }

  console.log('A09: tillfälliga fel i batchresultatet');
  {
    const rig = mkRig();
    const a = start(rig);
    let n = 0;
    a.serve = (fn, p) => (fn === 'batch' && n++ === 0)
      ? { ok: false, results: p.batch.map(j => ({ tag: j.args.tag, ok: false, code: 'LOCK_TIMEOUT', transient: true, msg: 'Server upptagen' })) }
      : rig.api(fn, p);
    a.run(count('7310001', 4, 2, 'Kratta'));
    a.run('clearTimeout(updateTimer); updateTimer = null; flushUpdates()');
    await drain(a, 1);
    ok(queuedTags(a).includes('7310001'), 'tillfälligt fel (transient:true) → jobbet ligger kvar i den beständiga kön');
    ok(a.run('_failedWrites') === 0, 'tillfälligt fel räknas inte som förlorad skrivning');
    a.run('flushUpdates()'); await drain(a);
    ok(qty(rig, 2) === 4, 'nästa flush sparar jobbet (arket har ' + qty(rig, 2) + ')');
    a.stop();
  }
  {
    const rig = mkRig();
    const a = start(rig);
    let n = 0;
    a.serve = (fn, p) => {
      if (fn !== 'batch' || n++ !== 0) return rig.api(fn, p);
      // Saldo 6 (nyare) skrivs, saldo 4 (äldre) fick ett tillfälligt fel.
      const second = rig.api('batch', { batch: [p.batch[1]], cv: 160 }).results[0];
      return { ok: false, results: [{ tag: p.batch[0].args.tag, ok: false, code: 'LOCK_TIMEOUT', transient: true, msg: 'Server upptagen' }, second] };
    };
    a.run(count('7310001', 4, 2, 'Kratta'));
    a.run(count('7310001', 6, 2, 'Kratta'));
    a.run('clearTimeout(updateTimer); updateTimer = null; flushUpdates()');
    await drain(a, 1);
    a.run('flushUpdates()'); await drain(a);
    ok(qty(rig, 2) === 6, 'ett äldre värde med tillfälligt fel skriver inte över ett nyare (arket har ' + qty(rig, 2) + ')');
    a.stop();
  }
  {
    const rig = mkRig();
    const a = start(rig);
    let n = 0;
    a.serve = (fn, p) => (fn === 'batch' && n++ === 0) ? { error: 'Exception: Service invoked too many times' } : rig.api(fn, p);
    a.run(count('7310002', 8, 3, 'Spade'));
    a.run('clearTimeout(updateTimer); updateTimer = null; flushUpdates()');
    await drain(a, 1);
    ok(queuedTags(a).includes('7310002'), 'serverfel utan resultatlista → jobbet ligger kvar i kön');
    a.run('flushUpdates()'); await drain(a);
    ok(qty(rig, 3) === 8, 'och sparas vid nästa flush');
    a.stop();
  }
  {
    const rig = mkRig();
    const a = start(rig);
    a.serve = (fn, p) => fn === 'batch'
      ? { ok: false, results: p.batch.map(j => ({ tag: j.args.tag, ok: false, code: 'ROW_UNVERIFIED', transient: false, msg: 'x' })) }
      : rig.api(fn, p);
    a.run(count('7310002', 8, 3, 'Spade'));
    a.run('clearTimeout(updateTimer); updateTimer = null; flushUpdates()');
    await drain(a, 2);
    ok(!queuedTags(a).includes('7310002') && a.run('updateQueue.length') === 0, 'permanent fel (transient:false) försöks inte om');
    ok(a.run('_failedWrites') === 1, 'permanent fel syns i felräknaren');
    a.stop();
  }

  console.log('A10: singelskanning och koppling sparas i kön före avsändning');
  {
    const rig = mkRig();
    const a = start(rig);
    a.fetchMode = 'hang';
    a.run(`Save.logSingle('7310003', { name: 'Hink', sheetName: '${S}', rowNum: 4, expectedName: 'Hink' })`);
    a.run(`Save.linkTag('7399999', { name: 'Spade', sheetName: '${S}', rowNum: 3, currentTag: '7310002', expectedName: 'Spade' })`);
    await a.settle(10);
    const p = a.persisted(PKEY) || {};
    ok((p.logSingle || []).some(j => j.tag === '7310003'), 'singelskanningen ligger på disk medan anropet väntar');
    ok((p.tagLinks || []).some(j => j.scannedTag === '7399999'), 'kopplingen ligger på disk medan anropet väntar');
    const ls = snapshot(a); a.stop();
    const b = start(rig, ls);
    await b.run('resyncPendingTagLinks()'); await b.settle(30); await drain(b);
    ok(qty(rig, 4) === 1, 'efter omstart sparas singelskanningen (arket har ' + qty(rig, 4) + ')');
    ok(rig.findByTag('7399999').length === 1, 'efter omstart sparas kopplingen');
    b.stop();
  }

  console.log('Två köer, en artikel: skanna offline och sedan markera saknad');
  for (const order of ['resync först', 'flush först']) {
    const rig = mkRig();
    const a = start(rig);
    a.fetchMode = 'offline';
    a.run(`Save.logSingle('7310001', { name: 'Kratta', sheetName: '${S}', rowNum: 2, expectedName: 'Kratta' })`);
    await a.settle(8500);   // gasCallWithRetry ger upp efter 4 försök (0,8 + 2 + 5 s)
    a.run(`markSingleMissing('7310001', 'Kratta', { tag: '7310001', newCount: 0, userName: 'Testare', sheetName: '${S}', rowNum: 2, expectedName: 'Kratta' })`);
    await drain(a, 2);
    a.fetchMode = 'rig';
    if (order === 'resync först') { a.run('resyncPendingTagLinks()'); a.run('flushUpdates()'); }
    else { a.run('flushUpdates()'); a.run('resyncPendingTagLinks()'); }
    await a.settle(30); await drain(a); await a.settle(30); await drain(a);
    ok(qty(rig, 2) === 0, order + ': det senare (saknas, 0) vinner över den tidigare skanningen (1), arket har ' + qty(rig, 2));
    a.stop();
  }

  console.log('A10: ett besvarat anrop lämnar ingenting kvar på disk');
  for (const mode of ['bekräftat', 'avvisat']) {
    const rig = mkRig();
    const a = start(rig);
    if (mode === 'avvisat') a.serve = (fn, p) => (fn === 'logTag' || fn === 'addTag')
      ? { ok: false, code: 'ROW_UNVERIFIED', transient: false, staleRow: true, msg: 'x' } : rig.api(fn, p);
    a.run(`Save.logSingle('7310003', { name: 'Hink', sheetName: '${S}', rowNum: 4, expectedName: 'Hink' })`);
    a.run(`Save.linkTag('7399999', { name: 'Spade', sheetName: '${S}', rowNum: 3, currentTag: '7310002', expectedName: 'Spade' })`);
    await a.settle(40); await drain(a);
    const p = a.persisted(PKEY) || {};
    ok(a.run('_pendingLogSingle.size + _pendingTagLinks.size') === 0 && !(p.logSingle || []).length && !(p.tagLinks || []).length,
      mode + ' singelskanning och koppling: båda köerna är tomma, i minnet och på disk');
    a.stop();
  }

  console.log('Två köer, en artikel: saldo offline och sedan skanna');
  {
    const rig = mkRig();
    const a = start(rig);
    a.fetchMode = 'offline';
    a.run(count('7310001', 4, 2, 'Kratta'));
    a.run('clearTimeout(updateTimer); updateTimer = null; flushUpdates()');
    await drain(a, 2);
    a.run(`Save.logSingle('7310001', { name: 'Kratta', sheetName: '${S}', rowNum: 2, expectedName: 'Kratta' })`);
    await a.settle(50); await drain(a, 2);
    ok(a.run(`_pendingLogSingle.has('7310001')`), 'skanningen ligger kvar i kön medan det äldre saldot väntar');
    a.fetchMode = 'rig';
    a.run('flushUpdates()');
    await a.settle(30); await drain(a); await a.settle(30); await drain(a);
    ok(qty(rig, 2) === 1, 'det senare (skanningen, 1) vinner över det tidigare saldot (4), arket har ' + qty(rig, 2));
    ok(!a.run(`_pendingLogSingle.has('7310001')`), 'och skanningen är bekräftad');
    a.stop();
  }

  console.log('markSingleMissing och ett hållet namnbyte');
  {
    const rig = mkRig();
    const a = start(rig);
    a.run(`globalThis.__endRename = _beginRename_('7310002', 'Spade', 'Spade 2')`);
    const le = a.run(`markSingleMissing('7310002', 'Spade', { tag: '7310002', newCount: 0, userName: 'Testare', sheetName: '${S}', rowNum: 3, expectedName: 'Spade' })`);
    await drain(a, 2);
    const icon = () => le.querySelector('.icon').textContent;
    ok(icon() !== '✅', 'medan namnbytet väntar visas ingen bock (' + icon() + ')');
    rig.api('updateName', { tag: '7310002', newName: 'Spade 2', sheetName: S, rowNum: 3, expectedName: 'Spade', cv: 160 });
    a.run(`__endRename(true); _renameIdentityInQueues_('7310002', 'Spade', 'Spade 2'); _flushHeldSoon_()`);
    await drain(a);
    ok(qty(rig, 3) === 0, 'jobbet sparas när namnbytet bekräftats');
    ok(icon() === '✅', '⚠️ blir ✅ när jobbet faktiskt sparats (' + icon() + ')');
    a.stop();
  }

  apps.forEach(x => x.stop());
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('KRASCH', e && e.stack); process.exit(1); });
