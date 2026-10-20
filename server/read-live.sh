#!/bin/sh
# Reads the live records with the read-only key (b253); it can never change them.
#   server/read-live.sh state [season id]   a season as Universal sees it
#   server/read-live.sh export              every table, the settings, the people
# Needs TBS_READ_KEY (set in the Claude cloud environment). See server/README.md.
set -e
URL="${TBS_URL:-https://tbs-server.gitagovinda.workers.dev/}"
[ -n "$TBS_READ_KEY" ] || { echo "TBS_READ_KEY is not set (see server/README.md, The read-only key)." >&2; exit 1; }
WHAT="${1:-state}"
if [ -n "$2" ]; then BODY="{\"action\":\"readOnly\",\"what\":\"$WHAT\",\"season\":\"$2\"}"
else BODY="{\"action\":\"readOnly\",\"what\":\"$WHAT\"}"; fi
curl -sS --fail-with-body -X POST "$URL" -H "Authorization: Bearer $TBS_READ_KEY" -H 'Content-Type: application/json' -d "$BODY"
