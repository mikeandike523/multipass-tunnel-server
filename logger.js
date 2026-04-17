'use strict';

const USE_COLOR = process.stdout.isTTY === true;

const ANSI = {
  reset:     '\x1b[0m',
  bold:      '\x1b[1m',
  dim:       '\x1b[2m',
  cyan:      '\x1b[36m',
  green:     '\x1b[32m',
  yellow:    '\x1b[33m',
  red:       '\x1b[31m',
  boldRed:   '\x1b[1;31m',
  blue:      '\x1b[34m',
  boldBlue:  '\x1b[1;34m',
  magenta:   '\x1b[35m',
};

function c(code, text) {
  if (!USE_COLOR) return text;
  return `${code}${text}${ANSI.reset}`;
}

const LEVEL_META = {
  DEBUG: { label: 'DEBUG', color: ANSI.cyan },
  INFO:  { label: 'INFO ', color: ANSI.green },
  WARN:  { label: 'WARN ', color: ANSI.yellow },
  ERROR: { label: 'ERROR', color: ANSI.boldRed },
};

function formatTimestamp() {
  return c(ANSI.dim, new Date().toISOString());
}

function formatLevel(level) {
  const meta = LEVEL_META[level] || LEVEL_META.INFO;
  return c(meta.color, `[${meta.label}]`);
}

function formatMachine(machineName) {
  if (!machineName) return '';
  return c(ANSI.boldBlue, `[${machineName}]`) + ' ';
}

function formatPort(port) {
  return c(ANSI.magenta, String(port));
}

function write(level, machineName, parts) {
  const line = [
    formatTimestamp(),
    formatLevel(level),
    formatMachine(machineName) + parts.join(' '),
  ].join(' ');
  if (level === 'ERROR') {
    console.error(line);
  } else {
    console.log(line);
  }
}

function makeLogger(machineName = null) {
  return {
    debug: (...args) => write('DEBUG', machineName, args.map(String)),
    info:  (...args) => write('INFO',  machineName, args.map(String)),
    warn:  (...args) => write('WARN',  machineName, args.map(String)),
    error: (...args) => write('ERROR', machineName, args.map(String)),
    port:  formatPort,
    child: (name) => makeLogger(name),
  };
}

const rootLogger = makeLogger(null);

module.exports = { rootLogger, makeLogger, formatPort };
