// Sets an account's gold / silver (and optionally power-up stock) on the server. STOP the server first, run this, start the server again.
//   node set-balance.js <email-or-10-digit-mobile> <gold> <silver> [swap pinwheel flowerpot insecticide weedkiller]
// Coins are earned minus spent, so this changes "spent" (and raises "earned" if you ask for more than was ever earned).
const fs = require('fs'), path = require('path');
const FILE = process.env.DATA_FILE || path.join(__dirname, 'anicrash-data.json');
const [id0, gold, silver, ...stock] = process.argv.slice(2);
if (!id0 || gold === undefined || silver === undefined) { console.log('usage: node set-balance.js <email-or-mobile> <gold> <silver> [5 stock numbers]'); process.exit(1); }
let id = id0.trim(); if (id.includes('@')) id = id.toLowerCase(); else { id = id.replace(/\D/g, ''); id = id.length > 10 ? id.slice(-10) : id; }
const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const u = data.users[id];
if (!u) { console.log('No such account: ' + id + '. Accounts: ' + Object.keys(data.users).join(', ')); process.exit(1); }
const have = () => 'gold ' + Math.max(0, (u.goldEarned || 0) - (u.goldSpent || 0)) + ' silver ' + Math.max(0, (u.silverEarned || 0) - (u.silverSpent || 0)) + ' | earned ' + u.goldEarned + '/' + u.silverEarned + ' spent ' + (u.goldSpent || 0) + '/' + (u.silverSpent || 0) + ' | stock ' + [u.stockSwap, u.stockPin, u.stockPot, u.stockInsect, u.stockWeed];
console.log('before:', have());
const g = Math.max(0, Math.trunc(+gold)), s = Math.max(0, Math.trunc(+silver));
u.goldEarned = Math.max(u.goldEarned || 0, g); u.goldSpent = u.goldEarned - g;
u.silverEarned = Math.max(u.silverEarned || 0, s); u.silverSpent = u.silverEarned - s;
if (stock.length === 5) [u.stockSwap, u.stockPin, u.stockPot, u.stockInsect, u.stockWeed] = stock.map(v => Math.max(0, Math.trunc(+v)));
fs.copyFileSync(FILE, FILE + '.backup');
fs.writeFileSync(FILE, JSON.stringify(data));
console.log('after: ', have(), '\n(backup saved as ' + FILE + '.backup)');
