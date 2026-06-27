#!/bin/bash
#
# install-ssh.sh
#
# Installs and configures SSH based on config.json.
# Idempotent: safe to re-run, overwrites managed config blocks instead of duplicating.
#
# Expected to be called by mainscript.sh, which already installed base
# dependencies (jq, curl, build-essential, etc). This script only adds
# what's specific to SSH.
#
set -uo pipefail

# ──────────────────────────────────────────────
# Paths and constants
# ──────────────────────────────────────────────
CONFIG_JSON="${CONFIG_JSON:-/opt/rocket-plus/config.json}"
UNIFIED_SESSION_URL="https://raw.githubusercontent.com/farhad-apps/rp-files/main/unified-session.sh"
UNIFIED_SESSION_PATH="/usr/local/bin/unified-session.sh"
ROCKET_SSHD_FILE="/etc/ssh/rocket_sshd_config"
SSHD_CONFIG="/etc/ssh/sshd_config"
PAM_SSHD_FILE="/etc/pam.d/sshd"
SSH_GROUP="rocket"
NETHOGS_BIN_URL="https://github.com/pro-apps-1/files/raw/main/my-neth.zip"
BADVPN_USER="videocall"

LOG_PREFIX="[install-ssh]"

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
    SSH_ENABLED=$(jq -r '.ssh.enabled // false' "$CONFIG_JSON")
    SSH_PORT=$(jq -r '.ssh.port // empty' "$CONFIG_JSON")
    SSH_BADVPN_PORT=$(jq -r '.ssh.badvpn_port // empty' "$CONFIG_JSON")

    if [ -z "$PANEL_URL" ] || [ -z "$API_TOKEN" ]; then
        err "panel_url or api_token is empty in config.json."
        exit 1
    fi

    if [ "$SSH_ENABLED" != "true" ]; then
        err "ssh.enabled is not true in config.json, aborting."
        exit 1
    fi

    if [ -z "$SSH_PORT" ]; then
        err "ssh.port is not defined in config.json. Expected example:
  \"ssh\": { \"enabled\": true, \"port\": 22022, \"badvpn_port\": 7300 }"
        exit 1
    fi

    if [ -z "$SSH_BADVPN_PORT" ]; then
        log "warning: ssh.badvpn_port not defined, defaulting to 7300 for badvpn-udpgw."
        SSH_BADVPN_PORT=7300
    fi

    log "PANEL_URL=$PANEL_URL"
    log "SSH_PORT=$SSH_PORT"
    log "SSH_BADVPN_PORT=$SSH_BADVPN_PORT"
}

# ──────────────────────────────────────────────
# SSH-specific package (base deps already handled by mainscript.sh)
# ──────────────────────────────────────────────
install_ssh_package() {
    log "ensuring openssh-server is installed..."
    apt-get install -y openssh-server
}

# ──────────────────────────────────────────────
# Create rocket group (used to filter users in unified-session.sh)
# ──────────────────────────────────────────────
setup_rocket_group() {
    if ! getent group "$SSH_GROUP" >/dev/null; then
        groupadd "$SSH_GROUP"
        log "group '$SSH_GROUP' created."
    else
        log "group '$SSH_GROUP' already exists."
    fi
}

# ──────────────────────────────────────────────
# badvpn-udpgw (UDP forwarding)
# ──────────────────────────────────────────────
setup_udpgw_service() {
    if id -u "$BADVPN_USER" >/dev/null 2>&1; then
        log "user '$BADVPN_USER' (badvpn) already exists."
    else
        local vendor_id
        vendor_id=$(lscpu | awk -F': ' '/Vendor ID/ {gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2}')

        if [ "$vendor_id" = "ARM" ]; then
            wget -O /usr/bin/badvpn-udpgw "https://raw.githubusercontent.com/rocket-ap/badvpn/master/udpgw-arm"
        else
            wget -O /usr/bin/badvpn-udpgw "https://raw.githubusercontent.com/rocket-ap/badvpn/master/udpgw-x86"
        fi

        chmod 755 /usr/bin/badvpn-udpgw
        useradd -m "$BADVPN_USER"
        log "badvpn user and binary installed."
    fi

    cat > /etc/systemd/system/videocall.service << EOF
[Unit]
Description=UDP forwarding for badvpn-tun2socks
After=nss-lookup.target

[Service]
ExecStart=/usr/bin/badvpn-udpgw --loglevel none --listen-addr 127.0.0.1:${SSH_BADVPN_PORT} --max-clients 999
User=${BADVPN_USER}
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable videocall
    systemctl restart videocall

    log "badvpn-udpgw service enabled on port ${SSH_BADVPN_PORT}."
}

# ──────────────────────────────────────────────
# nethogs (traffic monitoring)
# ──────────────────────────────────────────────
setup_nethogs() {
    if command -v nethogs >/dev/null 2>&1; then
        log "nethogs already installed, skipping rebuild."
        return 0
    fi

    local tmp_dir
    tmp_dir=$(mktemp -d)

    wget -O "${tmp_dir}/nethogs.zip" "$NETHOGS_BIN_URL"
    unzip -o "${tmp_dir}/nethogs.zip" -d "$tmp_dir"

    local src_dir
    src_dir=$(find "$tmp_dir" -maxdepth 1 -type d -iname "nethogs*" | head -n1)

    if [ -z "$src_dir" ]; then
        err "nethogs source directory not found, skipping nethogs install."
        rm -rf "$tmp_dir"
        return 1
    fi

    (
        cd "$src_dir" || exit 1
        chmod 744 determineVersion.sh 2>/dev/null || true
        make install
    )

    hash -r
    cp -f /usr/local/sbin/nethogs /usr/sbin/nethogs
    setcap "cap_net_admin,cap_net_raw,cap_dac_read_search,cap_sys_ptrace+pe" /usr/local/sbin/nethogs

    rm -rf "$tmp_dir"
    log "nethogs installed."
}

# ──────────────────────────────────────────────
# Download and configure unified-session.sh
# ──────────────────────────────────────────────
setup_unified_session() {
    log "downloading unified-session.sh..."
    curl -fsSL -o "$UNIFIED_SESSION_PATH" "$UNIFIED_SESSION_URL"

    if [ ! -s "$UNIFIED_SESSION_PATH" ]; then
        err "failed to download unified-session.sh."
        exit 1
    fi

    # inject PANEL_BASE_URL and API_KEY from config.json
    sed -i "s|^PANEL_BASE_URL=.*|PANEL_BASE_URL=\"${PANEL_URL}\"|" "$UNIFIED_SESSION_PATH"
    sed -i "s|^API_KEY=.*|API_KEY=\"${API_TOKEN}\"|" "$UNIFIED_SESSION_PATH"

    chmod 755 "$UNIFIED_SESSION_PATH"

    touch /var/log/unified-session.log
    chmod 644 /var/log/unified-session.log

    log "unified-session.sh installed and configured at ${UNIFIED_SESSION_PATH}."
}

# ──────────────────────────────────────────────
# Configure PAM to call unified-session.sh
# ──────────────────────────────────────────────
config_pam_auth() {
    local auth_line="auth       required     pam_exec.so ${UNIFIED_SESSION_PATH}"
    local session_line="session    optional     pam_exec.so ${UNIFIED_SESSION_PATH}"

    if ! grep -qF "pam_exec.so ${UNIFIED_SESSION_PATH}" "$PAM_SSHD_FILE" 2>/dev/null; then
        # remove legacy rocket_ssh_auth.so lines if present
        sed -i '/rocket_ssh_auth\.so/d' "$PAM_SSHD_FILE"

        # insert auth line after pam_nologin.so, or append if not found
        if grep -q "pam_nologin.so" "$PAM_SSHD_FILE"; then
            sed -i "/pam_nologin.so/a ${auth_line}" "$PAM_SSHD_FILE"
        else
            echo "$auth_line" >> "$PAM_SSHD_FILE"
        fi

        echo "$session_line" >> "$PAM_SSHD_FILE"

        log "PAM lines for unified-session.sh added."
    else
        log "PAM lines already configured, no change made."
    fi
}

# ──────────────────────────────────────────────
# Configure sshd (port)
# ──────────────────────────────────────────────
config_sshd() {
    # rebuild rocket_sshd_config from scratch (safe overwrite)
    cat > "$ROCKET_SSHD_FILE" << EOF
# This file is generated automatically by install-ssh.sh.
# Manual changes will be lost on the next run.
ClientAliveInterval 30
ClientAliveCountMax 1
Port ${SSH_PORT}
EOF

    if ! grep -qF "Include ${ROCKET_SSHD_FILE}" "$SSHD_CONFIG"; then
        echo "Include ${ROCKET_SSHD_FILE}" >> "$SSHD_CONFIG"
        log "Include line added to sshd_config."
    fi

    # comment out default Port 22 if present (port now comes from rocket_sshd_config)
    sed -i -E 's/^#?\s*Port 22\s*$/#Port 22/' "$SSHD_CONFIG" 2>/dev/null || true

    # validate config before restarting
    if sshd -t 2>/tmp/sshd_test_err; then
        systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null
        log "sshd restarted successfully on port ${SSH_PORT}."
    else
        err "sshd config is invalid:"
        cat /tmp/sshd_test_err >&2
        err "sshd restart aborted to avoid dropping the current connection."
        exit 1
    fi

    rm -f /tmp/sshd_test_err
}

# ──────────────────────────────────────────────
# Firewall - open required ports
# ──────────────────────────────────────────────
open_firewall_ports() {
    if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
        ufw allow "${SSH_PORT}/tcp" >/dev/null 2>&1
        log "port ${SSH_PORT}/tcp opened in ufw."
    fi
}

# ──────────────────────────────────────────────
# Notify panel that install completed
# ──────────────────────────────────────────────
complete_install() {
    log "SSH install completed."
}

# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────
main() {
    require_root
    load_config
    install_ssh_package
    setup_rocket_group
    setup_nethogs
    setup_udpgw_service
    setup_unified_session
    config_pam_auth
    config_sshd
    open_firewall_ports
    complete_install
}

main "$@"
