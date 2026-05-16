/* node autosaveflush.test.js — verifierar bug 5.2-fixen: tyst förlust av
   "antal som ska finnas"-edits vid swipe mellan flera artikelkort i följd.

   Rotorsak: prepareContainerDialogs autosave-debounce (_autoSaveTimer +
   autoSaveExtra) är CLOSURE-LOKAL. resetDialog (toppnivå, ingen closure-
   åtkomst) rensade bara _aiSuggestTimer. minQty-fältets blur startar en
   300 ms debounce. Swipe-touchend river .extraFields + bygger nästa kort
   efter ~200 ms — INNAN debouncen fyrar. Den orphanade autoSaveExtra läste
   sedan #minQtyEdit (= NÄSTA kortets fält, ofta 0/tomt) men byggde payloaden
   med STALE closure-tag/_sn/_rn (gamla artikeln) → queueUpdate skrev fel/0
   till fel rad, backend returnerade {ok:true} → falsk "Synkroniserad".
   Edits på artikel 2 och 3 tappades.

   Fixarna (app.js):
   1. resetDialog kör _pendingAutoSaveFlush() SYNKRONT före DOM-teardown
      (closure-tag + rätt DOM ännu giltiga) och nollar handtaget — symmetriskt
      med hur _aiSuggestTimer redan rensas. Ingen orphanad debounce kan fyra.
   2. scheduleAutoSave registrerar denna dialogs flushAutoSave i det globala
      _pendingAutoSaveFlush-handtaget; flushAutoSave clearTimeout:ar
      _autoSaveTimer + committar mot DENNA closures tag.
   3. autoSaveCommitDecision: debounce-vägen (isFlush=false) committar BARA om
      live-dialogen fortfarande visar closure-tag — annars (navigerat bort)
      skippas allt så ingen payload byggs mot fel korts DOM.

   autoSaveCommitDecision nedan är KOPIERAD ORDAGRANT från app.js. Håll i
   synk. (Samma mönster som dialogfreeze.test.js / latency.test.js — DOM kan
   ej köras lokalt i Node, så vi modellerar swipe-racet med en minimal
   fake-harness; ingen jsdom-dependency i projektet.) */

// ---- Kopierat ORDAGRANT från app.js ----
function autoSaveCommitDecision(closureTag, liveDialogTag, isFlush){
  if (isFlush) return { commit: true, tag: closureTag };
  if (liveDialogTag !== closureTag) return { commit: false, tag: null };
  return { commit: true, tag: closureTag };
}

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log("  PASS " + msg); }
  else { fail++; console.log("  FAIL " + msg); }
}

// ---- Harness: modellerar app.js-mekaniken (closure-debounce + global flush
// + resetDialog-teardown-ordning), tillräckligt för att bevisa fixen. ----
//
// writes[] = vad backend skulle få (queueUpdate-anrop): { tag, minQty }.
// Varje "kort" har sitt DOM-värde i liveDom[tag].minQty. autoSaveExtra läser
// LIVE-dom (som den riktiga koden via qs("#minQtyEdit")) → bevisar att en
// fel-timad autosave bygger payload mot fel kort.
function makeApp() {
  const app = {
    writes: [],
    liveDom: {},            // tag -> { minQty }  (vad #minQtyEdit visar just nu)
    currentDialogTag: null,
    _pendingAutoSaveFlush: null,
    _timers: [],            // pending setTimeout-callbacks (manuell klocka)
  };

  // resetDialog: flush FÖRE teardown (app.js-ordning), sedan "river DOM".
  app.resetDialog = (nextTag) => {
    if (app._pendingAutoSaveFlush) {
      const f = app._pendingAutoSaveFlush; app._pendingAutoSaveFlush = null;
      try { f(); } catch {}
    }
    // teardown: gamla kortets fält finns inte längre; nästa kort byggs.
    if (nextTag != null) app.currentDialogTag = nextTag;
  };

  // prepareContainerDialog: skapar EN ny closure (tag/_sn/_rn) med egen
  // _autoSaveTimer + flushAutoSave, exakt som app.js.
  app.openCard = (tag) => {
    app.resetDialog(tag);
    if (app.liveDom[tag] === undefined) app.liveDom[tag] = { minQty: 0 };

    let _autoSaveTimer = null;
    const _sn = "Sheet_" + tag, _rn = 100 + Number(tag);

    const autoSaveExtra = (isFlush) => {
      const d = autoSaveCommitDecision(tag, app.currentDialogTag, isFlush === true);
      if (!d.commit) return;
      // läser LIVE dom (som qs("#minQtyEdit") i app.js):
      const live = app.liveDom[app.currentDialogTag] || app.liveDom[tag] || { minQty: 0 };
      app.writes.push({ tag, sheetName: _sn, rowNum: _rn, minQty: live.minQty,
                        readFromTag: app.currentDialogTag ?? tag });
    };
    const flushAutoSave = () => {
      if (_autoSaveTimer) { app._cancel(_autoSaveTimer); _autoSaveTimer = null; }
      autoSaveExtra(true);
    };
    const scheduleAutoSave = () => {
      if (_autoSaveTimer) app._cancel(_autoSaveTimer);
      app._pendingAutoSaveFlush = flushAutoSave;
      _autoSaveTimer = app._after(300, () => { app._pendingAutoSaveFlush = null; autoSaveExtra(false); });
    };

    return {
      tag,
      // simulerar att användaren skrev ett värde i #minQtyEdit + blur
      editMinQtyAndBlur(val) { app.liveDom[tag].minQty = val; scheduleAutoSave(); },
    };
  };

  // closeDialog → (RAF) resetDialog. Vi kör resetDialog direkt i swipe-steget.
  app.closeDialog = () => { app.currentDialogTag = null; };

  // manuell klocka
  app._after = (ms, cb) => { const t = { ms, cb, dead: false }; app._timers.push(t); return t; };
  app._cancel = (t) => { if (t) t.dead = true; };
  app._tick = (ms) => {
    for (const t of app._timers) { if (!t.dead) t.ms -= ms; }
    const due = app._timers.filter(t => !t.dead && t.ms <= 0);
    app._timers = app._timers.filter(t => !t.dead && t.ms > 0);
    due.forEach(t => t.cb());
  };

  return app;
}

console.log("autosaveflush.test.js — bug 5.2 (tyst batch-förlust vid swipe)\n");

// --- Test 1: ren beslutslogik (autoSaveCommitDecision) ---
{
  console.log("autoSaveCommitDecision:");
  let d = autoSaveCommitDecision("A", "A", false);
  ok(d.commit === true && d.tag === "A", "debounce, samma kort öppet → committa mot A");
  d = autoSaveCommitDecision("A", "B", false);
  ok(d.commit === false && d.tag === null, "debounce, navigerat till B → skippa (orphan-skydd)");
  d = autoSaveCommitDecision("A", null, false);
  ok(d.commit === false, "debounce, dialog stängd (null) → skippa");
  d = autoSaveCommitDecision("A", null, true);
  ok(d.commit === true && d.tag === "A", "flush committar ALLTID mot closure-tag (currentDialogTag kan vara null)");
  d = autoSaveCommitDecision("A", "B", true);
  ok(d.commit === true && d.tag === "A", "flush ignorerar live-tag, använder closure-tag");
}

// --- Test 2: FAILING-BEFORE-modell — orphanad timer utan flush/guard ---
// Bevisar att UTAN fixen (ingen resetDialog-flush, ingen guard) skriver den
// orphanade timern fel rad/0-värde. Vi emulerar pre-fix genom att kalla
// autoSaveExtra(false) men med guarden bortkopplad.
{
  console.log("\nFailing-before (pre-fix-modell):");
  const writes = [];
  const liveDom = { "1": { minQty: 0 }, "2": { minQty: 0 } };
  let cur = "1";
  const _sn = "Sheet_1", _rn = 101, closureTag = "1";
  // pre-fix autoSaveExtra: ingen decision-guard, läser live-dom
  const preFixOrphan = () => {
    const live = liveDom[cur] || { minQty: 0 };
    writes.push({ tag: closureTag, rowNum: _rn, minQty: live.minQty });
  };
  // användaren skrev 7 på kort 1, swipe → cur=2 (kort 2 tomt=0), DÅ fyrar timern
  liveDom["1"].minQty = 7;
  cur = "2";
  preFixOrphan();
  ok(writes.length === 1 && writes[0].tag === "1" && writes[0].rowNum === 101 && writes[0].minQty === 0,
     "PRE-FIX: orphan skriver kort1:s rad MEN med kort2:s DOM-värde (0) → edit (7) TAPPAD");
}

// --- Test 3: PASSING-AFTER — full swipe-sekvens med fixen ---
// Användaren ändrar "antal som ska finnas" på tre kort i följd via swipe.
{
  console.log("\nPassing-after (med fixen) — swipe A1→A2→A3:");
  const app = makeApp();

  // Öppna kort 1, ändra minQty=7, blur (300ms debounce armas)
  let c = app.openCard("1");
  c.editMinQtyAndBlur(7);
  ok(app._pendingAutoSaveFlush !== null, "kort1: pending flush registrerad");

  // Swipe efter 200 ms (debounce ej fyrad än): closeDialog → resetDialog(nästa)
  app._tick(200);
  app.closeDialog();                 // currentDialogTag = null
  app.resetDialog("2");              // flush kör SYNKRONT före teardown
  c = app.openCard("2");             // bygger nästa kort (egen closure)
  ok(app.writes.length === 1, "kort1 committad EXAKT en gång vid kortbyte");
  ok(app.writes[0].tag === "1" && app.writes[0].rowNum === 101 && app.writes[0].minQty === 7,
     "kort1 skrevs mot RÄTT rad (101) med RÄTT värde (7)");

  // Den gamla (kort1) debounce-timern får INTE orphanas och fyra mot kort2
  app._tick(500);
  ok(app.writes.length === 1, "kort1:s gamla timer fyrar ALDRIG efter resetDialog (orphan eliminerad)");

  // Kort 2: ändra minQty=3, blur, swipe vidare till kort 3
  c.editMinQtyAndBlur(3);
  app._tick(200);
  app.closeDialog();
  app.resetDialog("3");
  c = app.openCard("3");
  ok(app.writes.length === 2 && app.writes[1].tag === "2" && app.writes[1].rowNum === 102 && app.writes[1].minQty === 3,
     "kort2 committad mot RÄTT rad (102) värde (3) — edit ej tappad");

  // Kort 3: ändra minQty=9, blur, STÄNG (utan swipe)
  c.editMinQtyAndBlur(9);
  app._tick(150);
  app.closeDialog();
  app.resetDialog(null);             // ren stängning → flush före teardown
  ok(app.writes.length === 3 && app.writes[2].tag === "3" && app.writes[2].rowNum === 103 && app.writes[2].minQty === 9,
     "kort3 committad vid stängning utan swipe — edit ej tappad");

  app._tick(500);
  ok(app.writes.length === 3, "inga extra/dubbla skrivningar (ingen dubbelfyrning)");
  // Ingen skrivning fick fel readFromTag (= byggd mot fel korts DOM)
  ok(app.writes.every(w => String(w.readFromTag) === String(w.tag)),
     "ingen payload byggdes mot fel/annat korts DOM");
}

// --- Test 4: NORMALFLÖDE bevarat — ändra fält, vänta (ingen swipe) ---
{
  console.log("\nNormalflöde bevarat (edit → blur → debounce → save):");
  const app = makeApp();
  const c = app.openCard("5");
  c.editMinQtyAndBlur(4);
  app._tick(300);                    // debounce fyrar normalt, dialog öppen
  ok(app.writes.length === 1 && app.writes[0].tag === "5" && app.writes[0].minQty === 4,
     "vanlig autosave fungerar oförändrat (debounce committar mot öppet kort)");
  ok(app._pendingAutoSaveFlush === null, "timern nollar handtaget när den fyrar normalt");
  app.resetDialog(null);
  app._tick(500);
  ok(app.writes.length === 1, "ingen extra flush-skrivning efter att timern redan committat (ingen dubbelfyrning)");
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
