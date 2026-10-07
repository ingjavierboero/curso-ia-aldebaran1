import express, { type NextFunction, type Request, type Response } from 'express';
import type { Db } from './db/index.js';
import { reviewRoutes } from './review/routes.js';

export interface AppDeps {
  db: Db;
  /** CUIT del emisor (ARCA_CUIT), para el PDF de las facturas. */
  issuerCuit: string;
  now?: () => Date;
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api', reviewRoutes(deps));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'No existe' });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(error);
    res.status(500).json({ error: 'Error interno del servidor' });
  });

  return app;
}
