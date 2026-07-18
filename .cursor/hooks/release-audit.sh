#!/bin/bash
set -u

input=$(</dev/stdin)
command=$(node -e '
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => body += chunk);
  process.stdin.on("end", () => {
    try { process.stdout.write(String(JSON.parse(body).command || "")); }
    catch { process.exit(2); }
  });
' <<<"$input") || {
  printf '%s\n' '{"permission":"deny","user_message":"Release audit could not parse the shell command.","agent_message":"The fail-closed release hook rejected an invalid event payload."}'
  exit 0
}

event_cwd=$(node -e '
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => body += chunk);
  process.stdin.on("end", () => {
    try { process.stdout.write(String(JSON.parse(body).cwd || "")); }
    catch { process.exit(2); }
  });
' <<<"$input") || event_cwd=""

if [[ ! "$command" =~ (^|[[:space:]])git[[:space:]]+push([[:space:]]|$) ]] &&
   [[ ! "$command" =~ (^|[[:space:]])(vercel|npx[[:space:]]+vercel)([[:space:]].*)?(deploy|--prod) ]]; then
  printf '%s\n' '{"permission":"allow"}'
  exit 0
fi

# Incident-response exception: the fixed, no-secret maintenance deployment may
# replace production while the main working tree is intentionally under repair.
# No other dirty-tree deploy is allowed.
if [[ "$event_cwd" == */tmp/emergency-lock ]] &&
   [[ "$command" == "npx vercel deploy --prod --yes" ]]; then
  if node --check "$event_cwd/api/locked.js" &&
     node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(p.rewrites?.[0]?.destination!=="/api/locked") process.exit(1)' "$event_cwd/vercel.json"; then
    printf '%s\n' '{"permission":"allow"}'
  else
    printf '%s\n' '{"permission":"deny","user_message":"Emergency lock deployment failed validation.","agent_message":"Repair the fixed maintenance artifact before deploying it."}'
  fi
  exit 0
fi

if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  printf '%s\n' '{"permission":"deny","user_message":"Push/deploy blocked: the working tree is not clean.","agent_message":"Commit or intentionally remove all tracked and untracked changes, then rerun the release audit."}'
  exit 0
fi

if ! npm run audit:prepush >&2; then
  printf '%s\n' '{"permission":"deny","user_message":"Push/deploy blocked: the mandatory pre-push audit failed.","agent_message":"Fix the reported audit failure; do not bypass or weaken the gate."}'
  exit 0
fi

printf '%s\n' '{"permission":"allow"}'
