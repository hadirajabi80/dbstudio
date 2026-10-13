// Fixture renderer used by test/smoke.test.mjs and `npm run start:fake`.
document.getElementById('status').textContent = window.dbstudio ? `bridge ${window.dbstudio.appVersion}` : 'no bridge';
window.dbstudio?.onMenuCommand((cmd) => { document.getElementById('status').textContent = `menu: ${cmd}`; });
