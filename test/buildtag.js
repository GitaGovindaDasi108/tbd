/* b336: the page's version (#bld in index.html) and the server's (SERVER_BUILD
   in Code.gs) must be the same number. If the server is ahead, every refresh
   shows "A newer version of the app is out" and refreshing can never clear it
   (Gita's iPhone after b335). Raise both together in every build. */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const page = (/id="bld"[^>]*>(b\d+)</.exec(fs.readFileSync(path.join(root, 'index.html'), 'utf8')) || [])[1];
const server = (/var SERVER_BUILD = '(b\d+)'/.exec(fs.readFileSync(path.join(root, 'Code.gs'), 'utf8')) || [])[1];
const ok = !!page && page === server;
console.log((ok ? '  ok  ' : '  FAIL ') + 'page build ' + page + ' = server build ' + server);
console.log(ok ? 'buildtag: all 1 passed' : 'buildtag: 1 of 1 failed (raise #bld in index.html and SERVER_BUILD in Code.gs together)');
process.exit(ok ? 0 : 1);
