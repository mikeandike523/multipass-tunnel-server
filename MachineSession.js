'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { Client } = require('ssh2');

/**
 * MachineSession manages a single long-lived SSH connection to one Multipass VM.
 * All tunnels targeting the same machineName share this session.
 *
 * Responsibilities:
 *  - IP discovery (via `multipass info`)
 *  - SSH connect / keepalive / reconnect with exponential backoff
 *  - Dynamic vmPort discovery (via `cat` over SSH exec) on each session build
 *  - Exposing forwardOut channels to TunnelServer instances
 */
class MachineSession {
  /**
   * @param {string} machineName
   * @param {string} keyPath       - Resolved absolute path to the SSH private key
   * @param {object} config        - Global resolved config (for tunables)
   * @param {object} tunnelSpecs   - Array of tunnel specs for this machine (to discover dynamic ports)
   * @param {object} log           - Machine-scoped logger
   */
  constructor(machineName, keyPath, config, tunnelSpecs, log) {
    this.machineName  = machineName;
    this.keyPath      = keyPath;
    this.config       = config;
    this.tunnelSpecs  = tunnelSpecs; // [{hostPort, vmPort: {type,…}}, …]
    this.log          = log;

    this._privateKey  = fs.readFileSync(keyPath);

    // IP cache
    this._cachedIp    = null;
    this._cachedAt    = 0;
    this._inflightIp  = null;

    // SSH connection state
    this._conn        = null;
    this._connHost    = null;
    this._connState   = 'disconnected'; // disconnected | connecting | ready
    this._connectPromise    = null;
    this._reconnectTimer    = null;
    this._reconnectAttempt  = 0;
    this._generation        = 0;         // bumped on every successful connect

    // Resolved vmPorts keyed by hostPort: Map<hostPort, number>
    this._resolvedPorts = new Map();

    // Lifecycle
    this._shuttingDown = false;

    // Stats
    this.stats = {
      reconnects: 0,
      openedChannels: 0,
      failedChannels: 0,
    };
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Ensure the SSH session is ready and return the ssh2 Client.
   * Safe to call concurrently — deduplicates in-flight connection attempts.
   */
  async ensureReady({ forceRediscovery = false } = {}) {
    if (this._shuttingDown) throw new Error('MachineSession is shutting down');
    if (this._connState === 'ready' && this._conn) return this._conn;
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = this._doConnect({ forceRediscovery }).finally(() => {
      this._connectPromise = null;
    });

    return this._connectPromise;
  }

  /**
   * Open a forwardOut channel to the resolved vmPort for the given hostPort.
   * Handles one retry with forced reconnect on stale-transport errors.
   */
  async openChannel(hostPort, srcAddr, srcPort) {
    const vmPort = this._resolvedPorts.get(hostPort);
    if (vmPort === undefined) {
      throw new Error(`No resolved vmPort for hostPort ${hostPort} on machine "${this.machineName}"`);
    }

    let conn = await this.ensureReady();

    try {
      return await this._forwardOut(conn, srcAddr, srcPort, vmPort);
    } catch (err) {
      if (!isStaleTransportError(err)) throw err;

      this.log.warn(`Channel open failed on existing session, forcing reconnect: ${err.message}`);
      this._teardown(`channel open failed: ${err.message}`);
      conn = await this.ensureReady({ forceRediscovery: true });
      return await this._forwardOut(conn, srcAddr, srcPort, vmPort);
    }
  }

  /**
   * Returns a snapshot of current session state for the health endpoint.
   */
  healthSnapshot() {
    const now = Date.now();
    const ports = {};
    for (const [hp, vp] of this._resolvedPorts) {
      ports[hp] = vp;
    }
    return {
      machineName:    this.machineName,
      state:          this._connState,
      host:           this._connHost,
      generation:     this._generation,
      cachedIp:       this._cachedIp,
      cachedIpAgeMs:  this._cachedAt ? now - this._cachedAt : null,
      resolvedPorts:  ports,
      stats:          { ...this.stats },
    };
  }

  shutdown() {
    this._shuttingDown = true;
    this._clearReconnectTimer();
    this._teardown('shutdown');
  }

  // ─── IP Discovery ──────────────────────────────────────────────────────────

  async _getVmIp({ force = false } = {}) {
    const now = Date.now();

    if (!force && this._cachedIp && (now - this._cachedAt) < this.config.ipCacheMs) {
      return this._cachedIp;
    }

    if (!force && this._inflightIp) {
      return this._inflightIp;
    }

    this._inflightIp = (async () => {
      try {
        const ip = await this._discoverIp();
        if (ip !== this._cachedIp) {
          this.log.info(`VM IP ${this._cachedIp ? `changed ${this._cachedIp} → ${ip}` : `resolved as ${ip}`}`);
        }
        this._cachedIp = ip;
        this._cachedAt = Date.now();
        return ip;
      } catch (err) {
        if (!force && this._cachedIp) {
          this.log.warn(`IP discovery failed, reusing cached IP ${this._cachedIp}: ${err.message}`);
          return this._cachedIp;
        }
        throw err;
      } finally {
        this._inflightIp = null;
      }
    })();

    return this._inflightIp;
  }

  async _discoverIp() {
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.config.multipassBin,
        ['info', this.machineName, '--format', 'json'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b) => { stdout += b; });
      child.stderr.on('data', (b) => { stderr += b; });
      child.on('error', (err) => reject(new Error(`Failed to spawn multipass: ${err.message}`)));
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`multipass info exited ${code}: ${stderr.trim()}`));
          return;
        }
        try {
          const data = JSON.parse(stdout);
          const instance = data?.info?.[this.machineName];
          if (!instance) throw new Error(`Instance "${this.machineName}" not in multipass output`);
          const ipv4 = (Array.isArray(instance.ipv4) ? instance.ipv4 : []).filter(Boolean);
          if (ipv4.length === 0) throw new Error(`No IPv4 address for instance "${this.machineName}"`);
          resolve(ipv4[0]);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  // ─── Port Discovery ────────────────────────────────────────────────────────

  /**
   * For all tunnels on this machine that have dynamic vmPort, SSH-exec a `cat`
   * on the discovery file and extract the port number.
   * Updates this._resolvedPorts. Called once per session build.
   */
  async _discoverDynamicPorts(conn) {
    for (const t of this.tunnelSpecs) {
      if (t.vmPort.type === 'static') {
        this._resolvedPorts.set(t.hostPort, t.vmPort.port);
        continue;
      }

      const { portDiscoveryFile, portDiscoveryKey } = t.vmPort;

      try {
        const json = await this._execRead(conn, `cat ${portDiscoveryFile}`);
        const parsed = JSON.parse(json);
        const port = parsed[portDiscoveryKey];

        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(
            `Key "${portDiscoveryKey}" in ${portDiscoveryFile} is not a valid port number: ${JSON.stringify(port)}`
          );
        }

        this.log.info(
          `Dynamic port for hostPort ${this.log.port(t.hostPort)}: ` +
          `${portDiscoveryFile}["${portDiscoveryKey}"] = ${this.log.port(port)}`
        );

        this._resolvedPorts.set(t.hostPort, port);
      } catch (err) {
        this.log.error(
          `Port discovery failed for hostPort ${t.hostPort} ` +
          `(file: ${portDiscoveryFile}, key: ${portDiscoveryKey}): ${err.message}`
        );
        // Leave prior resolved port in place if present, else mark unavailable
        if (!this._resolvedPorts.has(t.hostPort)) {
          this._resolvedPorts.set(t.hostPort, null);
        }
      }
    }
  }

  /**
   * Execute a command over SSH and return its stdout as a string.
   */
  _execRead(conn, command) {
    return new Promise((resolve, reject) => {
      conn.exec(command, (err, stream) => {
        if (err) return reject(err);

        let out = '';
        let errOut = '';

        stream.on('data', (b) => { out += b; });
        stream.stderr.on('data', (b) => { errOut += b; });
        stream.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`exec "${command}" exited ${code}: ${errOut.trim()}`));
          } else {
            resolve(out);
          }
        });
        stream.on('error', reject);
      });
    });
  }

  // ─── SSH Connect / Reconnect ───────────────────────────────────────────────

  async _doConnect({ forceRediscovery = false } = {}) {
    this._clearReconnectTimer();
    this._connState = 'connecting';

    let lastErr;

    for (let attempt = 0; attempt < 2; attempt++) {
      const force = forceRediscovery || attempt > 0;

      try {
        const host = await this._getVmIp({ force });
        const conn = await this._connectToHost(host);

        // Session is up — run port discovery before marking ready
        this.log.info(`SSH session established to ${host}:${this.config.sshPort}, running port discovery…`);
        await this._discoverDynamicPorts(conn);

        this._conn           = conn;
        this._connHost       = host;
        this._connState      = 'ready';
        this._reconnectAttempt = 0;
        this._generation    += 1;

        this.log.info(`Session ready (generation ${this._generation})`);
        return conn;
      } catch (err) {
        lastErr = err;
        this.log.warn(`Connect attempt ${attempt + 1} failed: ${err.message}`);
        this._teardown(`connect failure: ${err.message}`, { quiet: true });
      }
    }

    this._connState = 'disconnected';
    throw lastErr || new Error('Failed to establish SSH session');
  }

  _connectToHost(host) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let settled = false;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { conn.end(); } catch {}
        try { conn.destroy(); } catch {}
        reject(err);
      };

      conn.once('ready', () => {
        if (settled) return;
        settled = true;
        resolve(conn);
      });

      conn.once('error', fail);

      conn.on('close', () => {
        if (this._conn === conn && !this._shuttingDown) {
          this._teardown('SSH close event');
          this._scheduleReconnect('SSH close event');
        }
      });

      conn.on('error', (err) => {
        if (!settled) { fail(err); return; }
        if (this._conn === conn && !this._shuttingDown) {
          this._teardown(`SSH runtime error: ${err.message}`);
          this._scheduleReconnect('SSH runtime error');
        }
      });

      conn.connect({
        host,
        port:                 this.config.sshPort,
        username:             this.config.sshUser || 'ubuntu',
        privateKey:           this._privateKey,
        readyTimeout:         this.config.sshReadyTimeoutMs,
        keepaliveInterval:    this.config.sshKeepaliveIntervalMs,
        keepaliveCountMax:    this.config.sshKeepaliveCountMax,
      });
    });
  }

  _scheduleReconnect(reason) {
    if (this._shuttingDown) return;
    this._clearReconnectTimer();

    this.stats.reconnects += 1;
    this._reconnectAttempt += 1;

    const exp     = Math.min(this._reconnectAttempt - 1, 5);
    const delayMs = Math.min(
      this.config.reconnectBaseDelayMs * (2 ** exp),
      this.config.reconnectMaxDelayMs
    );

    this.log.warn(`Reconnecting in ${delayMs}ms (${reason})`);

    this._reconnectTimer = setTimeout(() => {
      this.ensureReady({ forceRediscovery: true }).catch((err) => {
        this.log.error(`Reconnect failed: ${err.message}`);
        this._scheduleReconnect('retry after failed reconnect');
      });
    }, delayMs);
    this._reconnectTimer.unref();
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _teardown(reason, { quiet = false } = {}) {
    const { conn, connHost } = { conn: this._conn, connHost: this._connHost };
    this._conn         = null;
    this._connHost     = null;
    this._connState    = 'disconnected';
    this._connectPromise = null;

    if (conn) {
      if (!quiet) {
        this.log.warn(`Session torn down: ${reason}${connHost ? ` (was ${connHost})` : ''}`);
      }
      try { conn.end(); } catch {}
      try { conn.destroy(); } catch {}
    }
  }

  // ─── Channel / ForwardOut ──────────────────────────────────────────────────

  _forwardOut(conn, srcAddr, srcPort, vmPort) {
    return new Promise((resolve, reject) => {
      let timer = setTimeout(() => {
        timer = null;
        reject(new Error('forwardOut timeout'));
      }, this.config.channelOpenTimeoutMs);
      timer.unref();

      conn.forwardOut('127.0.0.1', srcPort, '127.0.0.1', vmPort, (err, stream) => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (err)   { reject(err); return; }
        resolve(stream);
      });
    });
  }

  // ─── Periodic IP Refresh ───────────────────────────────────────────────────

  async startIpRefreshLoop() {
    while (!this._shuttingDown) {
      await delay(this.config.ipRefreshMs);
      if (this._shuttingDown) break;

      try {
        const oldIp = this._cachedIp;
        const freshIp = await this._getVmIp({ force: true });

        if (oldIp && freshIp !== oldIp) {
          this.log.warn(`Periodic refresh: IP changed ${oldIp} → ${freshIp}, forcing reconnect`);
          this._teardown('IP changed during periodic refresh');
          this._scheduleReconnect('IP changed');
        } else {
          this.log.debug(`Periodic IP refresh: ${freshIp} (unchanged)`);
        }
      } catch (err) {
        this.log.warn(`Periodic IP refresh failed: ${err.message}`);
      }
    }
  }
}

function isStaleTransportError(err) {
  return /channel open failure|administratively prohibited|connection lost|not connected|failure/i.test(
    String(err && err.message || err)
  );
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { MachineSession };
