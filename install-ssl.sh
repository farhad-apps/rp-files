#!/bin/bash
#
# install-ssl.sh
#
# Issues a Let's Encrypt SSL certificate for the server's own IP address
# (no domain) using acme.sh in standalone mode, writes cert_key/cert_file
# paths into config.json's agent.api block, and sets up a permanent cron
# job to keep renewing it (IP certs from Let's Encrypt are valid ~6.5 days,
# so we check for renewal every 3 days).
#
# Unlike install-ssh.sh/install-xray.sh/install-ovpn.sh, this script's
# logic must survive after mainscript.sh self-destructs, because the
# renewal cron needs to keep calling it. So this script installs a copy
# of itself (the renew step only) to a permanent location.
#
set -uo pipefail

CONFIG_JSON="${CONFIG_JSON:-/opt/rocket-plus/config.json}"

ACME_HOME="/root/.acme.sh"
ACME_BIN="${ACME_HOME}/acme.sh"

SSL_DIR="/opt/rocket-plus/ssl"
CERT_KEY_PATH="${SSL_DIR}/ip.key"
CERT_FILE_PATH="${SSL_DIR}/ip.cer"

RENEW_DAYS=3

PERMANENT_RENEW_SCRIPT="/opt/rocket-plus/renew-ssl.sh"
CRON_FILE="/etc/cron.d/rocket-plus-ssl-renew"

LOG_PREFIX="[install-ssl]"

log() {
    echo "${LOG_PREFIX} $*"
}

err() {
    echo "${LOG_PREFIX} ERROR: $*" >&2
}

require_root() {
    if [ "$(id -u)" -ne 0 ]; then
        err "this script must be run as root (sudo)."
        exit 1
    fi
}

require_cmd() {
    local cmd="$1"
    if ! command -v "$cmd" >/dev/null 2>&1; then
        err "command '$cmd' not found. Run dependency install step first."
        exit 1
    fi
}

# ──────────────────────────────────────────────
# Load values from config.json
# ──────────────────────────────────────────────
load_config() {
    if [ ! -f "$CONFIG_JSON" ]; then
        err "config.json not found at '$CONFIG_JSON'."
        exit 1
    fi

    require_cmd jq

    PANEL_URL=$(jq -r '.panel_url // empty' "$CONFIG_JSON")
    API_TOKEN=$(jq -r '.api_token // empty' "$CONFIG_JSON")

    if [ -z "$PANEL_URL" ] || [ -z "$API_TOKEN" ]; then
        err "panel_url or api_token is empty in config.json."
        exit 1
    fi
}

# ──────────────────────────────────────────────
# Detect the server's public IP
# ──────────────────────────────────────────────
detect_server_ip() {
    SERVER_IP=$(curl -fsSL https://api.ipify.org || true)

    if [ -z "$SERVER_IP" ]; then
        SERVER_IP=$(curl -fsSL https://ifconfig.me || true)
    fi

    if [ -z "$SERVER_IP" ]; then
        err "could not detect the server's public IP address."
        exit 1
    fi

    log "detected server IP: ${SERVER_IP}"
}

# ──────────────────────────────────────────────
# Install acme.sh if missing
# ──────────────────────────────────────────────
install_acme() {
    if [ -x "$ACME_BIN" ]; then
        log "acme.sh already installed at ${ACME_BIN}."
        return 0
    fi

    log "installing acme.sh..."
    curl -fsSL https://get.acme.sh | sh -s email=admin@rocket-plus.com

    if [ ! -x "$ACME_BIN" ]; then
        err "acme.sh installation failed, binary not found at ${ACME_BIN}."
        exit 1
    fi

    log "acme.sh installed at ${ACME_BIN}."
}

# ──────────────────────────────────────────────
# Make sure port 80 is free (acme.sh standalone mode needs it)
# ──────────────────────────────────────────────
ensure_port_80_free() {
    if ss -ltn 2>/dev/null | grep -q ':80 '; then
        err "port 80 is already in use, acme.sh standalone mode cannot bind to it."
        exit 1
    fi
}

# ──────────────────────────────────────────────
# Issue the IP certificate (first time)
# ──────────────────────────────────────────────
issue_certificate() {
    mkdir -p "$SSL_DIR"

    log "issuing IP certificate for ${SERVER_IP} (standalone, port 80)..."

    "$ACME_BIN" --issue \
        -d "$SERVER_IP" \
        --standalone \
        --server letsencrypt \
        --certificate-profile shortlived \
        --days "$RENEW_DAYS" \
        --force

    local issue_exit=$?

    # acme.sh returns 0 on success, 2 means "cert already valid, skipped" - both are fine
    if [ "$issue_exit" -ne 0 ] && [ "$issue_exit" -ne 2 ]; then
        err "acme.sh --issue failed (exit code ${issue_exit})."
        exit 1
    fi

    install_certificate
}

# ──────────────────────────────────────────────
# Install the cert into our fixed paths and update config.json
# ──────────────────────────────────────────────
install_certificate() {
    log "installing certificate to ${SSL_DIR}..."

    "$ACME_BIN" --install-cert \
        -d "$SERVER_IP" \
        --key-file "$CERT_KEY_PATH" \
        --fullchain-file "$CERT_FILE_PATH" \
        --reloadcmd "systemctl restart rocket-agent"

    if [ ! -s "$CERT_KEY_PATH" ] || [ ! -s "$CERT_FILE_PATH" ]; then
        err "certificate files missing after --install-cert."
        exit 1
    fi

    update_config_json
}

# ──────────────────────────────────────────────
# Write cert_key/cert_file paths into config.json's agent.api block
# ──────────────────────────────────────────────
update_config_json() {
    local tmp_json
    tmp_json=$(mktemp)

    jq --arg key "$CERT_KEY_PATH" --arg cert "$CERT_FILE_PATH" \
        '.agent.api.cert_key = $key | .agent.api.cert_file = $cert' \
        "$CONFIG_JSON" > "$tmp_json"

    if [ ! -s "$tmp_json" ]; then
        err "failed to update config.json with cert paths."
        rm -f "$tmp_json"
        exit 1
    fi

    mv "$tmp_json" "$CONFIG_JSON"

    log "config.json updated: agent.api.cert_key=${CERT_KEY_PATH}, agent.api.cert_file=${CERT_FILE_PATH}."
}

# ──────────────────────────────────────────────
# Install a permanent, standalone renew script + cron job.
# This does NOT get deleted by mainscript.sh's self-destruct, since it
# lives outside the scripts/ dir mainscript.sh cleans up, and must keep
# working long after this install run is gone.
# ──────────────────────────────────────────────
install_renew_cron() {
    cat > "$PERMANENT_RENEW_SCRIPT" << EOF
#!/bin/bash
# Auto-generated by install-ssl.sh. Renews the IP SSL certificate and
# restarts rocket-agent so it picks up the refreshed cert/key.
set -uo pipefail

ACME_BIN="${ACME_BIN}"
SERVER_IP="${SERVER_IP}"
CERT_KEY_PATH="${CERT_KEY_PATH}"
CERT_FILE_PATH="${CERT_FILE_PATH}"
LOG_FILE="/opt/rocket-plus/renew-ssl.log"

echo "\$(date '+%Y-%m-%d %H:%M:%S') - running renew" >> "\$LOG_FILE"

"\$ACME_BIN" --cron --home "${ACME_HOME}" >> "\$LOG_FILE" 2>&1

"\$ACME_BIN" --install-cert \\
    -d "\$SERVER_IP" \\
    --key-file "\$CERT_KEY_PATH" \\
    --fullchain-file "\$CERT_FILE_PATH" \\
    --reloadcmd "systemctl restart rocket-agent" >> "\$LOG_FILE" 2>&1

echo "\$(date '+%Y-%m-%d %H:%M:%S') - renew finished" >> "\$LOG_FILE"
EOF

    chmod 755 "$PERMANENT_RENEW_SCRIPT"

    cat > "$CRON_FILE" << EOF
# Auto-generated by install-ssl.sh - renews the IP SSL cert every 3 days
0 3 */3 * * root ${PERMANENT_RENEW_SCRIPT}
EOF

    chmod 644 "$CRON_FILE"

    log "permanent renew script installed at ${PERMANENT_RENEW_SCRIPT}, cron set at ${CRON_FILE}."
}

# ──────────────────────────────────────────────
# Notify panel that install completed
# ──────────────────────────────────────────────
complete_install() {
    local api_address="${PANEL_URL}/confirm-installed?token=${API_TOKEN}&setup=ssl"
    curl -fsS -m 10 "$api_address" >/dev/null 2>&1 || log "warning: panel notification failed (network or panel unreachable)."
    log "SSL install completed."
}

# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────
main() {
    require_root
    load_config
    detect_server_ip
    install_acme
    ensure_port_80_free
    issue_certificate
    install_renew_cron
    complete_install
}

main "$@"
