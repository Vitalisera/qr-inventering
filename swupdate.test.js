/* node swupdate.test.js — verifierar beslutslogiken för SW-uppgraderingsknappen.

   Bakgrund (intermittent "knappen gör inget" i PWA:n):
   Rotorsak #1: knappens onclick var `if (reg?.waiting) postMessage else
   forceUpdate()`. Bannern triggas också av changelog-poll med reg=null →
   ALLTID forceUpdate() (unregister alla SW + radera caches + reload). Det
   race:ade pågående SW-install och på iOS Safari HTTP-cachades samma gamla
   app.js → banner kom tillbaka.
   Rotorsak #2: clients.claim() i sw.js → controllerchange fyrar EN gång, ev.
   före klick. Senare SKIP_WAITING till en waiting som inte finns = no-op,
   ingen ny controllerchange → ingen reload.

   Fixen: knapp-onclick hämtar FÄRSK registrering vid klick och kör en ren
   beslutsfunktion. forceUpdate() är nu SISTA utväg (ingen SW alls), inte
   default för reg=null. En fallback-reload-timer (3s) täcker #2.

   decideUpdateAction nedan är KOPIERAD ORDAGRANT från app.js. Håll i synk.
   (Samma mönster som findtag.test.js / latency.test.js — browser/SW kan ej
   köras lokalt i Node, så den testbara logiken extraheras till en ren fn.) */

// ---- Kopierat ordagrant från app.js ----
function decideUpdateAction({ hasRegistration, hasWaiting }) {
  if (!hasRegistration) return 'forceUpdateLastResort';
  if (hasWaiting) return 'skipWaiting';
  return 'updateAndWait';
}

// Modell av onclick-grenvalet INKL fallback-reload-timer. Speglar app.js:
// efter decideUpdateAction sätts en 3s fallback-timer (utom vid last-resort),
// och om controllerchange uteblir inom timeouten reloadas ändå.
function simulateButtonOutcome({ hasRegistration, hasWaiting, controllerchangeFiredWithinTimeout }) {
  const action = decideUpdateAction({ hasRegistration, hasWaiting });
  if (action === 'forceUpdateLastResort') {
    return { action, didForceUpdate: true, didReload: true, fallbackTimerArmed: false };
  }
  // skipWaiting eller updateAndWait → SKIP_WAITING postas + fallback-timer.
  // Om controllerchange fyrar i tid reloadar lyssnaren; annars fallback-timern.
  return {
    action,
    didForceUpdate: false,
    didReload: true,
    fallbackTimerArmed: true,
    reloadVia: controllerchangeFiredWithinTimeout ? 'controllerchange' : 'fallbackTimer',
  };
}

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n     ', e.message); fail++; }
}
function eq(a, b, m) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m || 'eq'}: ${A} !== ${B}`);
}

console.log('SW-uppgraderingsknapp — state-agnostisk beslutslogik');

// --- Rotorsak #1: reg=null får INTE ge forceUpdate som förstaval ---
t('(#1) reg=null (changelog-poll-banner) -> last-resort, INTE förstaval', () => {
  const a = decideUpdateAction({ hasRegistration: false, hasWaiting: false });
  eq(a, 'forceUpdateLastResort', 'ingen SW = enda kvarvarande väg');
});

t('(#1) reg=null -> last-resort men ingen mjuk väg förbigås (det FINNS ingen SW)', () => {
  const o = simulateButtonOutcome({ hasRegistration: false, hasWaiting: false, controllerchangeFiredWithinTimeout: false });
  eq(o.action, 'forceUpdateLastResort', 'last-resort');
  eq(o.didForceUpdate, true, 'forceUpdate körs bara här');
});

t('(#1-kontrast) reg finns men ingen waiting -> update+wait, INTE forceUpdate', () => {
  // Detta är exakt det fall gamla koden bröt mot: reg.waiting saknas men en
  // SW finns → gamla koden körde forceUpdate (race + iOS-cache). Nu: mjuk väg.
  const a = decideUpdateAction({ hasRegistration: true, hasWaiting: false });
  eq(a, 'updateAndWait', 'SW finns -> uppdatera o vänta in ny waiting');
  const o = simulateButtonOutcome({ hasRegistration: true, hasWaiting: false, controllerchangeFiredWithinTimeout: true });
  eq(o.didForceUpdate, false, 'forceUpdate ska INTE köras när SW finns');
});

// --- Mjuk väg: waiting finns -> SKIP_WAITING ---
t('(soft) reg.waiting finns -> skipWaiting (postMessage)', () => {
  eq(decideUpdateAction({ hasRegistration: true, hasWaiting: true }), 'skipWaiting', 'waiting -> postMessage');
});

t('(soft) ingen waiting -> updateAndWait (reg.update + vänta in waiting)', () => {
  eq(decideUpdateAction({ hasRegistration: true, hasWaiting: false }), 'updateAndWait', 'ingen waiting -> update+wait');
});

// --- Rotorsak #2: bränd/utebliven controllerchange -> fallback-reload ---
t('(#2) controllerchange uteblir inom timeout -> reload ändå via fallbackTimer', () => {
  const o = simulateButtonOutcome({ hasRegistration: true, hasWaiting: true, controllerchangeFiredWithinTimeout: false });
  eq(o.didReload, true, 'reload sker även utan controllerchange');
  eq(o.reloadVia, 'fallbackTimer', 'fallback-timern täcker redan-claimad-fallet');
  eq(o.fallbackTimerArmed, true, 'fallback-timer måste vara armerad på mjuk väg');
});

t('(#2) controllerchange fyrar i tid -> reload via lyssnaren (timer är no-op pga guard)', () => {
  const o = simulateButtonOutcome({ hasRegistration: true, hasWaiting: true, controllerchangeFiredWithinTimeout: true });
  eq(o.reloadVia, 'controllerchange', 'normal väg när controllerchange fungerar');
});

t('(#2) updateAndWait + utebliven controllerchange -> fallbackTimer', () => {
  const o = simulateButtonOutcome({ hasRegistration: true, hasWaiting: false, controllerchangeFiredWithinTimeout: false });
  eq(o.reloadVia, 'fallbackTimer', 'även update-vägen skyddas av fallback-timern');
});

// --- Last-resort armerar INTE fallback-timern (location.reload sker direkt) ---
t('(guard) last-resort armerar ingen fallback-timer (reload sker i forceUpdate)', () => {
  const o = simulateButtonOutcome({ hasRegistration: false, hasWaiting: false, controllerchangeFiredWithinTimeout: false });
  eq(o.fallbackTimerArmed, false, 'ingen extra timer behövs när forceUpdate redan reloadar');
});

console.log(`\n${pass}/${pass + fail} passerade`);
process.exit(fail ? 1 : 0);
