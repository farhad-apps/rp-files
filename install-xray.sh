#!/bin/bash
#
# install-xray.sh
#
set -uo pipefail

CONFIG_JSON="${CONFIG_JSON:-/opt/rocket-plus/config.json}"

RP_FILES_XRAY_BASE="https://raw.githubusercontent.com/farhad-apps/rp-files/main/xray"
XRAY_CLI_ZIP_URL="${RP_FILES_XRAY_BASE}/xray-cli.zip"
XRAY_RUNTIME_CONFIG_URL="${RP_FILES_XRAY_BASE}/config.json"

XRAY_SERVICE_FILE="/etc/systemd/system/rsxray.service"

LOG_PREFIX="[install-xray]"

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

load_config() {
    if [ ! -f "$CONFIG_JSON" ]; then
        err "config.json not found at '$CONFIG_JSON'."
        exit 1
    fi

    require_cmd jq

    PANEL_URL=$(jq -r '.panel_url // empty' "$CONFIG_JSON")
    API_TOKEN=$(jq -r '.api_token // empty' "$CONFIG_JSON")
    XRAY_ENABLED=$(jq -r '.xray.enabled // false' "$CONFIG_JSON")
    XRAY_PATH=$(jq -r '.xray.path // empty' "$CONFIG_JSON")
    XRAY_PORT=$(jq -r '.xray.port // empty' "$CONFIG_JSON")
    XRAY_CONFIG_PATH=$(jq -r '.xray.config_path // empty' "$CONFIG_JSON")

    if [ -z "$PANEL_URL" ] || [ -z "$API_TOKEN" ]; then
        err "panel_url or api_token is empty in config.json."
        exit 1
    fi

    if [ "$XRAY_ENABLED" != "true" ]; then
        err "xray.enabled is not true in config.json, aborting."
        exit 1
    fi

    if [ -z "$XRAY_PATH" ] || [ -z "$XRAY_PORT" ] || [ -z "$XRAY_CONFIG_PATH" ]; then
        err "xray.path, xray.port or xray.config_path is not defined in config.json. Expected example:
  \"xray\": { \"enabled\": true, \"path\": \"/usr/local/bin/rxray/\", \"port\": 62789, \"config_path\": \"/usr/local/bin/rxray/config.json\" }"
        exit 1
    fi

    XRAY_EXECUTABLE="${XRAY_PATH%/}/xray-cli"

    log "PANEL_URL=$PANEL_URL"
    log "XRAY_PATH=$XRAY_PATH"
    log "XRAY_EXECUTABLE=$XRAY_EXECUTABLE"
    log "XRAY_PORT=$XRAY_PORT"
    log "XRAY_CONFIG_PATH=$XRAY_CONFIG_PATH"
}

stop_existing_service() {
    if systemctl is-active --quiet rsxray 2>/dev/null; then
        log "stopping existing rsxray service..."
        systemctl stop rsxray
    fi
}

install_xray_binary() {
    mkdir -p "$XRAY_PATH"

    local tmp_zip
    tmp_zip=$(mktemp /tmp/xray-cli.XXXXXX.zip)

    log "downloading xray-cli.zip..."
    curl -fsSL -o "$tmp_zip" "$XRAY_CLI_ZIP_URL"

    if [ ! -s "$tmp_zip" ]; then
        err "failed to download xray-cli.zip."
        rm -f "$tmp_zip"
        exit 1
    fi

    unzip -o "$tmp_zip" -d "$XRAY_PATH"
    rm -f "$tmp_zip"

    if [ ! -f "$XRAY_EXECUTABLE" ]; then
        err "xray-cli not found at '$XRAY_EXECUTABLE' after extracting xray-cli.zip."
        exit 1
    fi

    chmod +x "$XRAY_EXECUTABLE"

    log "xray-cli.zip extracted into ${XRAY_PATH}."
}

install_xray_runtime_config() {
    local config_dir
    config_dir=$(dirname "$XRAY_CONFIG_PATH")
    mkdir -p "$config_dir"

    log "downloading xray runtime config.json..."

    curl -fsSL -o "$XRAY_CONFIG_PATH" "$XRAY_RUNTIME_CONFIG_URL"

    if [ ! -s "$XRAY_CONFIG_PATH" ]; then
        err "failed to download xray runtime config.json."
        exit 1
    fi

    log "xray runtime config.json installed at ${XRAY_CONFIG_PATH}."
}

setup_xray_log() {
    install -d -m 700 -o nobody -g nogroup /var/log/xray
    install -m 600 -o nobody -g nogroup /dev/null /var/log/xray/error.log

    log "xray log directory configured."
}

install_xray_service() {
    cat > "$XRAY_SERVICE_FILE" << EOF
[Unit]
Description=Xray Service
Documentation=https://github.com/xtls
After=network.target nss-lookup.target

[Service]
User=root
ExecStart=${XRAY_EXECUTABLE} run -config ${XRAY_CONFIG_PATH}
Restart=on-failure
RestartPreventExitStatus=23
LimitNPROC=10000
LimitNOFILE=infinity

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable rsxray
    systemctl restart rsxray

    log "rsxray service started (ExecStart: ${XRAY_EXECUTABLE} run -config ${XRAY_CONFIG_PATH})."
}

complete_install() {
    local api_address="${PANEL_URL}/confirm-installed?token=${API_TOKEN}&setup=xray"
    curl -fsS -m 10 "$api_address" >/dev/null 2>&1 || log "warning: panel notification failed (network or panel unreachable)."
    log "Xray install completed."
}

main() {
    require_root
    load_config
    stop_existing_service
    install_xray_binary
    install_xray_runtime_config
    setup_xray_log
    install_xray_service
    complete_install
}

main "$@"
