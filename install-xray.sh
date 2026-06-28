#!/bin/bash
#
# install-xray.sh
#
set -uo pipefail

CONFIG_JSON="${CONFIG_JSON:-/opt/rocket-plus/config.json}"

RP_FILES_XRAY_BASE="https://raw.githubusercontent.com/farhad-apps/rp-files/main/xray"
XRAY_CLI_ZIP_URL="${RP_FILES_XRAY_BASE}/xray-cli.zip"
XRAY_RUNTIME_CONFIG_URL="${RP_FILES_XRAY_BASE}/config.json"

XRAY_SERVICE_FILE="/etc/systemd/system/rxray.service"

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

    XRAY_PATH="${XRAY_PATH%/}/"
    XRAY_EXECUTABLE="${XRAY_PATH}xray"

    log "PANEL_URL=$PANEL_URL"
    log "XRAY_PATH=$XRAY_PATH"
    log "XRAY_EXECUTABLE=$XRAY_EXECUTABLE"
    log "XRAY_PORT=$XRAY_PORT"
    log "XRAY_CONFIG_PATH=$XRAY_CONFIG_PATH"
}

stop_existing_service() {
    if systemctl is-active --quiet rxray 2>/dev/null; then
        log "stopping existing rxray service..."
        systemctl stop rxray
    fi
}

get_cpu_vendor() {
    local MACHINE
    case "$(uname -m)" in
        'i386' | 'i686')        MACHINE='32' ;;
        'amd64' | 'x86_64')     MACHINE='64' ;;
        'armv5tel')             MACHINE='arm32-v5' ;;
        'armv6l')
            MACHINE='arm32-v6'
            grep Features /proc/cpuinfo | grep -qw 'vfp' || MACHINE='arm32-v5'
            ;;
        'armv7' | 'armv7l')
            MACHINE='arm32-v7a'
            grep Features /proc/cpuinfo | grep -qw 'vfp' || MACHINE='arm32-v5'
            ;;
        'armv8' | 'aarch64')    MACHINE='arm64-v8a' ;;
        'mips')                 MACHINE='mips32' ;;
        'mipsle')               MACHINE='mips32le' ;;
        'mips64')
            MACHINE='mips64'
            lscpu | grep -q "Little Endian" && MACHINE='mips64le'
            ;;
        'mips64le')             MACHINE='mips64le' ;;
        'ppc64')                MACHINE='ppc64' ;;
        'ppc64le')              MACHINE='ppc64le' ;;
        'riscv64')              MACHINE='riscv64' ;;
        's390x')                MACHINE='s390x' ;;
        *)
            err "the architecture is not supported."
            exit 1
            ;;
    esac
    echo "$MACHINE"
}

install_xray() {
    mkdir -p "$XRAY_PATH"

    local arch
    arch=$(get_cpu_vendor)

    local url
    url=$(wget -q -O- https://api.github.com/repos/XTLS/Xray-core/releases/latest | jq --arg v "Xray-linux-$arch.zip" -r '.assets[] | select(.name == $v) | .browser_download_url')

    if [ -z "$url" ] || [ "$url" = "null" ]; then
        err "could not resolve download URL for Xray-linux-${arch}.zip from GitHub releases."
        exit 1
    fi

    log "downloading xray from ${url}..."

    wget -O "${XRAY_PATH}xray.zip" "$url"
    unzip -o "${XRAY_PATH}xray.zip" -d "$XRAY_PATH"
    rm -f "${XRAY_PATH}xray.zip"

    log "xray installed into ${XRAY_PATH}."
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

    local xray_cli_path="${XRAY_PATH}xray-cli"

    if [ ! -f "$xray_cli_path" ]; then
        err "xray-cli not found at '$xray_cli_path' after extracting xray-cli.zip."
        exit 1
    fi

    chmod +x "$xray_cli_path"

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
    systemctl enable rxray
    systemctl restart rxray

    log "rxray service started (ExecStart: ${XRAY_EXECUTABLE} run -config ${XRAY_CONFIG_PATH})."
}

complete_install() {
    log "Xray install completed."
}
complete_install() {
    local panel_url api_token api_address

    panel_url=$(jq -r '.panel_url // empty' "$CONFIG_JSON")
    api_token=$(jq -r '.api_token // empty' "$CONFIG_JSON")

    if [ -z "$panel_url" ] || [ -z "$api_token" ]; then
        log "warning: panel_url or api_token missing, skipping agent-ready notification"
        return 0
    fi

    api_address="${panel_url}/agent/server/confirm-installed?setup=xray"

    curl -fsS -m 10 -H "X-API-Key: ${api_token}" "$api_address" >> "$LOG_FILE" 2>&1 \
        || log "warning: agent-ready panel notification failed (network or panel unreachable)"

    log "Xray install completed."
}

main() {
    require_root
    load_config
    stop_existing_service
    install_xray
    install_xray_binary
    install_xray_runtime_config
    setup_xray_log
    install_xray_service
    complete_install
}

main "$@"
