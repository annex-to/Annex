import { z } from "zod";
import { prisma } from "../db/client.js";
import { cardigannRepository } from "../services/cardigann/index.js";
import { publicProcedure, router } from "../trpc.js";

export const cardigannRouter = router({
  // Definition Repository Management
  sync: publicProcedure.mutation(async () => {
    const stats = await cardigannRepository.syncFromGitHub();
    return {
      success: true,
      ...stats,
      message: `Synced ${stats.added + stats.updated} definitions (${stats.added} new, ${stats.updated} updated)`,
    };
  }),

  listDefinitions: publicProcedure
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

  getDefinition: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
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

  // Indexer Instance Management
  listIndexers: publicProcedure.query(async () => {
    return prisma.cardigannIndexer.findMany({
      orderBy: [{ enabled: "desc" }, { priority: "desc" }, { name: "asc" }],
    });
  }),

  getIndexer: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const indexer = await prisma.cardigannIndexer.findUnique({
      where: { id: input.id },
    });

    if (!indexer) {
      throw new Error(`Indexer not found: ${input.id}`);
    }

    return indexer;
  }),

  createIndexer: publicProcedure
    .input(
      z.object({
        definitionId: z.string(),
        name: z.string(),
        settings: z.record(z.string(), z.any()).default({}),
        categoriesMovies: z.array(z.number()).default([]),
        categoriesTv: z.array(z.number()).default([]),
        priority: z.number().default(50),
        enabled: z.boolean().default(true),
        rateLimitEnabled: z.boolean().default(false),
        rateLimitMax: z.number().optional(),
        rateLimitWindowSecs: z.number().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // Verify definition exists
      const definition = await cardigannRepository.getDefinition(input.definitionId);
      if (!definition) {
        throw new Error(`Definition not found: ${input.definitionId}`);
      }

      return prisma.cardigannIndexer.create({
        data: input,
      });
    }),

  updateIndexer: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        settings: z.record(z.string(), z.any()).optional(),
        categoriesMovies: z.array(z.number()).optional(),
        categoriesTv: z.array(z.number()).optional(),
        priority: z.number().optional(),
        enabled: z.boolean().optional(),
        rateLimitEnabled: z.boolean().optional(),
        rateLimitMax: z.number().optional(),
        rateLimitWindowSecs: z.number().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, ...data } = input;

      return prisma.cardigannIndexer.update({
        where: { id },
        data,
      });
    }),

  deleteIndexer: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    await prisma.cardigannIndexer.delete({
      where: { id: input.id },
    });

    return { success: true, message: "Indexer deleted" };
  }),

  testIndexer: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const indexer = await prisma.cardigannIndexer.findUnique({
      where: { id: input.id },
    });

    if (!indexer) {
      throw new Error(`Indexer not found: ${input.id}`);
    }

    const definition = await cardigannRepository.getDefinition(indexer.definitionId);
    if (!definition) {
      throw new Error(`Definition not found: ${indexer.definitionId}`);
    }

    // TODO: Implement actual search test when executor is integrated
    // For now, just verify definition is valid
    return {
      success: true,
      message: "Indexer configured correctly",
      indexerName: indexer.name,
      definition: {
        id: definition.definition.id,
        name: definition.definition.name,
        links: definition.definition.links,
      },
    };
  }),
});
