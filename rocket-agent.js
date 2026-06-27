const http = require("http");
const https = require("https");
const { execSync, exec } = require("child_process");
const fs = require("fs");
const { Buffer } = require("buffer");

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
const SETUP_LOG_PATH = `${__dirname}/mainscript.log`;

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
      intervals: { config: 300000, traffic: 30000 },
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
      console.log("[config] Reloaded");
   } catch (err) {
      console.error("[config] Reload failed, keeping old config:", err.message);
   }
}, 10 * 60 * 1000);

// ─── Config Accessors  ─────────────────

const cfg = {
   get sshEnabled() { return !!config.ssh?.enabled; },
   get ovpnEnabled() { return !!config.openvpn?.enabled; },
   get xrayEnabled() { return !!config.xray?.enabled; },
   get sshTrafficEnabled() { return !!config.ssh?.features?.traffic; },

   get maxJobs() { return config.agent?.max_jobs ?? 5; },

   get jobsInterval() { return config.agent?.intervals?.jobs ?? 5000; },
   get statsInterval() { return config.agent?.intervals?.stats ?? 60000; },
   get remoteConfigInterval() { return config.agent?.intervals?.config ?? 60000; },
   get xrayConfigInterval() { return config.xray?.intervals?.config ?? 300000; },

   get sshTrafficInterval() { return config.ssh?.intervals?.traffic ?? 60000; },
   get ovpnTrafficInterval() { return config.openvpn?.intervals?.traffic ?? 60000; },
   get xrayTrafficInterval() { return config.xray?.intervals?.traffic ?? 30000; },

   get sshOnlineInterval() { return config.ssh?.intervals?.online ?? 60000; },
   get ovpnOnlineInterval() { return config.openvpn?.intervals?.online ?? 60000; },

   get apiConfig() { return config.agent?.api ?? {}; },
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

// ─── buildWebApi ──────────────────────────────────────────────────────────────

function buildWebApi({ getConfig, ServerStats, System }) {
   const ROUTES = {
      "GET /ovpn/client-file": async () => {
         const result = await ServerStats.getOvpnClientFile();
         return { status: 200, body: result };
      },
      "GET /server/stats": async () => {
         const stats = await ServerStats.collect({ send: false });
         return { status: 200, body: stats };
      },
      "GET /server/setup-log": async () => {
         const result = await ServerStats.getSetupLogs();
         return { status: 200, body: result };
      },
      "POST /system/restart-xray": async () => {
         await System.restartXray();
         return { status: 200, body: { ok: true } };
      },
      "POST /system/restart-ssh": async () => {
         await System.restartSsh();
         return { status: 200, body: { ok: true } };
      },
      "POST /system/restart-openvpn": async () => {
         await System.restartOpenvpn();
         return { status: 200, body: { ok: true } };
      },
      "POST /system/restart-agent": async () => {
         System.restartAgent();
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
         // CORS preflight - browsers send this before the real request and
         // never include X-API-Key, so it must be answered before auth.
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

         const { status, body } = await handler(req, res);
         return sendJson(res, status, body);
      } catch (err) {
         console.error("[web-api] Request error:", err?.stack ?? err);
         return sendJson(res, 500, { error: err.message || "Internal error" });
      }
   }

   let server = null;

   function start() {
      const apiCfg = cfg.apiConfig;
      const port = parseInt(apiCfg.listen, 10);

      if (!port) {
         console.warn("[web-api] No valid agent.api.listen port configured, skipping web server start");
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
            server.listen(port, () => console.log(`[web-api] HTTPS listening on port ${port}`));
         } catch (err) {
            console.error("[web-api] Failed to load certificate, falling back to HTTP:", err.message);
            server = http.createServer(handleRequest);
            server.listen(port, () => console.log(`[web-api] HTTP listening on port ${port} (cert load failed)`));
         }
      } else {
         server = http.createServer(handleRequest);
         server.listen(port, () => console.log(`[web-api] HTTP listening on port ${port}`));
      }

      server.on("error", (err) => console.error("[web-api] Server error:", err.message));
   }

   function stop() {
      if (server) server.close();
   }

   return { start, stop };
}

// ─── XrayCLI ──────────────────────────────────────────────────────────────────

class XrayCLI {
   get bin() { return config.xray.bin; }
   get port() { return config.xray.port; }

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

         const jsonLine = output.split("\n").filter((l) => l.trim().startsWith("{")).pop();
         if (jsonLine) return JSON.parse(jsonLine);
         return { ok: true };
      } catch (err) {
         const raw = (err.stdout || err.stderr || "").toString();
         const jsonLine = raw.split("\n").filter((l) => l.trim().startsWith("{")).pop();
         if (jsonLine) {
            const parsed = JSON.parse(jsonLine);
            throw new XrayError(parsed.error || "Xray command failed", { command, args, response: parsed });
         }
         throw new XrayError(`Xray CLI error: ${(err.stderr || err.message).toString()}`, { command, args });
      }
   }

   addInbound(cfg) { return this._run("add-inbound", cfg); }
   delInbound(tag) { return this._run("del-inbound", { tag }); }
   addUser(protocol, tag, email, extras) { return this._run("add-user", { protocol, tag, email, ...extras }); }
   removeUser(tag, email) { return this._run("remove-user", { tag, email }); }
   getTraffic() { return this._run("get-traffic"); }
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
            console.warn(`[api] Retrying ${endpoint} (${attemptsLeft} left): ${err.message}`);
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
   getFullSync: () => request("GET", "agent/sync"),
   getAgentConfig: () => request("GET", "agent/config"),
   getXrayFullConfig: () => request("GET", "agent/xray/config"),
   sendServerStats: (data) => request("POST", "agent/server/stats", { data }),
   sendXrayTraffic: (data) => request("POST", "agent/traffic/xray", { data }),
   sendSshTraffic: (data) => request("POST", "agent/traffic/ssh", { data }),
   sendOvpnTraffic: (clients) => request("POST", "agent/traffic/openvpn", { clients }),
   sendSshOnline: (users) => request("POST", "agent/online/ssh", { users }),
   sendOvpnOnline: (clients) => request("POST", "agent/online/openvpn", { clients }),
};

// ─── SSH Actions ──────────────────────────────────────────────────────────────

const SSH = {
   addUser: async ({ username, password }) => {
      const { exitCode: e1, stderr: s1 } = await runCmd(
         `sudo adduser ${username} --force-badname --shell /usr/sbin/nologin --disabled-password --gecos ""`
      );
      if (e1 !== 0) throw new SSHError(`adduser failed for ${username}: ${s1}`, { username });

      const { exitCode: e2, stderr: s2 } = await SSH._setPassword(username, password);
      if (e2 !== 0) throw new SSHError(`setpassword failed for ${username}: ${s2}`, { username });

      const { exitCode: e3, stderr: s3 } = await runCmd(`sudo adduser ${username} rocket`);
      if (e3 !== 0) throw new SSHError(`adduser to group failed for ${username}: ${s3}`, { username });

      console.log(`[ssh] User added: ${username}`);
   },

   removeUser: async ({ username }) => {
      await runCmd(`sudo killall -u ${username} 2>/dev/null; true`);
      await runCmd(`sudo pkill -u ${username} 2>/dev/null; true`);

      const { exitCode, stderr } = await runCmd(`sudo userdel -r ${username}`);
      if (exitCode !== 0 && !stderr.includes("does not exist")) {
         throw new SSHError(`userdel failed for ${username}: ${stderr}`, { username });
      }
      console.log(`[ssh] User removed: ${username}`);
   },

   updateUser: async ({ username, password }) => {
      const { exitCode, stderr } = await SSH._setPassword(username, password);
      if (exitCode !== 0) throw new SSHError(`setpassword failed for ${username}: ${stderr}`, { username });
      console.log(`[ssh] Password updated: ${username}`);
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
      console.log(`[xray] Inbound added: ${tag}`);
   },

   updateInbound: async (payload) => {
      const { inbound_id, tag, protocol, port, settings, streamSettings, sniffing, old_tag } = payload;
      try {
         xrayCLI.delInbound(old_tag);
      } catch (err) {
         console.warn(`[xray] delInbound(${old_tag}) failed (continuing):`, err.message);
      }
      xrayCLI.addInbound({ tag, protocol, port, settings, streamSettings, sniffing });
      await Xray._pushClientsForInbound(inbound_id, tag, protocol);
      console.log(`[xray] Inbound updated: ${old_tag} → ${tag}`);
   },

   removeInbound: async ({ tag }) => {
      xrayCLI.delInbound(tag);
      console.log(`[xray] Inbound removed: ${tag}`);
   },

   addClient: async (payload) => {
      const { uuid, email, inbound_tag, inbound_protocol } = payload;
      xrayCLI.addUser(inbound_protocol, inbound_tag, email, { id: uuid });
      console.log(`[xray] Client added: ${email} → ${inbound_tag}`);
   },

   removeClient: async ({ email, inbound_tag }) => {
      xrayCLI.removeUser(inbound_tag, email);
      console.log(`[xray] Client removed: ${email} from ${inbound_tag}`);
   },

   _pushClientsForInbound: async (inbound_id, tag, protocol) => {
      const { clients } = await api.getInboundClients(inbound_id);
      console.log("inbound_id", inbound_id, clients);
      if (!clients?.length) return;

      const errors = [];
      for (const client of clients) {
         try {
            xrayCLI.addUser(protocol, tag, client.email, { id: client.uuid });
         } catch (err) {
            errors.push({ client: client.email, error: err.message });
         }
      }

      if (errors.length) console.warn(`[xray] Some clients failed for inbound ${tag}:`, errors);
      console.log(`[xray] Pushed ${clients.length - errors.length}/${clients.length} clients to ${tag}`);
   },
};

// ─── Full Sync ────────────────────────────────────────────────────────────────

const FullSync = {
   run: async () => {
      console.log("[sync] Starting full sync...");
      const data = await api.getFullSync();
      const results = { inbounds: 0, clients: 0, ssh: 0, errors: [] };

      for (const inbound of data.inbounds ?? []) {
         try {
            try { xrayCLI.delInbound(inbound.tag); } catch { }
            xrayCLI.addInbound(inbound);
            results.inbounds++;
         } catch (err) {
            results.errors.push({ type: "inbound", tag: inbound.tag, error: err.message });
         }
      }

      for (const [tag, clients] of Object.entries(data.clients ?? {})) {
         const inbound = data.inbounds?.find((i) => i.tag === tag);
         if (!inbound) continue;
         for (const client of clients) {
            try {
               xrayCLI.addUser(inbound.protocol, tag, client.email, { id: client.uuid });
               results.clients++;
            } catch (err) {
               results.errors.push({ type: "client", email: client.email, error: err.message });
            }
         }
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

      console.log(`[sync] Done — inbounds: ${results.inbounds}, clients: ${results.clients}, ssh: ${results.ssh}`);
      if (results.errors.length) console.error(`[sync] ${results.errors.length} errors:`, results.errors);
   },
};

// ─── Job Runner ───────────────────────────────────────────────────────────────

const ACTION_MAP = {
   add_xray_inbound: (p) => Xray.addInbound(p),
   update_xray_inbound: (p) => Xray.updateInbound(p),
   remove_xray_inbound: (p) => Xray.removeInbound(p),
   add_xray_client: (p) => Xray.addClient(p),
   remove_xray_client: (p) => Xray.removeClient(p),
   add_ssh_user: (p) => SSH.addUser(p),
   remove_ssh_user: (p) => SSH.removeUser(p),
   update_ssh_user: (p) => SSH.updateUser(p),
   sync_server: () => FullSync.run(),
   restart_xray: () => System.restartXray(),
   restart_ssh: () => System.restartSsh(),
   restart_openvpn: () => System.restartOpenvpn(),
   restart_agent: () => System.restartAgent(),
};

const JobRunner = {
   busy: false,

   get CONCURRENCY() { return cfg.maxJobs; },

   start() {
      setInterval(() => JobRunner.poll(), cfg.jobsInterval);
      console.log(`[jobs] Polling every ${cfg.jobsInterval}ms (batch concurrency ${JobRunner.CONCURRENCY})`);
   },

   async poll() {
      if (JobRunner.busy) return;
      JobRunner.busy = true;
      try {
         const res = await api.getJobs();
         const jobs = res?.jobs ?? [];
         if (!jobs.length) return;
         console.log(`[jobs] Batch received: ${jobs.length} job(s)`);
         await JobRunner.runBatch(jobs);
      } catch (err) {
         console.error("[jobs] Poll error:", err.message);
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
         console.log(`[jobs] Job #${id} done`);
      } catch (err) {
         console.error(`[jobs] Job #${id} failed (${err.name}):`, {
            message: err.message,
            code: err.code,
            ...(err.context ?? {}),
         });
         await api.failJob(id, err.message);
      }
   },
};

// ─── Traffic ──────────────────────────────────────────────────────────────────

const Traffic = {
   startSsh() {
      const run = async () => {
         if (cfg.sshEnabled && cfg.sshTrafficEnabled) {
            try {
               const { stdout, exitCode } = await runCmd("sudo nethogs -j -v3 -c2", { timeout: 30000 });
               await runCmd("sudo pkill nethogs");

               if (exitCode === 0 && stdout) {
                  const lines = stdout.split("\n").filter((l) => l.trim().startsWith("["));
                  if (lines.length) {
                     const last = lines[lines.length - 1];
                     const clients = JSON.parse(last)
                        .filter((c) => c.UID > 0 && c.name.startsWith("sshd:"))
                        .map((c) => ({
                           username: c.name.replace("sshd:", "").split("@")[0].trim(),
                           rx: c.RX,
                           tx: c.TX,
                        }));
                     if (clients.length) await api.sendSshTraffic(clients);
                  }
               }
            } catch (err) {
               console.error("[traffic:ssh]", err.message);
            }
         }
         setTimeout(run, cfg.sshTrafficInterval);
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
                  if (clients.length) await api.sendOvpnTraffic(clients);
               }
            } catch (err) {
               console.error("[traffic:ovpn]", err.message);
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
               console.error("[traffic:xray]", err.message);
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
               const { stdout } = await runCmd(
                  "ps aux | grep -E 'sshd|stunnel' | grep -v grep | awk '{print $1}' | sort -u"
               );
               const users = stdout.split("\n").filter((u) => u && u !== "root");
               if (users.length) await api.sendSshOnline(users);
            } catch (err) {
               console.error("[online:ssh]", err.message);
            }
         }
         setTimeout(run, cfg.sshOnlineInterval);
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
               console.error("[online:ovpn]", err.message);
            }
         }
         setTimeout(run, cfg.ovpnOnlineInterval);
      };
      run();
   },

   parseOvpnStatus(log) {
      const clients = [];
      for (const line of log.split("\n")) {
         if (!line.startsWith("CLIENT_LIST")) continue;
         const parts = line.split(",");
         if (parts.length < 6) continue;
         const username = parts[1];
         const ip = parts[2]?.split(":")[0];
         const bytesReceived = parseInt(parts[4]) || 0;
         const bytesSent = parseInt(parts[5]) || 0;
         if (username && username !== "UNDEF") {
            clients.push({ username, ip, bytes_received: bytesReceived, bytes_sent: bytesSent });
         }
      }
      return clients;
   },
};

// ─── ServerStats ──────────────────────────────────────────────────────────────

const ServerStats = {
   start() {
      const run = async () => {
         try {
            await ServerStats.collect();
         } catch (err) {
            console.error("[stats]", err.message);
         }
         setTimeout(run, cfg.statsInterval);
      };
      run();
   },

   async collect({ send = true } = {}) {
      const [cpuUsage, cpuInfo, ram, disk, net, loadAvg, uptime, os, kernel] = await Promise.all([
         runCmd("top -bn1 | grep 'Cpu(s)' | awk '{print $2+$4}'"),
         runCmd("lscpu | grep -E 'Model name|^CPU\\(s\\)|CPU MHz'"),
         runCmd("free -m | awk 'NR==2{print $2,$3,$4}'"),
         runCmd("df -h / | awk 'NR==2{print $2,$3,$4}'"),
         runCmd("cat /proc/net/dev | awk 'NR>2{in+=$2; out+=$10} END{print in, out}'"),
         runCmd("cat /proc/loadavg | awk '{print $1,$2,$3}'"),
         runCmd("cat /proc/uptime | awk '{print int($1)}'"),
         runCmd("cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"'"),
         runCmd("uname -r"),
      ]);

      const cpuLines = cpuInfo.stdout.split("\n");
      const cpuModel =
         cpuLines.find((l) => l.includes("Model name"))?.split(":")[1]?.trim() ?? "";
      const cpuCores =
         cpuLines.find((l) => l.includes("CPU(s)"))?.split(":")[1]?.trim() ?? "0";
      const cpuMhz =
         cpuLines.find((l) => l.includes("CPU MHz"))?.split(":")[1]?.trim() ?? "0";

      const [ramTotal, ramUsed, ramFree] = ram.stdout.split(" ").map(Number);
      const [diskTotal, diskUsed, diskFree] = disk.stdout.split(" ");
      const [netIn, netOut] = net.stdout.split(" ").map(Number);

      const stats = {
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
      };

      if (send) {
         await api.sendServerStats(stats);
         console.log("[stats] Sent");
      }

      return stats;
   },

   getSetupLogs: async () => {
      console.log("[system] get setup log...");
      const raw = fs.readFileSync(SETUP_LOG_PATH, "utf8");
      return raw;
   },
   getOvpnClientFile: async () => {
      console.log("[system] get ovpn client file...");
      const filePath = `/etc/openvpn/myuser.txt`
      const raw = fs.readFileSync(filePath, "utf8");
      return raw;
   },
};

// ─── Remote Config ────────────────────────────────────────────────────────────

const RemoteConfig = {
   start() {
      const run = async () => {
         try {
            await RemoteConfig.fetch();
         } catch (err) {
            console.error("[remote-config]", err.message);
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

      console.log("[remote-config] Updated:", JSON.stringify({
         ssh: { enabled: cfg.sshEnabled, traffic: cfg.sshTrafficEnabled },
         openvpn: { enabled: cfg.ovpnEnabled },
         xray: { enabled: cfg.xrayEnabled },
      }));
   },
};

// ─── XrayFullConfig ───────────────────────────────────────────────────────────

const XrayFullConfig = {
   start() {
      const run = async () => {
         try {
            await XrayFullConfig.collect();
         } catch (err) {
            console.error("[xray-config]", err.message);
         }
         setTimeout(run, cfg.xrayConfigInterval);
      };
      run();
   },

   async collect() {
      const result = await api.getXrayFullConfig();
      if (!result?.config) {
         console.warn("[xray-config] Empty config received");
         return;
      }
      fs.writeFileSync(config.xray.config_path, JSON.stringify(result.config, null, 2), "utf8");
      console.log(`[xray-config] Saved to ${config.xray.config_path}`);
   },
};

// ─── System ───────────────────────────────────────────────────────────────────

const System = {
   restartXray: async () => {
      const { exitCode, stderr } = await runCmd("sudo systemctl restart rxray");
      if (exitCode !== 0) throw new AgentError(`restart xray failed: ${stderr}`, "SYSTEM_ERROR");
      console.log("[system] Xray restarted");
   },

   restartSsh: async () => {
      const { exitCode, stderr } = await runCmd("sudo systemctl restart ssh sshd 2>/dev/null; true");
      if (exitCode !== 0) throw new AgentError(`restart ssh failed: ${stderr}`, "SYSTEM_ERROR");
      console.log("[system] SSH restarted");
   },

   restartOpenvpn: async () => {
      const { exitCode, stderr } = await runCmd("sudo systemctl restart openvpn");
      if (exitCode !== 0) throw new AgentError(`restart openvpn failed: ${stderr}`, "SYSTEM_ERROR");
      console.log("[system] OpenVPN restarted");
   },

   restartAgent: async () => {
      console.log("[system] Agent restarting...");
      setTimeout(() => process.exit(0), 1000);
   }
};

// ─── Web API ──────────────────────────────────────────────────────────────────

const webApi = buildWebApi({
   getConfig: () => config,
   ServerStats,
   System,
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
   console.log("[agent] Starting Rocket Agent...");
   console.log(`[agent] Panel: ${config.panel_url}`);

   try {
      await RemoteConfig.fetch();
   } catch (err) {
      console.warn("[agent] Remote config failed, using local defaults:", err.message);
   }

   XrayFullConfig.start();
   JobRunner.start();
   Traffic.startXray();
   Traffic.startSsh();
   Traffic.startOvpn();
   Online.startSsh();
   Online.startOvpn();
   RemoteConfig.start();
   webApi.start();
}

boot();

process.on("unhandledRejection", (err) => console.error("[agent] unhandledRejection:", err?.stack ?? err));
process.on("uncaughtException", (err) => console.error("[agent] uncaughtException:", err?.stack ?? err));
