import { createRequire } from 'node:module';
import pino, { type LoggerOptions } from 'pino';
import { config } from './env.js';

function prettyTransportAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

const options: LoggerOptions = {
  level: config.log.level,
  base: { service: 'rentoledger-api', env: config.env },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.code',
      'req.body.refreshToken',
      'res.headers["set-cookie"]',
      '*.accessToken',
      '*.refreshToken',
      '*.code',
    ],
    censor: '[redacted]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

if (config.log.pretty && prettyTransportAvailable()) {
  options.transport = {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,service,env' },
  };
}

export const logger = pino(options);
