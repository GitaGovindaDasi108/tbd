/* The browser tests' own config.js — the real one points at the live server.
   The tests answer anything sent to script.google.com themselves (with
   test/mini.js), so this stands in for "the app on Google, no sign-in". */
window.TBS_CONFIG = {
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/TEST/exec',
  PRABHUPADA_IMG: 'Srila_Prabhupada.jpeg',
  GURUDEVA_IMG:   'Gurudeva.jpeg',
  AUTO_REFRESH_SECONDS: 15
};
