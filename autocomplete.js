/* Autocomplete-engine: substring/prefix-match med viktad Damerau-Levenshtein-fuzzy.
   Synkron, ren funktion. Rekommenderad debounce i UI-lagret: 150–250 ms.
   Ordlistor upp till några tusen ord scannas linjärt utan problem. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Autocomplete = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEYBOARD = [
    '1234567890+',
    'qwertyuiopå',
    'asdfghjklöä',
    'zxcvbnm,.-'
  ];

  const NEIGHBORS = (() => {
    const map = new Map();
    KEYBOARD.forEach((row, ri) => {
      for (let ci = 0; ci < row.length; ci++) {
        const c = row[ci];
        const set = new Set();
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const r = KEYBOARD[ri + dr];
            if (!r) continue;
            const ch = r[ci + dc];
            if (ch) set.add(ch);
          }
        }
        map.set(c, set);
      }
    });
    return map;
  })();

  function neighborCost(a, b) {
    if (a === b) return 0;
    const n = NEIGHBORS.get(a);
    if (n && n.has(b)) return 0.5;
    return 1;
  }

  function distance(a, b) {
    const n = a.length, m = b.length;
    if (!n) return m;
    if (!m) return n;
    const d = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = 0; i <= n; i++) d[i][0] = i;
    for (let j = 0; j <= m; j++) d[0][j] = j;
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const sub = neighborCost(a[i - 1], b[j - 1]);
        d[i][j] = Math.min(
          d[i - 1][j] + 1,
          d[i][j - 1] + 1,
          d[i - 1][j - 1] + sub
        );
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[n][m];
  }

  function norm(s) {
    return String(s == null ? '' : s).toLocaleLowerCase('sv');
  }

  const DEFAULTS = {
    maxSuggestions: 8,
    minPrefixHits: 3,
    fuzzyThreshold: 2.5,
    matchMode: 'substring'
  };

  function suggest(input, words, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const q = norm(input).trim();
    if (!q) return [];
    if (!words || typeof words[Symbol.iterator] !== 'function') return [];

    const seen = new Set();
    const results = [];

    const direct = [];
    for (const w of words) {
      const wn = norm(w);
      if (!wn || seen.has(wn)) continue;
      const hit = o.matchMode === 'prefix' ? wn.startsWith(q) : wn.includes(q);
      if (hit) {
        direct.push(w);
        seen.add(wn);
      }
    }
    direct.sort((a, b) => norm(a).localeCompare(norm(b), 'sv'));
    for (const w of direct) {
      results.push({ word: w, source: 'prefix', distance: 0 });
      if (results.length >= o.maxSuggestions) return results;
    }

    if (q.length < 2) return results;
    if (direct.length >= o.minPrefixHits) return results;

    // Adaptiv tröskel: stoppar att korta queries (4 tecken) matchar allt med 50% fel.
    const effThreshold = Math.min(o.fuzzyThreshold, q.length * 0.4);

    const fuzzy = [];
    for (const w of words) {
      const wn = norm(w);
      if (!wn || seen.has(wn)) continue;
      const d = distance(q, wn);
      if (d <= effThreshold) {
        fuzzy.push({ word: w, distance: d });
        seen.add(wn);
      }
    }
    fuzzy.sort((a, b) => a.distance - b.distance || norm(a.word).localeCompare(norm(b.word), 'sv'));
    for (const f of fuzzy) {
      results.push({ word: f.word, source: 'fuzzy', distance: f.distance });
      if (results.length >= o.maxSuggestions) break;
    }

    return results;
  }

  return { suggest, distance };
});
