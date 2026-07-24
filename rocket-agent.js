const http = require("http");
const https = require("https");
const { execSync, exec } = require("child_process");
const fs = require("fs");
const { Buffer } = require("buffer");
const { spawn } = require("child_process");
const crypto = require("crypto");


// ─── Logger ───────────────────────────────────────────────────────────────────
// فرمت خروجی: [LEVEL] [tag] پیام
// LEVEL یکی از: INFO, SUCCESS, WARN, ERROR
// این فرمت طوری طراحی شده که هم روی کنسول/journalctl خوانا باشه، هم سمت پنل
// با یه regex ساده (/^\[(\w+)\]\s*\[([\w:.-]+)\]\s*(.*)$/) قابل parse باشه.

function log(level, tag, message) {
    const line = `[${level.toUpperCase()}] [${tag}] ${message}`;
    if (level === "error") console.error(line);
    else console.log(line);
}

// ─── Custom Errors ────────────────────────────────────────────────────────────

class AgentError extends Error {
    constructor(message, code, context = {}) {
        super(message);
        this.name = "AgentError";
        this.code = code;
        this.context = context;
    }
}

class XrayError extends AgentError {
    constructor(message, context = {}) {
        super(message, "XRAY_ERROR", context);
        this.name = "XrayError";
    }
}

class SSHError extends AgentError {
    constructor(message, context = {}) {
        super(message, "SSH_ERROR", context);
        this.name = "SSHError";
    }
}

class APIError extends AgentError {
    constructor(message, statusCode, context = {}) {
        super(message, "API_ERROR", context);
        this.name = "APIError";
        this.statusCode = statusCode;
    }
}

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = `${__dirname}/config.json`;
const INSTALLER_PATH = `${__dirname}/installer`;
const SETUP_LOG_PATH = `${__dirname}/mainscript.log`;
const SERVICE_NAME = "rocket-agent"; // اسم سرویس systemd برای خوندن لاگ‌ها
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULTS = {
    agent: {
        max_jobs: 5,
        intervals: {
            jobs: 5000,
            stats: 60000,
            config: 60000,
        },
        api: {
            listen: "",
            cert_key: "",
            cert_file: "",
        },
    },
    ssh: {
        enabled: false,
        port: 22,
        badvpn_port: 7301,
        features: { traffic: 0 },
        intervals: { traffic: 60000, online: 60000 },
    },
    openvpn: {
        enabled: false,
        port: 1194,
        protocol: "udp",
        domain: "",
        intervals: { traffic: 60000, online: 60000 },
    },
    xray: {
        enabled: false,
        path: "/usr/local/bin/",
        bin: "/usr/local/bin/rxray",
        port: 62789,
        config_path: "/usr/local/bin/rxray/config.json",
        intervals: { config: 300000, traffic: 30000, online: 60000 },
    },
};

function loadConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, "utf8");
        const cfg = JSON.parse(raw);

        // deep merge با defaults
        cfg.agent = {
            ...DEFAULTS.agent,
            ...cfg.agent,
            intervals: { ...DEFAULTS.agent.intervals, ...(cfg.agent?.intervals ?? {}) },
            api: { ...DEFAULTS.agent.api, ...(cfg.agent?.api ?? {}) },
        };

        cfg.ssh = {
            ...DEFAULTS.ssh,
            ...cfg.ssh,
            features: { ...DEFAULTS.ssh.features, ...(cfg.ssh?.features ?? {}) },
            intervals: { ...DEFAULTS.ssh.intervals, ...(cfg.ssh?.intervals ?? {}) },
        };

        cfg.openvpn = {
            ...DEFAULTS.openvpn,
            ...cfg.openvpn,
            intervals: { ...DEFAULTS.openvpn.intervals, ...(cfg.openvpn?.intervals ?? {}) },
        };

        cfg.xray = {
            ...DEFAULTS.xray,
            ...cfg.xray,
            intervals: { ...DEFAULTS.xray.intervals, ...(cfg.xray?.intervals ?? {}) },
        };

        return cfg;
    } catch (err) {
        throw new AgentError(`Failed to load config.json: ${err.message}`, "CONFIG_ERROR");
    }
}

let config = loadConfig();

setInterval(() => {
    try {
        config = loadConfig();
        log("success", "config", "Reloaded");
    } catch (err) {
        log("error", "config", `Reload failed, keeping old config: ${err.message}`);
    }
}, 10 * 60 * 1000);

// ─── Config Accessors  ─────────────────

const cfg = {
    get sshEnabled() {
        return !!config.ssh?.enabled;
    },

    get sshPort() {
        return config.ssh?.port ?? 22;
    },

    get ovpnEnabled() {
        return !!config.openvpn?.enabled;
    },

    get xrayEnabled() {
        return !!config.xray?.enabled;
    },

    get sshTrafficEnabled() {
        return !!config.ssh?.features?.traffic;
    },

    get maxJobs() {
        return config.agent?.max_jobs ?? 5;
    },

    get jobsInterval() {
        return config.agent?.intervals?.jobs ?? 5000;
    },

    get statsInterval() {
        return config.agent?.intervals?.stats ?? 60000;
    },

    get remoteConfigInterval() {
        return config.agent?.intervals?.config ?? 30000;
    },

    get xrayConfigInterval() {
        return config.xray?.intervals?.config ?? 300000;
    },

    get sshTrafficInterval() {
        return config.ssh?.intervals?.traffic ?? 30000;
    },

    get ovpnTrafficInterval() {
        return config.openvpn?.intervals?.traffic ?? 30000;
    },

    get xrayTrafficInterval() {
        return config.xray?.intervals?.traffic ?? 30000;
    },

    get sshOnlineInterval() {
        return config.ssh?.intervals?.online ?? 30000;
    },

    get ovpnOnlineInterval() {
        return config.openvpn?.intervals?.online ?? 30000;
    },

    get xrayOnlineInterval() {
        return config.xray?.intervals?.online ?? 30000;
    },

    get apiConfig() {
        return config.agent?.api ?? {};
    },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function runCmd(command, { timeout = 15000, throwOnError = false } = {}) {
    return new Promise((resolve, reject) => {
        const proc = exec(command, { timeout }, (error, stdout, stderr) => {
            const result = {
                stdout: stdout ? stdout.trim() : "",
                stderr: stderr ? stderr.trim() : "",
                exitCode: error ? error.code ?? 1 : 0,
            };
            if (error && throwOnError) {
                return reject(new AgentError(`Command failed: ${command}\n${stderr || error.message}`, "CMD_ERROR", result));
            }
            resolve(result);
        });
        setTimeout(() => {
            proc.kill("SIGKILL");
            if (throwOnError) reject(new AgentError(`Command timed out: ${command}`, "CMD_TIMEOUT"));
        }, timeout + 1000);
    });
}

// یه خط JSON خام از «journalctl -o json» رو به فرمت ساختارمند لاگ تبدیل می‌کنه
function parseJournalEntry(entry) {
    const message = entry.MESSAGE ?? "";
    const timestampMs = entry.__REALTIME_TIMESTAMP ? Math.floor(Number(entry.__REALTIME_TIMESTAMP) / 1000) : Date.now();
    const timestamp = new Date(timestampMs).toISOString();

    const match = message.match(/^\[(\w+)\]\s*\[([\w:.-]+)\]\s*(.*)$/);
    if (match) {
        const [, level, tag, msg] = match;
        return { timestamp, level: level.toLowerCase(), tag, message: msg };
    }
    return { timestamp, level: "unknown", tag: "", message };
}

// ─── buildWebApi ──────────────────────────────────────────────────────────────

function buildWebApi({ getConfig, ServerApi }) {
    function parseBody(req) {
        return new Promise((resolve, reject) => {
            let data = "";
            req.on("data", (chunk) => (data += chunk));
            req.on("end", () => {
                try {
                    resolve(data ? JSON.parse(data) : {});
                } catch {
                    resolve({});
                }
            });
            req.on("error", reject);
        });
    }

    const ROUTES = {
        "GET /api/ovpn/client-file": async () => {
            const result = await ServerApi.getOvpnClientFile();
            return { status: 200, body: { file: result } };
        },
        "GET /api/server/stats": async () => {
            const stats = await ServerApi.getStats();
            return { status: 200, body: stats };
        },
        "GET /api/server/setup-log": async () => {
            const result = await ServerApi.getSetupLogs();
            return { status: 200, body: { logs: result } };
        },
        "POST /api/server/logs": async (req, res, body) => {
            const { minutes } = body;
            const logs = await ServerApi.getLogs(minutes || 1);
            console.log(logs);
            return { status: 200, body: { logs } };
        },
        "POST /api/system/restart-xray": async () => {
            await ServerApi.restartXray();
            return { status: 200, body: { ok: true } };
        },
        "POST /api/system/restart-ssh": async () => {
            await ServerApi.restartSsh();
            return { status: 200, body: { ok: true } };
        },
        "POST /api/system/restart-openvpn": async () => {
            await ServerApi.restartOpenvpn();
            return { status: 200, body: { ok: true } };
        },
        "POST /api/system/restart-agent": async () => {
            ServerApi.restartAgent();
            return { status: 200, body: { ok: true } };
        },
        "POST /api/system/setup-protocol": async (req, res, body) => {
            const { protocol } = body;
            ServerApi.setupProtocol(protocol);
            return { status: 200, body: { ok: true } };
        },
    };

    function sendJson(res, status, body) {
        const payload = JSON.stringify(body);
        res.writeHead(status, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            "Access-Control-Allow-Origin": "*",
        });
        res.end(payload);
    }

    function authenticate(req) {
        const provided = req.headers["x-api-key"];
        return typeof provided === "string" && provided.length > 0 && provided === getConfig().api_token;
    }

    async function handleRequest(req, res) {
        try {
            if (req.method === "OPTIONS") {
                res.writeHead(204, {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
                    "Access-Control-Max-Age": "86400",
                });
                return res.end();
            }

            const url = new URL(req.url, "http://localhost");
            const routeKey = `${req.method} ${url.pathname}`;

            if (!authenticate(req)) {
                return sendJson(res, 401, { error: "Unauthorized" });
            }

            const handler = ROUTES[routeKey];
            if (!handler) {
                return sendJson(res, 404, { error: "Not found" });
            }

            const body = await parseBody(req);
            const { status, body: resBody } = await handler(req, res, body);
            return sendJson(res, status, resBody);
        } catch (err) {
            log("error", "web-api", `Request error: ${err?.message ?? err}`);
            return sendJson(res, 500, { error: err.message || "Internal error" });
        }
    }

    let server = null;

    function start() {
        const apiCfg = cfg.apiConfig;

        const port = parseInt(apiCfg.listen, 10);

        if (!port) {
            log("warn", "web-api", "No valid agent.api.listen port configured, skipping web server start");
            return;
        }

        const certFile = apiCfg.cert_file;
        const keyFile = apiCfg.cert_key;
        const hasCert = certFile && keyFile && fs.existsSync(certFile) && fs.existsSync(keyFile);

        if (hasCert) {
            try {
                const cert = fs.readFileSync(certFile);
                const key = fs.readFileSync(keyFile);
                server = https.createServer({ key, cert }, handleRequest);
                server.listen(port, () => log("success", "web-api", `HTTPS listening on port ${port}`));
            } catch (err) {
                log("error", "web-api", `Failed to load certificate, falling back to HTTP: ${err.message}`);
                server = http.createServer(handleRequest);
                server.listen(port, () => log("warn", "web-api", `HTTP listening on port ${port} (cert load failed)`));
            }
        } else {
            server = http.createServer(handleRequest);
            server.listen(port, () => log("success", "web-api", `HTTP listening on port ${port}`));
        }

        server.on("error", (err) => log("error", "web-api", `Server error: ${err.message}`));
    }

    function stop() {
        if (server) server.close();
    }

    return { start, stop };
}

// ─── XrayCLI ──────────────────────────────────────────────────────────────────

class XrayCLI {
    get bin() {
        return config.xray.bin;
    }
    get port() {
        return config.xray.port;
    }

    _run(command, args = null) {
        const env = { ...process.env, XRAY_API_PORT: this.port };
        const hasInput = args !== null;
        const cmd = hasInput ? `${this.bin} ${command} -` : `${this.bin} ${command}`;

        try {
            const output = execSync(cmd, {
                env,
                input: hasInput ? JSON.stringify(args) : undefined,
                stdio: ["pipe", "pipe", "pipe"],
                timeout: 10000,
            }).toString();

            const jsonLine = output
                .split("\n")
                .filter((l) => l.trim().startsWith("{"))
                .pop();
            if (jsonLine) return JSON.parse(jsonLine);
            return { ok: true };
        } catch (err) {
            const raw = (err.stdout || err.stderr || "").toString();
            const jsonLine = raw
                .split("\n")
                .filter((l) => l.trim().startsWith("{"))
                .pop();
            if (jsonLine) {
                const parsed = JSON.parse(jsonLine);
                throw new XrayError(parsed.error || "Xray command failed", { command, args, response: parsed });
            }
            throw new XrayError(`Xray CLI error: ${(err.stderr || err.message).toString()}`, { command, args });
        }
    }

    addInbound(cfg) {
        return this._run("add-inbound", cfg);
    }
    delInbound(tag) {
        return this._run("del-inbound", { tag });
    }
    addUser(protocol, tag, email, extras) {
        return this._run("add-user", { protocol, tag, email, ...extras });
    }
    removeUser(tag, email) {
        return this._run("remove-user", { tag, email });
    }
    getTraffic() {
        return this._run("get-traffic");
    }
    getOnline() {
        return this._run("get-online");
    }
}

const xrayCLI = new XrayCLI();

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function request(method, endpoint, body = null, { retries = 2, retryDelay = 2000 } = {}) {
    const attempt = (attemptsLeft) =>
        new Promise((resolve, reject) => {
            const base = new URL(config.panel_url);
            const isHttps = base.protocol === "https:";
            const port = base.port || (isHttps ? 443 : 80);
            const path = `/sapi/${endpoint}`;

            const options = {
                hostname: base.hostname,
                port,
                path,
                method,
                headers: {
                    "Content-Type": "application/json",
                    "X-API-Key": config.api_token,
                },
                timeout: 15000,
            };

            const transport = isHttps ? https : http;
            const req = transport.request(options, (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    if (res.statusCode === 204) return resolve(null);
                    if (res.statusCode >= 400) {
                        return reject(new APIError(`HTTP ${res.statusCode} from ${endpoint}`, res.statusCode, { endpoint, body: data }));
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        resolve(data);
                    }
                });
            });

            req.on("timeout", () => {
                req.destroy();
                reject(new APIError(`Request timeout: ${endpoint}`, 408, { endpoint }));
            });
            req.on("error", (err) => {
                reject(new APIError(`Network error: ${err.message}`, 0, { endpoint }));
            });

            if (body) req.write(JSON.stringify(body));
            req.end();
        }).catch(async (err) => {
            if (attemptsLeft > 0) {
                log("warn", "api", `Retrying ${endpoint} (${attemptsLeft} left): ${err.message}`);
                await new Promise((r) => setTimeout(r, retryDelay));
                return attempt(attemptsLeft - 1);
            }
            throw err;
        });

    return attempt(retries);
}

const api = {
    getJobs: () => request("GET", "agent/jobs"),
    completeJob: (id, result) => request("POST", `agent/jobs/${id}/done`, { result }),
    failJob: (id, error) => request("POST", `agent/jobs/${id}/fail`, { error }),
    getInboundClients: (inboundId) => request("GET", `agent/inbounds/${inboundId}/clients`),
    getFullSync: () => request("GET", "agent/server/sync"),
    getAgentConfig: () => request("GET", "agent/config"),
    getXrayFullConfig: () => request("GET", "agent/xray/config"),
    sendServerStats: (data) => request("POST", "agent/server/stats", { data }),
    sendXrayTraffic: (data) => request("POST", "agent/traffic/xray", { data }),
    sendSshTraffic: (data) => request("POST", "agent/traffic/ssh", { data }),
    sendOvpnTraffic: (clients) => request("POST", "agent/traffic/openvpn", { clients }),
    sendSshOnline: (users) => request("POST", "agent/online/ssh", { users }),
    sendOvpnOnline: (clients) => request("POST", "agent/online/openvpn", { clients }),
    sendXrayOnline: (clients) => request("POST", "agent/online/xray", { clients }),
};

// ─── SSH Actions ──────────────────────────────────────────────────────────────

const SSH = {
    addUser: async ({ username, password }) => {
        const { exitCode: e1, stderr: s1 } = await runCmd(`sudo adduser ${username} --force-badname --shell /usr/sbin/nologin --disabled-password --gecos ""`);
        if (e1 !== 0) throw new SSHError(`adduser failed for ${username}: ${s1}`, { username });

        const { exitCode: e2, stderr: s2 } = await SSH._setPassword(username, password);
        if (e2 !== 0) throw new SSHError(`setpassword failed for ${username}: ${s2}`, { username });

        const { exitCode: e3, stderr: s3 } = await runCmd(`sudo adduser ${username} rocket`);
        if (e3 !== 0) throw new SSHError(`adduser to group failed for ${username}: ${s3}`, { username });

        log("success", "ssh", `User added: ${username}`);
    },

    removeUser: async ({ username }) => {
        await runCmd(`sudo killall -u ${username} 2>/dev/null; true`);
        await runCmd(`sudo pkill -u ${username} 2>/dev/null; true`);

        const { exitCode, stderr } = await runCmd(`sudo userdel -r ${username}`);
        if (exitCode !== 0 && !stderr.includes("does not exist")) {
            throw new SSHError(`userdel failed for ${username}: ${stderr}`, { username });
        }
        log("success", "ssh", `User removed: ${username}`);
    },

    updateUser: async ({ username, password }) => {
        const { exitCode, stderr } = await SSH._setPassword(username, password);
        if (exitCode !== 0) throw new SSHError(`setpassword failed for ${username}: ${stderr}`, { username });
        log("success", "ssh", `Password updated: ${username}`);
    },

    _setPassword: async (username, password) => {
        const safePass = password.replace(/'/g, "'\\''");
        const hashed = execSync(`openssl passwd -6 '${safePass}'`).toString().trim();
        return await runCmd(`sudo usermod --password '${hashed}' ${username}`);
    },
};

// ─── Xray Actions ─────────────────────────────────────────────────────────────

const Xray = {
    addInbound: async (payload) => {
        const { inbound_id, tag, protocol, port, settings, streamSettings, sniffing } = payload;
        xrayCLI.addInbound({ tag, protocol, port, settings, streamSettings, sniffing });
        await Xray._pushClientsForInbound(inbound_id, tag, protocol);
        log("success", "xray", `Inbound added: ${tag}`);
    },

    updateInbound: async (payload) => {
        const { inbound_id, tag, protocol, port, settings, streamSettings, sniffing, old_tag } = payload;
        try {
            xrayCLI.delInbound(old_tag);
        } catch (err) {
            log("warn", "xray", `delInbound(${old_tag}) failed (continuing): ${err.message}`);
        }
        xrayCLI.addInbound({ tag, protocol, port, settings, streamSettings, sniffing });
        await Xray._pushClientsForInbound(inbound_id, tag, protocol);
        log("success", "xray", `Inbound updated: ${old_tag} → ${tag}`);
    },

    removeInbound: async ({ tag }) => {
        xrayCLI.delInbound(tag);
        log("success", "xray", `Inbound removed: ${tag}`);
    },

    addClient: async (payload) => {
        const { uuid, email, inbound_tag, inbound_protocol } = payload;
        xrayCLI.addUser(inbound_protocol, inbound_tag, email, { id: uuid });
        log("success", "xray", `Client added: ${email} → ${inbound_tag}`);
    },

     updateClient: async (payload) => {
        const { uuid, email, inbound_tag, inbound_protocol } = payload;
        try {
            xrayCLI.removeUser(inbound_tag, email);
        } catch (err) {
            log("warn", "xray", `removeUser(${email}) failed during update (continuing): ${err.message}`);
        }
        xrayCLI.addUser(inbound_protocol, inbound_tag, email, { id: uuid });
        log("success", "xray", `Client updated: ${email} → ${inbound_tag} (new uuid)`);
    },

    removeClient: async ({ email, inbound_tag }) => {
        xrayCLI.removeUser(inbound_tag, email);
        log("success", "xray", `Client removed: ${email} from ${inbound_tag}`);
    },

    _pushClientsForInbound: async (inbound_id, tag, protocol) => {
        const { clients } = await api.getInboundClients(inbound_id);
        if (!clients?.length) return;

        const errors = [];
        for (const client of clients) {
            try {
                xrayCLI.addUser(protocol, tag, client.email, { id: client.uuid });
            } catch (err) {
                errors.push({ client: client.email, error: err.message });
            }
        }

        if (errors.length) log("warn", "xray", `Some clients failed for inbound ${tag}: ${JSON.stringify(errors)}`);
        log("info", "xray", `Pushed ${clients.length - errors.length}/${clients.length} clients to ${tag}`);
    },
};

// ─── Full Sync ────────────────────────────────────────────────────────────────

const FullSync = {
    run: async () => {
        log("info", "sync", "Starting full sync...");
        const data = await api.getFullSync();
        const results = { inbounds: 0, clients: 0, ssh: 0, errors: [] };

        if (cfg.xrayEnabled && data.xray_config) {
            const { xray_config } = data;
            fs.writeFileSync(config.xray.config_path, JSON.stringify(xray_config, null, 2), "utf8");
            await sleep(5000);
            await runCmd("sudo systemctl restart rxray");
        }

        if (cfg.sshEnabled) {
            for (const user of data.ssh_users ?? []) {
                try {
                    await SSH.addUser(user);
                    results.ssh++;
                } catch (err) {
                    results.errors.push({ type: "ssh", username: user.username, error: err.message });
                }
            }
        }

        log("success", "sync", `Done — inbounds: ${results.inbounds}, clients: ${results.clients}, ssh: ${results.ssh}`);
        if (results.errors.length) log("error", "sync", `${results.errors.length} errors: ${JSON.stringify(results.errors)}`);
    },
};

// ─── Job Runner ───────────────────────────────────────────────────────────────

const ACTION_MAP = {
    add_xray_inbound: (p) => Xray.addInbound(p),
    update_xray_inbound: (p) => Xray.updateInbound(p),
    remove_xray_inbound: (p) => Xray.removeInbound(p),
    add_xray_client: (p) => Xray.addClient(p),
    update_xray_client: (p) => Xray.updateClient(p),
    remove_xray_client: (p) => Xray.removeClient(p),
    add_ssh_user: (p) => SSH.addUser(p),
    remove_ssh_user: (p) => SSH.removeUser(p),
    update_ssh_user: (p) => SSH.updateUser(p),
    sync_server: () => FullSync.run(),
};

const JobRunner = {
    busy: false,

    get CONCURRENCY() {
        return cfg.maxJobs;
    },

    start() {
        setInterval(() => JobRunner.poll(), cfg.jobsInterval);
        log("info", "jobs", `Polling every ${cfg.jobsInterval}ms (batch concurrency ${JobRunner.CONCURRENCY})`);
    },

    async poll() {
        if (JobRunner.busy) return;
        JobRunner.busy = true;
        try {
            const res = await api.getJobs();
            const jobs = res?.jobs ?? [];
            if (!jobs.length) return;
            log("info", "jobs", `Batch received: ${jobs.length} job(s)`);
            await JobRunner.runBatch(jobs);
        } catch (err) {
            log("error", "jobs", `Poll error: ${err.message}`);
        } finally {
            JobRunner.busy = false;
        }
    },

    async runBatch(jobs) {
        let cursor = 0;
        const next = () => jobs[cursor++];
        const worker = async () => {
            let job;
            while ((job = next())) {
                await JobRunner.execute(job);
            }
        };
        const workerCount = Math.min(JobRunner.CONCURRENCY, jobs.length);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
    },

    async execute({ id, action, payload }) {
        const handler = ACTION_MAP[action];
        if (!handler) {
            await api.failJob(id, `Unknown action: ${action}`);
            return;
        }
        try {
            await handler(payload);
            await api.completeJob(id, { status: "ok" });
            log("success", "jobs", `Job #${id} done`);
        } catch (err) {
            log("error", "jobs", `Job #${id} failed (${err.name}): ${err.message}`);
            await api.failJob(id, err.message);
        }
    },
};

// ─── Traffic ──────────────────────────────────────────────────────────────────

const Traffic = {
    startSsh() {
        const runCycle = async () => {
            if (cfg.sshEnabled && cfg.sshTrafficEnabled) {
                try {
                    const clients = await Traffic._runNethogsOnce();
                    if (clients.length) await api.sendSshTraffic(clients);
                } catch (err) {
                    log("error", "traffic:ssh", err.message);
                }
            }
            // چون خود nethogs به اندازه sshTrafficInterval طول می‌کشه،
            // اینجا فقط یه فاصله‌ی کوچیک اضافه می‌کنیم (یا صفر)
            setTimeout(runCycle, 0);
        };
        runCycle();
    },

    _runNethogsOnce() {
        return new Promise((resolve, reject) => {
            let buffer = "";
            let finished = false;

            const delaySec = Math.max(1, Math.round(cfg.sshTrafficInterval / 1000));
            const proc = spawn("sudo", ["nice", "-n", "10", "ionice", "-c2", "-n7", "nethogs", "-j", "-v2", "-d", String(delaySec), "-c", "2", cfg.sshInterface || "eth0"]);

            const safetyTimeout = setTimeout(() => {
                if (!finished) {
                    proc.kill("SIGKILL");
                    finished = true;
                    reject(new Error("nethogs cycle timed out"));
                }
            }, delaySec * 1000 + 15000); // مدت -d + 15s فرصت اضافه

            proc.stdout.on("data", (chunk) => {
                buffer += chunk.toString();
            });

            proc.stderr.on("data", () => { });

            proc.on("exit", () => {
                if (finished) return;
                finished = true;
                clearTimeout(safetyTimeout);

                const validLines = buffer
                    .split("\n")
                    .map((l) => l.trim())
                    .filter((l) => l.startsWith("["));
                if (!validLines.length) return resolve([]);

                const lastLine = validLines[validLines.length - 1];

                try {
                    const parsed = JSON.parse(lastLine);
                    const clients = parsed
                        .filter((c) => c.UID > 0 && c.name.startsWith("sshd-session:"))
                        .map((c) => ({
                            username: c.name.replace("sshd-session:", "").split("@")[0].trim(),
                            rx: c.RX,
                            tx: c.TX,
                        }))
                        .filter((c) => c.rx > 0 || c.tx > 0);
                    resolve(clients);
                } catch (err) {
                    reject(err);
                }
            });

            proc.on("error", reject);
        });
    },
    startOvpn() {
        const run = async () => {
            if (cfg.ovpnEnabled) {
                try {
                    const { stdout } = await runCmd("cat /etc/openvpn/status.log", { throwOnError: true });
                    if (stdout) {
                        const clients = Online.parseOvpnStatus(stdout);
                        if (clients.length) await api.sendOvpnTraffic(clients);
                    }
                } catch (err) {
                    log("error", "traffic:ovpn", err.message);
                }
            }
            setTimeout(run, cfg.ovpnTrafficInterval);
        };
        run();
    },

    startXray() {
        const run = async () => {
            if (cfg.xrayEnabled) {
                try {
                    const result = xrayCLI.getTraffic();
                    if (result?.data) await api.sendXrayTraffic(result.data);
                } catch (err) {
                    log("error", "traffic:xray", err.message);
                }
            }
            setTimeout(run, cfg.xrayTrafficInterval);
        };
        run();
    },
};

// ─── Online ───────────────────────────────────────────────────────────────────

const Online = {
    startSsh() {
        const run = async () => {
            if (cfg.sshEnabled) {
                try {
                    const sessions = await Online.getSshSessions();
                    if (sessions.length) await api.sendSshOnline(sessions);
                } catch (err) {
                    log("error", "online:ssh", err.message);
                }
            }
            setTimeout(run, cfg.sshOnlineInterval);
        };
        run();
    },

    startXray() {
        const run = async () => {
            if (cfg.xrayEnabled) {
                try {
                    const result = xrayCLI.getOnline();
                    if (result?.data) await api.sendXrayOnline(result.data);
                } catch (err) {
                    log("error", "traffic:xray", err.message);
                }
            }
            setTimeout(run, cfg.xrayOnlineInterval);
        };
        run();
    },

    startOvpn() {
        const run = async () => {
            if (cfg.ovpnEnabled) {
                try {
                    const { stdout } = await runCmd("cat /etc/openvpn/status.log", { throwOnError: true });
                    if (stdout) {
                        const clients = Online.parseOvpnStatus(stdout);
                        if (clients.length) await api.sendOvpnOnline(clients);
                    }
                } catch (err) {
                    log("error", "online:ovpn", err.message);
                }
            }
            setTimeout(run, cfg.ovpnOnlineInterval);
        };
        run();
    },

    async getSshSessions() {
        const { stdout } = await runCmd(
            `ss -tnp state established '( sport = :${cfg.sshPort} )'`
        );
        const sessions = [];
        for (const line of stdout.split("\n")) {
            const m = line.match(/(\d+\.\d+\.\d+\.\d+):(\d+)\s+users:/);
            if (!m) continue;
            const [, peerIp, peerPort] = m;

            const pids = [...line.matchAll(/pid=(\d+)/g)].map((x) => parseInt(x[1], 10));
            if (!pids.length) continue;

            let username = null;
            for (const pid of pids) {
                try {
                    const { stdout: userOut } = await runCmd(`ps -o user= -p ${pid}`);
                    const u = userOut.trim();
                    if (u && u !== "root") {
                        username = u;
                        break;
                    }
                } catch { }
            }
            if (!username) continue;

            sessions.push({
                username,
                ip: peerIp,
                session_id: Online.genSessionId(`${username}:${peerIp}:${peerPort}`),
            });
        }
        return sessions;
    },

    parseOvpnStatus(log) {
        const clients = [];
        for (const line of log.split("\n")) {
            if (!line.startsWith("CLIENT_LIST,")) continue;
            const parts = line.split(",");
            if (parts.length < 11) continue;

            const username = parts[1];
            const rawAddress = parts[2];
            const bytesReceived = parseInt(parts[5]) || 0;
            const bytesSent = parseInt(parts[6]) || 0;

            // rawAddress may be "ip:port" or "tcp4-server:ip:port" — always take
            // the LAST TWO colon-separated segments as port and ip
            const addrParts = rawAddress.split(":");
            const port = addrParts.pop() || "";
            const ip = addrParts.pop() || "";

            if (username && username !== "UNDEF") {
                clients.push({
                    username,
                    ip,
                    port, // ← موقتاً برای دیباگ
                    session_id: Online.genSessionId(`${username}:${ip}:${port}`),
                    bytes_received: bytesReceived,
                    bytes_sent: bytesSent,
                });
            }
        }
        return clients;
    },
    genSessionId(key) {
        return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
    }
};

// ─── ServerApi ──────────────────────────────────────────────────────────────

const ServerApi = {
    start() {
        const run = async () => {
            try {
                await ServerApi.collect();
            } catch (err) {
                log("error", "stats", err.message);
            }
            setTimeout(run, cfg.statsInterval);
        };
        run();
    },

    async getStats() {
        const [cpuUsage, cpuInfo, ram, disk, net, loadAvg, uptime, os, kernel, sshStatus, xrayStatus, ovpnStatus] = await Promise.all([
            runCmd("top -bn1 | grep 'Cpu(s)' | awk '{print $2+$4}'"),
            runCmd("lscpu | grep -E 'Model name|^CPU\\(s\\)|CPU MHz'"),
            runCmd("free -m | awk 'NR==2{print $2,$3,$4}'"),
            runCmd("df -h / | awk 'NR==2{print $2,$3,$4}'"),
            runCmd("cat /proc/net/dev | awk 'NR>2{in+=$2; out+=$10} END{print in, out}'"),
            runCmd("cat /proc/loadavg | awk '{print $1,$2,$3}'"),
            runCmd("cat /proc/uptime | awk '{print int($1)}'"),
            runCmd("cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"'"),
            runCmd("uname -r"),
            runCmd("systemctl is-active ssh 2>/dev/null || systemctl is-active sshd 2>/dev/null"),
            runCmd("systemctl is-active rxray 2>/dev/null"),
            runCmd("systemctl is-active openvpn 2>/dev/null"),
        ]);

        const cpuLines = cpuInfo.stdout.split("\n");
        const cpuModel =
            cpuLines
                .find((l) => l.includes("Model name"))
                ?.split(":")[1]
                ?.trim() ?? "";
        const cpuCores =
            cpuLines
                .find((l) => l.includes("CPU(s)"))
                ?.split(":")[1]
                ?.trim() ?? "0";
        const cpuMhz =
            cpuLines
                .find((l) => l.includes("CPU MHz"))
                ?.split(":")[1]
                ?.trim() ?? "0";

        const [ramTotal, ramUsed, ramFree] = ram.stdout.split(" ").map(Number);
        const [diskTotal, diskUsed, diskFree] = disk.stdout.split(" ");
        const [netIn, netOut] = net.stdout.split(" ").map(Number);

        return {
            cpu_usage: parseFloat(cpuUsage.stdout) || 0,
            cpu_cores: parseInt(cpuCores) || 0,
            cpu_model: cpuModel,
            cpu_mhz: parseFloat(cpuMhz) || 0,
            ram_total: ramTotal || 0,
            ram_used: ramUsed || 0,
            ram_free: ramFree || 0,
            disk_total: diskTotal || "0",
            disk_used: diskUsed || "0",
            disk_free: diskFree || "0",
            net_in: netIn || 0,
            net_out: netOut || 0,
            load_avg: loadAvg.stdout.trim(),
            uptime: parseInt(uptime.stdout) || 0,
            os: os.stdout.trim(),
            kernel: kernel.stdout.trim(),
            services: {
                ssh: cfg.sshEnabled ? sshStatus.stdout.trim() : null,
                xray: cfg.xrayEnabled ? xrayStatus.stdout.trim() : null,
                openvpn: cfg.ovpnEnabled ? ovpnStatus.stdout.trim() : null,
            },
        };
    },

    async setupProtocol(protocol) {
        log("info", "server-api", "setup protocol...");
        if (protocol === "openvpn") {
            protocol = "ovpn";
        }
        await runCmd(`rm ${SETUP_LOG_PATH}`);
        await runCmd(`${INSTALLER_PATH} setup-${protocol}`);
    },

    getSetupLogs: async () => {
        log("info", "system", "get setup log...");
        const raw = fs.readFileSync(SETUP_LOG_PATH, "utf8");
        return raw;
    },

    getOvpnClientFile: async () => {
        log("info", "system", "get ovpn client file...");
        const filePath = `/etc/openvpn/myuser.txt`;
        const raw = fs.readFileSync(filePath, "utf8");
        return raw;
    },

    // لیست لاگ‌های خود سرویس rocket-agent رو از journalctl می‌گیره
    // پارامتر minutes: چند دقیقه‌ی اخیر (پیش‌فرض 10، حداکثر 1440 = 24 ساعت)
    getLogs: async (minutes) => {
        const safeMinutes = Math.min(Math.max(parseInt(minutes, 10) || 10, 1), 1440);
        log("info", "system", `get logs (last ${safeMinutes}m)...`);


        const { stdout } = await runCmd(`sudo journalctl -u ${SERVICE_NAME} --since "${safeMinutes} minutes ago" --no-pager -o json`, {
            timeout: 15000,
            throwOnError: true,
        });

        if (!stdout) return [];

        return stdout
            .split("\n")
            .filter(Boolean)
            .map((line) => {
                try {
                    return parseJournalEntry(JSON.parse(line));
                } catch {
                    return null;
                }
            })
            .filter(Boolean);
    },

    restartXray: async () => {
        const { exitCode, stderr } = await runCmd("sudo systemctl restart rxray");
        if (exitCode !== 0) throw new AgentError(`restart xray failed: ${stderr}`, "SYSTEM_ERROR");
        log("success", "system", "Xray restarted");
    },

    restartSsh: async () => {
        const { exitCode, stderr } = await runCmd("sudo systemctl restart ssh sshd 2>/dev/null; true");
        if (exitCode !== 0) throw new AgentError(`restart ssh failed: ${stderr}`, "SYSTEM_ERROR");
        log("success", "system", "SSH restarted");
    },

    restartOpenvpn: async () => {
        const { exitCode, stderr } = await runCmd("sudo systemctl restart openvpn");
        if (exitCode !== 0) throw new AgentError(`restart openvpn failed: ${stderr}`, "SYSTEM_ERROR");
        log("success", "system", "OpenVPN restarted");
    },

    restartAgent: async () => {
        log("warn", "system", "Agent restarting...");
        setTimeout(() => process.exit(0), 1000);
    },
};

// ─── Remote Config ────────────────────────────────────────────────────────────

const RemoteConfig = {
    start() {
        const run = async () => {
            try {
                await RemoteConfig.fetch();
            } catch (err) {
                log("error", "remote-config", err.message);
            }
            setTimeout(run, cfg.remoteConfigInterval);
        };
        run();
    },

    async fetch() {
        const remote = await api.getAgentConfig();
        if (!remote) return;

        if (remote.agent) {
            config.agent = {
                ...config.agent,
                ...remote.agent,
                intervals: { ...config.agent.intervals, ...(remote.agent?.intervals ?? {}) },
                api: { ...config.agent.api, ...(remote.agent?.api ?? {}) },
            };
        }

        if (remote.ssh) {
            config.ssh = {
                ...config.ssh,
                ...remote.ssh,
                features: { ...config.ssh.features, ...(remote.ssh?.features ?? {}) },
                intervals: { ...config.ssh.intervals, ...(remote.ssh?.intervals ?? {}) },
            };
        }

        if (remote.openvpn) {
            config.openvpn = {
                ...config.openvpn,
                ...remote.openvpn,
                intervals: { ...config.openvpn.intervals, ...(remote.openvpn?.intervals ?? {}) },
            };
        }

        if (remote.xray) {
            config.xray = {
                ...config.xray,
                ...remote.xray,
                intervals: { ...config.xray.intervals, ...(remote.xray?.intervals ?? {}) },
            };
        }

        try {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
            log("success", "remote-config", "Config saved to file");
        } catch (err) {
            log("error", "remote-config", `Failed to save config: ${err.message}`);
        }

        log(
            "info",
            "remote-config",
            `Updated: ${JSON.stringify({
                ssh: { enabled: cfg.sshEnabled, traffic: cfg.sshTrafficEnabled },
                openvpn: { enabled: cfg.ovpnEnabled },
                xray: { enabled: cfg.xrayEnabled },
            })}`
        );
    },
};

// ─── XrayFullConfig ───────────────────────────────────────────────────────────

const XrayFullConfig = {
    start() {
        const run = async () => {
            try {
                await XrayFullConfig.collect();
            } catch (err) {
                log("error", "xray-config", err.message);
            }
            setTimeout(run, cfg.xrayConfigInterval);
        };
        run();
    },

    async collect() {
        const result = await api.getXrayFullConfig();
        if (!result?.config) {
            log("warn", "xray-config", "Empty config received");
            return;
        }
        fs.writeFileSync(config.xray.config_path, JSON.stringify(result.config, null, 2), "utf8");
        log("success", "xray-config", `Saved to ${config.xray.config_path}`);
    },
};

// ─── Web API ──────────────────────────────────────────────────────────────────

const webApi = buildWebApi({
    getConfig: () => config,
    ServerApi,
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
    log("info", "agent", "Starting Rocket Agent...");
    log("info", "agent", `Panel: ${config.panel_url}`);

    try {
        await RemoteConfig.fetch();
    } catch (err) {
        log("warn", "agent", `Remote config failed, using local defaults: ${err.message}`);
    }

    XrayFullConfig.start();
    JobRunner.start();

    Traffic.startXray();
    Traffic.startSsh();
    Traffic.startOvpn();

    Online.startSsh();
    Online.startXray();
    Online.startOvpn();

    RemoteConfig.start();
    webApi.start();
}

boot();

process.on("unhandledRejection", (err) => log("error", "agent", `unhandledRejection: ${err?.stack ?? err}`));
process.on("uncaughtException", (err) => log("error", "agent", `uncaughtException: ${err?.stack ?? err}`));
