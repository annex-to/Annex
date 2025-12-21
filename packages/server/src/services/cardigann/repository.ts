import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cardigannParser } from "./parser";
import type { CardigannDefinition, ParsedIndexerDefinition } from "./types";

export interface DefinitionMetadata {
  id: string;
  name: string;
  description?: string;
  language?: string;
  type?: string;
  links: string[];
  version: string;
  categories?: string[];
  supportsMovieSearch?: boolean;
  supportsTvSearch?: boolean;
  lastUpdated: Date;
}

interface RepositoryInfo {
  url: string;
  branch: string;
  definitionsPath: string;
}

export class CardigannRepository {
  private readonly storageDir: string;
  private readonly repositoryInfo: RepositoryInfo;
  private definitionsCache: Map<string, ParsedIndexerDefinition> = new Map();

  constructor(storageDir: string = "./data/cardigann-definitions") {
    this.storageDir = storageDir;
    this.repositoryInfo = {
      url: "https://api.github.com/repos/Prowlarr/Indexers/contents/definitions/v11",
      branch: "master",
      definitionsPath: "definitions/v11",
    };
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.storageDir)) {
      await mkdir(this.storageDir, { recursive: true });
    }
  }

  async syncFromGitHub(): Promise<{ added: number; updated: number; errors: string[] }> {
    await this.initialize();

    const stats = { added: 0, updated: 0, errors: [] as string[] };

    try {
      console.log(`[Cardigann] Fetching definitions from ${this.repositoryInfo.url}`);
      const files = await this.fetchDefinitionsList();
      console.log(`[Cardigann] Fetched ${files.length} files from GitHub`);

      for (const file of files) {
        if (file.name.endsWith(".yml")) {
          try {
            const content = await this.fetchFileContent(file.download_url);
            const definitionId = file.name.replace(".yml", "");

            const exists = await this.hasDefinition(definitionId);
            await this.saveDefinition(definitionId, content);

            if (exists) {
              stats.updated++;
            } else {
              stats.added++;
            }
          } catch (error) {
            const errorMsg = `Failed to sync ${file.name}: ${error instanceof Error ? error.message : "Unknown error"}`;
            console.error(`[Cardigann] ${errorMsg}`);
            stats.errors.push(errorMsg);
          }
        }
      }

      console.log(`[Cardigann] Sync complete: ${stats.added} added, ${stats.updated} updated, ${stats.errors.length} errors`);
      await this.saveMetadata({ lastSync: new Date().toISOString(), stats });
    } catch (error) {
      const errorMsg = `Failed to sync from GitHub: ${error instanceof Error ? error.message : "Unknown error"}`;
      console.error(`[Cardigann] ${errorMsg}`);
      throw new Error(errorMsg);
    }

    return stats;
  }

  private async fetchDefinitionsList(): Promise<Array<{ name: string; download_url: string }>> {
    const response = await fetch(this.repositoryInfo.url, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Annex-Media-Server",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Cardigann] GitHub API error ${response.status}: ${errorText}`);
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    console.log(`[Cardigann] GitHub API returned ${Array.isArray(data) ? data.length : 0} items`);

    if (!Array.isArray(data)) {
      console.error(`[Cardigann] Invalid response from GitHub API:`, data);
      throw new Error("Invalid response from GitHub API");
    }

    // Log sample items to debug
    if (data.length > 0) {
      console.log(`[Cardigann] Sample items:`, data.slice(0, 3).map((item: any) => ({
        name: item.name,
        type: item.type,
        download_url: item.download_url
      })));
    }

    // biome-ignore lint/suspicious/noExplicitAny: GitHub API response type is not typed
    const ymlFiles = data.filter((item: any) =>
      item.type === "file" && (item.name.endsWith(".yml") || item.name.endsWith(".yaml"))
    );
    console.log(`[Cardigann] Found ${ymlFiles.length} .yml/.yaml definition files`);

    return ymlFiles;
  }

  private async fetchFileContent(downloadUrl: string): Promise<string> {
    const response = await fetch(downloadUrl, {
      headers: {
        Accept: "application/vnd.github.v3.raw",
        "User-Agent": "Annex-Media-Server",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.status} ${response.statusText}`);
    }

    return response.text();
  }

  async saveDefinition(id: string, content: string): Promise<void> {
    const filePath = join(this.storageDir, `${id}.yml`);
    await writeFile(filePath, content, "utf-8");

    try {
      const parsed = cardigannParser.parseDefinition(content);
      this.definitionsCache.set(id, parsed);
    } catch (_error) {
      // Saved raw content, will try to parse on next load
    }
  }

  async getDefinition(id: string): Promise<ParsedIndexerDefinition | null> {
    const cached = this.definitionsCache.get(id);
    if (cached) {
      return cached;
    }

    const filePath = join(this.storageDir, `${id}.yml`);

    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const content = await readFile(filePath, "utf-8");
      const parsed = cardigannParser.parseDefinition(content);
      this.definitionsCache.set(id, parsed);
      return parsed;
    } catch (error) {
      console.error(`[Cardigann Repository] Failed to parse ${id}:`, error);
      return null;
    }
  }

  async hasDefinition(id: string): Promise<boolean> {
    const filePath = join(this.storageDir, `${id}.yml`);
    return existsSync(filePath);
  }

  async listDefinitions(): Promise<DefinitionMetadata[]> {
    await this.initialize();

    const files = await this.getDefinitionFiles();
    const definitions: DefinitionMetadata[] = [];

    for (const file of files) {
      const id = file.replace(".yml", "");

      try {
        const parsed = await this.getDefinition(id);

        if (parsed) {
          definitions.push(this.extractMetadata(id, parsed));
        }
      } catch (_error) {
        // Skip failed definitions
      }
    }

    return definitions;
  }

  private async getDefinitionFiles(): Promise<string[]> {
    if (!existsSync(this.storageDir)) {
      return [];
    }

    const { readdirSync } = require("node:fs");
    const files = readdirSync(this.storageDir);
    return files.filter((f: string) => f.endsWith(".yml"));
  }

  private extractMetadata(id: string, parsed: ParsedIndexerDefinition): DefinitionMetadata {
    const def = parsed.definition;

    return {
      id,
      name: def.name,
      description: def.description,
      language: def.language,
      type: def.type,
      links: def.links || [],
      version: parsed.version,
      categories: this.extractCategories(def),
      supportsMovieSearch: this.supportsMovieSearch(def),
      supportsTvSearch: this.supportsTvSearch(def),
      lastUpdated: new Date(),
    };
  }

  private extractCategories(def: CardigannDefinition): string[] {
    if (!def.caps?.categorymappings) {
      return [];
    }

    return def.caps.categorymappings.map((m) => m.cat);
  }

  private supportsMovieSearch(def: CardigannDefinition): boolean {
    return def.caps?.modes?.["movie-search"] !== undefined;
  }

  private supportsTvSearch(def: CardigannDefinition): boolean {
    return def.caps?.modes?.["tv-search"] !== undefined;
  }

  async searchDefinitions(query: string): Promise<DefinitionMetadata[]> {
    const all = await this.listDefinitions();
    const lowerQuery = query.toLowerCase();

    return all.filter(
      (def) =>
        def.name.toLowerCase().includes(lowerQuery) ||
        def.id.toLowerCase().includes(lowerQuery) ||
        def.description?.toLowerCase().includes(lowerQuery)
    );
  }

  async getRepositoryInfo(): Promise<{
    totalDefinitions: number;
    lastSync?: string;
    storageDir: string;
  }> {
    const files = await this.getDefinitionFiles();
    const metadata = await this.loadMetadata();

    return {
      totalDefinitions: files.length,
      lastSync: metadata?.lastSync,
      storageDir: this.storageDir,
    };
  }

  // biome-ignore lint/suspicious/noExplicitAny: Metadata structure is dynamic
  private async saveMetadata(data: any): Promise<void> {
    const metadataPath = join(this.storageDir, ".metadata.json");
    await writeFile(metadataPath, JSON.stringify(data, null, 2), "utf-8");
  }

  // biome-ignore lint/suspicious/noExplicitAny: Metadata structure is dynamic
  private async loadMetadata(): Promise<any> {
    const metadataPath = join(this.storageDir, ".metadata.json");

    if (!existsSync(metadataPath)) {
      return null;
    }

    try {
      const content = await readFile(metadataPath, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  clearCache(): void {
    this.definitionsCache.clear();
  }
}

export const cardigannRepository = new CardigannRepository();
