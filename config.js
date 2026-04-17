'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Resolves a path that may be absolute, or relative according to resolveRelativeMode.
 * @param {string} p - The path string from config
 * @param {'cwd'|'config'} mode
 * @param {string} configDir - Directory of the config file
 */
function resolvePath(p, mode, configDir) {
  if (path.isAbsolute(p)) return p;
  const base = mode === 'config' ? configDir : process.cwd();
  return path.resolve(base, p);
}

/**
 * Resolves the SSH private key path for a given tunnel entry.
 * Resolution order:
 *   1. tunnel.keyPath  (explicit per-tunnel)
 *   2. config.machineKeys[machineName]
 *   3. <keysFolder>/<machineName>
 */
function resolveKeyPath(tunnel, config, configDir) {
  const mode = config.resolveRelativeMode || 'cwd';

  if (tunnel.keyPath) {
    return resolvePath(tunnel.keyPath, mode, configDir);
  }

  if (config.machineKeys && config.machineKeys[tunnel.machineName]) {
    return resolvePath(config.machineKeys[tunnel.machineName], mode, configDir);
  }

  if (!config.keysFolder) {
    throw new Error(
      `No key path resolvable for machine "${tunnel.machineName}": ` +
      `no tunnel.keyPath, no machineKeys entry, and no keysFolder defined`
    );
  }

  const keysFolder = resolvePath(config.keysFolder, mode, configDir);
  return path.join(keysFolder, tunnel.machineName);
}

/**
 * Validates and normalises vmPort.
 * Returns either:
 *   { type: 'static', port: number }
 *   { type: 'discovery', portDiscoveryFile: string, portDiscoveryKey: string }
 */
function normaliseVmPort(vmPort, tunnelIndex) {
  if (typeof vmPort === 'number') {
    if (!Number.isInteger(vmPort) || vmPort < 1 || vmPort > 65535) {
      throw new Error(`tunnels[${tunnelIndex}].vmPort: invalid port number ${vmPort}`);
    }
    return { type: 'static', port: vmPort };
  }

  if (vmPort && typeof vmPort === 'object') {
    const { portDiscoveryFile, portDiscoveryKey } = vmPort;
    if (typeof portDiscoveryFile !== 'string' || !portDiscoveryFile) {
      throw new Error(`tunnels[${tunnelIndex}].vmPort.portDiscoveryFile must be a non-empty string`);
    }
    if (typeof portDiscoveryKey !== 'string' || !portDiscoveryKey) {
      throw new Error(`tunnels[${tunnelIndex}].vmPort.portDiscoveryKey must be a non-empty string`);
    }
    return { type: 'discovery', portDiscoveryFile, portDiscoveryKey };
  }

  throw new Error(`tunnels[${tunnelIndex}].vmPort must be a number or a port discovery object`);
}

/**
 * Loads, validates and normalises the config file at the given path.
 * Returns a fully resolved config object ready for use by the daemon.
 */
function loadConfig(configPath) {
  const absConfigPath = path.resolve(configPath);

  if (!fs.existsSync(absConfigPath)) {
    throw new Error(`Config file not found: ${absConfigPath}`);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(absConfigPath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse config file: ${err.message}`);
  }

  const configDir = path.dirname(absConfigPath);
  const mode = raw.resolveRelativeMode || 'cwd';

  if (!['cwd', 'config'].includes(mode)) {
    throw new Error(`resolveRelativeMode must be "cwd" or "config", got: ${JSON.stringify(mode)}`);
  }

  if (!Array.isArray(raw.tunnels) || raw.tunnels.length === 0) {
    throw new Error('Config must have a non-empty "tunnels" array');
  }

  const tunnels = raw.tunnels.map((t, i) => {
    if (typeof t.machineName !== 'string' || !t.machineName) {
      throw new Error(`tunnels[${i}].machineName must be a non-empty string`);
    }
    if (!Number.isInteger(t.hostPort) || t.hostPort < 1 || t.hostPort > 65535) {
      throw new Error(`tunnels[${i}].hostPort must be a valid port number`);
    }
    if (t.vmPort === undefined || t.vmPort === null) {
      throw new Error(`tunnels[${i}].vmPort is required`);
    }

    const vmPort = normaliseVmPort(t.vmPort, i);
    const keyPath = resolveKeyPath(t, raw, configDir);

    return {
      machineName: t.machineName,
      hostPort: t.hostPort,
      vmPort,
      keyPath,
    };
  });

  // Validate all key paths exist
  for (const t of tunnels) {
    if (!fs.existsSync(t.keyPath)) {
      throw new Error(`SSH key not found for machine "${t.machineName}": ${t.keyPath}`);
    }
  }

  return {
    resolveRelativeMode: mode,
    keysFolder: raw.keysFolder || null,
    machineKeys: raw.machineKeys || {},
    tunnels,

    // Runtime tunables with sensible defaults (not in JSON schema, but overridable via env)
    sshPort:                    Number(process.env.SSH_PORT                    || 22),
    sshReadyTimeoutMs:          Number(process.env.SSH_READY_TIMEOUT_MS        || 15000),
    sshKeepaliveIntervalMs:     Number(process.env.SSH_KEEPALIVE_INTERVAL_MS   || 15000),
    sshKeepaliveCountMax:       Number(process.env.SSH_KEEPALIVE_COUNT_MAX     || 3),
    channelOpenTimeoutMs:       Number(process.env.CHANNEL_OPEN_TIMEOUT_MS     || 10000),
    ipCacheMs:                  Number(process.env.IP_CACHE_MS                 || 15000),
    ipRefreshMs:                Number(process.env.IP_REFRESH_MS               || 5 * 60 * 1000),
    rediscoveryBackoffMs:       Number(process.env.REDISCOVERY_BACKOFF_MS      || 3000),
    reconnectBaseDelayMs:       Number(process.env.RECONNECT_BASE_DELAY_MS     || 1000),
    reconnectMaxDelayMs:        Number(process.env.RECONNECT_MAX_DELAY_MS      || 10000),
    listenHost:                 process.env.LISTEN_HOST                        || '127.0.0.1',
    healthHost:                 process.env.HEALTH_HOST                        || '127.0.0.1',
    healthPort:                 Number(process.env.HEALTH_PORT                 || 18790),
    multipassBin:               process.env.MULTIPASS_BIN                      || '/snap/bin/multipass',
  };
}

module.exports = { loadConfig };
