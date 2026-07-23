#!/bin/bash
set -uo pipefail
CONFIG_JSON="${CONFIG_JSON:-/opt/rocket-plus/config.json}"
PANEL_URL=$(jq -r '.panel_url // empty' "$CONFIG_JSON")
API_TOKEN=$(jq -r '.api_token // empty' "$CONFIG_JSON")
TIMEOUT=5
LOG_FILE="/var/log/unified-session.log"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $*" >> "$LOG_FILE"
}

# escape json string
json_escape() {
    echo "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/g' | tr -d '\n' | sed 's/\\n$//'
}

# deterministic session id: same input -> same id, so connect & disconnect
# events for the same session line up without needing local state/storage
gen_session_id() {
    echo -n "$1" | sha256sum | cut -c1-16
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
    ovpn_ip="${untrusted_ip:-${trusted_ip:-}}"
    ovpn_port="${untrusted_port:-${trusted_port:-}}"
    ip=$(json_escape "$ovpn_ip")

    # NOTE: common_name is NOT reliably set at the user-pass-verify stage
    # (only later, e.g. client-connect) — use username instead, which is
    # guaranteed present here and matches what the node agent uses
 session_key="${username:-}:${ovpn_ip}:${ovpn_port}"
    session_id=$(gen_session_id "$session_key")

    jsonData=$(printf '{"protocol":"%s","username":"%s","password":"%s","ip":"%s","session_id":"%s","bytes_received":"%s","bytes_sent":"%s"}' \
        "$protocol" \
        "$user" \
        "$pass" \
        "$ip" \
        "$session_id" \
        "${bytes_received:-0}" \
        "${bytes_sent:-0}"
    )

# ────────────────────────────────────────────
# SSH / PAM
# ────────────────────────────────────────────
elif [ -n "${PAM_TYPE:-}" ]; then
    protocol="ssh"
    user="${PAM_USER:-}"

    if ! id -nG "$user" 2>/dev/null | grep -qw "rocket"; then
        exit 0
    fi

    case "$PAM_TYPE" in
        auth)          endpoint="connect"    ;;
        close_session) endpoint="disconnect" ;;
        *)             exit 0 ;;
    esac

    ip="${PAM_RHOST:-}"
    client_port=""
    if [ -n "${SSH_CONNECTION:-}" ]; then
        # SSH_CONNECTION="client_ip client_port server_ip server_port"
        read -r conn_ip client_port _ <<< "$SSH_CONNECTION"
         [ -z "$ip" ] && ip="$conn_ip"
    fi

    session_key="${user}:${ip}:${client_port}"
    session_id=$(gen_session_id "$session_key")

    user=$(json_escape "$user")
    ip=$(json_escape "$ip")

    jsonData=$(printf '{"protocol":"%s","username":"%s","ip":"%s","session_id":"%s"}' "$protocol" "$user" "$ip" "$session_id")
else
    exit 0
fi

# ────────────────────────────────────────────
# Send to panel
# ────────────────────────────────────────────
apiUrl="${PANEL_URL}/session/${endpoint}"
response=$(curl -s -o /dev/null -w "%{http_code}" \
    -m "$TIMEOUT" \
    -X POST \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $API_TOKEN" \
    -d "$jsonData" \
    "$apiUrl" 2>/dev/null) || response="000"

log "protocol=$protocol user=$user endpoint=$endpoint ip=$ip port=${ovpn_port:-${client_port:-}} session_id=$session_id response=$response"

[ "$endpoint" = "disconnect" ] && exit 0
[ "$response" = "200" ] && exit 0

log "AUTH FAILED: user=$user response=$response"
exit 1
