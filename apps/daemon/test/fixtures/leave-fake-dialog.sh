#!/bin/sh
# leave.test.ts: stand-in for osascript / zenity so no real OS dialog ever appears.
# A dialog records its pid and hangs; anything else (e.g. a notification) records its pid and exits.
case "$*" in
  *"display dialog"*|*--question*) echo $$ >> "$LEAVE_PIDS/dialog.pids"; exec sleep 300 ;;
  *) echo $$ >> "$LEAVE_PIDS/other.pids"; exit 0 ;;
esac
