#!/bin/bash
#
# mainscript.sh
#
# Entry point dispatcher. Installs base dependencies, sets up rocket-agent.js
# (running under Bun as a systemd service), then dispatches to protocol-specific
# install scripts downloaded from the rp-files repository.
#
# Usage:
#   ./mainscript.sh setup-ssh
#   ./mainscript.sh setup-xray
#   ./mainscript.sh setup-ovpn
#   ./mainscript.sh setup-all
#
set -uo pipefail

# ──────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────
INSTALL_DIR="/opt/rocket-plus"
CONFIG_JSON="${INSTALL_DIR}/config.json"
SCRIPTS_DIR="${INSTALL_DIR}/scripts"
LOG_FILE="${INSTALL_DIR}/mainscript.log"

REPO_RAW_BASE="https://raw.githubusercontent.com/farhad-apps/rp-files/main"
AGENT_PATH="${INSTALL_DIR}/rocket-agent.js"
AGENT_SERVICE="/etc/systemd/system/rocket-agent.service"
BUN_INSTALL_DIR="/usr/local/bun"
BUN_BIN="${BUN_INSTALL_DIR}/bin/bun"

mkdir -p "$INSTALL_DIR" "$SCRIPTS_DIR"
touch "$LOG_FILE"

# ──────────────────────────────────────────────
# Self-delete: this script and every downloaded install-*.sh helper are
# removed when the process exits, regardless of success or failure, so
# the token/panel URL embedded in config.json's reach stays as small as
# possible and nobody can later read the install logic off disk.
# ──────────────────────────────────────────────
self_destruct() {
    local self_path="${BASH_SOURCE[0]}"

    rm -f "${SCRIPTS_DIR}"/install-*.sh 2>/dev/null

    if [ -f "$self_path" ]; then
        rm -f "$self_path" 2>/dev/null
    fi
}

trap self_destruct EXIT

# ──────────────────────────────────────────────
# Logging (silent on stdout, everything to log file)
# ──────────────────────────────────────────────
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $*" >> "$LOG_FILE"
}

fail() {
    log "FATAL: $*"
    exit 1
}

require_root() {
    if [ "$(id -u)" -ne 0 ]; then
        fail "must be run as root"
    fi
}

# ──────────────────────────────────────────────
# Base dependencies (needed by all protocols + agent)
# ──────────────────────────────────────────────
install_dependencies() {
    log "installing base dependencies"

    apt-get update -y >> "$LOG_FILE" 2>&1

    apt-get install -y \
        curl wget unzip tar \
        ca-certificates gnupg lsb-release \
        jq openssl \
        iptables iproute2 \
        build-essential libpam0g-dev libcurl4-openssl-dev \
        cmake libncurses5-dev libpcap-dev make \
        >> "$LOG_FILE" 2>&1 || fail "dependency installation failed"

    log "base dependencies installed"
}

# ──────────────────────────────────────────────
# Bun runtime
# ──────────────────────────────────────────────
install_bun() {
    if [ -x "$BUN_BIN" ]; then
        log "bun already installed at ${BUN_BIN}"
        return 0
    fi

    log "installing bun"

    export BUN_INSTALL="$BUN_INSTALL_DIR"
    curl -fsSL https://bun.sh/install | bash >> "$LOG_FILE" 2>&1

    if [ ! -x "$BUN_BIN" ]; then
        fail "bun installation failed, binary not found at ${BUN_BIN}"
    fi

    ln -sf "$BUN_BIN" /usr/local/bin/bun

    log "bun installed at ${BUN_BIN}"
}

# ──────────────────────────────────────────────
# rocket-agent.js + systemd service
# ──────────────────────────────────────────────
setup_agent() {
    log "downloading rocket-agent.js"

    curl -fsSL -o "$AGENT_PATH" "${REPO_RAW_BASE}/rocket-agent.js" >> "$LOG_FILE" 2>&1

    if [ ! -s "$AGENT_PATH" ]; then
        fail "failed to download rocket-agent.js"
    fi

    chmod 644 "$AGENT_PATH"

    cat > "$AGENT_SERVICE" << EOF
[Unit]
Description=Rocket Plus Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${BUN_BIN} run ${AGENT_PATH}
WorkingDirectory=${INSTALL_DIR}
Environment=CONFIG_PATH=${CONFIG_JSON}
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable rocket-agent >> "$LOG_FILE" 2>&1
    systemctl restart rocket-agent >> "$LOG_FILE" 2>&1

    log "rocket-agent service started"
}

# ──────────────────────────────────────────────
# Generic protocol install dispatcher
# ──────────────────────────────────────────────
run_protocol_install() {
    local protocol_name="$1"
    local script_name="$2"
    local script_path="${SCRIPTS_DIR}/${script_name}"

    log "downloading ${script_name}"

    curl -fsSL -o "$script_path" "${REPO_RAW_BASE}/${script_name}" >> "$LOG_FILE" 2>&1

    if [ ! -s "$script_path" ]; then
        rm -f "$script_path" 2>/dev/null
        fail "failed to download ${script_name}"
    fi

    chmod 755 "$script_path"

    log "running ${script_name}"

    CONFIG_JSON="$CONFIG_JSON" bash "$script_path" >> "$LOG_FILE" 2>&1
    local exit_code=$?

    rm -f "$script_path" 2>/dev/null

    if [ "$exit_code" -ne 0 ]; then
        fail "${protocol_name} install failed (exit code ${exit_code})"
    fi

    log "${protocol_name} install completed"
}

setup_ssh() {
    run_protocol_install "ssh" "install-ssh.sh"
}

setup_xray() {
    run_protocol_install "xray" "install-xray.sh"
}

setup_ovpn() {
    run_protocol_install "openvpn" "install-ovpn.sh"
}

setup_ssl() {
    run_protocol_install "ssl" "install-ssl.sh"
}

# ──────────────────────────────────────────────
# Bootstrap: deps + agent (always runs before any protocol)
# ──────────────────────────────────────────────
bootstrap() {
    require_root

    if [ ! -f "$CONFIG_JSON" ]; then
        fail "config.json not found at ${CONFIG_JSON}"
    fi

    install_dependencies
    install_bun
    setup_agent
}

usage() {
    cat << EOF
Usage: $0 <command>

Commands:
  setup-ssh     Install and configure SSH
  setup-xray    Install and configure Xray
  setup-ovpn    Install and configure OpenVPN
  setup-ssl     Issue/install SSL certificate for the server's IP
  setup-all     Run all three (based on protocols enabled in config.json)
EOF
}

# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────
main() {
    local cmd="${1:-}"

    case "$cmd" in
        setup-ssh)
            bootstrap
            setup_ssh
            ;;
        setup-xray)
            bootstrap
            setup_xray
            ;;
        setup-ovpn)
            bootstrap
            setup_ovpn
            ;;
        setup-ssl)
            bootstrap
            setup_ssl
            ;;
        setup-all)
            bootstrap
            [ "$(jq -r '.ssh.enabled // false' "$CONFIG_JSON")" = "true" ] && setup_ssh
            [ "$(jq -r '.xray.enabled // false' "$CONFIG_JSON")" = "true" ] && setup_xray
            [ "$(jq -r '.openvpn.enabled // false' "$CONFIG_JSON")" = "true" ] && setup_ovpn
            ;;
        *)
            usage
            exit 1
            ;;
    esac
}

main "$@"
