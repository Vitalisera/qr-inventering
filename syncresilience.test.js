/* node syncresilience.test.js — bug 2.7: nätfel vid tag-koppling doldes helt.

   Rotorsak: Save.linkTag-callsites visade success-banner OPTIMISTISKT före
   `await Save.linkTag`. Offline → gasCallWithRetry returnerar (kastar EJ)
   {ok:false,exhausted:true}. linkTag-fail-pathen rullade tillbaka ALLT
   (tog bort scannedTag ur altTags + pendingSync:false). Resultat: ingen
   gulmarkering (renderLists kräver pendingSync), ⏳-historik blev aldrig ⚠️,
   success-bannern visades redan → felet osynligt. Ingen online-resync fanns.

   Fix:
   - classifyLinkResult: skiljer 'verified' / 'pending-retry' / 'rejected'.
     exhausted/nätfel → 'pending-retry' (BEHÅLL pendingSync, ⚠️, ingen success).
     collision/staleRow/valideringsfel UTAN exhausted → 'rejected' (rollback).
   - shouldShowLinkSuccess: bara 'verified' → "Tag kopplad" (bannern ljuger ej).
   - selectPendingResync + EN online-listener (idempotent _inflight-guard) →
     re-försök ej-bekräftade länkar utan dubbelfyrning.

   Pure-logiken nedan är KOPIERAD ORDAGRANT från app.js. Håll i synk.
   (Samma mönster som staleecho/autosaveflush — GAS/DOM kan ej köras lokalt.) */

// ---- Kopierat ORDAGRANT från app.js ----
function classifyLinkResult(r) {
  if (r && r.ok === true) return 'verified';
  if (r && (r.collision === true || r.staleRow === true)) return 'rejected';
  if (r && r.exhausted === true) return 'pending-retry';
  if (!r) return 'pending-retry';            // ingen res = nätfel innan svar
  // ok:false UTAN exhausted = servern svarade och avvisade (validering m.m.)
  return 'rejected';
}
function shouldShowLinkSuccess(cls) { return cls === 'verified'; }
function selectPendingResync(map) {
  const out = [];
  for (const [k, v] of (map instanceof Map ? map : new Map())) {
    if (v && !v._inflight) out.push({ key: k, job: v });
  }
  return out;
}
// ---- slut app.js-kopia ----

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n      ', e.message); fail++; }
}
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m||'eq'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }

// ===== classifyLinkResult — den centrala 2.7-sanningskällan =====

// (a) Offline/uttömt → pending-retry (pendingSync behålls, ⚠️, INGEN success)
t('a: gasCallWithRetry-uttömt {ok:false,exhausted:true} → pending-retry', () => {
  const cls = classifyLinkResult({ ok: false, exhausted: true,
    msg: 'Misslyckades efter 4 försök: Failed to fetch' });
  eq(cls, 'pending-retry', 'exhausted ska EJ rollbacka');
  assert(shouldShowLinkSuccess(cls) === false, 'success-banner får EJ visas vid pending');
});
t('a2: res saknas helt (nätfel innan svar) → pending-retry', () => {
  eq(classifyLinkResult(null), 'pending-retry', 'null res = ej bekräftat');
  eq(classifyLinkResult(undefined), 'pending-retry', 'undefined res = ej bekräftat');
  assert(shouldShowLinkSuccess(classifyLinkResult(null)) === false, 'ingen falsk success');
});

// (b) Äkta server-avvisning → rejected (rollback som förr)
t('b: collision (servern svarade, tag tillhör annan artikel) → rejected', () => {
  const r = { ok: false, collision: true, existingName: 'Olivolja' };
  eq(classifyLinkResult(r), 'rejected', 'collision = äkta avvisning → rollback');
  assert(shouldShowLinkSuccess(classifyLinkResult(r)) === false, 'ingen success vid collision');
});
t('b2: staleRow:true → rejected (rad-skift, scannedTag tillhör ej raden)', () => {
  eq(classifyLinkResult({ ok: false, staleRow: true }), 'rejected', 'staleRow → rollback');
});
t('b3: ok:false UTAN exhausted (valideringsfel: "sheetName krävs") → rejected', () => {
  eq(classifyLinkResult({ ok: false, msg: 'sheetName krävs' }), 'rejected',
    'server avvisade → äkta rollback, inte pending');
});

// (c) Verifierat ok → verified, success-banner FÅR visas
t('c: ok:true → verified + success-banner får visas', () => {
  const r = { ok: true, tag: '959773' };
  eq(classifyLinkResult(r), 'verified', 'ok:true = bekräftat');
  assert(shouldShowLinkSuccess(classifyLinkResult(r)) === true, 'verified → banner ok');
});

// (c-edge) collision OCH exhausted (extremt osannolikt): collision vinner →
// rejected (säkrare: rolla tillbaka en kollision än att lämna kvar pending).
t('c-edge: {collision:true,exhausted:true} → rejected (collision prioriteras)', () => {
  eq(classifyLinkResult({ ok: false, collision: true, exhausted: true }), 'rejected',
    'känd kollision ska rollbacka även om retry-uttömt');
});

// ===== selectPendingResync — online-event väljer rätt jobb, idempotent =====

t('d: tom map → inga jobb', () => {
  eq(selectPendingResync(new Map()), [], 'tom → []');
  eq(selectPendingResync(null), [], 'null arg → [] (defensiv)');
});
t('d2: två pending utan _inflight → båda väljs', () => {
  const m = new Map([
    ['111', { scannedTag: '111', currentTag: 'A', sheetName: 'S', rowNum: 2, name: 'X' }],
    ['222', { scannedTag: '222', currentTag: 'B', sheetName: 'S', rowNum: 3, name: 'Y' }],
  ]);
  const sel = selectPendingResync(m);
  eq(sel.map(s => s.key).sort(), ['111', '222'], 'båda pending väljs');
});
t('d3: pågående re-försök (_inflight) hoppas över → ingen dubbelfyrning', () => {
  const m = new Map([
    ['111', { scannedTag: '111', _inflight: true }],   // redan på väg
    ['222', { scannedTag: '222' }],                     // ledig
  ]);
  const sel = selectPendingResync(m);
  eq(sel.map(s => s.key), ['222'], 'bara den lediga — _inflight skippas');
});
t('d4: alla _inflight → tomt (idempotent, dubbel online-event ofarligt)', () => {
  const m = new Map([['111', { _inflight: true }], ['222', { _inflight: true }]]);
  eq(selectPendingResync(m), [], 'inget re-försök startas igen');
});

// ===== Scenario-bevis: 2.7-buggen FÖRE vs EFTER =====

// FÖRE: exhausted behandlades som fail → rollback → dolt. Verifiera att den
// nya klassificeringen ALDRIG returnerar 'rejected' för ett rent nätfel.
t('scenario: offline tag-koppling — exhausted ALDRIG rejected (ingen rollback)', () => {
  for (const r of [
    { ok: false, exhausted: true },
    { ok: false, exhausted: true, msg: 'Failed to fetch' },
    null,
  ]) {
    const cls = classifyLinkResult(r);
    assert(cls === 'pending-retry', `förväntade pending-retry, fick ${cls}`);
    assert(shouldShowLinkSuccess(cls) === false, 'success-banner ljuger EJ');
  }
});
t('scenario: server-avvisning — ALLTID rejected (rollback bevaras som förr)', () => {
  for (const r of [
    { ok: false, collision: true },
    { ok: false, staleRow: true },
    { ok: false, msg: 'Ogiltig flik' },
  ]) {
    assert(classifyLinkResult(r) === 'rejected', 'äkta fel ska fortf. rollbacka');
  }
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
