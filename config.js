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
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbxxoUERGN9gxfK9Xtkjm4MvsXZpAJ_LRpkmVVvRZwldXOTXkCs81wZx804aM8ilKkB1/exec',

  // Header photographs. Leave as-is unless you rename the files.
  PRABHUPADA_IMG: 'Srila_Prabhupada.jpeg',
  GURUDEVA_IMG:   'Gurudeva.jpeg',

  // How often each device re-checks for other people's sales.
  AUTO_REFRESH_SECONDS: 15

};
