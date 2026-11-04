'use strict';
/* dupscan.test.js — A11 klientdelen, mot den FAKTISKA app.js (appvm.js) och den
 * FAKTISKA Code.js (riggen bakom fetch). Livefallet: "Stora kaffebryggaren" med
 * koden 0959773 på Kurslokal/Reception OCH Köksutrustning.
 *   (1) initData och preload-cachen skriver inte över på kod: två rader = två poster.
 *   (2) Skanning av en kod som sitter på flera rader väljer ingen tyst: inget sparas,
 *       sökrutan öppnas med en fråga om vilken artikel det gäller.
 *   (3) En skrivning till en av dubbletterna går till rätt rad och bär id/expectedName.
 *   (4) Skrivningar till en dubblettrad skickar den RIKTIGA koden (inte radnyckeln)
 *       med flik, rad och identitet, på alla vägar. Rad infogad ovanför efter att
 *       listan hämtats: grannraden rörs aldrig. Kör även mot live-backend @126:
 *       GAS_CODE_PATH=<Code.js från 2655c04> node dupscan.test.js
 *   (5) En vanlig kod (Visp 1110001, en rad) behåller sin nyckel och registreras vid skanning.
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
  ok(call && call.tag === '0959773' && !('wireTag' in call), `registreringen skickar den riktiga koden, inte radnyckeln (tag=${call && call.tag})`);

  console.log('A11 klient: (5) en vanlig kod behåller sin nyckel och registreras vid skanning');
  ok(a.run(`tagCache.has('1110001') && tagCache.get('1110001').name === 'Visp' && !tagCache.get('1110001').dupTag`),
    'Visp ligger under sin egen kod 1110001');
  {
    const b5 = a.calls.length;
    await scan(a, '1110001');
    await drain(a);
    const c5 = a.calls.slice(b5).find(x => x.fn === 'logTag');
    ok(!!c5 && c5.tag === '1110001', 'skanning av 1110001 registrerar Visp: ' + JSON.stringify(c5 && { tag: c5.tag, rowNum: c5.rowNum }));
    ok(rig.cell(B, 2, COL['användare']) === 'Testare', `Visp (Köksutrustning rad 2) fick registreringen ("${rig.cell(B, 2, COL['användare'])}")`);
  }

  console.log('A11 klient: (6) en gammal post under koden försvinner när den är synkad');
  a.run(`tagCache.set('0959773', { name: '', pendingSync: true }); globalThis.__p = preloadShared().then(initData)`);
  try { await a.run('__p'); } catch (_) {}
  ok(a.run(`tagCache.has('0959773')`), 'medan den väntar på synk ligger den kvar (inget tappas)');
  a.run(`tagCache.set('0959773', { ...tagCache.get('0959773'), pendingSync: false }); _recentlySynced.set('0959773', Date.now()); globalThis.__p = preloadShared().then(initData)`);
  try { await a.run('__p'); } catch (_) {}
  ok(!a.run(`tagCache.has('0959773')`), 'synkad: posten under den gamla nyckeln är borta');
  ok(entries(a).length === 2, 'båda raderna finns kvar under sina radnycklar');
  a.stop();

  // (4) En rad infogas ovanför dubblettraden EFTER att listan hämtats. Varje
  // skrivväg (registrering, saldo via kön, kommentar, namnbyte, radering) bär då
  // en inaktuell rad. Med den riktiga koden nekar servern (STALE_ROW, eller
  // ROW_UNVERIFIED), eller hittar rätt rad via artikel-id. Grannen rörs aldrig.
  for (const withId of [false, true]) {
    console.log(`A11 klient: (4) rad infogad ovanför, ${withId ? 'med' : 'utan'} artikel-id-kolumn`);
    const H = withId ? [...HEADERS, 'artikel-id'] : HEADERS;
    const R = (r, id) => withId ? [...r, id] : r;
    const rg = makeRig();
    rg.addSheet(A, H, [R(row(NAME, 1, '0959773|'), 'ID-A')]);
    rg.addSheet(B, H, [R(row('Visp', 3, '1110001|'), 'ID-V'), R(row(NAME, 1, '0959773|'), 'ID-B')]);
    const d = start(rg);
    await ready(d);
    const k = (entries(d).find(e => e.sheetName === B && e.rowNum == 3) || {}).k;
    ok(!!k && k.startsWith('S'), 'dubblettraden har en radnyckel lokalt: ' + k);
    const NB = 'Tältduk';
    rg.insertRowAt(B, 3, R(row(NB, 7, ''), 'ID-T'));
    const b4 = d.calls.length;
    d.run(`openContainerForTag(${JSON.stringify(k)}); qs('#confirmSingle').onclick()`);
    await drain(d);
    d.run(`globalThis.__r = []; const it = tagCache.get(${JSON.stringify(k)}); const id = _identityOfItem_(it);
      const base = { tag: ${JSON.stringify(k)}, sheetName: it.sheetName, rowNum: it.rowNum };
      queueUpdate('updateCount', { ...base, newCount: 9, userName, ...id });
      (async () => {
        __r.push(['updateMeta', await gasCall('updateMeta', { tag: base.tag, args: { comment: 'NY', userName, sheetName: base.sheetName, rowNum: base.rowNum, ...id } })]);
        __r.push(['updateName', await gasCall('updateName', { ...base, newName: 'Omdöpt', ...id })]);
        __r.push(['deleteItem', await gasCall('deleteItem', { ...base, ...id })]);
      })()`);
    await d.settle(50);
    try { await d.run('waitForPendingSync()'); } catch (_) {}
    await drain(d);
    const writes = d.calls.slice(b4).filter(x => ['logTag', 'updateMeta', 'updateName', 'deleteItem', 'batch'].includes(x.fn));
    const wireTags = writes.flatMap(x => x.fn === 'batch' ? x.batch.map(j => j.args.tag) : [x.tag]);
    const fns = new Set(writes.flatMap(x => x.fn === 'batch' ? x.batch.map(j => j.fnName) : [x.fn]));
    ok(['logTag', 'updateCount', 'updateMeta', 'updateName', 'deleteItem'].every(f => fns.has(f)), 'alla fem skrivvägar skickades: ' + [...fns].join(','));
    ok(wireTags.length >= 5 && wireTags.every(t => t === '0959773'), 'alla skickar den riktiga koden: ' + JSON.stringify(wireTags));
    ok(!JSON.stringify(writes).includes('wireTag'), 'hjälpfältet wireTag skickas aldrig');
    const nRow = rg.rowOfName(B, NB);
    ok(nRow === 3 && rg.cell(B, 3, COL.QTY) === 7 && rg.cell(B, 3, COL['användare']) === '' && rg.cell(B, 3, COL.COMMENT) === '',
      `grannraden (${NB}) är orörd: rad ${nRow}, saldo ${rg.cell(B, 3, COL.QTY)}, användare "${rg.cell(B, 3, COL['användare'])}", kommentar "${rg.cell(B, 3, COL.COMMENT)}"`);
    ok(rg.cell(A, 2, COL['användare']) === '' && rg.cell(A, 2, COL.NAME) === NAME, 'Kurslokal/Reception rad 2 är orörd');
    const res = JSON.parse(d.run('JSON.stringify(__r)'));
    const okIds = withId && !process.env.GAS_CODE_PATH;
    for (const [f, r] of res) {
      const good = okIds ? r.ok === true : (r.ok === false && /^(STALE_ROW|ROW_UNVERIFIED)$/.test(String(r.code || (r.staleRow ? 'STALE_ROW' : ''))));
      ok(good, `${f}: ${okIds ? 'rätt rad via id' : 'nekas'} (${JSON.stringify({ ok: r.ok, code: r.code, staleRow: r.staleRow })})`);
    }
    if (okIds) ok(rg.rowOfName(B, NAME) === null && rg.sheet(B).rows.length === 3, 'via id: rätt rad (rad 4) ändrades och raderades, inte grannen');
    else ok(rg.cell(B, 4, COL.NAME) === NAME && rg.cell(B, 4, COL['användare']) === '' && rg.cell(B, 4, COL.QTY) === 1, 'utan id: dubblettraden (nu rad 4) fick inget skrivet');
    d.stop();
  }

  console.log(`\n${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
