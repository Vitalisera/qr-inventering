/* identity.test.js — v160 (A03–A06): artikelidentiteten på klienten.
   Speglar _isSynthKey_, _captureIdentity_, _hasIdentity_, _attachIdentity_ och
   _attachIdentityForSend_ ur app.js (testdrift.check.js vakar över kopiorna).
   Kärnregeln: identiteten fångas när användaren agerar och skrivs aldrig över;
   ett äldre jobb på en SYNTETISK nyckel får ingen identitet i efterhand.
   Kör: node identity.test.js */
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const tagCache = new Map();

function _isSynthKey_(tag) { return /^S[A-Za-z]/.test(String(tag == null ? '' : tag)); }
function _identityOfItem_(e) {
  const out = {};
  if (e && e.id) out.id = e.id;
  const nm = e ? (e.serverName != null ? e.serverName : e.name) : null;
  if (nm) out.expectedName = String(nm).trim();
  return out;
}
function _captureIdentity_(tag) {
  const e = tagCache.get(tag);
  const out = {};
  if (e && e.id) out.id = e.id;
  const nm = e ? (e.serverName != null ? e.serverName : e.name) : null;
  if (nm) out.expectedName = String(nm).trim();
  return out;
}
function _adoptServerIdentity_(key, item, server) {
  if (!server) return false;
  if (!_isSynthKey_(key)) return true;                       // riktig tagg = beständig
  if (item.id && server.id) return item.id === server.id;    // båda har ID
  if (item.serverName == null) return true;                  // optimistisk post, aldrig sett arket
  return String(item.serverName) === String(server.serverName);
}
function _hasIdentity_(o) { return !!o && (o.id !== undefined || o.expectedName !== undefined); }
function _attachIdentity_(o, tag, allowSynthetic) {
  if (!o || _hasIdentity_(o)) return o;
  if (!allowSynthetic && _isSynthKey_(tag)) return o;
  Object.assign(o, _captureIdentity_(tag));
  return o;
}
const _IDENTITY_DIRECT_FNS_ = { updateMeta: 1, updateName: 1, deleteItem: 1, updateCount: 1 };
function _attachIdentityForSend_(fn, params) {
  if (!params || !_IDENTITY_DIRECT_FNS_[fn]) return;
  if (fn === 'updateMeta') { if (params.args) _attachIdentity_(params.args, params.tag, false); return; }
  _attachIdentity_(params, params.tag, false);
}

const _renamesInFlight_ = new Map();
function _beginRename_(tag, oldName, newName) {
  let settle; const done = new Promise(r => { settle = r; });
  const entry = { oldName, newName, done };
  _renamesInFlight_.set(tag, entry);
  return ok => { if (_renamesInFlight_.get(tag) === entry) _renamesInFlight_.delete(tag); settle(!!ok); };
}
function _identityTargets_(fn, params) {
  if (!params || fn === 'updateName') return [];
  if (fn === 'batch') return (params.batch || []).filter(j => j && j.args).map(j => [j.args.tag, j.args]);
  if (fn === 'updateMeta') return params.args ? [[params.tag, params.args]] : [];
  if (fn === 'logTag' || fn === 'addTag' || _IDENTITY_DIRECT_FNS_[fn]) return [[params.tag, params]];
  return [];
}
async function _awaitRenames_(fn, params, capMs = 45000) {
  for (const [tag, o] of _identityTargets_(fn, params)) {
    const e = _renamesInFlight_.get(tag);
    if (!e) continue;
    let timer;
    const ok = await Promise.race([e.done, new Promise(r => { timer = setTimeout(() => r(false), capMs); })]);
    clearTimeout(timer);
    if (ok && o.expectedName === e.oldName) o.expectedName = e.newName;
  }
}

console.log('Identitet fångas vid handlingen:');
tagCache.set('SMatR5', { name: 'Krattor', serverName: 'Krattor', id: 'id-A' });
const job = { tag: 'SMatR5', newCount: 3 };
_attachIdentity_(job, 'SMatR5', true);
ok(job.id === 'id-A' && job.expectedName === 'Krattor', 'köat jobb får id och namn när det läggs i kön');
// Radförskjutning: samma syntetiska nyckel pekar nu på en annan artikel.
tagCache.set('SMatR5', { name: 'Penna', serverName: 'Penna', id: 'id-B' });
_attachIdentity_(job, 'SMatR5', false);
ok(job.id === 'id-A' && job.expectedName === 'Krattor', 'identiteten skrivs inte över efter en ny lista');

console.log('Äldre jobb utan identitet:');
const legacySynth = { tag: 'SMatR5', newCount: 3 };
_attachIdentity_(legacySynth, 'SMatR5', false);
ok(!_hasIdentity_(legacySynth), 'syntetisk nyckel får ingen identitet i efterhand (servern nekar synligt)');
tagCache.set('7310', { name: 'Te', id: 'id-T' });
const legacyReal = { tag: '7310', newCount: 1 };
_attachIdentity_(legacyReal, '7310', false);
ok(legacyReal.id === 'id-T' && legacyReal.expectedName === 'Te', 'riktig tagg får identitet i efterhand (taggen är beständig)');

console.log('Namnet i arket, inte det lokala:');
tagCache.set('7311', { name: 'Nytt namn', serverName: 'Gammalt namn', id: null });
const r = {}; _attachIdentity_(r, '7311', true);
ok(r.expectedName === 'Gammalt namn' && !('id' in r), 'expectedName = serverName, inget id utan ID-kolumn');

console.log('Direkta anrop:');
const meta = { tag: '7310', args: { comment: 'x' } };
_attachIdentityForSend_('updateMeta', meta);
ok(meta.args.id === 'id-T' && !('id' in meta), 'updateMeta får identiteten i args, där servern läser den');
const del = { tag: '7310' }; _attachIdentityForSend_('deleteItem', del);
ok(del.id === 'id-T', 'deleteItem får identitet');
const pre = { tag: '7310' }; _attachIdentityForSend_('preload', pre);
ok(!('id' in pre), 'läsanrop rörs inte');
const retry = { tag: '7310', id: 'id-X', expectedName: 'X' }; _attachIdentityForSend_('updateName', retry);
ok(retry.id === 'id-X', 'ett omförsök behåller den först fångade identiteten');

console.log('Ny lista över en gul rad (initData-sammanslagning):');
// Före migreringen saknar alla rader ID. En rad infogas i arket → under samma
// syntetiska nyckel ligger nu en annan artikel. Den gula raden visar fortfarande
// "Krattor"; tar den över serverns namn skulle nästa ändring skrivas på Penna.
ok(!_adoptServerIdentity_('SMatR5', { name: 'Krattor', serverName: 'Krattor', id: null },
                                    { serverName: 'Penna', id: null }),
   'syntetisk nyckel utan ID: annan artikel → behåller sin egen identitet');
ok(_adoptServerIdentity_('SMatR5', { name: 'Krattor', serverName: 'Krattor', id: null },
                                   { serverName: 'Krattor', id: null }),
   'syntetisk nyckel, samma namn → tar serverns identitet');
ok(!_adoptServerIdentity_('SMatR5', { serverName: 'Krattor', id: 'id-A' }, { serverName: 'Krattor', id: 'id-B' }),
   'olika ID → aldrig samma artikel, även om namnen råkar vara lika');
ok(_adoptServerIdentity_('SMatR5', { name: 'Ny', id: null }, { serverName: 'Ny', id: 'id-N' }),
   'optimistisk post (aldrig sett arket) tar serverns identitet');
ok(_adoptServerIdentity_('7310', { serverName: 'Te gammalt', id: null }, { serverName: 'Te', id: 'id-T' }),
   'riktig tagg: servern vet bäst (namnbyte direkt i arket)');

console.log('B3: dialog öppen, raden flyttas, listan byggs om, radera:');
{
  // initData bygger NYA objekt i tagCache; dialogen håller referensen från öppningen.
  tagCache.clear();
  tagCache.set('SMatR5', { name: 'Krattor', serverName: 'Krattor', id: null, sheetName: 'Mat', rowNum: 5 });
  const item = tagCache.get('SMatR5');                    // prepareContainerDialog(item, tag)
  const _dlgIdent = _identityOfItem_(item);               // fångas vid öppning
  // En rad infogas i arket ovanför. Pollern bygger om cachen: samma syntetiska
  // nyckel pekar nu på en annan artikel.
  tagCache.clear();
  tagCache.set('SMatR5', { name: 'Penna', serverName: 'Penna', id: null, sheetName: 'Mat', rowNum: 5 });
  tagCache.set('SMatR6', { name: 'Krattor', serverName: 'Krattor', id: null, sheetName: 'Mat', rowNum: 6 });
  const del = { tag: 'SMatR5', sheetName: 'Mat', rowNum: 5, ..._dlgIdent };   // dialogens deleteItem
  _attachIdentityForSend_('deleteItem', del);
  ok(del.expectedName === 'Krattor', 'radering bär namnet från när dialogen öppnades (servern nekar Penna)');
  const cnt = { tag: 'SMatR5', newCount: 2, sheetName: 'Mat', rowNum: 5, ..._dlgIdent };
  _attachIdentity_(cnt, 'SMatR5', false);                  // queueUpdate
  ok(cnt.expectedName === 'Krattor', 'saldo från dialogen bär dialogens identitet');
  const bare = { tag: 'SMatR5', sheetName: 'Mat', rowNum: 5 };
  _attachIdentityForSend_('deleteItem', bare);
  ok(!_hasIdentity_(bare), 'syntetisk nyckel slås aldrig upp vid sändning (servern nekar i stället för att gissa)');
  // Källkodsvakt: varje skrivning ur dialogerna skickar den fångade identiteten.
  const src = require('fs').readFileSync(__dirname + '/app.js', 'utf8');
  const must = [
    "gasCall('deleteItem', { tag, sheetName: _sn, rowNum: _rn, ..._dlgIdent })",
    "queueUpdate('updateCount', { tag, newCount: newQty, userName, sheetName: _sn, rowNum: _rn, ..._dlgIdent })",
    "queueUpdate('updateCount', { tag, newCount, userName, sheetName: _sn, rowNum: _rn, ..._dlgIdent })",
    "rowNum: _rn, ..._dlgIdent };\n    if (date) payload.lastYMD",
    "gasCallWithRetry('updateMeta', { tag, args: { ...args, ..._dlgIdent } })",
    "gasCallWithRetry('updateMeta', { tag, args: { ...innerArgs, ..._dlgIdent } })",
    "Save.logSingle(tag, { name: dialogItem.name, sheetName: _sn, rowNum: _rn, ..._dlgIdent })",
    "Save.logSingle(tag, { name: item.name, sheetName: item.sheetName, rowNum: item.rowNum, ..._dlgIdent })",
    "{ ...buildMissingPayload(tag, item, userName), ..._dlgIdent }",
    "const _ident = { ..._dlgIdent };",
    "..._popIdent });",
    "ident: _identityOfItem_(val) });",                         // OFF-förslag
    "...(btn.dataset.id ? { id: btn.dataset.id } : {}),",
    "..._identityOfItem_(val)   // v160: artikeln som visades i sökträffen",
    "Save.logSingle(primaryTag, { ...buildLogSingleTarget(name, cached), ..._identityOfItem_(cached) })",
    "Save.logSingle(finalTag, { ...buildLogSingleTarget(cached.name || name, cached), ..._identityOfItem_(cached) })",
  ];
  const missing = must.filter(m => !src.includes(m));
  ok(missing.length === 0, 'alla dialogskrivningar skickar dialogens identitet' + (missing.length ? ' (saknas: ' + missing.join(' | ') + ')' : ''));
  ok((src.match(/const _dlgIdent = _identityOfItem_\(item\);/g) || []).length === 2, 'identiteten fångas när båda artikeldialogerna öppnas');
}

(async () => {
  console.log('Namnbyte och registrering nästan samtidigt (tagglös artikel utan id):');
  // Användaren döper om Gammal → Ny och trycker Registrera direkt. Båda anropen
  // fångade expectedName = Gammal. Registreringen ska vänta på namnbytet.
  const settle = _beginRename_('STR2', 'Gammal', 'Ny');
  const reg = { tag: 'STR2', name: 'Ny', expectedName: 'Gammal' };
  let sent = false;
  const p = _awaitRenames_('logTag', reg).then(() => { sent = true; });
  await Promise.resolve(); await Promise.resolve();
  ok(!sent, 'registreringen skickas inte medan namnbytet är på väg');
  settle(true);
  await p;
  ok(sent && reg.expectedName === 'Ny', 'bekräftat namnbyte → registreringen förväntar sig det nya namnet');
  const settle2 = _beginRename_('STR2', 'Ny', 'Nyare');
  const cnt = { tag: 'STR2', batch: [{ fnName: 'updateCount', args: { tag: 'STR2', newCount: 2, expectedName: 'Ny' } }] };
  const p2 = _awaitRenames_('batch', cnt);
  settle2(false);
  await p2;
  ok(cnt.batch[0].args.expectedName === 'Ny', 'nekat namnbyte → jobbet behåller det gamla namnet (arket heter fortfarande så)');
  const settle3 = _beginRename_('STR3', 'A', 'B');
  const meta = { tag: 'STR3', args: { comment: 'x', expectedName: 'A' } };
  const p3 = _awaitRenames_('updateMeta', meta); settle3(true); await p3;
  ok(meta.args.expectedName === 'B', 'updateMeta väntar också (identiteten i args)');
  const ren = { tag: 'STR3', newName: 'C', expectedName: 'B' };
  _beginRename_('STR3', 'B', 'C');
  let renSent = false; await _awaitRenames_('updateName', ren).then(() => { renSent = true; });
  ok(renSent, 'namnbytet självt väntar aldrig på sig själv');
  const slow = { tag: 'STR4', expectedName: 'X' };
  _beginRename_('STR4', 'X', 'Y');
  await _awaitRenames_('logTag', slow, 20);
  ok(slow.expectedName === 'X', 'svarar namnbytet aldrig skickas registreringen ändå efter en gräns, med det gamla namnet');
  const src = require('fs').readFileSync(__dirname + '/app.js', 'utf8');
  ok(/async function gasCall\([^)]*\) \{\n  _attachIdentityForSend_\(fn, params\);\n  await _awaitRenames_\(fn, params\);/.test(src),
     'gasCall väntar in pågående namnbyten före varje skrivning');
  ok(src.includes("const _endRename = _beginRename_(tag, _oldName, n);"), 'commitName anmäler namnbytet innan det skickas');
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
