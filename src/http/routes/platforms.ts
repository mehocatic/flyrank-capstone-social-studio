import { Router } from 'express';
import type { Config } from '../../config.js';
import { PROFILES } from '../../platforms/profiles.js';

/**
 * Read-only view of the rules the system enforces, so a reviewer can see the active
 * profiles and the platform-to-adapter mapping without opening .env or the source.
 */
export function platformRoutes(config: Config): Router {
  const router = Router();

  router.get('/platforms', (_req, res) => {
    res.json({
      platforms: config.platforms.map((platform) => ({
        ...PROFILES[platform],
        adapter: config.publishers[platform],
      })),
    });
  });

  return router;
}
