'use strict';
/* qtyinput.test.js — A15: antalsfälten tolkar aldrig skräp, mot den FAKTISKA app.js
 * (appvm.js) och den FAKTISKA Code.js (riggen bakom fetch).
 *
 * TL-beslut 2026-11-04: "abc" och "2kg" AVVISAS med beskedet "Skriv bara siffror"
 * synligt i dialogen. Inget sparas, inget tolkas om i tysthet. 0 ger 0.
 * Beteendeval (dagens avsikt, bevarad):
 *   - Tomt: ny artikel → 1 (platshållaren lovar "1 som standard"), min-antal → 0,
 *     saldo i artikeldialogen → avvisas (fanns ingen standard före heller).
 *   - Decimalkomma: 1,5 och 0,5 godtas som 1.5 och 0.5 (Mat räknas i kg).
 *   - Negativt: avvisas överallt. Det finns inget "Öka antal"-läge som minskar;
 *     −/+-knapparna golvar redan på 0.
 * Vägar: (1) saldo i artikeldialogen (Spara), (2) antal vid ny artikel,
 *        (3) min-antal vid ny artikel, (4) min-antal i Egenskaper (autospar),
 *        (5) kön: ett köat create med antal 0 överlever en omstart som 0.
 *        (H) index.html: min-fälten är inte type="number" (webbläsaren gör då
 *        "abc" och ibland "1,5" till tom sträng, och tomt betyder 0).
 * Kör: node qtyinput.test.js            (båda backendarna: 2655c04 = live, och HEAD)
 *      GAS_CODE_PATH=<fil> node qtyinput.test.js   (bara den backend)
 */
const path = require('path');
const fs = require('fs');

if (!process.env.GAS_CODE_PATH) {
  const { execFileSync, spawnSync } = require('child_process');
  const os = require('os');
  const qa = path.join(__dirname, '..', 'QR-aktuell');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qtyinput-'));
  const at = rev => { const f = path.join(dir, `Code.${rev}.js`); fs.writeFileSync(f, execFileSync('git', ['-C', qa, 'show', `${rev}:Code.js`])); return f; };
  const head = execFileSync('git', ['-C', qa, 'rev-parse', '--short', 'HEAD']).toString().trim();
  let bad = 0;
  for (const [label, file] of [['live (2655c04)', at('2655c04')], [`HEAD (${head})`, at('HEAD')]]) {
    console.log(`\n=== Backend: ${label} ===`);
    const r = spawnSync(process.execPath, [__filename], { env: { ...process.env, GAS_CODE_PATH: file }, stdio: 'inherit' });
    if (r.status !== 0) bad++;
  }
  console.log(bad ? `\n${bad} backend(ar) FAIL` : '\nBåda backendarna: 0 FAIL');
  process.exit(bad ? 1 : 0);
}
const { loadApp } = require('./appvm');
const { makeRig, HEADERS, COL, row } = require(path.join(__dirname, '..', 'QR-aktuell', 'test', 'gas-rig'));

// Servern med A15 (_parseQty_) skriver 0 som 0 vid skapande. Live 2655c04 gör
// Number(qty) || 1: där är "skapa med 0 blir 1" en KÄND LUCKA tills steg 2,
// inte ett klientfel. Klientens del (skickar qty 0) prövas ändå.
const SERVER_HAS_A15 = /function _parseQty_/.test(fs.readFileSync(process.env.GAS_CODE_PATH, 'utf8'));
let pass = 0, fail = 0, known = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const S1 = 'Kurslokal/Reception';
const BAD = /Skriv bara siffror/;
const INPUTS = ['abc', '2kg', '0', '1,5', '0,5', '', '-2', ' 3 '];
const REJECT = new Set(['abc', '2kg', '-2']);
const NUM = { '0': 0, '1,5': 1.5, '0,5': 0.5, ' 3 ': 3 };

function mkRig() {
  const rig = makeRig();
  const r = row('Burk', 5, '111|');
  r[COL['typ'] - 1] = 'behållare';
  r[COL['enhet'] - 1] = 'kg';
  r[COL['antal som ska finnas under kurs'] - 1] = 2;
  rig.addSheet(S1, HEADERS, [r]);
  return rig;
}
async function ready(a) { for (let i = 0; i < 200 && !a.run('preloadDone'); i++) await a.settle(10); }
function start(rig, opts) {
  const a = loadApp(Object.assign({ rig }, opts || {}));
  a.run('userName = "Testare"');
  a.run(`(() => { const q = document.querySelector, g = document.getElementById;
    document.querySelector = s => s === '.dialog:not(.hidden)' ? null : q(s);
    document.getElementById = s => s === 'installOverlay' ? null : g(s);
    // Nya noder (Egenskaper-blocket) slår upp sina fält i dokumentet, så att
    // testet når samma fält som appen läser med qs().
    const ce = document.createElement;
    document.createElement = t => { const n = ce(t); n.querySelector = s => document.querySelector(s); return n; };
    globalThis.__ls = {};
    for (const id of ['#minQtyEdit']) {
      document.querySelector(id).addEventListener = (ev, f) => { (__ls[id + ':' + ev] = __ls[id + ':' + ev] || []).push(f); };
    }
  })()`);
  return a;
}
async function drain(a, rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    a.run('if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; flushUpdates(); }');
    await a.settle(5);
    const f = a.run('flushInFlight');
    if (f) { try { await f; } catch (_) {} }
  }
  await a.settle(5);
}
const writes = (a, from) => a.calls.slice(from).filter(x => ['logTag', 'batch', 'updateCount', 'updateMeta'].includes(x.fn));
const J = v => JSON.stringify(v);
// Alla updateCount/updateMeta-argument, även de som ligger i en batch.
function jobs(sent, fn) {
  const out = [];
  for (const x of sent) {
    if (x.fn === fn) out.push(x.args || x);
    if (x.fn === 'batch') for (const b of (x.batch || [])) if (b.fnName === fn) out.push(b.args);
  }
  return out;
}
const text = (a, sel) => String(a.run(`String(qs(${J(sel)}).textContent || '')`));

(async () => {
  // ---------- (1) saldo i artikeldialogen ----------
  console.log('A15 (1) saldo i artikeldialogen (förra saldot 5 kg), Spara');
  for (const inp of INPUTS) {
    const rig = mkRig();
    const a = start(rig);
    await ready(a);
    const before = a.calls.length;
    a.run(`openContainerForTag('111'); dlgInput.value = ${J(inp)}; qs('#saveBtn').onclick()`);
    const msg = text(a, '#msgLine');
    await drain(a);
    const sent = jobs(writes(a, before), 'updateCount');
    const cell = rig.cell(S1, 2, COL.QTY);
    if (REJECT.has(inp) || inp === '') {
      ok(sent.length === 0 && cell === 5, `"${inp}": inget sparas (skickat ${J(sent.map(s => s.newCount))}, cell ${J(cell)})`);
      ok(BAD.test(msg), `"${inp}": beskedet syns i dialogen ("${msg}")`);
    } else {
      ok(sent.length === 1 && sent[0].newCount === NUM[inp] && cell === NUM[inp], `"${inp}" → ${NUM[inp]} (skickat ${J(sent.map(s => s.newCount))}, cell ${J(cell)})`);
    }
    a.stop();
  }

  // ---------- (2)+(3) ny artikel: antal och min-antal ----------
  async function create(qtyIn, minIn) {
    const rig = mkRig();
    const a = start(rig);
    await ready(a);
    const before = a.calls.length;
    a.run(`createManualArticle();
      manualName.value = 'Nyvara'; manualType.value = 'behållare';
      manualQty.value = ${J(qtyIn)}; qs('#manualMinQty').value = ${J(minIn)};
      qs('#manualUnit').value = 'kg'; qs('#manualPlace').value = ${J(S1)};
      qs('#saveNewBtn').onclick()`);
    const note = text(a, '#manualQtyNote') + ' ' + text(a, '#status');
    const inDialog = text(a, '#manualQtyNote');
    await drain(a);
    const sent = writes(a, before).filter(x => x.fn === 'logTag');
    const newRow = rig.sheet(S1).rows.slice(1).find(r => r[COL.NAME - 1] === 'Nyvara');
    a.stop();
    return { sent, newRow, note, inDialog };
  }
  console.log('A15 (2) antal vid ny artikel');
  const WANT_CREATE = { ...NUM, '': 1 };
  for (const inp of INPUTS) {
    const r = await create(inp, '');
    if (REJECT.has(inp)) {
      ok(r.sent.length === 0 && !r.newRow, `"${inp}": ingen artikel skapas (skickat qty ${J(r.sent.map(s => s.qty))})`);
      ok(BAD.test(r.inDialog), `"${inp}": beskedet syns i dialogen ("${r.inDialog}")`);
    } else {
      const want = WANT_CREATE[inp];
      const got = r.newRow ? r.newRow[COL.QTY - 1] : undefined;
      if (!SERVER_HAS_A15 && want === 0) {
        ok(r.sent.length >= 1 && r.sent[0].qty === 0, `"${inp}": klienten skickar qty 0 (skickat ${J(r.sent.map(s => s.qty))})`);
        known++; console.log(`  KÄND LUCKA (live-servern) "${inp}": arket fick ${J(got)}, Number(qty) || 1 i 2655c04, stängs i steg 2`);
      } else {
        ok(r.sent.length >= 1 && r.sent[0].qty === want && got === want, `"${inp}" → ${want} (skickat ${J(r.sent.map(s => s.qty))}, cell ${J(got)})`);
      }
    }
  }
  console.log('A15 (3) min-antal vid ny artikel');
  const WANT_MIN = { ...NUM, '': 0 };
  for (const inp of INPUTS) {
    const r = await create('2', inp);
    if (REJECT.has(inp)) {
      ok(r.sent.length === 0 && !r.newRow, `"${inp}": ingen artikel skapas (skickat minQty ${J(r.sent.map(s => s.minQty))})`);
      ok(BAD.test(r.inDialog), `"${inp}": beskedet syns i dialogen ("${r.inDialog}")`);
    } else {
      const want = WANT_MIN[inp];
      ok(r.sent.length >= 1 && r.sent[0].minQty === want, `"${inp}" → ${want} (skickat ${J(r.sent.map(s => s.minQty))})`);
    }
  }

  // ---------- (4) min-antal i Egenskaper (autospar och stängning) ----------
  console.log('A15 (4) min-antal i Egenskaper, autospar vid stängning');
  for (const inp of INPUTS) {
    const rig = mkRig();
    const a = start(rig);
    await ready(a);
    const before = a.calls.length;
    a.run(`openContainerForTag('111');
      qs('#minQtyEdit').value = ${J(inp)}; qs('#commentEdit').value = 'ny kommentar'; qs('#dateEdit').value = qs('#dateEdit').value || '2026-11-04';
      (__ls['#minQtyEdit:input'] || __ls['#minQtyEdit:blur'] || []).forEach(f => f());`);
    const flushFn = a.run('typeof _pendingAutoSaveFlush === "function"');
    a.run('if (_pendingAutoSaveFlush) { const f = _pendingAutoSaveFlush; _pendingAutoSaveFlush = null; f(); }');
    const msg = text(a, '#msgLine');
    const cachedMin = a.run("tagCache.get('111').minQty");
    await drain(a);
    const sent = jobs(writes(a, before), 'updateMeta');
    const s0 = sent[0] || {};
    if (!flushFn) { ok(false, `"${inp}": autosparet registrerades inte (testriggen når inte fältet)`); a.stop(); continue; }
    if (REJECT.has(inp)) {
      ok(sent.length === 1 && !('minQty' in s0) && s0.comment === 'ny kommentar',
        `"${inp}": min-antal sparas inte, kommentaren gör det (${J(sent.map(s => ({ minQty: s.minQty, comment: s.comment })))})`);
      ok(BAD.test(msg), `"${inp}": beskedet syns i dialogen ("${msg}")`);
      ok(cachedMin === 2, `"${inp}": listans min-antal behåller 2 (${J(cachedMin)})`);
    } else {
      const want = WANT_MIN[inp];
      ok(cachedMin === want, `"${inp}": listans min-antal blir ${want} (${J(cachedMin)})`);
      ok(sent.length === 1 && s0.minQty === want && rig.cell(S1, 2, COL['antal som ska finnas under kurs']) === want,
        `"${inp}" → ${want} (skickat ${J(sent.map(s => s.minQty))}, cell ${J(rig.cell(S1, 2, COL['antal som ska finnas under kurs']))})`);
    }
    a.stop();
  }

  // ---------- (5) köat create med antal 0 överlever omstart som 0 ----------
  console.log('A15 (5) köat create med antal 0, omstart före synk');
  {
    const rig = mkRig();
    const a = start(rig);
    await ready(a);
    a.fetchMode = 'offline';
    a.run(`createManualArticle();
      manualName.value = 'Nollvara'; manualType.value = 'behållare'; manualQty.value = '0';
      qs('#manualUnit').value = 'kg'; qs('#manualPlace').value = ${J(S1)};
      qs('#saveNewBtn').onclick()`);
    await a.settle(20);
    let blob = null;
    for (const [k, v] of a.ls) { if (/Pending/i.test(k) && /Nollvara/.test(v)) blob = JSON.parse(v); }
    const creates = blob ? (Array.isArray(blob) ? blob[2] : (blob.creates || blob[2])) : null;
    const job = Array.isArray(creates) ? creates.find(c => c.name === 'Nollvara') : null;
    ok(!!job && job.qty === 0, `persisterat jobb har qty 0 (${J(job && job.qty)})`);
    a.stop();
  }

  // ---------- (H) min-fälten är textfält ----------
  console.log('A15 (H) min-fälten är inte type="number"');
  {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    ok(!/id="manualMinQty"[^>]*type="number"|type="number"[^>]*id="manualMinQty"/.test(html), 'index.html #manualMinQty är inte type="number"');
    ok(!/id="minQtyEdit"[^>]*type="number"|type="number"[^>]*id="minQtyEdit"/.test(appSrc), 'app.js #minQtyEdit är inte type="number"');
  }

  console.log(`\n${pass} PASS, ${fail} FAIL${known ? `, ${known} KÄND LUCKA` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
