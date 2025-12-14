import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "@annex/server/routers";
import { getAuthToken } from "./hooks/useAuth";

export const trpc = createTRPCReact<AppRouter>();

export function getTrpcClient() {
  return trpc.createClient({
    transformer: superjson,
    links: [
      httpBatchLink({
        url: "/trpc",
        headers() {
          const token = getAuthToken();
          return token
            ? {
                Authorization: `Bearer ${token}`,
              }
            : {};
        },
      }),
    ],
  });
}
