/* ============================================================
   Transcendental Book Sales — local settings
   ------------------------------------------------------------
   This is the ONLY file that holds your Apps Script address.
   Keep it out of any copy/paste update: when you push a new
   index.html to GitHub, leave this file exactly as it is and
   the tracker stays connected to the same Sheet and the same
   data.
   ============================================================ */

window.TBS_CONFIG = {

  // Apps Script web-app address, ending in /exec.
  /* The app's server (Phase 3: the records live on Cloudflare since the
     switch). The Google address it replaced, for going back:
     https://script.google.com/macros/s/AKfycbzzCqbbHIihpCZAiAAWbcCg-zwDxsi0vrV0tUxuDhygRALckkSpPZIvk_UcSxW0U8oU/exec */
  APPS_SCRIPT_URL: 'https://tbs-server.gitagovinda.workers.dev/',

  // The owner's app signs in with Google (links never do).
  GOOGLE_CLIENT_ID: '29414235907-a1hvfe3pq2707vbu8bbkfc2hude19o41.apps.googleusercontent.com',

  // Header photographs. Leave as-is unless you rename the files.
  PRABHUPADA_IMG: 'Srila_Prabhupada.jpeg',
  GURUDEVA_IMG:   'Gurudeva.jpeg',

  // How often each device re-checks for other people's sales.
  AUTO_REFRESH_SECONDS: 15

};
