import { router } from "../trpc.js";
import { authRouter } from "./auth.js";
import { discoveryRouter } from "./discovery.js";
import { requestsRouter } from "./requests.js";
import { serversRouter } from "./servers.js";
import { indexersRouter } from "./indexers.js";
import { libraryRouter } from "./library.js";
import { systemRouter } from "./system.js";
import { syncRouter } from "./sync.js";
import { jobSubscriptionsRouter } from "./jobSubscriptions.js";
import { encodersRouter } from "./encoders.js";
import { secretsRouter } from "./secrets.js";
import { pipelinesRouter } from "./pipelines.js";
import { approvalsRouter } from "./approvals.js";
import { notificationsRouter } from "./notifications.js";

export const appRouter = router({
  auth: authRouter,
  discovery: discoveryRouter,
  requests: requestsRouter,
  servers: serversRouter,
  indexers: indexersRouter,
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
