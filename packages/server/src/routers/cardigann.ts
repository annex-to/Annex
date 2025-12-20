import { z } from "zod";
import { cardigannRepository } from "../services/cardigann/index.js";
import { publicProcedure, router } from "../trpc.js";

export const cardigannRouter = router({
  sync: publicProcedure.mutation(async () => {
    const stats = await cardigannRepository.syncFromGitHub();
    return {
      success: true,
      ...stats,
      message: `Synced ${stats.added + stats.updated} definitions (${stats.added} new, ${stats.updated} updated)`,
    };
  }),

  list: publicProcedure
    .input(
      z
        .object({
          search: z.string().optional(),
          language: z.string().optional(),
          type: z.string().optional(),
          supportsMovies: z.boolean().optional(),
          supportsTv: z.boolean().optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      let definitions = await cardigannRepository.listDefinitions();

      if (input?.search) {
        definitions = await cardigannRepository.searchDefinitions(input.search);
      }

      if (input?.language) {
        definitions = definitions.filter((d) => d.language === input.language);
      }

      if (input?.type) {
        definitions = definitions.filter((d) => d.type === input.type);
      }

      if (input?.supportsMovies !== undefined) {
        definitions = definitions.filter((d) => d.supportsMovieSearch === input.supportsMovies);
      }

      if (input?.supportsTv !== undefined) {
        definitions = definitions.filter((d) => d.supportsTvSearch === input.supportsTv);
      }

      return definitions.sort((a, b) => a.name.localeCompare(b.name));
    }),

  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const definition = await cardigannRepository.getDefinition(input.id);

    if (!definition) {
      throw new Error(`Definition not found: ${input.id}`);
    }

    return definition;
  }),

  info: publicProcedure.query(async () => {
    return cardigannRepository.getRepositoryInfo();
  }),

  clearCache: publicProcedure.mutation(async () => {
    cardigannRepository.clearCache();
    return { success: true, message: "Cache cleared" };
  }),
});
