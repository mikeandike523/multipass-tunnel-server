'use strict';

const http = require('node:http');

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type':   'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} opts.port
 * @param {number} opts.startedAt
 * @param {() => object[]} opts.getMachineSessions   - returns array of MachineSession health snapshots
 * @param {() => object[]} opts.getTunnelServers     - returns array of TunnelServer health snapshots
 * @param {object} opts.log
 */
function startHealthServer({ host, port, startedAt, getMachineSessions, getTunnelServers, log }) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      writeJson(res, 405, { error: 'method not allowed' });
      return;
    }

    const now = Date.now();

    if (req.url === '/' || req.url === '/live') {
      writeJson(res, 200, {
        ok: true,
        uptimeSec: Math.floor((now - startedAt) / 1000),
      });
      return;
    }

    if (req.url === '/health') {
      const machines = getMachineSessions();
      const tunnels  = getTunnelServers();

      const allReady = machines.every((m) => m.state === 'ready');

      writeJson(res, allReady ? 200 : 503, {
        ok:        allReady,
        uptimeSec: Math.floor((now - startedAt) / 1000),
        machines,
        tunnels,
      });
      return;
    }

    writeJson(res, 404, { error: 'not found' });
  });

  server.on('error', (err) => {
    log.error(`Health server error: ${err.message}`);
    process.exit(1);
  });

  server.listen(port, host, () => {
    log.info(`Health server listening on http://${host}:${port}`);
  });

  return server;
}

module.exports = { startHealthServer };
