import { randomUUID } from 'node:crypto';
import cors, { type CorsOptions } from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { config } from './config/env.js';
import { logger } from './config/logger.js';
import { getDb } from './db/mongo.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { apiLimiter } from './middleware/rate-limit.js';
import { apiRouter } from './routes.js';

const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.0\.2\.2)(:\d+)?$/;

function corsOptions(): CorsOptions {
  const allowed = config.cors.origins;
  return {
    origin(origin, callback) {
      // Non-browser clients (mobile apps, curl) send no Origin header.
      if (!origin) return callback(null, true);
      if (allowed === '*') return callback(null, true);
      if (allowed === 'dev-localhost') return callback(null, LOCALHOST_ORIGIN.test(origin));
      return callback(null, allowed.includes(origin));
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
    maxAge: 600,
  };
}

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.server.trustProxy);
  app.set('query parser', 'extended');

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors(corsOptions()));
  app.use(express.json({ limit: '200kb' }));

  app.get('/', (_req, res) => {
    res.json({
      success: true,
      data: { name: 'RentOLedger API', version: '1.0.0', apiPrefix: config.server.apiPrefix, health: '/health', ready: '/ready' },
    });
  });

  // Liveness: the process is up.
  app.get('/health', (_req, res) => {
    res.json({ success: true, data: { status: 'ok', uptime: Math.round(process.uptime()) } });
  });

  // Readiness: dependencies are reachable.
  app.get('/ready', async (_req, res) => {
    try {
      await getDb().command({ ping: 1 });
      res.json({ success: true, data: { status: 'ready', database: 'up' } });
    } catch {
      res.status(503).json({ success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database unavailable' } });
    }
  });

  app.get(`${config.server.apiPrefix}/health`, (_req, res) => {
    res.json({ success: true, data: { status: 'ok' } });
  });

  app.use(config.server.apiPrefix, apiLimiter, apiRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
