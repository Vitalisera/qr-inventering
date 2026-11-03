// A02 (Astra-audit 2026-11-03): experimentsidor får inte ligga på produktionsorigin.
// vision-poc-v4.html tog en valfri API-adress och skrev svaret oescapat med innerHTML,
// på samma origin som appen (= samma localStorage, samma köer). Allt som serveras
// från detta repo är produktion, så testet läser git:s spårade filer, inte disken.
const { execSync } = require('child_process');
const tracked = execSync('git ls-files', { cwd: __dirname, encoding: 'utf8' }).split('\n').filter(Boolean);
const poc = tracked.filter(f => /(^|\/)(vision-)?poc[^/]*\.html$/i.test(f));
if (poc.length) { console.error('RÖTT: POC-sidor på produktionsorigin:', poc.join(', ')); process.exit(1); }
console.log('GRÖNT: inga POC-sidor spåras (' + tracked.length + ' filer kontrollerade)');
