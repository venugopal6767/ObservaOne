// Feature routers. "public" ones authenticate themselves (webhooks, beacons with their own keys);
// "private" ones run after the sign-in check.
import { agentsRouter } from './agents.js';
import { agentMgmtRouter } from './agent-mgmt.js';
import { tenantsRouter } from './tenants.js';
import { gatewaysRouter } from './gateways.js';
import { alertingRouter } from './alerting.js';

export const extraRouters = {
  public: [],
  private: [agentsRouter, agentMgmtRouter, tenantsRouter, gatewaysRouter, alertingRouter],
};
