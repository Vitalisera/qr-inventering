/* node staleecho.test.js — verifierar den KRITISKA synk-sanningskällan:
   backend slutar returnera falsk {ok:true} när en write träffar fel/stale rad,
   och frontend upptäcker det.

   Rotorsak: resolveItem(tag, sheetName, rowNum) returnerade ett blad så fort
   sheetName+rowNum matchade — UTAN att verifiera att raden faktiskt innehöll
   `tag`. updateMeta/updateCount skrev då till en stale rowNum (efter rad-skift,
   M-tag, bytt nyckel) och returnerade {ok:true}. Frontend _applyBatchResults_
   litade blint på r.ok → falsk "☑️ Synkroniserad".

   Fixarna:
   - Backend _verifyTagInRow_ (ren): cellTag-jämförelse via normalizeTags +
     leading-zero-nyckel (samma _zk som addTagToRow / _matchTagInScanned_).
     'skip' för syntetisk/tom tag (bakåtkompat: tagglösa rader får EJ flaggas).
   - Backend _staleRowGuard_-semantik: viaRowNum=false (tag-sökt) → korrekt;
     'mismatch' → {ok:false,staleRow:true}; annars echo writtenRow/writtenTag.
   - Frontend _isJobVerifiedOk_: ÄKTA ok = ok && !staleRow && writtenTag matchar
     förväntad tag. writtenTag saknas → lita på ok:true (bakåtkompat mot
     gammal/ej-deployad backend).

   Pure-logiken nedan är KOPIERAD ORDAGRANT från Code.js (_verifyTagInRow_) och
   app.js (_normTagFE_, _isJobVerifiedOk_). Håll i synk. (Samma mönster som
   findtag.test.js / latency.test.js — GAS/DOM kan ej köras lokalt.) */

// ---- Kopierat ORDAGRANT från Code.js ----
function normalizeTag(x) { return String(x).trim().replace(/[^\d]/g, ""); }
function normalizeTags(cell) {
  if (cell === null || cell === undefined || cell === "") return [];
  return String(cell)
    .split(/[,|]/)
    .map(s => s.trim().replace(/[^\d]/g, ''))
    .filter(Boolean);
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
// ---- slut Code.js-kopia ----

// ---- Kopierat ORDAGRANT från app.js ----
function _normTagFE_(x) { return String(x == null ? '' : x).trim().replace(/[^\d]/g, ''); }
function _isJobVerifiedOk_(expectedTag, r) {
  if (!r || r.ok === false) return false;
  if (r.staleRow === true) return false;
  if (r.writtenTag != null && r.writtenTag !== '' &&
      !/^S[A-Za-z]/.test(String(expectedTag == null ? '' : expectedTag))) {
    const exp = _normTagFE_(expectedTag);
    const got = _normTagFE_(r.writtenTag);
    if (exp) {
      const zk = s => (s.replace(/^0+/, '') || '0');
      if (exp !== got && zk(exp) !== zk(got)) return false;
    }
  }
  return true;
}
// ---- slut app.js-kopia ----

/* _staleRowGuard_-semantik modellerad rent: vi simulerar found-objektet
 * (viaRowNum + TAG-cellvärde) och kör samma beslutskedja som Code.js
 * _staleRowGuard_ (utan SpreadsheetApp). Bevisar att updateMeta/updateCount
 * INTE längre kan returnera falsk {ok:true} på en stale rad. */
function staleGuardDecision(found, tag) {
  if (!found.viaRowNum) return { write: true, echo: { writtenRow: found.row } };
  if (!found.tagCol) return { write: true, echo: { writtenRow: found.row } };
  const state = _verifyTagInRow_(tag, found.cellVal);
  if (state === 'mismatch') {
    return { write: false, resp: { ok: false, msg: "stale row", staleRow: true,
      attemptedRow: found.row, sheetName: found.sheetName } };
  }
  const cellTags = normalizeTags(found.cellVal);
  return { write: true, echo: { writtenRow: found.row, writtenTag: cellTags[0] || normalizeTag(tag) } };
}

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n      ', e.message); fail++; }
}
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m||'eq'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }

console.log('staleecho.test.js');

// (a) Korrekt rowNum med matchande tag → write + echo writtenTag
t('a: rowNum-resolvad rad innehåller taggen → write + echo writtenTag', () => {
  const d = staleGuardDecision(
    { viaRowNum: true, tagCol: 13, cellVal: '959773|', row: 5, sheetName: 'Steg 2' },
    '959773');
  assert(d.write === true, 'ska skriva');
  eq(d.echo.writtenTag, '959773', 'writtenTag');
  eq(d.echo.writtenRow, 5, 'writtenRow');
});

// (b) Stale rowNum (raden innehåller ANNAN tag) → staleRow:true, EJ ok
t('b: stale rowNum (rad har annan tag) → staleRow:true, ej write', () => {
  const d = staleGuardDecision(
    { viaRowNum: true, tagCol: 13, cellVal: '888888|', row: 5, sheetName: 'Steg 2' },
    '959773');
  assert(d.write === false, 'ska INTE skriva');
  eq(d.resp.ok, false, 'ok=false');
  eq(d.resp.staleRow, true, 'staleRow=true');
});

// (b2) Falsk {ok:true} omöjliggjord: tidigare KOD hade skrivit + returnerat
// ok:true på exakt detta fall. Frontend måste nu se det som fail.
t('b2: frontend ser staleRow-svaret som MISSLYCKAT (ej falsk success)', () => {
  const d = staleGuardDecision(
    { viaRowNum: true, tagCol: 13, cellVal: '888888|', row: 5, sheetName: 'Steg 2' },
    '959773');
  assert(_isJobVerifiedOk_('959773', d.resp) === false, 'staleRow → ej verifierat ok');
});

// (c) Tag-only-väg (ingen rowNum / tag-sökt) → oförändrat beteende
t('c: viaRowNum=false (tag-sökt) → write, ingen verifiering (bakåtkompat)', () => {
  const d = staleGuardDecision(
    { viaRowNum: false, tagCol: 13, cellVal: 'whatever', row: 9, sheetName: 'X' },
    '959773');
  assert(d.write === true, 'tag-sökt rad är redan korrekt → skriv');
  assert(!('writtenTag' in d.echo), 'ingen tag-verifiering på tag-sökt väg');
});

// (c2) Syntetisk tag (S..R..) via rowNum → 'skip' → write, oförändrat (bakåtkompat)
t('c2: syntetisk tag normaliserar till tomt → skip → write (bakåtkompat)', () => {
  eq(_verifyTagInRow_('SStegR5', '888888|'), 'skip', 'syntetisk → skip');
  const d = staleGuardDecision(
    { viaRowNum: true, tagCol: 13, cellVal: '888888|', row: 5, sheetName: 'Steg 2' },
    'SStegR5');
  assert(d.write === true, 'syntetisk → skriv som förr');
});

// (c3) Tagglös flik (ingen TAG-kolumn) via rowNum → write, oförändrat
t('c3: flik utan TAG-kolumn → write (bakåtkompat, ingen verifiering möjlig)', () => {
  const d = staleGuardDecision(
    { viaRowNum: true, tagCol: null, cellVal: '', row: 3, sheetName: 'Köksutrustning' },
    '959773');
  assert(d.write === true, 'ingen TAG-kol → skriv som förr');
});

// leading-zero-numeric likvärdighet (samma _zk som backend tag-pipe)
t('leading-zero: cell "0959773|", tag "959773" → match (ej falsk stale)', () => {
  eq(_verifyTagInRow_('959773', '0959773|'), 'match', 'leading-zero-numeric match');
});

// (d) Frontend stale-detektering — pendingSync behålls, ingen falsk success
t('d: _isJobVerifiedOk_ — ok+!stale+matchande writtenTag → verifierat ok', () => {
  assert(_isJobVerifiedOk_('959773', { ok: true, writtenTag: '959773' }) === true, 'äkta success');
});
t('d: ok men staleRow:true → EJ ok (pendingSync behålls)', () => {
  assert(_isJobVerifiedOk_('959773', { ok: true, staleRow: true }) === false, 'stale → fail');
});
t('d: ok men writtenTag pekar på ANNAN artikel → EJ ok', () => {
  assert(_isJobVerifiedOk_('959773', { ok: true, writtenTag: '111111' }) === false, 'fel tag → fail');
});
t('d: ok men writtenTag SAKNAS (gammal/ej-deployad backend) → ok (bakåtkompat)', () => {
  assert(_isJobVerifiedOk_('959773', { ok: true }) === true, 'gammal backend → lita på ok:true');
});
t('d: ok + writtenTag samma numeriskt (leading-zero) → ok', () => {
  assert(_isJobVerifiedOk_('959773', { ok: true, writtenTag: '0959773' }) === true, 'leading-zero ekvivalent');
});
t('d: r saknas eller ok:false → fail', () => {
  assert(_isJobVerifiedOk_('959773', null) === false, 'null → fail');
  assert(_isJobVerifiedOk_('959773', { ok: false }) === false, 'ok:false → fail');
});
t('d: syntetisk förväntad tag + writtenTag → lita på ok:true (kan ej jämföra)', () => {
  assert(_isJobVerifiedOk_('SStegR5', { ok: true, writtenTag: '888888' }) === true, 'syntetisk → ok:true räcker');
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
