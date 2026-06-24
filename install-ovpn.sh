#!/bin/bash
#
# install-ovpn.sh
#
# Installs and configures OpenVPN based on config.json.
# Supports both tcp and udp via config.json's openvpn.protocol field.
# Idempotent: safe to re-run, overwrites managed config files instead of duplicating.
#
# Expected to be called by mainscript.sh, which already installed base
# dependencies (jq, curl, build-essential, etc). This script only adds
# what's specific to OpenVPN.
#
set -uo pipefail

# ──────────────────────────────────────────────
# Paths and constants
# ──────────────────────────────────────────────
CONFIG_JSON="${CONFIG_JSON:-/opt/rocket-plus/config.json}"

OVPN_DIR="/etc/openvpn"
RP_FILES_BASE="https://raw.githubusercontent.com/farhad-apps/rc-files/main/openvpn"
CERTS_ZIP_URL="${RP_FILES_BASE}/certs.zip"
SERVER_CONF_URL="${RP_FILES_BASE}/ovpn-server.conf"
CLIENT_CONF_URL="${RP_FILES_BASE}/ovpn-client.conf"
CLIENT_GENERATOR_URL="${RP_FILES_BASE}/gen-client-conf.sh"

UNIFIED_SESSION_URL="https://raw.githubusercontent.com/farhad-apps/rp-files/main/unified-session.sh"
UNIFIED_SESSION_PATH="/usr/local/bin/unified-session.sh"

LOG_PREFIX="[install-ovpn]"

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
    OVPN_ENABLED=$(jq -r '.openvpn.enabled // false' "$CONFIG_JSON")
    OVPN_PORT=$(jq -r '.openvpn.port // empty' "$CONFIG_JSON")
    OVPN_DOMAIN=$(jq -r '.openvpn.domain // empty' "$CONFIG_JSON")
    OVPN_PROTO=$(jq -r '.openvpn.protocol // "udp"' "$CONFIG_JSON")

    if [ -z "$PANEL_URL" ] || [ -z "$API_TOKEN" ]; then
        err "panel_url or api_token is empty in config.json."
        exit 1
    fi

    if [ "$OVPN_ENABLED" != "true" ]; then
        err "openvpn.enabled is not true in config.json, aborting."
        exit 1
    fi

    if [ -z "$OVPN_PORT" ]; then
        err "openvpn.port is not defined in config.json. Expected example:
  \"openvpn\": { \"enabled\": true, \"port\": 1194, \"protocol\": \"udp\", \"domain\": \"vpn.example.com\" }"
        exit 1
    fi

    if [ -z "$OVPN_DOMAIN" ]; then
        err "openvpn.domain is not defined in config.json (needed to build client .ovpn files)."
        exit 1
    fi

    if [ "$OVPN_PROTO" != "tcp" ] && [ "$OVPN_PROTO" != "udp" ]; then
        log "warning: openvpn.protocol '${OVPN_PROTO}' is not tcp/udp, defaulting to udp."
        OVPN_PROTO="udp"
    fi

    log "PANEL_URL=$PANEL_URL"
    log "OVPN_PORT=$OVPN_PORT"
    log "OVPN_PROTO=$OVPN_PROTO"
    log "OVPN_DOMAIN=$OVPN_DOMAIN"
}

# ──────────────────────────────────────────────
# Remove any previous OpenVPN install (clean slate, idempotent)
# ──────────────────────────────────────────────
remove_existing_install() {
    if [ -d "$OVPN_DIR" ]; then
        log "existing OpenVPN installation found, removing for a clean reinstall."
        systemctl stop openvpn 2>/dev/null || true
        apt-get purge -y openvpn >/dev/null 2>&1 || true
        rm -rf "$OVPN_DIR"
    fi
}

# ──────────────────────────────────────────────
# OpenVPN-specific package (base deps already handled by mainscript.sh)
# ──────────────────────────────────────────────
install_ovpn_package() {
    log "installing openvpn package..."
    apt-get install -y openvpn
    mkdir -p "$OVPN_DIR"
}

# ──────────────────────────────────────────────
# Download and extract certificates (fixed for both tcp/udp)
# ──────────────────────────────────────────────
build_certificates() {
    log "downloading certificates..."
    local certs_zip="${OVPN_DIR}/certs.zip"

    curl -fsSL -o "$certs_zip" "$CERTS_ZIP_URL"

    if [ ! -s "$certs_zip" ]; then
        err "failed to download certs.zip."
        exit 1
    fi

    unzip -o "$certs_zip" -d "$OVPN_DIR"
    rm -f "$certs_zip"

    log "certificates installed."
}

# ──────────────────────────────────────────────
# Download and configure unified-session.sh (same one used by SSH)
# ──────────────────────────────────────────────
setup_unified_session() {
    if [ -f "$UNIFIED_SESSION_PATH" ]; then
        log "unified-session.sh already present at ${UNIFIED_SESSION_PATH}, refreshing."
    fi

    log "downloading unified-session.sh..."
    curl -fsSL -o "$UNIFIED_SESSION_PATH" "$UNIFIED_SESSION_URL"

    if [ ! -s "$UNIFIED_SESSION_PATH" ]; then
        err "failed to download unified-session.sh."
        exit 1
    fi

    sed -i "s|^PANEL_BASE_URL=.*|PANEL_BASE_URL=\"${PANEL_URL}\"|" "$UNIFIED_SESSION_PATH"
    sed -i "s|^API_KEY=.*|API_KEY=\"${API_TOKEN}\"|" "$UNIFIED_SESSION_PATH"

    chmod 755 "$UNIFIED_SESSION_PATH"

    touch /var/log/unified-session.log
    chmod 644 /var/log/unified-session.log

    log "unified-session.sh installed and configured at ${UNIFIED_SESSION_PATH}."
}

# ──────────────────────────────────────────────
# Configure server.conf (port + protocol)
# ──────────────────────────────────────────────
configure_server_conf() {
    log "downloading server.conf template..."
    mkdir -p "${OVPN_DIR}/ccd"

    local conf_path="${OVPN_DIR}/server.conf"
    curl -fsSL -o "$conf_path" "$SERVER_CONF_URL"

    if [ ! -s "$conf_path" ]; then
        err "failed to download server.conf template."
        exit 1
    fi

    sed -i "s|{openPort}|${OVPN_PORT}|g" "$conf_path"
    sed -i "s|{openProto}|${OVPN_PROTO}|g" "$conf_path"

    log "server.conf configured (port=${OVPN_PORT}, proto=${OVPN_PROTO})."
}

# ──────────────────────────────────────────────
# Configure client.conf template (domain + port + protocol)
# ──────────────────────────────────────────────
configure_client_conf() {
    log "downloading client.conf template..."
    local conf_path="${OVPN_DIR}/myuser.txt"

    curl -fsSL -o "$conf_path" "$CLIENT_CONF_URL"

    if [ ! -s "$conf_path" ]; then
        err "failed to download client.conf template."
        exit 1
    fi

    sed -i "s|{openDomain}|${OVPN_DOMAIN}|g" "$conf_path"
    sed -i "s|{openPort}|${OVPN_PORT}|g" "$conf_path"
    sed -i "s|{openProto}|${OVPN_PROTO}|g" "$conf_path"

    log "client.conf template configured (domain=${OVPN_DOMAIN}, port=${OVPN_PORT}, proto=${OVPN_PROTO})."
}

# ──────────────────────────────────────────────
# iptables NAT/forward rules (kept, no UFW)
# ──────────────────────────────────────────────
configure_iptables() {
    log "configuring iptables NAT/forward rules..."

    local service_name="iptables-openvpn"
    local service_file="/etc/systemd/system/${service_name}.service"

    if [ -f "$service_file" ]; then
        systemctl stop "$service_name" 2>/dev/null || true
        systemctl disable "$service_name" 2>/dev/null || true
        rm -f "$service_file"
        systemctl daemon-reload
    fi

    local nic
    nic=$(ip -4 route ls | grep default | grep -Po '(?<=dev )(\S+)' | head -1)

    cat > "${OVPN_DIR}/add-iptables-rules.sh" << EOF
#!/bin/sh
iptables -t nat -I POSTROUTING 1 -s 10.8.0.0/24 -o ${nic} -j MASQUERADE
iptables -I INPUT 1 -i tun0 -j ACCEPT
iptables -I FORWARD 1 -i ${nic} -o tun0 -j ACCEPT
iptables -I FORWARD 1 -i tun0 -o ${nic} -j ACCEPT
iptables -I INPUT 1 -i ${nic} -p ${OVPN_PROTO} --dport ${OVPN_PORT} -j ACCEPT
EOF

    cat > "${OVPN_DIR}/rm-iptables-rules.sh" << EOF
#!/bin/sh
iptables -t nat -D POSTROUTING -s 10.8.0.0/24 -o ${nic} -j MASQUERADE
iptables -D INPUT -i tun0 -j ACCEPT
iptables -D FORWARD -i ${nic} -o tun0 -j ACCEPT
iptables -D FORWARD -i tun0 -o ${nic} -j ACCEPT
iptables -D INPUT -i ${nic} -p ${OVPN_PROTO} --dport ${OVPN_PORT} -j ACCEPT
EOF

    cat > "$service_file" << EOF
[Unit]
Description=iptables rules for OpenVPN
Before=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${OVPN_DIR}/add-iptables-rules.sh
ExecStop=${OVPN_DIR}/rm-iptables-rules.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

    chmod +x "${OVPN_DIR}/add-iptables-rules.sh" "${OVPN_DIR}/rm-iptables-rules.sh"

    systemctl daemon-reload
    systemctl enable "$service_name"
    systemctl restart "$service_name"

    # Firewall (ufw) stays disabled - we rely solely on iptables rules above
    if command -v ufw >/dev/null 2>&1; then
        ufw disable >/dev/null 2>&1 || true
    fi

    log "iptables rules applied via NIC=${nic}, proto=${OVPN_PROTO}, port=${OVPN_PORT}."
}

# ──────────────────────────────────────────────
# Enable IP forwarding (persistent)
# ──────────────────────────────────────────────
configure_ip_forward() {
    echo 1 > /proc/sys/net/ipv4/ip_forward

    if ! grep -q "^net.ipv4.ip_forward" /etc/sysctl.conf 2>/dev/null; then
        echo "net.ipv4.ip_forward = 1" >> /etc/sysctl.conf
    else
        sed -i 's/^net.ipv4.ip_forward.*/net.ipv4.ip_forward = 1/' /etc/sysctl.conf
    fi

    log "ip_forward enabled."
}

# ──────────────────────────────────────────────
# Client config generator script
# ──────────────────────────────────────────────
get_client_generator() {
    log "downloading client config generator..."
    local conf_path="${OVPN_DIR}/gen-client-conf.sh"

    curl -fsSL -o "$conf_path" "$CLIENT_GENERATOR_URL"
    chmod +x "$conf_path"

    log "client config generator installed."
}

# ──────────────────────────────────────────────
# Start OpenVPN service
# ──────────────────────────────────────────────
start_openvpn() {
    systemctl daemon-reload
    systemctl enable openvpn
    systemctl restart openvpn

    log "OpenVPN service started."
}

# ──────────────────────────────────────────────
# Notify panel that install completed
# ──────────────────────────────────────────────
complete_install() {
    local api_address="${PANEL_URL}/confirm-installed?token=${API_TOKEN}&setup=openvpn"
    curl -fsS -m 10 "$api_address" >/dev/null 2>&1 || log "warning: panel notification failed (network or panel unreachable)."
    log "OpenVPN install completed."
}

# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────
main() {
    require_root
    load_config
    remove_existing_install
    install_ovpn_package
    build_certificates
    configure_server_conf
    configure_client_conf
    setup_unified_session
    configure_iptables
    configure_ip_forward
    get_client_generator
    start_openvpn
    complete_install
}

main "$@"
