/* node failcount.test.js — P3a/P3b: den beständiga felräknaren i synk-badgen.

   VARFÖR FILEN FINNS: fram till P3 kunde en misslyckad skrivning inträffa utan
   att någon märkte det. Historiken var kollapsad, MAX_LOG=5 vräkte ut
   varningen inom ~30 s, och synk-badgen räknade bara VÄNTANDE jobb — aldrig
   fel. Räknaren nedan är motmedlet, och den har två sätt att vara värdelös:

     1. Den larmar aldrig (tautologisk vakt). Detta är den verkliga risken:
        rejected-grenarna avregistrerar jobbet ur pending-mapparna i SAMMA
        andetag som de failar, så köerna är TOMMA precis när felet finns. Den
        gamla badge-modellen returnerade "dold" vid tom kö innan den ens tittade
        på warn-facket — hade `failed` lagts in under den regeln hade den varit
        dödkod från dag ett. Testet nedan börjar därför med exakt det fallet.
     2. Den larmar vid normal drift. En skanning gjord offline hamnar i
        _pendingLogSingle och skickas vid nästa 'online' — fördröjd, inte
        förlorad. Räknas den som fel blir badgen röd i vardagen och slutar
        betyda något.

   Testet driver båda: en liten simulator som räknar upp EXAKT när
   countsAsLostWrite säger till, och renderar resultatet genom
   buildSyncBadgeModel.

   countsAsLostWrite / humanizeSaveError / buildSyncBadgeModel nedan är
   KOPIERADE ORDAGRANT ur app.js. Håll i synk (testdrift.check.js vaktar). */

// ---- Kopierat ordagrant från app.js ----
function countsAsLostWrite(cls, retryRegistered) {
  if (cls === 'verified') return false;      // skrivningen är bekräftad i arket
  if (retryRegistered === true) return false; // fördröjd, inte förlorad
  return true;                                // avvisad, eller tappad utan kö
}

function humanizeSaveError(raw, code) {
  const c = String(code == null ? '' : code).toUpperCase();
  const s = String(raw == null ? '' : raw).trim();
  const low = s.toLowerCase();
  // A03–A06 (v160): servern kunde inte bevisa att raden är rätt artikel, eller
  // artikeln finns inte längre. Inget skrevs. Ny lista behövs innan nästa försök.
  if (c === 'ROW_UNVERIFIED' && low.includes('heter likadant'))
    return 'två artiklar utan kod heter likadant på fliken, ge artikeln ett eget namn eller en kod';
  if (c === 'ROW_UNVERIFIED')
    return 'artikeln har flyttats i arket, ladda om listan och försök igen';
  if (c === 'ITEM_NOT_FOUND')
    return 'artikeln finns inte längre i arket, ladda om listan';
  if (c === 'TAG_EXISTS')
    return 'koden används redan av en annan artikel, ingen ny artikel skapades';
  if (c === 'STALE_ROW' || low.includes('stale row'))
    return 'raden hade flyttat sig i arket, skanna om artikeln';
  if (c === 'NOT_FOUND' || low.startsWith('tagg ej hittad'))
    return 'artikeln hittades inte i arket, skanna om den';
  if (c === 'SHEET_MISSING' || low.startsWith('flik finns inte'))
    return 'fliken finns inte längre i arket, kontrollera artikelns plats';
  if (c === 'SHEET_HEADER_BROKEN' || c === 'NO_NAME_COL' || low.includes('rubrikrad'))
    return 'arkets rubrikrad känns inte igen, välj en annan flik';
  if (c === 'LOCK_TIMEOUT' || low.includes('server upptagen'))
    return 'arket var upptaget, gör om ändringen';
  if (c === 'BAD_ARGS' || c === 'BAD_TAG')
    return 'uppgifterna kunde inte tolkas, gör om ändringen';
  // Transportfel. Safari/iOS-PWA är huvudklienten och har egna texter
  // ("Load failed", "The network connection was lost") — Chromes "Failed to
  // fetch" ensam räcker alltså inte som mönster.
  if (/failed to fetch|load failed|networkerror|network connection was lost|network request failed/.test(low))
    return 'ingen kontakt med arket, gör om ändringen när du är online';
  if (/timeout|timed out|tidsgräns/.test(low))
    return 'arket svarade inte i tid, gör om ändringen';
  if (c === 'SERVER_ERROR' || low === 'serverfel')
    return 'arket svarade med ett fel, gör om ändringen';
  if (!s) return 'okänt fel, skanna om artikeln';
  return s;
}

function buildSyncBadgeModel(counts) {
  const c = counts || {};
  const links = c.links || 0, singles = c.singles || 0, queue = c.queue || 0, warn = c.warn || 0;
  const failed = c.failed || 0;
  const total = links + singles + queue;
  // P3a: rött har FÖRETRÄDE och kräver INTE att något ligger kvar i köerna.
  // Den gamla ordningen ("total <= 0 → dold" FÖRE warn-grenen) gjorde varje
  // avvisad skrivning osynlig, eftersom rejected-grenarna i Save.logSingle /
  // Save.create / Save.linkTag avregistrerar jobbet i SAMMA andetag som de
  // failar — total är alltså noll precis i det ögonblick felet uppstår.
  // warn + failed summeras: båda betyder "nådde inte arket", och båda kräver
  // samma sak av användaren (titta i historiken).
  const red = warn + failed;
  if (red > 0) return { visible: true, warn: true, text: red + ' kunde inte sparas – tryck här' };
  if (total <= 0) return { visible: false, warn: false, text: '' };
  const noun = (links === total)
    ? (total === 1 ? 'koppling' : 'kopplingar')
    : (total === 1 ? 'ändring' : 'ändringar');
  return { visible: true, warn: false, text: total + ' ' + noun + ' synkas…' };
}
// ---- slut kopia ----

let pass = 0, fail = 0;
function eq(got, want, msg) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + ' (fick ' + g + ', ville ' + w + ')'); }
}

/* ------------------------------------------------------------------ *
 * Simulator: speglar app.js:s koppling mellan fail-grenarna, den
 * beständiga räknaren (_failedWrites) och badgen. Ett "utfall" är
 * (cls, retryRegistered) — exakt de två uppgifter varje callsite i
 * app.js lämnar till countsAsLostWrite.
 * ------------------------------------------------------------------ */
function runPass(outcomes, queues) {
  let failed = 0;
  for (const o of outcomes) {
    if (countsAsLostWrite(o.cls, o.retryRegistered)) failed += (o.n || 1);
  }
  const q = queues || {};
  return {
    failed,
    badge: buildSyncBadgeModel({
      links: q.links || 0, singles: q.singles || 0, queue: q.queue || 0,
      warn: q.warn || 0, failed
    })
  };
}

/* ================================================================== *
 * 1. RÄKNAREN GÅR UPP VID VERKLIGA FEL — och badgen blir faktiskt röd
 *    fast köerna är tomma. Detta är hela poängen; går detta test rätt
 *    men badgen ändå döljs är vakten dödkod.
 * ================================================================== */
console.log('\n1. Verkliga fel → röd badge');

// Save.logSingle rejected: servern avvisade (t.ex. STALE_ROW) och jobbet
// raderas ur _pendingLogSingle → inget re-försök, ingenting i kön.
eq(runPass([{ cls: 'rejected', retryRegistered: false }], {}),
   { failed: 1, badge: { visible: true, warn: true, text: '1 kunde inte sparas – tryck här' } },
   'avvisad singel-registrering med TOM kö → röd badge (inte dold)');

// Save.linkTag rejected: tag-krock. Kopplingen är rullad tillbaka.
eq(runPass([{ cls: 'rejected', retryRegistered: false }], {}).badge.warn, true,
   'avvisad koppling → röd');

// Save.create rejected: t.ex. SHEET_HEADER_BROKEN — artikeln finns inte i arket.
eq(runPass([{ cls: 'rejected', retryRegistered: false }], {}).failed, 1,
   'avvisad ny artikel → räknas');

// commitContainerDate pending-retry: datumvägen registrerar INGET resync-jobb,
// så ett uttömt nätfel där är ett slutgiltigt tapp (till skillnad från
// logSingle, som har en kö).
eq(runPass([{ cls: 'pending-retry', retryRegistered: false }], {}).failed, 1,
   'datumändring utan kö, uttömt nätfel → räknas');

// _renderBatchOutcome_: batchen re-köar inte failade jobb (ALLVARLIG #10).
eq(runPass([{ cls: 'rejected', retryRegistered: false, n: 3 }], {}),
   { failed: 3, badge: { visible: true, warn: true, text: '3 kunde inte sparas – tryck här' } },
   '3 avvisade rader i en batch → 3 i räknaren');

// Flera fel i samma pass summeras och blandas med warn-facket.
eq(runPass([{ cls: 'rejected', retryRegistered: false },
            { cls: 'rejected', retryRegistered: false }], { singles: 1, warn: 1 }),
   { failed: 2, badge: { visible: true, warn: true, text: '3 kunde inte sparas – tryck här' } },
   'två permanenta fel + ett uppgivet kö-jobb → 3 i badgen');

/* ================================================================== *
 * 2. RÄKNAREN GÅR INTE UPP VID NORMAL DRIFT
 * ================================================================== */
console.log('\n2. Normal drift → ingen röd badge');

// Lyckad skrivning.
eq(runPass([{ cls: 'verified', retryRegistered: false }], {}),
   { failed: 0, badge: { visible: false, warn: false, text: '' } },
   'bekräftad skrivning → räknaren står still, badgen dold');

// Offline-skanning: jobbet ligger i _pendingLogSingle och tas av resync-svepet.
eq(runPass([{ cls: 'pending-retry', retryRegistered: true }], { singles: 1 }),
   { failed: 0, badge: { visible: true, warn: false, text: '1 ändring synkas…' } },
   'köad offline-skanning → gul "synkas", INTE röd');

// Offline-koppling: samma sak via _pendingTagLinks.
eq(runPass([{ cls: 'pending-retry', retryRegistered: true }], { links: 1 }),
   { failed: 0, badge: { visible: true, warn: false, text: '1 koppling synkas…' } },
   'köad offline-koppling → gul, INTE röd');

// Oväntat throw i logSingle: jobbet registreras ändå för resync
// (markLogFail(le, err, { retryable: true })).
eq(runPass([{ cls: 'rejected', retryRegistered: true }], { singles: 1 }).failed, 0,
   'oväntat kast MEN jobbet köat → räknas inte');

// Hela flödet: jobbet köas (fördröjt) och lyckas i nästa försök.
// Detta är exakt det scenario ägaren pekade ut som "inte ett fel".
const attempt1 = runPass([{ cls: 'pending-retry', retryRegistered: true }], { singles: 1 });
const attempt2 = runPass([{ cls: 'verified', retryRegistered: false }], {});
eq({ ett: attempt1.failed, tva: attempt2.failed, badge: attempt2.badge.visible },
   { ett: 0, tva: 0, badge: false },
   'köat → lyckas vid omförsök → aldrig rött, badgen slocknar');

// Batch utan fel.
eq(runPass([], { queue: 2 }),
   { failed: 0, badge: { visible: true, warn: false, text: '2 ändringar synkas…' } },
   'inget fel alls → gul synkas-text oförändrad');

/* ================================================================== *
 * 3. KVITTERING: badgen nollas när användaren tryckt — men bara den
 *    permanenta delen. Kö-jobb som gett upp hoppet är fortfarande
 *    osparade och får inte tystas av en knapptryckning.
 * ================================================================== */
console.log('\n3. Kvittering');

eq(buildSyncBadgeModel({ links: 0, singles: 0, queue: 0, warn: 0, failed: 0 }),
   { visible: false, warn: false, text: '' },
   'efter tryck (failed nollad, inga kö-jobb) → badgen slocknar');

eq(buildSyncBadgeModel({ links: 0, singles: 1, queue: 0, warn: 1, failed: 0 }),
   { visible: true, warn: true, text: '1 kunde inte sparas – tryck här' },
   'efter tryck men uppgivet kö-jobb kvar → förblir röd (ingen falsk trygghet)');

/* ================================================================== *
 * 4. KLARSPRÅK: råa feltexter ska bli begripliga och säga vad man gör.
 * ================================================================== */
console.log('\n4. Klarspråk');

eq(humanizeSaveError('Två artiklar utan kod heter likadant på fliken och går inte att skilja åt. Ge artikeln ett eget namn eller en kod.', 'ROW_UNVERIFIED'),
   'två artiklar utan kod heter likadant på fliken, ge artikeln ett eget namn eller en kod', 'B1: dubblettnamn får ett eget besked');
eq(humanizeSaveError('stale row', 'STALE_ROW'),
   'raden hade flyttat sig i arket, skanna om artikeln', '"stale row" → klarspråk');
eq(humanizeSaveError('stale row'),
   'raden hade flyttat sig i arket, skanna om artikeln', 'stale utan kod → samma text');
eq(humanizeSaveError('Failed to fetch'),
   'ingen kontakt med arket, gör om ändringen när du är online', 'Chrome-nätfel → klarspråk');
eq(humanizeSaveError('Load failed'),
   'ingen kontakt med arket, gör om ändringen när du är online', 'Safari-nätfel → klarspråk');
eq(humanizeSaveError('The network connection was lost.'),
   'ingen kontakt med arket, gör om ändringen när du är online', 'iOS-nätfel → klarspråk');
eq(humanizeSaveError('Tagg ej hittad.', 'NOT_FOUND'),
   'artikeln hittades inte i arket, skanna om den', 'NOT_FOUND → klarspråk');
eq(humanizeSaveError('Flik finns inte: Steg 2', 'SHEET_MISSING'),
   'fliken finns inte längre i arket, kontrollera artikelns plats', 'SHEET_MISSING → klarspråk');
eq(humanizeSaveError('Rubrikraden saknas i fliken "Mat" — artikeln kunde inte skapas.', 'SHEET_HEADER_BROKEN'),
   'arkets rubrikrad känns inte igen, välj en annan flik', 'trasig rubrikrad → klarspråk');
eq(humanizeSaveError('Server upptagen, försök igen', 'LOCK_TIMEOUT'),
   'arket var upptaget, gör om ändringen', 'LOCK_TIMEOUT → klarspråk');
eq(humanizeSaveError('serverfel'),
   'arket svarade med ett fel, gör om ändringen', '"serverfel" → klarspråk');
eq(humanizeSaveError(''),
   'okänt fel, skanna om artikeln', 'tom text → begripligt fallback');
eq(humanizeSaveError(null, null),
   'okänt fel, skanna om artikeln', 'null → ingen krasch');
eq(humanizeSaveError('Artikeln har flyttats i arket. Ladda om listan och försök igen.', 'ROW_UNVERIFIED'),
   'artikeln har flyttats i arket, ladda om listan och försök igen', 'ROW_UNVERIFIED → klarspråk');
eq(humanizeSaveError('Artikeln finns inte längre i arket. Ladda om listan.', 'ITEM_NOT_FOUND'),
   'artikeln finns inte längre i arket, ladda om listan', 'ITEM_NOT_FOUND → klarspråk');
eq(humanizeSaveError('Koden används redan av en annan artikel i arket. Ingen ny artikel skapades.', 'TAG_EXISTS'),
   'koden används redan av en annan artikel, ingen ny artikel skapades', 'TAG_EXISTS → klarspråk');
// Servern skickar redan läsbar svenska i vissa fall — den ska INTE svälјas.
eq(humanizeSaveError('Taggen är redan kopplad till: Yogamatta', 'TAG_COLLISION'),
   'Taggen är redan kopplad till: Yogamatta', 'begripligt server-meddelande släpps igenom');

console.log('\n' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
