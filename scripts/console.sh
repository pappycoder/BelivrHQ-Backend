#!/usr/bin/env bash
# Interactive operations console. Bash 3.2+; Node 20.19+/22.12+.
set +x  # Never trace secret-bearing prompts or stdin pipes.
set -uo pipefail
umask 077
OPS_CALLER_DIR=$(pwd -P)
OPS_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P) || exit 1
OPS_ENV_FILE="$OPS_ROOT/.env"
OPS_MANAGER=npm
OPS_DRY_RUN=0
OPS_SINGLE_ACTION=''
ops_help() {
  cat <<'HELP'
BelivrHQ Backend interactive operations console
Usage: bash scripts/console.sh [--env FILE] [--manager npm|pnpm] [--dry-run]
       bash scripts/console.sh [options] --action ACTION
       bash scripts/console.sh --list
Options:
  --env FILE       Select dotenv file; it overrides inherited values, never executes shell code.
  --manager NAME   Choose npm (default) or pnpm.
  --dry-run        Print the selected action plan without any commands/network/writes.
  --action ACTION  Run one menu action; confirmations and hidden passwords still apply.
  --list           List all action IDs.
  --help           Show this help.
Migrations and account creation are backend-only and require confirmation.
HELP
}
OPS_LIST=0
while (($#)); do
  case "$1" in
    --help|-h) ops_help; exit 0 ;;
    --env|--manager|--action)
      [[ $# -ge 2 && -n "$2" ]] || { printf 'Missing value for %s\n' "$1" >&2; exit 2; }
      case "$1" in
        --env) case "$2" in /*) OPS_ENV_FILE=$2 ;; *) OPS_ENV_FILE="$OPS_CALLER_DIR/$2" ;; esac ;;
        --manager) [[ "$2" == npm || "$2" == pnpm ]] || { printf 'Choose npm or pnpm.\n' >&2; exit 2; }; OPS_MANAGER=$2 ;;
        --action) OPS_SINGLE_ACTION=$2 ;;
      esac
      shift 2 ;;
    --dry-run) OPS_DRY_RUN=1; shift ;;
    --list) OPS_LIST=1; shift ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
command -v node >/dev/null 2>&1 || { printf 'Install Node.js 20.19+ or 22.12+ first.\n' >&2; exit 1; }
cd -- "$OPS_ROOT" || exit 1
ops_helper() { node "$OPS_ROOT/scripts/ops/cli.cjs" "$OPS_ENV_FILE" "$OPS_MANAGER" "$@"; }
ops_read() {
  printf '%s' "$1" >&2
  IFS= read -r OPS_ANSWER || return 130
}
ops_confirm() {
  printf '\nType exactly: %s\n' "$1" >&2
  ops_read '> ' || return 130
  if [[ "$OPS_ANSWER" != "$1" ]]; then printf 'Cancelled; confirmation did not match.\n' >&2; return 130; fi
  OPS_CONFIRM=$OPS_ANSWER
}
ops_admin() {
  local action=$1 email password='' repeated='' first last phone church_mode church_id='' church_name='' auth_mode auth_id='' token role
  ops_helper preview "$action" || return $?
  printf '\nAccount mode: 1) NEW login (default)  2) Link ORPHAN auth UUID (no existing profile)\n'
  ops_read 'Choice [1]: ' || return 130
  case "$OPS_ANSWER" in ''|1) auth_mode=new ;; 2) auth_mode=existing ;; *) printf 'Invalid account mode.\n' >&2; return 2 ;; esac
  ops_read 'Email: ' || return 130; email=$OPS_ANSWER
  if [[ "$auth_mode" == new ]]; then
    printf 'Password (12+ chars; upper/lower/number/symbol; hidden): ' >&2
    IFS= read -r -s password || { printf '\n' >&2; return 130; }; printf '\n' >&2
    printf 'Repeat password (hidden): ' >&2
    IFS= read -r -s repeated || { printf '\n' >&2; return 130; }; printf '\n' >&2
    [[ "$password" == "$repeated" ]] || { printf 'Passwords do not match.\n' >&2; return 2; }
  else
    ops_read 'Existing Supabase auth user UUID: ' || return 130; auth_id=$OPS_ANSWER
  fi
  ops_read 'First name: ' || return 130; first=$OPS_ANSWER
  ops_read 'Last name: ' || return 130; last=$OPS_ANSWER
  ops_read 'Phone (optional): ' || return 130; phone=$OPS_ANSWER
  printf '\nChurch: 1) Existing church  2) Create a new church\n'
  ops_read 'Choice: ' || return 130
  case "$OPS_ANSWER" in
    1) church_mode=existing; ops_read 'Church UUID: ' || return 130; church_id=$OPS_ANSWER ;;
    2) church_mode=new; ops_read 'New church name: ' || return 130; church_name=$OPS_ANSWER ;;
    *) printf 'Invalid church mode.\n' >&2; return 2 ;;
  esac
  role=church_admin; [[ "$action" != admin-super ]] || role=super_admin
  printf '\nReview: role=%s, email=%s, church=%s %s, auth=%s\nHQ scope: all branches WITHIN this church, subject to role permissions.\n' "$role" "$email" "$church_id" "$church_name" "$auth_mode"
  token=$(ops_helper token "$action") || return $?
  ops_confirm "$token" || return $?
  printf '%s\0' "$OPS_CONFIRM" "$email" "$password" "$first" "$last" "$phone" "$church_mode" "$church_id" "$church_name" "$auth_mode" "$auth_id" | ops_helper run "$action"
}
ops_subscription() {
  local action=$1 email plan cycle members='' staff='' locations='' choice token limits
  ops_helper preview "$action" || return $?
  ops_read 'User email: ' || return 130; email=$OPS_ANSWER
  printf '\nPlan: 1) essentials  2) community  3) network  4) enterprise\n'
  ops_read 'Choice: ' || return 130
  case "$OPS_ANSWER" in
    1) plan=essentials ;; 2) plan=community ;; 3) plan=network ;; 4) plan=enterprise ;;
    *) printf 'Invalid plan.\n' >&2; return 2 ;;
  esac
  printf '\nCycle: 1) monthly (default)  2) annual\n'
  ops_read 'Choice [1]: ' || return 130
  case "$OPS_ANSWER" in ''|1) cycle=monthly ;; 2) cycle=annual ;; *) printf 'Invalid cycle.\n' >&2; return 2 ;; esac
  if [[ "$plan" == enterprise ]]; then
    ops_read 'Enterprise member limit: ' || return 130; members=$OPS_ANSWER
    ops_read 'Enterprise staff limit: ' || return 130; staff=$OPS_ANSWER
    ops_read 'Enterprise location limit: ' || return 130; locations=$OPS_ANSWER
    limits=", members=$members staff=$staff locations=$locations"
  else
    limits=''
  fi
  printf '\nReview: email=%s, plan=%s/%s%s\nThis immediately replaces that church'\''s subscription; scheduled changes are cleared.\n' "$email" "$plan" "$cycle" "$limits"
  token=$(ops_helper token "$action") || return $?
  ops_confirm "$token" || return $?
  printf '%s\0' "$OPS_CONFIRM" "$email" "$plan" "$cycle" "$members" "$staff" "$locations" | ops_helper run "$action"
}
ops_dispatch() {
  local action=$1 input token
  input=$(ops_helper input "$action") || return $?
  if ((OPS_DRY_RUN)); then ops_helper plan "$action"; return $?; fi
  case "$input" in
    admin) ops_admin "$action" ;;
    subscription) ops_subscription "$action" ;;
    confirm)
      ops_helper preview "$action" || return $?
      token=$(ops_helper token "$action") || return $?
      ops_confirm "$token" || return $?
      printf '%s\0' "$OPS_CONFIRM" | ops_helper run "$action" ;;
    port)
      ops_read 'Port [3000]: ' || return 130
      printf '%s\0' "${OPS_ANSWER:-3000}" | ops_helper run "$action" ;;
    none) ops_helper run "$action" ;;
    *) printf 'Unsupported input mode.\n' >&2; return 2 ;;
  esac
}
# Keep the terminal UI small; the helpers parse dotenv safely and protect DB/auth work.
RESET='' BOLD='' CYAN='' GREEN='' YELLOW='' RED='' DIM=''
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  RESET=$'\033[0m'; BOLD=$'\033[1m'; CYAN=$'\033[36m'
  GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; DIM=$'\033[2m'
fi
ops_title() { printf '\n%b== %s%b\n\n' "$BOLD$CYAN" "$1" "$RESET"; }
ops_pause() { ops_read 'Press Enter to continue… ' || return 130; }
ops_result() {
  local status=$1
  case "$status" in
    0) printf '\n%bFinished OK.%b\n' "$GREEN" "$RESET" ;;
    130) printf '\n%bAction cancelled.%b\n' "$YELLOW" "$RESET" ;;
    *) printf '\n%bCommand exited %s. The menu remains available.%b\n' "$RED" "$status" "$RESET" >&2 ;;
  esac
}
trap 'printf "\nInterrupted; returning to console when the foreground action exits.\n" >&2' INT
if ((OPS_LIST)); then ops_helper list; exit $?; fi
if [[ -n "$OPS_SINGLE_ACTION" ]]; then
  # Single actions use the same prompts as the menu.
  ops_dispatch "$OPS_SINGLE_ACTION"; OPS_STATUS=$?; ops_result "$OPS_STATUS"; exit "$OPS_STATUS"
fi
while true; do
  ops_title 'BelivrHQ Backend'
  printf '%bEnv: %s | %s%b\n\n' "$DIM" "$OPS_ENV_FILE" "$OPS_MANAGER" "$RESET"
  cat <<'MENU'
  [1] Dev build (watch)
  [2] Production build
  [3] Test
  [4] Deploy migrations
  [5] Create super user
  [6] Create church admin
  [7] Switch subscription
  [q] Quit
MENU
  ops_read '> ' || exit 0
  case "$OPS_ANSWER" in
    1) ops_dispatch dev ;;
    2) ops_dispatch build ;;
    3) ops_dispatch test ;;
    4) ops_dispatch migration-deploy ;;
    5) ops_dispatch admin-super ;;
    6) ops_dispatch admin-church ;;
    7) ops_dispatch subscription-switch ;;
    q|Q|0) printf 'Bye!\n'; exit 0 ;;
    *) printf 'Choose a listed number.\n'; continue ;;
  esac
  OPS_STATUS=$?; ops_result "$OPS_STATUS"
  ops_pause || exit 0
done
