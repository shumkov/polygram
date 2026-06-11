#!/bin/bash
# Background monitor for the shumabit production fleet (post 0.12.0-rc.27 + channels
# enable for Ivan DM + Shumabit@UMI). Polls both bot DBs over ssh every 60s and
# echoes NEW error/wedge/feature events + substantial outbound duplication on the
# cli chats. Echoes re-invoke the agent (notification); silence = healthy.
HOST=shumabit@127.0.0.1
SEEN_EV=$(mktemp)
SEEN_DUP=$(mktemp)
echo "[shumabit prod monitor armed] watching shumabit + umi-assistant (errors/wedges/features + cli dup). silent = healthy."

while true; do
  # --- error/wedge/feature events on both bots ---
  for db in shumabit umi-assistant; do
    out=$(ssh "$HOST" "sqlite3 -separator '|' ~/polygram/$db.db < /tmp/mon-events.sql" 2>/dev/null)
    while IFS='|' read -r id rest; do
      [ -z "$id" ] && continue
      key="$db:$id"
      if ! grep -qxF "$key" "$SEEN_EV"; then
        echo "$key" >> "$SEEN_EV"
        echo "[$db] $rest"
      fi
    done <<< "$out"
  done
  # --- substantial identical-outbound duplication on the cli chats (shumabit only) ---
  dup=$(ssh "$HOST" "sqlite3 -separator '|' ~/polygram/shumabit.db < /tmp/mon-dup.sql" 2>/dev/null)
  while IFS='|' read -r mid rest; do
    [ -z "$mid" ] && continue
    if ! grep -qxF "$mid" "$SEEN_DUP"; then
      echo "$mid" >> "$SEEN_DUP"
      echo "[shumabit DUP] msg $mid | $rest"
    fi
  done <<< "$dup"
  sleep 60
done
