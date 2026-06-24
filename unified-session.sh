#!/bin/bash
set -uo pipefail

PANEL_BASE_URL="{ApiUrl}"
API_KEY="{ApiKey}"
TIMEOUT=5
LOG_FILE="/var/log/unified-session.log"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $*" >> "$LOG_FILE"
}

# escape json string
json_escape() {
    echo "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/g' | tr -d '\n' | sed 's/\\n$//'
}

# ────────────────────────────────────────────
# OpenVPN
# ────────────────────────────────────────────
if [ -n "${script_type:-}" ]; then
    protocol="openvpn"

    case "$script_type" in
        user-pass-verify)  endpoint="connect"    ;;
        client-disconnect) endpoint="disconnect" ;;
        client-connect)    exit 0 ;;
        *)                 exit 0 ;;
    esac

    user=$(json_escape "${username:-}")
    pass=$(json_escape "${password:-}")

    jsonData=$(printf '{"protocol":"%s","username":"%s","password":"%s","bytes_received":"%s","bytes_sent":"%s"}' \
        "$protocol" \
        "$user" \
        "$pass" \
        "${bytes_received:-0}" \
        "${bytes_sent:-0}"
    )

# ────────────────────────────────────────────
# SSH / PAM
# ────────────────────────────────────────────
elif [ -n "${PAM_TYPE:-}" ]; then
    protocol="ssh"
    user="${PAM_USER:-}"

    # فقط کاربران گروه rocket
    if ! id -nG "$user" 2>/dev/null | grep -qw "rocket"; then
        exit 0
    fi

    case "$PAM_TYPE" in
        auth)          endpoint="connect"    ;;
        close_session) endpoint="disconnect" ;;
        *)             exit 0 ;;
    esac

    user=$(json_escape "$user")
    jsonData=$(printf '{"protocol":"%s","username":"%s"}' "$protocol" "$user")

else
    exit 0
fi

# ────────────────────────────────────────────
# Send to panel
# ────────────────────────────────────────────
apiUrl="${PANEL_BASE_URL}/${endpoint}"

response=$(curl -s -o /dev/null -w "%{http_code}" \
    -m "$TIMEOUT" \
    -X POST \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $API_KEY" \
    -d "$jsonData" \
    "$apiUrl" 2>/dev/null) || response="000"

log "protocol=$protocol user=$user endpoint=$endpoint response=$response"

[ "$endpoint" = "disconnect" ] && exit 0
[ "$response" = "200" ] && exit 0

log "AUTH FAILED: user=$user response=$response"
exit 1

