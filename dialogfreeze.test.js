/* node dialogfreeze.test.js — verifierar bug 3.1-fixen: ny-artikel-dialogen
   låser sig (3 fält disablade) efter radering + ny skanning av samma tag.

   Rotorsak: delete-flödet (deleteBtn.onclick) frös HELA dlg via
   dlg.querySelectorAll("button,input,textarea,select") — vilket svepte in de
   PERMANENTA #newItemFields-noderna (#manualUnit/#manualPlace/#manualCategory
   m.fl.) som bara .hidden-togglas och återanvänds av ALLA dialoger.
   Success-vägen efter lyckad delete anropade aldrig thawDialog() (bara
   error/catch gjorde det) → permanenta noder förblev disablade →
   nästa prepareNewItemDialog gav 3 låsta fält. Appomstart byggde om DOM.

   Fixarna (app.js):
   1. thawDialog() anropas nu även på delete-SUCCESS-vägen (symmetriskt).
   2. resetDialog() kör unfreezeStale(dlg) — idempotent säkerhetsnät som
      re-enablar varje nod med dataset._wasDisabled och rensar flaggan.
   3. computeFreezeSet(extra, dlgBtns) ersätter dlg.querySelectorAll(...) —
      bara .extraFields-fält + aktiva dlgBtns fryses, ALDRIG #newItemFields.

   computeFreezeSet/unfreezeStale nedan är KOPIERADE ORDAGRANT från app.js.
   Håll i synk. (Samma mönster som swupdate.test.js / findtag.test.js —
   DOM kan ej köras lokalt i Node, så vi testar den extraherade logiken mot
   en minimal fake-element-harness; ingen jsdom-dependency i projektet.) */

// ---- Kopierat ORDAGRANT från app.js ----
function computeFreezeSet(extra, dlgBtns){
  const set = [];
  const sel = "button, input, textarea, select";
  if (extra) extra.querySelectorAll(sel).forEach(el => set.push(el));
  if (dlgBtns) dlgBtns.querySelectorAll(sel).forEach(el => { if (!set.includes(el)) set.push(el); });
  return set;
}
function unfreezeStale(root){
  if (!root) return;
  root.querySelectorAll('[data-_was-disabled]').forEach(el => {
    el.disabled = el.dataset._wasDisabled === "1";
    delete el.dataset._wasDisabled;
  });
}

// ---- Minimal fake-DOM ----
// El: tag-namn, disabled-flagga, dataset (camelCase _wasDisabled <-> attribut
// [data-_was-disabled]), barn. querySelectorAll stöder bara de selektorer
// koden faktiskt använder: form-tagg-listan + [data-_was-disabled].
class El {
  constructor(tag, children = []) {
    this.tag = tag;
    this.disabled = false;
    this.dataset = {};
    this.children = children;
  }
  _all() {
    const out = [];
    const walk = n => { for (const c of n.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelectorAll(sel) {
    const FORM = new Set(["button", "input", "textarea", "select"]);
    if (sel === "[data-_was-disabled]") {
      return this._all().filter(n => "_wasDisabled" in n.dataset);
    }
    return this._all().filter(n => FORM.has(n.tag));
  }
}

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log("  PASS " + msg); }
  else { fail++; console.log("  FAIL " + msg); }
}

// Bygg en dlg som speglar verklig struktur:
//   dlg
//     #newItemFields (permanent)  → manualName(input), manualType(select),
//                                    manualUnit(select), manualPlace(select),
//                                    manualCategory(select)
//     extra .extraFields (dynamisk) → placeEdit(select), deleteItemBtn(button)
//     dlgBtns                       → saveBtn(button), cancelBtn(button)
function buildDlg() {
  const manualName = new El("input");
  const manualType = new El("select");
  const manualUnit = new El("select");
  const manualPlace = new El("select");
  const manualCategory = new El("select");
  const newItemFields = new El("div",
    [manualName, manualType, manualUnit, manualPlace, manualCategory]);

  const placeEdit = new El("select");
  const deleteBtn = new El("button");
  const extra = new El("div", [placeEdit, deleteBtn]);

  const saveBtn = new El("button");
  const cancelBtn = new El("button");
  const dlgBtns = new El("div", [saveBtn, cancelBtn]);

  const dlg = new El("div", [newItemFields, extra, dlgBtns]);
  return { dlg, newItemFields, extra, dlgBtns,
    manualUnit, manualPlace, manualCategory, manualName,
    placeEdit, deleteBtn, saveBtn, cancelBtn };
}

// Speglar delete-flödets frys+thaw (app.js): frys = sätt _wasDisabled +
// disabled=true; thaw = återställ disabled + rensa flaggan.
function freeze(nodes) {
  nodes.forEach(el => { el.dataset._wasDisabled = el.disabled ? "1" : "0"; el.disabled = true; });
}
function thaw(nodes) {
  nodes.forEach(el => { el.disabled = el.dataset._wasDisabled === "1"; delete el.dataset._wasDisabled; });
}

console.log("computeFreezeSet — permanenta #newItemFields fryses ALDRIG");
{
  const d = buildDlg();
  const set = computeFreezeSet(d.extra, d.dlgBtns);
  ok(!set.includes(d.manualUnit), "manualUnit (permanent) ej i freeze-set");
  ok(!set.includes(d.manualPlace), "manualPlace (permanent) ej i freeze-set");
  ok(!set.includes(d.manualCategory), "manualCategory (permanent) ej i freeze-set");
  ok(!set.includes(d.manualName), "manualName (permanent) ej i freeze-set");
  ok(set.includes(d.deleteBtn), "deleteBtn (extra) ÄR i freeze-set (intent bevaras)");
  ok(set.includes(d.placeEdit), "placeEdit (extra) ÄR i freeze-set");
  ok(set.includes(d.saveBtn), "saveBtn (dlgBtns) ÄR i freeze-set (hindrar Spara under radering)");
  ok(set.includes(d.cancelBtn), "cancelBtn (dlgBtns) ÄR i freeze-set");
}

console.log("FAILING-BEFORE: gamla breda svepet skulle frusit permanenta noder");
{
  // Simulera den GAMLA buggen: dlg.querySelectorAll(form) → manual* fryses,
  // success-vägen missar thaw → permanenta noder fortfarande disablade.
  const d = buildDlg();
  const oldFrozen = d.dlg.querySelectorAll("button, input, textarea, select");
  ok(oldFrozen.includes(d.manualUnit),
    "(bekräftar buggen) gamla svepet INKLUDERADE manualUnit");
  freeze(oldFrozen);
  // success-väg utan thaw (gammalt beteende):
  ok(d.manualUnit.disabled === true,
    "(bekräftar buggen) manualUnit förblir disablad utan thaw → låst ny-artikel");
}

console.log("FIX #1: thaw på success-vägen återställer allt fryst");
{
  const d = buildDlg();
  const frozen = computeFreezeSet(d.extra, d.dlgBtns);
  freeze(frozen);
  ok(d.deleteBtn.disabled === true, "deleteBtn fryst under radering");
  thaw(frozen); // success-vägen anropar nu detta
  ok(d.deleteBtn.disabled === false, "deleteBtn återställd efter success-thaw");
  ok(!("_wasDisabled" in d.deleteBtn.dataset), "_wasDisabled rensad på deleteBtn");
  ok(!("_wasDisabled" in d.saveBtn.dataset), "_wasDisabled rensad på saveBtn");
  ok(d.manualUnit.disabled === false, "manualUnit aldrig rörd → fortfarande fri");
}

console.log("FIX #2: unfreezeStale är idempotent säkerhetsnät");
{
  const d = buildDlg();
  // Värsta fall: en delete-väg frös permanenta noder OCH missade thaw
  // (motsvarar läckage förbi den nya scopingen). resetDialog ska städa.
  const leaked = [d.manualUnit, d.manualPlace, d.manualCategory];
  freeze(leaked);
  ok(d.manualUnit.disabled === true && "_wasDisabled" in d.manualUnit.dataset,
    "förutsättning: läckt fruset state finns");
  unfreezeStale(d.dlg); // resetDialog kör detta vid varje uppbyggnad
  ok(d.manualUnit.disabled === false, "manualUnit re-enablad av unfreezeStale");
  ok(d.manualPlace.disabled === false, "manualPlace re-enablad");
  ok(d.manualCategory.disabled === false, "manualCategory re-enablad");
  ok(!("_wasDisabled" in d.manualUnit.dataset), "_wasDisabled rensad → inget läckage kvar");

  // Dubbel-anrop får inte skada (idempotens):
  unfreezeStale(d.dlg);
  ok(d.manualUnit.disabled === false, "dubbel unfreezeStale: fortfarande fri");
  ok(d.manualPlace.disabled === false && d.manualCategory.disabled === false,
    "dubbel unfreezeStale: inga sidoeffekter");
}

console.log("FIX #2b: unfreezeStale bevarar äkta _wasDisabled=1 (var disablad innan)");
{
  const d = buildDlg();
  // deleteBtn var legitimt disablad innan frysning (t.ex. canDelete=false).
  d.deleteBtn.disabled = true;
  const frozen = computeFreezeSet(d.extra, d.dlgBtns);
  freeze(frozen); // _wasDisabled="1" för deleteBtn, "0" för övriga
  unfreezeStale(d.dlg);
  ok(d.deleteBtn.disabled === true, "deleteBtn återställs till disablad (var det innan)");
  ok(d.placeEdit.disabled === false, "placeEdit återställs till enabled (var det innan)");
}

console.log("EDGE: unfreezeStale(null) kastar inte");
{
  let threw = false;
  try { unfreezeStale(null); } catch { threw = true; }
  ok(!threw, "unfreezeStale(null) är säker");
  let threw2 = false;
  try { computeFreezeSet(null, null); } catch { threw2 = true; }
  ok(!threw2, "computeFreezeSet(null,null) är säker → tom array");
  ok(computeFreezeSet(null, null).length === 0, "computeFreezeSet(null,null) === []");
}

console.log("\n" + pass + " pass, " + fail + " fail");
process.exit(fail ? 1 : 0);
