/* node undots.test.js — Undo återställer FÖREGÅENDE tidsstämpel, ej dagens/kl12.

   ROTORSAK (app.js): Save.logSingle kör setLocalMeta(tag,{lastMs:Date.now()})
   SYNKRONT (rad ~1312) FÖRE gasCallWithRetry(...).then() resolvar.
   addUndoButton anropas i den .then():en (rad ~1277) och läste DÅ
   metaCache.get(tag) — som redan klobbrats med dagens Date.now().
   → prev.lastMs = idag, ej artikelns föregående. Undo bygger lastYMD från
   prev.lastMs → backend parseYMD_ tvingar kl 12:00 → "idag 12:00:00".
   = case (a) prev fångat efter overwrite, sekundärt (b) parseYMD_ 12:00.

   FIX: fånga prev SYNKRONT i logSingle FÖRE setLocalMeta (_undoPrev) och
   skicka in i addUndoButton(le,tag,prevOverride).

   Pure-logiken nedan är KOPIERAD ORDAGRANT från app.js/Code.js. Håll i synk
   (samma mönster som syncrestclass/staleecho — GAS/DOM kör ej lokalt). */

// ---- Kopierat ORDAGRANT från Code.js ----
function parseYMD_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  return isNaN(d) ? null : d;
}
// ---- slut Code.js-kopia ----

// ---- Modell av app.js undo-payload-derivering (rad ~1064-1069) ----
// prev = { lastMs, user }. Returnerar exakt det payload undo POSTar.
function buildUndoPayload(prev, sheetName, rowNum) {
  const payload = { clearUser: true, userName: prev.user || "", sheetName, rowNum };
  if (prev.lastMs) {
    const d = new Date(prev.lastMs);
    payload.lastYMD = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  } else {
    payload.clearTimestamp = true;
  }
  return payload;
}

// ---- Modell av Save.logSingle: prev-capture-tajming relativt overwrite ----
// metaCache = artikelns nuvarande state. Registrering sätter lastMs=now SYNKRONT.
// addUndoButton anropas i .then() (efter overwrite).
//   capture='after'  = BUGGEN: addUndoButton läser metaCache EFTER overwrite.
//   capture='before' = FIXEN: logSingle snapshotar FÖRE overwrite (_undoPrev).
function simulateLogSingleUndoPrev(metaCache, tag, nowMs, capture) {
  // Synkron snapshot (fixen): _undoPrev = {lastMs:meta.lastMs??null,user}
  const m0 = metaCache.get(tag) || {};
  const _undoPrev = { lastMs: m0.lastMs ?? null, user: m0.user || "" };
  // Optimistisk overwrite (logSingle rad ~1306): setLocalMeta lastMs=now
  metaCache.set(tag, { ...(metaCache.get(tag) || {}), lastMs: nowMs, user: 'Robert' });
  // .then() resolvar SENARE → addUndoButton körs nu.
  if (capture === 'before') {
    // FIX: prevOverride = _undoPrev (taget före overwrite)
    const meta = _undoPrev;
    return { lastMs: meta.lastMs ?? null, user: meta.user || "" };
  } else {
    // BUGG: addUndoButton läser metaCache (redan överskrivet)
    const meta = metaCache.get(tag) || {};
    return { lastMs: meta.lastMs ?? null, user: meta.user || "" };
  }
}

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n      ', e.message); fail++; }
}
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m||'eq'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }

// Reproducerbara tider
const TODAY = new Date(2026, 4, 16, 9, 30, 0).getTime();     // 2026-05-16 idag
const PREV  = new Date(2026, 1, 3, 0, 0, 0).getTime();        // 2026-02-03 föregående (day-trunc, som setLocalMeta)

console.log('Undo timestamp-rotorsak');

t('FÖRE-bevis: prev fångat EFTER overwrite → undo återställer IDAG (buggen)', () => {
  const mc = new Map([['959773', { lastMs: PREV, user: 'Anna' }]]);
  const prev = simulateLogSingleUndoPrev(mc, '959773', TODAY, 'after');
  // Buggen: prev.lastMs blev dagens Date.now(), ej artikelns 2026-02-03.
  const p = buildUndoPayload(prev, 'Gosedjur', 7);
  eq(p.lastYMD, '2026-05-16', 'BUGG: undo skriver IDAG, ej föregående datum');
  const written = parseYMD_(p.lastYMD);
  eq([written.getFullYear(), written.getMonth()+1, written.getDate(),
      written.getHours(), written.getMinutes(), written.getSeconds()],
     [2026, 5, 16, 12, 0, 0],
     'BUGG-symptom exakt: "2026-05-16 12:00:00" (dagens datum + parseYMD_ kl 12)');
});

t('EFTER-fix: prev fångat FÖRE overwrite → undo återställer FÖREGÅENDE datum', () => {
  const mc = new Map([['959773', { lastMs: PREV, user: 'Anna' }]]);
  const prev = simulateLogSingleUndoPrev(mc, '959773', TODAY, 'before');
  eq(prev.lastMs, PREV, 'snapshot fångar artikelns FÖREGÅENDE lastMs');
  eq(prev.user, 'Anna', 'snapshot fångar FÖREGÅENDE användare (ej Robert)');
  const p = buildUndoPayload(prev, 'Gosedjur', 7);
  eq(p.lastYMD, '2026-02-03', 'undo återställer artikelns FÖREGÅENDE datum');
  assert(!p.clearTimestamp, 'inventerad artikel → ingen clearTimestamp');
  eq(p.userName, 'Anna', 'undo återställer föregående användare');
  const written = parseYMD_(p.lastYMD);
  eq([written.getFullYear(), written.getMonth()+1, written.getDate()],
     [2026, 2, 3], 'TIMESTAMP-cellen får 2026-02-03 (kl12 = avsiktligt datum-only)');
});

t('EDGE aldrig-inventerad: prev FÖRE overwrite = null → undo clearTimestamp (avinventera)', () => {
  const mc = new Map();  // artikeln har INGEN tidigare meta (aldrig inventerad)
  const prev = simulateLogSingleUndoPrev(mc, 'SVerktygslådaR4', TODAY, 'before');
  eq(prev.lastMs, null, 'aldrig inventerad → snapshot lastMs = null');
  const p = buildUndoPayload(prev, 'Verktygslåda', 4);
  assert(p.clearTimestamp === true, 'undo ska AVINVENTERA, ej sätta dagens datum');
  assert(!('lastYMD' in p), 'ingen lastYMD → backend kör clearTimestamp-grenen');
});

t('EDGE-bevis att buggen bröt edge: prev EFTER overwrite för aldrig-inventerad → felaktigt IDAG', () => {
  const mc = new Map();
  const prev = simulateLogSingleUndoPrev(mc, 'SVerktygslådaR4', TODAY, 'after');
  // Buggen: prev.lastMs = idag (overwrite) → undo SÄTTER dagens datum
  // istället för att avinventera. Bevisar varför capture-ordningen är roten.
  eq(prev.lastMs, TODAY, 'BUGG: aldrig-inventerad fick ändå dagens lastMs');
  const p = buildUndoPayload(prev, 'Verktygslåda', 4);
  assert(!p.clearTimestamp, 'BUGG: avinventerade EJ — satte dagens datum (fel)');
  eq(p.lastYMD, '2026-05-16', 'BUGG: skrev IDAG på artikel som aldrig inventerats');
});

t('parseYMD_ kl-12 är datum-only-beteende (rörs EJ) — felet var FEL datum', () => {
  // Korrekt datum + parseYMD_ → rätt dag, kl 12:00 (avsiktligt för datum-only).
  const d = parseYMD_('2026-02-03');
  eq([d.getFullYear(), d.getMonth()+1, d.getDate(), d.getHours()],
     [2026, 2, 3, 12], 'kl 12 är väntat; roten var dagens datum, ej tiden');
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
