'use strict';
/* appvm.js — laddar den FAKTISKA app.js i en Node-vm, med fetch kopplad till
 * QR-aktuell-riggen (som i sin tur kör den faktiska Code.js). Inga kopior av
 * funktioner: köerna, flushen och resyncen som testas är appens egen kod.
 *
 *   const { loadApp } = require('./appvm');
 *   const app = loadApp({ ls });            // ls = localStorage-innehåll att starta med
 *   app.rig.addSheet(...);                  // riggen bakom fetch
 *   app.run('queueUpdate("updateCount", {...})');   // kör i appens globala scope
 *   app.fetchMode = 'hang' | 'offline' | 'rig';
 *
 * DOM, kamera och tjänstearbetare ersätts av en tålig stubbe som svarar på allt
 * (Proxy). Bara det som påverkar köernas beteende är verkligt: localStorage,
 * timers, fetch och navigator.onLine.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeRig } = require(path.join(__dirname, '..', 'QR-aktuell', 'test', 'gas-rig'));

function stub(name) {
  const store = {};
  const calls = new Map();   // samma anrop (t.ex. querySelector('.icon')) ger samma nod
  const fn = function () {};
  return new Proxy(fn, {
    get(t, k) {
      if (k in store) return store[k];
      if (k === Symbol.toPrimitive) return () => '';
      // Anropsresultat (t.ex. serviceWorker.register()) får .then/.catch som
      // aldrig fyrar: koden kedjar vidare utan att stubben låtsas lyckas.
      if (k === 'then' || k === 'catch' || k === 'finally') return name.endsWith(')') ? () => stub(name + '.' + k + '()') : undefined;
      if (k === 'length') return 0;
      if (k === 'textContent' || k === 'value' || k === 'innerHTML' || k === 'className' || k === 'id') return '';
      if (k === 'dataset' || k === 'style') return (store[k] = {});
      if (k === 'classList') return (store[k] = { add() {}, remove() {}, toggle() {}, contains() { return false; } });
      if (k === 'children' || k === 'childNodes') return [];
      if (k === 'querySelectorAll' || k === 'getElementsByClassName' || k === 'getElementsByTagName') return () => [];
      // Samma egenskap ger samma stubbe: le.querySelector('.icon') två gånger
      // måste vara samma nod, annars försvinner det som skrevs dit.
      return (store[k] = stub(name + '.' + String(k)));
    },
    set(t, k, v) { store[k] = v; return true; },
    apply(t, self, args) {
      const k = String(args && args.length ? args[0] : '');
      if (/createElement$/.test(name)) return stub(name + '(' + k + ')#' + Math.random());   // ny nod varje gång
      if (!calls.has(k)) calls.set(k, stub(name + '(' + k + ')'));
      return calls.get(k);
    },
    construct() { return stub('new ' + name); },
  });
}

function loadApp(opts = {}) {
  const rig = opts.rig || makeRig();
  const lsData = new Map(Object.entries(opts.ls || {}));
  const localStorage = {
    getItem: k => (lsData.has(k) ? lsData.get(k) : null),
    setItem: (k, v) => { lsData.set(k, String(v)); },
    removeItem: k => { lsData.delete(k); },
    clear: () => lsData.clear(),
    key: i => [...lsData.keys()][i] ?? null,
    get length() { return lsData.size; },
  };
  const app = { rig, ls: lsData, fetchMode: 'rig', calls: [], hung: [], timers: new Set(), delays: [] };
  const scale = typeof opts.timeScale === 'number' ? opts.timeScale : 1;
  const navigator = { onLine: true, userAgent: 'node', serviceWorker: stub('sw'), mediaDevices: stub('md'), clipboard: stub('cb') };
  const listeners = {};
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    app.calls.push(body);
    if (app.fetchMode === 'offline') throw new TypeError('Failed to fetch');
    if (app.fetchMode === 'hang') {
      return new Promise((resolve, reject) => {
        const h = { body, resolve: () => resolve(respond(body)), reject };
        app.hung.push(h);
        if (init.signal) init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
      });
    }
    return respond(body);
  };
  function respond(body) {
    const { fn, ...params } = body;
    const out = typeof app.serve === 'function' ? app.serve(fn, params) : rig.api(fn, params);
    return { ok: true, status: 200, text: async () => JSON.stringify(out) };
  }
  const realSetTimeout = setTimeout, realClearTimeout = clearTimeout;
  const win = {
    addEventListener: (ev, f) => { (listeners[ev] = listeners[ev] || []).push(f); },
    removeEventListener() {},
    location: { search: '', href: 'https://vitalisera.github.io/qr-inventering/', reload() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    DEBUG_TAG: false,
  };
  const document = stub('document');
  const ctx = {
    console: opts.quiet === false ? console : { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    localStorage, sessionStorage: localStorage, navigator, fetch, document,
    location: win.location, URLSearchParams, AbortController, TextEncoder, TextDecoder,
    // app.delays sparar de väntetider appen BER om (opts.timeScale krymper den
    // faktiska väntan, så att ett prov av 2 s/5 s/15 s-backoff går på millisekunder).
    setTimeout: (f, ms, ...a) => { app.delays.push({ ms, fn: (f && f.name) || "" }); const t = realSetTimeout(() => { app.timers.delete(t); f(...a); }, (ms || 0) * scale); if (t.unref) t.unref(); app.timers.add(t); return t; },
    clearTimeout: t => { app.timers.delete(t); realClearTimeout(t); },
    setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    performance: { now: () => Date.now() },
    crypto: require('crypto').webcrypto,
    Image: function () { return stub('img'); }, Audio: function () { return stub('audio'); },
    AudioContext: function () { return stub('ac'); }, MutationObserver: function () { return stub('mo'); },
    IntersectionObserver: function () { return stub('io'); }, ResizeObserver: function () { return stub('ro'); },
    ZXing: stub('ZXing'), alert() {}, confirm: () => false, prompt: () => null,
    getComputedStyle: () => stub('cs'), history: stub('history'), screen: stub('screen'),
    Promise, Date, Math, JSON, Map, Set, WeakMap, Array, Object, String, Number, Boolean, Error, TypeError, RegExp, Symbol, Proxy, Reflect, Intl,
  };
  Object.assign(win, ctx);
  ctx.window = win; ctx.self = win; ctx.globalThis = ctx;
  vm.createContext(ctx);
  // opts.appPath: ladda en annan app.js, t.ex. en äldre version ur git, för rött-mot-gammalt-prov.
  const src = fs.readFileSync(opts.appPath || path.join(__dirname, 'app.js'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'app.js' });
  app.ctx = ctx;
  app.navigator = navigator;
  app.run = code => vm.runInContext(code, ctx);
  app.fire = ev => Promise.all((listeners[ev] || []).map(f => f({})));
  app.persisted = k => { const v = lsData.get(k); return v == null ? null : JSON.parse(v); };
  app.settle = (ms = 0) => new Promise(r => realSetTimeout(r, ms));
  app.releaseHung = () => { const h = app.hung.splice(0); h.forEach(x => x.resolve()); return h.length; };
  app.stop = () => { for (const t of app.timers) realClearTimeout(t); app.timers.clear(); };
  return app;
}

module.exports = { loadApp };
