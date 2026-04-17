#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { loadConfig }       = require('./config');
const { MachineSession }   = require('./MachineSession');
const { TunnelServer }     = require('./TunnelServer');
const { startHealthServer } = require('./health');
const { rootLogger, makeLogger } = require('./logger');

const log = rootLogger;

// ─── Resolve config path ────────────────────────────────────────────────────

const configArg = process.argv[2];
if (!configArg) {
  log.error('Usage: node index.js <config.json>');
  process.exit(1);
}

const configPath = path.resolve(configArg);
log.info(`Loading config from ${configPath}`);

let config;
try {
  config = loadConfig(configPath);
} catch (err) {
  log.error(`Config error: ${err.message}`);
  process.exit(1);
}

// ─── Group tunnels by machineName ───────────────────────────────────────────

const machineMap = new Map(); // machineName → { keyPath, tunnelSpecs[] }

for (const tunnel of config.tunnels) {
  if (!machineMap.has(tunnel.machineName)) {
    machineMap.set(tunnel.machineName, {
      keyPath:     tunnel.keyPath,
      tunnelSpecs: [],
    });
  }
  machineMap.get(tunnel.machineName).tunnelSpecs.push({
    hostPort: tunnel.hostPort,
    vmPort:   tunnel.vmPort,
  });
}

// ─── Build MachineSession instances ─────────────────────────────────────────

const sessions = new Map(); // machineName → MachineSession

for (const [machineName, { keyPath, tunnelSpecs }] of machineMap) {
  const sessionLog = makeLogger(machineName);
  sessionLog.port  = rootLogger.port; // propagate port formatter

  const session = new MachineSession(
    machineName,
    keyPath,
    config,
    tunnelSpecs,
    sessionLog
  );

  sessions.set(machineName, session);
}

// ─── Build TunnelServer instances ───────────────────────────────────────────

const tunnelServers = [];

for (const tunnel of config.tunnels) {
  const session    = sessions.get(tunnel.machineName);
  const tunnelLog  = makeLogger(tunnel.machineName);
  tunnelLog.port   = rootLogger.port;

  const server = new TunnelServer(
    tunnel,
    session,
    config.listenHost,
    tunnelLog
  );

  tunnelServers.push(server);
}

// ─── Startup ─────────────────────────────────────────────────────────────────

const startedAt = Date.now();

const healthServer = startHealthServer({
  host:    config.healthHost,
  port:    config.healthPort,
  startedAt,
  getMachineSessions: () => [...sessions.values()].map((s) => s.healthSnapshot()),
  getTunnelServers:   () => tunnelServers.map((t) => t.healthSnapshot()),
  log,
});

async function main() {
  log.info(`Starting multipass tunnel daemon`);
  log.info(`Machines: ${[...sessions.keys()].join(', ')}`);
  log.info(`Tunnels:  ${config.tunnels.map((t) => `${t.hostPort}→${t.machineName}`).join(', ')}`);

  // Start all tunnel servers (bind ports)
  await Promise.all(tunnelServers.map((t) => t.start()));

  // Eagerly connect all machine sessions
  for (const [machineName, session] of sessions) {
    session.ensureReady().catch((err) => {
      log.warn(`Initial connect for "${machineName}" failed: ${err.message} — will retry on demand`);
    });

    // Start periodic IP refresh loop (runs forever, detached)
    session.startIpRefreshLoop().catch((err) => {
      log.error(`IP refresh loop crashed for "${machineName}": ${err.message}`);
    });
  }

  log.info('Daemon ready');
}

// ─── Graceful shutdown ───────────────────────────────────────────────────────

function shutdown() {
  log.info('Shutting down…');

  for (const s of sessions.values()) s.shutdown();
  for (const t of tunnelServers)     t.shutdown();

  try { healthServer.close(); } catch {}
  setTimeout(() => process.exit(0), 2000).unref();
  process.exit(0);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
