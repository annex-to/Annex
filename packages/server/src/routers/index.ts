import { router } from "../trpc.js";
import { approvalsRouter } from "./approvals.js";
import { authRouter } from "./auth.js";
import { cardigannRouter } from "./cardigann.js";
import { discoveryRouter } from "./discovery.js";
import { downloadClientsRouter } from "./downloadClients.js";
import { encodersRouter } from "./encoders.js";
import { indexersRouter } from "./indexers.js";
import { jobSubscriptionsRouter } from "./jobSubscriptions.js";
import { libraryRouter } from "./library.js";
import { notificationsRouter } from "./notifications.js";
import { pipelinesRouter } from "./pipelines.js";
import { requestsRouter } from "./requests.js";
import { secretsRouter } from "./secrets.js";
import { serversRouter } from "./servers.js";
import { syncRouter } from "./sync.js";
import { systemRouter } from "./system.js";

export const appRouter = router({
  auth: authRouter,
  cardigann: cardigannRouter,
  discovery: discoveryRouter,
  requests: requestsRouter,
  servers: serversRouter,
  indexers: indexersRouter,
  downloadClients: downloadClientsRouter,
  library: libraryRouter,
  system: systemRouter,
  sync: syncRouter,
  jobs: jobSubscriptionsRouter,
  encoders: encodersRouter,
  secrets: secretsRouter,
  pipelines: pipelinesRouter,
  approvals: approvalsRouter,
  notifications: notificationsRouter,
});

export type AppRouter = typeof appRouter;
