/**
 * Job Subscriptions Router
 *
 * tRPC subscriptions for real-time job updates via WebSocket.
 */

import { router, publicProcedure } from "../trpc.js";
import { z } from "zod";
import { observable } from "@trpc/server/observable";
import {
  getJobEventService,
  type JobUpdateEvent,
  type WorkerStatusEvent,
  type GpuStatusEvent,
} from "../services/jobEvents.js";

export const jobSubscriptionsRouter = router({
  /**
   * Subscribe to all job updates
   */
  onJobUpdate: publicProcedure.subscription(() => {
    return observable<JobUpdateEvent>((emit) => {
      const events = getJobEventService();
      const unsubscribe = events.onJobUpdate((event) => {
        emit.next(event);
      });
      return unsubscribe;
    });
  }),

  /**
   * Subscribe to job updates for a specific request
   */
  onRequestJobs: publicProcedure
    .input(z.object({ requestId: z.string() }))
    .subscription(({ input }) => {
      return observable<JobUpdateEvent>((emit) => {
        const events = getJobEventService();
        const unsubscribe = events.onRequestJobs(input.requestId, (event) => {
          emit.next(event);
        });
        return unsubscribe;
      });
    }),

  /**
   * Subscribe to child job updates for a specific parent job
   */
  onChildJobs: publicProcedure
    .input(z.object({ parentJobId: z.string() }))
    .subscription(({ input }) => {
      return observable<JobUpdateEvent>((emit) => {
        const events = getJobEventService();
        const unsubscribe = events.onChildJobs(input.parentJobId, (event) => {
          emit.next(event);
        });
        return unsubscribe;
      });
    }),

  /**
   * Subscribe to worker status updates
   */
  onWorkerStatus: publicProcedure.subscription(() => {
    return observable<WorkerStatusEvent>((emit) => {
      const events = getJobEventService();
      const unsubscribe = events.onWorkerStatus((status) => {
        emit.next(status);
      });
      return unsubscribe;
    });
  }),

  /**
   * Subscribe to GPU status updates
   */
  onGpuStatus: publicProcedure.subscription(() => {
    return observable<GpuStatusEvent>((emit) => {
      const events = getJobEventService();
      const unsubscribe = events.onGpuStatus((status) => {
        emit.next(status);
      });
      return unsubscribe;
    });
  }),
});
