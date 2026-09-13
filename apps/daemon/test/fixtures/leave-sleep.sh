#!/bin/sh
# leave.test.ts G: a long shell job that records its pid (LEAVE_PIDS is set on the daemon's env) then sleeps.
echo $$ > "$LEAVE_PIDS/job.pid"
exec sleep "${1:-300}"
