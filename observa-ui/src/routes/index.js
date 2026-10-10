// Feature routers. "public" ones authenticate themselves (webhooks, beacons with their own keys);
// "private" ones run after the sign-in check.
import { agentsRouter } from './agents.js';
import { incidentsRouter } from './incidents.js';
import { insightsRouter } from './insights.js';

export const extraRouters = {
  public: [],
  private: [agentsRouter, incidentsRouter, insightsRouter],
};
