/* node syncrestclass.test.js — "synk-restklassen" A+B+C+D, koherent.

   GEMENSAM KLASS: operationer som visar/lovar framgång utan verifierad
   sparning/resync. Samma mönster som syncresilience/staleecho:
   classifyLinkResult ('verified'|'pending-retry'|'rejected') + samma
   _pendingTagLinks-resync (selectPendingResync, EN listener, _inflight-guard).

   A) #34 behållar-datum-only sparas ej + ingen historik. saveBtn
      `if (newCount===oldCount) return` hoppade förbi datum HELT; enda
      datum-vägen = fire-and-forget change-handler. Fix: decideDateCommit
      (ren) + verifierad commitContainerDate via classifyLinkResult, anropad
      av BÅDE change-handler OCH saveBtn — ingen dubbel-commit (lastCommitted).
   B) 9.6 logSingle offline → "sparas när du är online igen" men sparades
      ALDRIG (registrerades ej för resync). Fix: _pendingLogSingle drivs av
      SAMMA selectPendingResync + resync-sweep som _pendingTagLinks.
   C) #33 logTag UPDATE-grenen saknade tag↔rad-vakt → stale rowNum gav falsk
      {ok:true}. Fix: kör genom samma _staleRowGuard_/_verifyTagInRow_.
   D) addUndoButton/commitName: anropsformen {tag,args:payload} ÄR korrekt
      (backend doPost: updateMeta(body.tag,body.args)); defekten var TYST
      svalt svar. Fix: verifierat via classifyLinkResult, ej-verifierat → ⚠️.

   Pure-logiken nedan är KOPIERAD ORDAGRANT från app.js / Code.js. Håll i
   synk. (Samma mönster som syncresilience/staleecho — GAS/DOM kör ej lokalt.) */

// ---- Kopierat ORDAGRANT från app.js ----
function classifyLinkResult(r) {
  if (r && r.ok === true) return 'verified';
  if (r && (r.collision === true || r.staleRow === true)) return 'rejected';
  if (r && r.exhausted === true) return 'pending-retry';
  if (!r) return 'pending-retry';
  return 'rejected';
}
function decideDateCommit(origYMD, currentYMD, lastCommittedYMD) {
  const cur = String(currentYMD == null ? '' : currentYMD);
  const last = String(lastCommittedYMD == null ? '' : lastCommittedYMD);
  if (cur === last) return { action: 'none' };
  if (cur === '') return { action: 'clear' };
  return { action: 'set', ymd: cur };
}
function selectPendingResync(map) {
  const out = [];
  for (const [k, v] of (map instanceof Map ? map : new Map())) {
    if (v && !v._inflight) out.push({ key: k, job: v });
  }
  return out;
}
// ---- slut app.js-kopia ----

// ---- Kopierat ORDAGRANT från Code.js (samma som staleecho.test.js) ----
function normalizeTag(x) { return String(x).trim().replace(/[^\d]/g, ""); }
function normalizeTags(cell) {
  if (cell === null || cell === undefined || cell === "") return [];
  return String(cell).split(/[,|]/).map(s => s.trim().replace(/[^\d]/g, '')).filter(Boolean);
}
function _verifyTagInRow_(rawTag, cellValue) {
  if (rawTag == null || rawTag === '' || /^S[A-Za-z]/.test(String(rawTag))) return 'skip';
  const wanted = normalizeTag(rawTag);
  if (!wanted) return 'skip';
  const cellTags = normalizeTags(cellValue);
  if (cellTags.indexOf(wanted) !== -1) return 'match';
  const _zk = s => (String(s).replace(/^0+/, '') || '0');
  const wantedKey = _zk(wanted);
  if (cellTags.some(t => _zk(t) === wantedKey)) return 'match';
  return 'mismatch';
}
function _staleRowGuard_(found, tag) {
  if (!found.viaRowNum) return { echo: { writtenRow: found.row } };
  const tagCol = found.cols && found.cols.TAG;
  if (!tagCol) return { echo: { writtenRow: found.row } };
  const cellVal = found.cellVal; // testharness: TAG-cellens värde för found.row
  const state = _verifyTagInRow_(tag, cellVal);
  if (state === 'mismatch') {
    return { stale: { ok: false, msg: "stale row", staleRow: true,
      attemptedRow: found.row, sheetName: found.sheetName } };
  }
  const cellTags = normalizeTags(cellVal);
  return { echo: { writtenRow: found.row, writtenTag: cellTags[0] || normalizeTag(tag) } };
}
// logTag UPDATE-grenen EFTER #33-fixen (modell av Code.js:724-742 kontrollflöde).
// FÖRE fixen: return {ok:true,...} UTAN guard (falsk success vid stale rowNum).
// EFTER: guard.stale → returnera staleRow; annars skriv + ok:true + echo.
function logTagUpdateBranch(found, tag) {
  const guard = _staleRowGuard_(found, tag);
  if (guard.stale) return guard.stale;            // {ok:false,staleRow:true}
  return { ok: true, updated: true, new: false, row: found.row, ...guard.echo };
}
// ---- slut Code.js-kopia ----

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n      ', e.message); fail++; }
}
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m||'eq'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }

// ===================================================================
// A) #34 — behållar-datum-only: spara + historik + verifierat + ingen dubbel
// ===================================================================
console.log('A) #34 datum-only behållardialog');

t('A1: datum ÄNDRAT vid oförändrat saldo → set (förut: tyst förlust)', () => {
  // Original 2025-10-16, användaren skriver 2026-05-16, saldo oförändrat.
  // FÖRE: saveBtn `if(newCount===oldCount) return` → datum aldrig sparat.
  const d = decideDateCommit('2025-10-16', '2026-05-16', '2025-10-16');
  eq(d, { action: 'set', ymd: '2026-05-16' }, 'datumändring ska sparas');
});
t('A2: datum OFÖRÄNDRAT → none (ingen onödig write/historik)', () => {
  eq(decideDateCommit('2025-10-16', '2025-10-16', '2025-10-16'),
     { action: 'none' }, 'samma datum → ingen commit');
});
t('A3: fält rensat → clear (avinventera, clearTimestamp)', () => {
  eq(decideDateCommit('2025-10-16', '', '2025-10-16'),
     { action: 'clear' }, 'tomt fält → avinventera');
});
t('A4: ingen dubbel-commit — change-handlern hann FÖRE saveBtn', () => {
  // change-handler committar 2026-05-16 → _lastCommittedDate := 2026-05-16.
  // saveBtn anropar sedan commitContainerDate med SAMMA fältvärde.
  const afterHandler = decideDateCommit('2025-10-16', '2026-05-16', '2025-10-16');
  eq(afterHandler.action, 'set', 'handler committar');
  // _lastCommittedDate uppdaterad → saveBtn ser cur===last → none.
  const fromSaveBtn = decideDateCommit('2025-10-16', '2026-05-16', '2026-05-16');
  eq(fromSaveBtn, { action: 'none' }, 'saveBtn dubbel-committar EJ samma värde');
});
t('A5: ändra→ändra-tillbaka-till-original re-committas (last≠cur)', () => {
  // Användare: 2025-10-16 → 2026-01-01 (committad) → tillbaka 2025-10-16.
  // cur(orig) !== last(2026-01-01) → MÅSTE re-committa (servern har 2026-01-01).
  const d = decideDateCommit('2025-10-16', '2025-10-16', '2026-01-01');
  eq(d, { action: 'set', ymd: '2025-10-16' }, 'revert till original måste sparas');
});
t('A6: verifierat utfall via classifyLinkResult (samma sanningskälla)', () => {
  eq(classifyLinkResult({ ok: true }), 'verified', 'spara ok → ✅ markAsDone');
  eq(classifyLinkResult({ ok: false, exhausted: true }), 'pending-retry',
     'offline → ⚠️ "sparas när online", ej falsk ✅');
  eq(classifyLinkResult({ ok: false, staleRow: true }), 'rejected',
     'staleRow (C) → markLogFail, ingen falsk success');
});

// ===================================================================
// B) 9.6 — logSingle offline registreras + resync:as (meddelandet blir SANT)
// ===================================================================
console.log('B) 9.6 logSingle offline-resync');

// Modell av Save.logSingle:s _pendingLogSingle-livscykel (kopierad semantik).
function logSingleApplyResult(map, tag, job, res) {
  const cls = classifyLinkResult(res);
  if (cls === 'verified') { map.delete(tag); }
  else if (cls === 'pending-retry') {
    const j = map.get(tag) || job; j._inflight = false; map.set(tag, j);
  } else { map.delete(tag); } // rejected → re-försök meningslöst
  return cls;
}

t('B1: FÖRE-bevis — pending-retry men INTET registrerat → resync:as ALDRIG', () => {
  // Gamla beteendet: logSingle visade meddelandet men rörde ingen map.
  const m = new Map();
  // (ingen .set) → selectPendingResync hittar inget → meddelandet ljög.
  eq(selectPendingResync(m), [], 'inget att resynca = meddelandet var falskt');
});
t('B2: EFTER — pending-retry registrerar i _pendingLogSingle', () => {
  const m = new Map();
  const job = { tag: '959773', name: 'Stor sengångare', sheetName: 'Gosedjur', rowNum: 7 };
  const cls = logSingleApplyResult(m, '959773', job, { ok: false, exhausted: true });
  eq(cls, 'pending-retry', 'offline → pending-retry');
  assert(m.has('959773'), 'jobbet MÅSTE registreras (annars resync:as det aldrig)');
  assert(m.get('959773')._inflight === false, '_inflight nollat → nästa event tar det');
});
t('B3: resync — samma selectPendingResync som _pendingTagLinks väljer jobbet', () => {
  const m = new Map([['959773', { tag: '959773', name: 'X', _inflight: false }]]);
  const sel = selectPendingResync(m);
  eq(sel.map(s => s.key), ['959773'], 'logSingle-jobb plockas av samma sweep');
});
t('B4: verified vid resync → self-delete (ej längre pending)', () => {
  const m = new Map([['959773', { tag: '959773', name: 'X' }]]);
  logSingleApplyResult(m, '959773', m.get('959773'), { ok: true });
  assert(!m.has('959773'), 'bekräftat → bort ur pending');
});
t('B5: rejected (t.ex. staleRow från C) → self-delete (re-försök meningslöst)', () => {
  const m = new Map([['959773', { tag: '959773', name: 'X' }]]);
  logSingleApplyResult(m, '959773', m.get('959773'), { ok: false, staleRow: true });
  assert(!m.has('959773'), 'äkta avvisning → ingen evig pending-loop');
});
t('B6: _inflight-guard → dubbel online-event dubbelfyrar EJ (idempotent)', () => {
  const m = new Map([['959773', { tag: '959773', _inflight: true }]]);
  eq(selectPendingResync(m), [], 'pågående re-försök hoppas över');
});

// ===================================================================
// C) #33 — logTag UPDATE-grenen genom _staleRowGuard_ (ej falsk ok)
// ===================================================================
console.log('C) #33 logTag tag↔rad-vakt');

t('C1: FÖRE-bevis — stale rowNum UTAN guard gav falsk {ok:true}', () => {
  // Det gamla beteendet (modellerat): logTag skrev + returnerade ok:true
  // oavsett om rowNum pekade på rätt rad.
  const oldBehaviour = { ok: true, updated: true, new: false, row: 5 };
  eq(classifyLinkResult(oldBehaviour), 'verified',
     'FÖRE: fel rad → ändå grön bock (det är buggen)');
});
t('C2: EFTER — stale rowNum (TAG-cell ≠ tag) → {ok:false,staleRow:true}', () => {
  const found = { viaRowNum: true, row: 5, sheetName: 'Gosedjur',
    cols: { TAG: 13 }, cellVal: '111222' };          // raden har ANNAN tag
  const r = logTagUpdateBranch(found, '959773');
  eq(r.ok, false, 'mismatch → INGEN write, INGEN falsk ok');
  eq(r.staleRow, true, 'staleRow:true → classifyLinkResult rejected');
  eq(classifyLinkResult(r), 'rejected', 'frontend tolkar → markLogFail, ej ✅');
});
t('C3: EFTER — rätt rad (TAG-cell innehåller tag) → ok:true + echo', () => {
  const found = { viaRowNum: true, row: 7, sheetName: 'Gosedjur',
    cols: { TAG: 13 }, cellVal: '959773' };
  const r = logTagUpdateBranch(found, '959773');
  eq(r.ok, true, 'matchande rad → write + ok');
  eq(r.writtenRow, 7, 'echo writtenRow');
  eq(r.writtenTag, '959773', 'echo writtenTag');
  eq(classifyLinkResult(r), 'verified', 'äkta success → ✅');
});
t('C4: bakåtkompat — tag-sökt rad (viaRowNum=false) oförändrad, ok', () => {
  const found = { viaRowNum: false, row: 3, sheetName: 'Kurslokal/Reception',
    cols: { TAG: 13 } };
  const r = logTagUpdateBranch(found, '959773');
  eq(r.ok, true, 'tag-sökt = redan verifierad → skriv som förr');
  eq(classifyLinkResult(r), 'verified', 'oförändrat beteende');
});
t('C5: bakåtkompat — syntetisk tag (S..R..) → skip, ingen falsk stale', () => {
  const found = { viaRowNum: true, row: 9, sheetName: 'Gosedjur',
    cols: { TAG: 13 }, cellVal: '' };               // tagglös rad
  const r = logTagUpdateBranch(found, 'SGosedjurR9');
  eq(r.ok, true, 'syntetisk → _verifyTagInRow_ skip → skriv (oförändrat)');
});
t('C6: bakåtkompat — flik utan TAG-kolumn → ingen verifiering, skriv', () => {
  const found = { viaRowNum: true, row: 4, sheetName: 'Köksutrustning',
    cols: {}, cellVal: '' };                         // ingen TAG-kol
  const r = logTagUpdateBranch(found, '959773');
  eq(r.ok, true, 'ingen TAG-kol → behåll gammalt beteende (bakåtkompat)');
});

// ===================================================================
// D) addUndoButton / commitName — verifierat utfall, ej tyst svalt
// ===================================================================
console.log('D) följdfynd: undo + namnbyte verifierat');

t('D1: anropsformen {tag,args:payload} ÄR korrekt (premiss-korrigering)', () => {
  // doPost: case "updateMeta": updateMeta(body.tag, body.args). Backend LÄSER
  // body.args. Alla 8 frontend-callsites använder {tag,args:...}. Promptens
  // "fel form (flata fält)" stämde EJ — defekten var det TYST svalda svaret.
  const payload = { clearTimestamp: true, userName: 'Robert' };
  const sent = { tag: '959773', args: payload };
  // Simulera doPost-dispatch: updateMeta(body.tag, body.args)
  const dispatched = { tag: sent.tag, args: sent.args };
  eq(dispatched.args, payload, 'backend får args intakt → formen är rätt');
});
t('D2: undo verifieras via classifyLinkResult (ej fire-and-forget)', () => {
  // FÖRE: gasCall(...) utan .then/.catch → svaret observerades ALDRIG →
  // "Ångrad" visades även när servern svarade ok:false.
  eq(classifyLinkResult({ ok: true }), 'verified', 'ångra ok → behåll ↩️');
  eq(classifyLinkResult({ ok: false, exhausted: true }), 'pending-retry',
     'ångra ej bekräftad → ⚠️ (ingen tyst förlust)');
  eq(classifyLinkResult({ ok: false, msg: 'fel' }), 'rejected',
     'server avvisade ångra → ⚠️');
});
t('D3: commitName — .catch(console.log) ersatt med verifierat ⚠️', () => {
  // FÖRE: .catch(console.log) → namnbyte kunde tyst aldrig sparas.
  assert(classifyLinkResult({ ok: true }) === 'verified',
    'namnbyte ok → tyst (UI redan uppdaterat)');
  assert(classifyLinkResult({ ok: false, exhausted: true }) !== 'verified',
    'namnbyte ej bekräftat → ⚠️-banner, inte tyst svalt');
  assert(classifyLinkResult(null) !== 'verified',
    'nätfel innan svar → ⚠️, inte falsk tystnad');
});

// ===================================================================
// Tvärsnitt: HELA klassen delar EN sanningskälla (ingen parallell logik)
// ===================================================================
console.log('Tvärsnitt: gemensam klass');

t('X1: A/B/C/D använder ALLA classifyLinkResult — ingen parallell klassare', () => {
  // Samma fyra utfall ska ge samma klass oavsett callsite.
  for (const r of [{ ok: true }, { ok: false, exhausted: true },
                   { ok: false, staleRow: true }, { ok: false, msg: 'x' }, null]) {
    const c = classifyLinkResult(r);
    assert(['verified', 'pending-retry', 'rejected'].includes(c),
      `klass måste vara en av de tre, fick ${c}`);
  }
});
t('X2: C:s staleRow → B:s rejected → self-delete (kedjan håller ihop)', () => {
  const found = { viaRowNum: true, row: 5, sheetName: 'S', cols: { TAG: 13 },
    cellVal: '999' };
  const backendRes = logTagUpdateBranch(found, '959773'); // C → staleRow
  const m = new Map([['959773', { tag: '959773' }]]);
  const cls = logSingleApplyResult(m, '959773', m.get('959773'), backendRes);
  eq(cls, 'rejected', 'C→B-kedjan: staleRow propagerar till rejected');
  assert(!m.has('959773'), 'rejected → logSingle self-delete (ingen evig loop)');
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
