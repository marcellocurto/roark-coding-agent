#!/bin/sh
# Test-only gh responses for issue snapshot and dependency recovery checks.
case "$1 $2" in
  "issue view")
    case "$*" in
      *stateReason,closed,closedAt*) response=blocker ;;
      *) response=issue ;;
    esac
    ;;
  "api repos/owner/repo/issues/12") response=summary ;;
  "api repos/owner/repo/issues/12/dependencies/blocked_by") response=blocked-by ;;
  "api repos/owner/repo/issues/12/dependencies/blocking") response=blocking ;;
  *) exit 64 ;;
esac
cat "$(dirname "$0")/$response.json"
