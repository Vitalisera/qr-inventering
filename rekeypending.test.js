/* node rekeypending.test.js — B4 (v151): key-swap S→riktig tagg måste re-keya
   ALLA köade jobb och bevara/fylla koordinater.

   Bakgrund: när en syntetisk nyckel ("S<flik>R<rad>") byts mot res.tag efter
   lyckad koppling re-keyade Save.linkTag bara tagCache/metaCache. Jobb i
   updateQueue (persisterad batch-kö) och _pendingLogSingle som köats mot den
   gamla S-nyckeln fick då cache-miss i _applyBatchResults_ (pendingSync
   rensades aldrig → evig gulmarkering) och resync av logSingle-jobb återskapade
   spöknycklar i tagCache. Dessutom sattes sheetName/rowNum till null i den nya
   cache-posten trots att raden i arket är densamma efter koppling (addTagToRow
   setValue:ar TAG-cellen på angiven rowNum — raden flyttas inte).

   rekeyPendingJobs nedan är KOPIERAD ORDAGRANT från app.js. Håll i synk.
   (Samma mönster som syncgrace/swupdate/findtag.test.js — app.js kan ej köras
   i Node pga browser-globaler, så den testbara logiken extraheras till en ren fn.) */

// ---- Kopierat ordagrant från app.js ----
function rekeyPendingJobs(oldTag, newTag, coords, queueArr, singleMap, linkMap) {
  const c = coords || {};
  const out = { queue: 0, singles: 0, links: 0 };
  if (!oldTag || !newTag || oldTag === newTag) return out;
  // Bundlade updateMeta/updateCount-jobb: nyckelfältet är args.tag.
  for (const j of (queueArr || [])) {
    if (!j || !j.args || j.args.tag !== oldTag) continue;
    j.args.tag = newTag;
    if (j.args.sheetName == null && c.sheetName != null) j.args.sheetName = c.sheetName;
    if (j.args.rowNum == null && c.rowNum != null) j.args.rowNum = c.rowNum;
    out.queue++;
  }
  // Pending singel-registreringar: map-nyckel = tag OCH jobbfält .tag.
  if (singleMap instanceof Map && singleMap.has(oldTag)) {
    const job = singleMap.get(oldTag);
    singleMap.delete(oldTag);
    if (job) {
      job.tag = newTag;
      if (job.sheetName == null && c.sheetName != null) job.sheetName = c.sheetName;
      if (job.rowNum == null && c.rowNum != null) job.rowNum = c.rowNum;
      if (!singleMap.has(newTag)) singleMap.set(newTag, job);
      out.singles++;
    }
  }
  // Pending tag-länkar: map-nyckel = scannedTag (oförändrad), men .currentTag
  // pekar på artikelns cache-nyckel och måste följa med vid swap.
  if (linkMap instanceof Map) for (const job of linkMap.values()) {
    if (!job || job.currentTag !== oldTag) continue;
    job.currentTag = newTag;
    if (job.sheetName == null && c.sheetName != null) job.sheetName = c.sheetName;
    if (job.rowNum == null && c.rowNum != null) job.rowNum = c.rowNum;
    out.links++;
  }
  return out;
}
// ---- slut kopia ----

let pass = 0, fail = 0;
function eq(got, want, msg) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + ' (fick ' + g + ', ville ' + w + ')'); }
}

const S = 'SVerktygsladaR12';
const T = '0959773';
const CO = { sheetName: 'Verktygslåda', rowNum: 12 };

// --- updateQueue: matchande jobb re-keyas, koordinater fylls, övriga orörda ---
{
  const q = [
    { fnName: 'updateMeta',  args: { tag: S, comment: 'hej', sheetName: null, rowNum: null } },
    { fnName: 'updateCount', args: { tag: S, newCount: 3, sheetName: 'Verktygslåda', rowNum: 12 } },
    { fnName: 'updateMeta',  args: { tag: 'ANNAN', comment: 'x', sheetName: 'A', rowNum: 1 } }
  ];
  const n = rekeyPendingJobs(S, T, CO, q, new Map(), new Map());
  eq(n.queue, 2, 'updateQueue: två S-jobb re-keyade');
  eq(q[0].args, { tag: T, comment: 'hej', sheetName: 'Verktygslåda', rowNum: 12 },
     'updateQueue: null-koordinater fylls från coords');
  eq(q[1].args, { tag: T, newCount: 3, sheetName: 'Verktygslåda', rowNum: 12 },
     'updateQueue: befintliga koordinater bevaras');
  eq(q[2].args.tag, 'ANNAN', 'updateQueue: andra taggar orörda');
}

// --- _pendingLogSingle: map-nyckel + .tag byts, koordinater fylls ---
{
  const m = new Map([[S, { tag: S, name: 'Sax', sheetName: null, rowNum: null, retries: 2 }]]);
  const n = rekeyPendingJobs(S, T, CO, [], m, new Map());
  eq(n.singles, 1, 'pendingLogSingle: jobbet re-keyat');
  eq(m.has(S), false, 'pendingLogSingle: gamla S-nyckeln borta');
  eq(m.get(T), { tag: T, name: 'Sax', sheetName: 'Verktygslåda', rowNum: 12, retries: 2 },
     'pendingLogSingle: ny nyckel, koordinater ifyllda, retries bevarad');
}

// --- _pendingLogSingle: befintligt jobb på nya nyckeln klobbas inte ---
{
  const keep = { tag: T, name: 'Behåll' };
  const m = new Map([[S, { tag: S, name: 'Sax' }], [T, keep]]);
  rekeyPendingJobs(S, T, CO, [], m, new Map());
  eq(m.get(T) === keep, true, 'pendingLogSingle: krock → befintligt jobb på nya nyckeln vinner');
  eq(m.has(S), false, 'pendingLogSingle: S-nyckeln raderad även vid krock');
}

// --- _pendingTagLinks: currentTag följer med, map-nyckel (scannedTag) orörd ---
{
  const m = new Map([['111222333', { scannedTag: '111222333', currentTag: S, sheetName: null, rowNum: null, name: 'Sax' }]]);
  const n = rekeyPendingJobs(S, T, CO, [], new Map(), m);
  eq(n.links, 1, 'pendingTagLinks: currentTag re-keyad');
  eq(m.get('111222333').currentTag, T, 'pendingTagLinks: currentTag = nya taggen');
  eq(m.get('111222333').sheetName, 'Verktygslåda', 'pendingTagLinks: koordinater ifyllda');
  eq(m.has('111222333'), true, 'pendingTagLinks: map-nyckeln (scannedTag) oförändrad');
}

// --- Felfall: tomt/null kraschar inte, no-op vid samma tagg ---
{
  eq(rekeyPendingJobs(S, T, null, null, null, null), { queue: 0, singles: 0, links: 0 },
     'null-köer + null-coords = no-op utan krasch');
  eq(rekeyPendingJobs(S, S, CO, [{ args: { tag: S } }], new Map(), new Map()),
     { queue: 0, singles: 0, links: 0 }, 'oldTag === newTag = no-op');
  eq(rekeyPendingJobs('', T, CO, [], new Map(), new Map()),
     { queue: 0, singles: 0, links: 0 }, 'tom oldTag = no-op');
  const q = [null, { fnName: 'x' }, { args: null }];
  eq(rekeyPendingJobs(S, T, CO, q, new Map(), new Map()).queue, 0,
     'trasiga kö-poster (null/utan args) hoppas över utan krasch');
}

console.log('\n' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
