'use strict';

const net = require('node:net');

/**
 * TunnelServer owns a single net.Server listening on hostPort.
 * Each accepted TCP connection gets a forwardOut channel through
 * the shared MachineSession for its machine.
 */
class TunnelServer {
  /**
   * @param {object} spec         - Tunnel spec: { machineName, hostPort, vmPort }
   * @param {MachineSession} session
   * @param {string} listenHost
   * @param {object} log          - Tunnel-scoped logger
   */
  constructor(spec, session, listenHost, log) {
    this.spec       = spec;
    this.session    = session;
    this.listenHost = listenHost;
    this.log        = log;

    this._server    = null;
    this._shuttingDown = false;

    this.stats = {
      acceptedSockets: 0,
      activeSockets:   0,
      openedChannels:  0,
      failedChannels:  0,
    };
  }

  /**
   * Start listening. Returns a promise that resolves once the server is bound.
   */
  start() {
    return new Promise((resolve, reject) => {
      this._server = net.createServer((socket) => {
        this._handleConnection(socket).catch((err) => {
          this.log.error(`Unhandled connection error: ${err.message}`);
          try { socket.destroy(); } catch {}
        });
      });

      this._server.on('error', (err) => {
        this.log.error(`Server error on port ${this.spec.hostPort}: ${err.message}`);
        reject(err);
      });

      this._server.listen(this.spec.hostPort, this.listenHost, () => {
        this.log.info(
          `Tunnel listening on ${this.listenHost}:${this.log.port(this.spec.hostPort)} ` +
          `→ ${this.spec.machineName}:${describeVmPort(this.spec.vmPort)}`
        );
        resolve();
      });
    });
  }

  shutdown() {
    this._shuttingDown = true;
    if (this._server) {
      this._server.close();
    }
  }

  healthSnapshot() {
    return {
      hostPort:    this.spec.hostPort,
      machineName: this.spec.machineName,
      vmPort:      describeVmPort(this.spec.vmPort),
      resolvedVmPort: this.session._resolvedPorts.get(this.spec.hostPort) ?? null,
      listening:   this._server?.listening ?? false,
      stats:       { ...this.stats },
    };
  }

  // ─── Connection Handling ───────────────────────────────────────────────────

  async _handleConnection(localSocket) {
    this.stats.acceptedSockets += 1;
    this.stats.activeSockets   += 1;

    const remote = `${localSocket.remoteAddress || '?'}:${localSocket.remotePort || '?'}`;
    this.log.debug(
      `Connection from ${remote} → port ${this.log.port(this.spec.hostPort)}. ` +
      `Active=${this.stats.activeSockets}`
    );

    let sshStream = null;
    let closed    = false;

    const cleanup = (err) => {
      if (closed) return;
      closed = true;
      if (err) this.log.debug(`Closing channel for ${remote}: ${err.message}`);
      try { localSocket.destroy(); } catch {}
      try { sshStream?.destroy(); } catch {}
    };

    // Decrement active count exactly once, whenever the socket finally closes
    let decremented = false;
    const decrement = () => {
      if (decremented) return;
      decremented = true;
      this.stats.activeSockets -= 1;
      this.log.debug(`Connection ended for ${remote}. Active=${this.stats.activeSockets}`);
    };
    localSocket.once('close', decrement);
    localSocket.once('error', decrement);
    setTimeout(decrement, 1000).unref(); // safety fallback

    try {
      sshStream = await this.session.openChannel(
        this.spec.hostPort,
        localSocket.remoteAddress || '127.0.0.1',
        localSocket.remotePort   || 0
      );

      this.stats.openedChannels += 1;
      this.session.stats.openedChannels += 1;

      localSocket.on('error', cleanup);
      sshStream.on('error', cleanup);
      localSocket.on('close', () => cleanup());
      sshStream.on('close', () => cleanup());

      localSocket.pipe(sshStream).pipe(localSocket);
    } catch (err) {
      this.stats.failedChannels  += 1;
      this.session.stats.failedChannels += 1;
      this.log.error(`Failed to open channel for ${remote}: ${err.message}`);
      cleanup(err);
    }
  }
}

function describeVmPort(vmPort) {
  if (vmPort.type === 'static') return String(vmPort.port);
  return `discovery(${vmPort.portDiscoveryFile}["${vmPort.portDiscoveryKey}"])`;
}

module.exports = { TunnelServer };
