#!/usr/bin/env bash
# SUPERSEDED 2026-07-01: this script used to restore the destructive
# scan-replace tier, which is now BANNED ("replace is banned; merge at most" —
# Greene St incident). Delegates to the merge-at-most recovery so any
# muscle-memory invocation applies the CORRECT code.
exec /home/workspace/project-tinyworld/.route-backups/reapply-merge-routes.sh "$@"
