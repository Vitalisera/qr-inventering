/* node singelconfirm.test.js — verifierar att den stora ✓-bekräftelse-
   overlayn BARA triggas när en singel-artikel registreras via SKANNING.

   Bakgrund: projektägaren bad om "större" feedback när man skannar en
   singel. Den får INTE visas från dialog-knapparna (confirmSingle i
   prepareSingleDialog, registerSingleBtn i prepareContainerDialog) eller
   för behållare/koppla-tag/ny-artikel. Triggern hålls lokal till de TVÅ
   skan-vägs-callsites:na (cache-hit + server-lookup) och gated av denna
   rena predikat-fn — INTE inuti Save.logSingle (delas av 4 callsites) →
   ingen dubbelfyrning (jfr tidigare delad-fn+listener-regression).

   shouldShowSingelConfirm nedan är KOPIERAD ORDAGRANT från app.js.
   Håll i synk. (Samma mönster som swupdate/findtag/latency.test.js —
   DOM kan ej köras i Node, så den testbara logiken extraheras.) */

// ---- Kopierat ordagrant från app.js ----
function shouldShowSingelConfirm({ via, type } = {}) {
  return via === 'scan' && type === 'singel';
}
// Steg5: bocken får BARA visas vid VERIFIERAT lyckat logTag-utfall —
// återanvänder samma 'verified'-kriterium som steg4:s shouldShowLinkSuccess.
function shouldShowSingelConfirmForResult(cls) { return cls === 'verified'; }
// classifyLinkResult KOPIERAD ORDAGRANT från app.js (steg4) — samma
// klassificerare som logSingle nu använder (ingen parallell variant).
function classifyLinkResult(r) {
  if (r && r.ok === true) return 'verified';
  if (r && (r.collision === true || r.staleRow === true)) return 'rejected';
  if (r && r.exhausted === true) return 'pending-retry';
  if (!r) return 'pending-retry';            // ingen res = nätfel innan svar
  return 'rejected';
}
// ---- slut kopia ----

// Modellerar exakt skan-callsite-grindarna (app.js ~4183 + ~4203):
//   allowConfirm = shouldShowSingelConfirm({via,type})
//   Save.logSingle(..., onResult: cls => { if (allowConfirm &&
//     shouldShowSingelConfirmForResult(cls)) showSingelConfirm() })
// + dialog-callsites (2601/2992) skickar INGEN onResult → ingen bock alls.
function bigCheckShownOnScan({ type, serverResult }) {
  const allowConfirm = shouldShowSingelConfirm({ via: 'scan', type });
  const cls = classifyLinkResult(serverResult);
  return allowConfirm && shouldShowSingelConfirmForResult(cls);
}
// Dialog-callsite: ingen onResult skickas → showSingelConfirm anropas ALDRIG,
// oavsett serverutfall (bevarat oförändrat beteende).
function bigCheckShownFromDialog(/* serverResult */) {
  return false; // ingen onResult-callback → ingen bock
}

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n     ', e.message); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert'); }

console.log('shouldShowSingelConfirm — bara singel via skanning');

t('singel via skan → visa', () => {
  assert(shouldShowSingelConfirm({ via: 'scan', type: 'singel' }) === true);
});

t('behållare via skan → visa INTE', () => {
  assert(shouldShowSingelConfirm({ via: 'scan', type: 'behållare' }) === false);
});

t('singel via dialog-knapp (confirmSingle/registerSingleBtn) → visa INTE', () => {
  assert(shouldShowSingelConfirm({ via: 'dialog', type: 'singel' }) === false);
});

t('singel utan via (koppla-tag/ny-artikel-väg) → visa INTE', () => {
  assert(shouldShowSingelConfirm({ type: 'singel' }) === false);
});

t('helt utan argument → visa INTE (ingen krasch)', () => {
  assert(shouldShowSingelConfirm() === false);
  assert(shouldShowSingelConfirm({}) === false);
});

t('fel via-värde → visa INTE', () => {
  assert(shouldShowSingelConfirm({ via: 'tap', type: 'singel' }) === false);
});

// === Steg5: bocken villkoras på VERIFIERAT serverutfall ===
// Failing-before: gammal kod anropade showSingelConfirm OVILLKORLIGT direkt
// efter (ej-awaitad) Save.logSingle → bock även vid tyst logTag-fel.
// Passing-after: bocken visas BARA vid classifyLinkResult==='verified'.
console.log('\nSteg5 — stor bock bara vid verifierat logTag-utfall');

t('skan-singel + server ok:true (verified) → STOR bock visas', () => {
  assert(bigCheckShownOnScan({ type: 'singel', serverResult: { ok: true } }) === true);
});

t('skan-singel + exhausted (offline/uttömt) → INGEN bock (pending)', () => {
  assert(bigCheckShownOnScan({ type: 'singel',
    serverResult: { ok: false, exhausted: true } }) === false);
});

t('skan-singel + inget svar (nätfel före respons) → INGEN bock (pending)', () => {
  assert(bigCheckShownOnScan({ type: 'singel', serverResult: null }) === false);
});

t('skan-singel + ok:false UTAN exhausted (server avvisade) → INGEN bock (rejected)', () => {
  assert(bigCheckShownOnScan({ type: 'singel',
    serverResult: { ok: false, msg: 'Flik finns inte' } }) === false);
});

t('skan-singel + staleRow (server avvisade) → INGEN bock (rejected)', () => {
  assert(bigCheckShownOnScan({ type: 'singel',
    serverResult: { ok: false, staleRow: true } }) === false);
});

t('skan-behållare + ok:true → INGEN bock (type-grind kvar)', () => {
  assert(bigCheckShownOnScan({ type: 'behållare', serverResult: { ok: true } }) === false);
});

t('dialog-callsite (confirmSingle/registerSingleBtn) → INGEN bock även vid ok:true', () => {
  assert(bigCheckShownFromDialog({ ok: true }) === false);
});

t('dialog-callsite → INGEN bock även vid fel (oförändrat optimistiskt beteende)', () => {
  assert(bigCheckShownFromDialog({ ok: false, exhausted: true }) === false);
  assert(bigCheckShownFromDialog({ ok: false, msg: 'fel' }) === false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
