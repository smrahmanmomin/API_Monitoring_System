import cors from 'cors';
import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import type { AppDeps } from './container.js';
import { createErrorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestContext.js';
import { createRouter } from './routes/index.js';

function limiter(windowMs: number, limit: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down', request_id: String(req.id ?? '') } });
    },
  });
}

/** Build the Express app from wired dependencies (no listening, no global state — test friendly). */
export function createApp(deps: AppDeps): Express {
  const { env } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
      methods: ['GET', 'POST', 'PATCH'],
      allowedHeaders: ['Content-Type', 'X-Request-Id', 'X-Monitor-Source'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    }),
  );
  app.use(requestLogger(deps.logger));
  app.use(limiter(env.RATE_LIMIT_WINDOW_MS, env.RATE_LIMIT_MAX));
  app.use(express.json({ limit: env.REQUEST_BODY_LIMIT, strict: false, type: ['application/json'] }));

  app.use(createRouter(deps, limiter(env.RATE_LIMIT_WINDOW_MS, env.MONITOR_RATE_LIMIT_MAX)));

  app.use(notFoundHandler);
  app.use(createErrorHandler(env.NODE_ENV === 'production'));
  return app;
}
