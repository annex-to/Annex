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
      url: "https://api.github.com/repos/Prowlarr/Indexers/contents/definitions",
      branch: "master",
      definitionsPath: "definitions",
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
      const files = await this.fetchDefinitionsList();

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
            stats.errors.push(errorMsg);
            console.error(errorMsg);
          }
        }
      }

      await this.saveMetadata({ lastSync: new Date().toISOString(), stats });
    } catch (error) {
      throw new Error(
        `Failed to sync from GitHub: ${error instanceof Error ? error.message : "Unknown error"}`
      );
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
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      throw new Error("Invalid response from GitHub API");
    }

    return data.filter((item: any) => item.type === "file" && item.name.endsWith(".yml"));
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
      console.warn(`Failed to parse definition ${id}, but saved raw content`);
    }
  }

  async getDefinition(id: string): Promise<ParsedIndexerDefinition | null> {
    if (this.definitionsCache.has(id)) {
      return this.definitionsCache.get(id)!;
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
      console.error(`Failed to load definition ${id}:`, error);
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
      } catch (error) {
        console.warn(`Failed to load definition ${id}:`, error);
      }
    }

    return definitions;
  }

  private async getDefinitionFiles(): Promise<string[]> {
    if (!existsSync(this.storageDir)) {
      return [];
    }

    const fs = require("node:fs");
    const files = fs.readdirSync(this.storageDir);
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

  private async saveMetadata(data: any): Promise<void> {
    const metadataPath = join(this.storageDir, ".metadata.json");
    await writeFile(metadataPath, JSON.stringify(data, null, 2), "utf-8");
  }

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
