#!/bin/sh
payload=$(cat)
model=$(printf '%s' "$payload" | python3 -c "import sys,json; d=json.load(sys.stdin); print((d.get('subagent_model') or '') + ' ' + (d.get('subagent_type') or ''))")
case "$model" in
  *claude*|*sonnet*|*opus*|*computerUse*|*computer-use*|*browser*)
    printf '{"permission":"deny","user_message":"Blocked non-allowed Cloud subagent model/type."}\n'
    ;;
  *)
    printf '{"permission":"allow"}\n'
    ;;
esac
