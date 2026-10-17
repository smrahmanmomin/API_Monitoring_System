import { Router, type RequestHandler } from 'express';
import type { AppDeps } from '../container.js';
import { createAlertsController } from '../controllers/alertsController.js';
import { createMonitorController } from '../controllers/monitorController.js';
import { createSystemController } from '../controllers/systemController.js';

export function createRouter(deps: AppDeps, monitorRateLimit: RequestHandler): Router {
  const router = Router();
  const monitor = createMonitorController(deps);
  const alerts = createAlertsController(deps);
  const system = createSystemController(deps);

  router.get('/health', system.health);
  router.get('/stats', system.stats);
  router.get('/checks', system.checks);

  router.post('/monitor', monitorRateLimit, monitor.ingest);

  router.get('/alerts', alerts.list);
  router.get('/alerts/:id', alerts.get);
  router.patch('/alerts/:id/status', alerts.updateStatus);
  router.post('/alerts/:id/regenerate', monitorRateLimit, alerts.regenerate);

  return router;
}
