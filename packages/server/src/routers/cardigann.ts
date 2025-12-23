import { Prisma } from "@prisma/client";
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

      // Get base URL from definition
      const baseUrl = definition.definition.links?.[0] || "https://example.com";

      // Create CardigannIndexer and corresponding Indexer in a transaction
      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const cardigannIndexer = await tx.cardigannIndexer.create({
          data: input,
        });

        // Create corresponding Indexer record for unified search
        await tx.indexer.create({
          data: {
            name: input.name,
            type: "CARDIGANN",
            url: baseUrl,
            apiKey: cardigannIndexer.id, // Store CardigannIndexer ID in apiKey field
            categoriesMovies: input.categoriesMovies,
            categoriesTv: input.categoriesTv,
            priority: input.priority,
            enabled: input.enabled,
            rateLimitEnabled: input.rateLimitEnabled,
            rateLimitMax: input.rateLimitMax,
            rateLimitWindowSecs: input.rateLimitWindowSecs,
          },
        });

        return cardigannIndexer;
      });

      return result;
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

      // Update both CardigannIndexer and corresponding Indexer in a transaction
      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const cardigannIndexer = await tx.cardigannIndexer.update({
          where: { id },
          data,
        });

        // Find and update corresponding Indexer record
        const indexer = await tx.indexer.findFirst({
          where: {
            type: "CARDIGANN",
            apiKey: id,
          },
        });

        if (indexer) {
          await tx.indexer.update({
            where: { id: indexer.id },
            data: {
              name: data.name,
              categoriesMovies: data.categoriesMovies,
              categoriesTv: data.categoriesTv,
              priority: data.priority,
              enabled: data.enabled,
              rateLimitEnabled: data.rateLimitEnabled,
              rateLimitMax: data.rateLimitMax,
              rateLimitWindowSecs: data.rateLimitWindowSecs,
            },
          });
        }

        return cardigannIndexer;
      });

      return result;
    }),

  deleteIndexer: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    // Delete both CardigannIndexer and corresponding Indexer in a transaction
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.cardigannIndexer.delete({
        where: { id: input.id },
      });

      // Find and delete corresponding Indexer record
      const indexer = await tx.indexer.findFirst({
        where: {
          type: "CARDIGANN",
          apiKey: input.id,
        },
      });

      if (indexer) {
        await tx.indexer.delete({
          where: { id: indexer.id },
        });
      }
    });

    return { success: true, message: "Indexer deleted" };
  }),

  searchIndexer: publicProcedure
    .input(
      z.object({
        id: z.string(),
        query: z.string().optional(),
        imdbId: z.string().optional(),
        tmdbId: z.string().optional(),
        tvdbId: z.string().optional(),
        season: z.number().optional(),
        episode: z.number().optional(),
        categories: z.array(z.string()).optional(),
        limit: z.number().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, ...searchParams } = input;

      const cardigannIndexer = await prisma.cardigannIndexer.findUnique({
        where: { id },
      });

      if (!cardigannIndexer) {
        throw new Error(`Indexer not found: ${id}`);
      }

      if (!cardigannIndexer.enabled) {
        throw new Error(`Indexer is disabled: ${cardigannIndexer.name}`);
      }

      const definition = await cardigannRepository.getDefinition(cardigannIndexer.definitionId);
      if (!definition) {
        throw new Error(`Definition not found: ${cardigannIndexer.definitionId}`);
      }

      const baseUrl = definition.definition.links?.[0];
      if (!baseUrl) {
        throw new Error(`No base URL found in definition: ${cardigannIndexer.definitionId}`);
      }

      // Build settings from stored configuration
      const settings: { [key: string]: string | boolean } = {};
      const storedSettings = cardigannIndexer.settings as Record<string, unknown>;
      for (const [key, value] of Object.entries(storedSettings)) {
        if (typeof value === "string" || typeof value === "boolean") {
          settings[key] = value;
        }
      }

      // Build context
      const context = {
        definition: definition.definition,
        settings,
        cookies: {},
        baseUrl,
      };

      // Execute search
      const { cardigannExecutor } = await import("../services/cardigann/index.js");
      const results = await cardigannExecutor.search(context, searchParams);

      return {
        indexerName: cardigannIndexer.name,
        resultCount: results.length,
        results,
      };
    }),

  testIndexer: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const cardigannIndexer = await prisma.cardigannIndexer.findUnique({
      where: { id: input.id },
    });

    if (!cardigannIndexer) {
      throw new Error(`Indexer not found: ${input.id}`);
    }

    const definition = await cardigannRepository.getDefinition(cardigannIndexer.definitionId);
    if (!definition) {
      throw new Error(`Definition not found: ${cardigannIndexer.definitionId}`);
    }

    // Get base URL from definition
    const baseUrl = definition.definition.links?.[0];
    if (!baseUrl) {
      throw new Error(`No base URL found in definition: ${cardigannIndexer.definitionId}`);
    }

    // Build settings from stored configuration
    const settings: { [key: string]: string | boolean } = {};
    const storedSettings = cardigannIndexer.settings as Record<string, unknown>;
    for (const [key, value] of Object.entries(storedSettings)) {
      if (typeof value === "string" || typeof value === "boolean") {
        settings[key] = value;
      }
    }

    // Build context
    const context = {
      definition: definition.definition,
      settings,
      cookies: {},
      baseUrl,
    };

    // Perform a simple test search
    try {
      const { cardigannExecutor } = await import("../services/cardigann/index.js");
      const results = await cardigannExecutor.search(context, {
        query: "test",
        limit: 5,
      });

      return {
        success: true,
        message: "Search test successful",
        indexerName: cardigannIndexer.name,
        definition: {
          id: definition.definition.id,
          name: definition.definition.name,
          links: definition.definition.links,
        },
        testResults: {
          resultCount: results.length,
          sample: results.slice(0, 3).map((r) => ({
            title: r.title,
            size: r.size,
            seeders: r.seeders,
          })),
        },
      };
    } catch (error) {
      return {
        success: false,
        message: `Search test failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        indexerName: cardigannIndexer.name,
        definition: {
          id: definition.definition.id,
          name: definition.definition.name,
          links: definition.definition.links,
        },
      };
    }
  }),
});
