import * as yaml from "js-yaml";
import type { CardigannDefinition, ParsedIndexerDefinition } from "./types";

export class CardigannParser {
  parseDefinition(ymlContent: string): ParsedIndexerDefinition {
    try {
      const definition = yaml.load(ymlContent) as CardigannDefinition;

      this.validateDefinition(definition);

      return {
        definition,
        version: this.extractVersion(ymlContent),
      };
    } catch (error) {
      throw new Error(
        `Failed to parse Cardigann definition: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  parseDefinitionFromFile(filePath: string): ParsedIndexerDefinition {
    const fs = require("node:fs");
    const ymlContent = fs.readFileSync(filePath, "utf-8");
    return this.parseDefinition(ymlContent);
  }

  private validateDefinition(definition: CardigannDefinition): void {
    if (!definition.id) {
      throw new Error("Definition must have an id");
    }

    if (!definition.name) {
      throw new Error("Definition must have a name");
    }

    if (!definition.links || definition.links.length === 0) {
      throw new Error("Definition must have at least one link");
    }

    if (!definition.search) {
      throw new Error("Definition must have search configuration");
    }

    if (!definition.search.paths || definition.search.paths.length === 0) {
      throw new Error("Definition must have at least one search path");
    }
  }

  private extractVersion(ymlContent: string): string {
    const versionMatch = ymlContent.match(/# version: (.+)/i);
    return versionMatch ? versionMatch[1].trim() : "1.0";
  }

  normalizeUrl(baseUrl: string, path: string): string {
    if (path.startsWith("http://") || path.startsWith("https://")) {
      return path;
    }

    const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;

    return `${base}${normalizedPath}`;
  }

  replaceVariables(
    template: string,
    variables: { [key: string]: string | number | boolean }
  ): string {
    let result = template;

    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\{\\{\\s*\\.Config\\.${key}\\s*\\}\\}`, "g");
      result = result.replace(regex, String(value));
    }

    const queryRegex = /\{\{\s*\.Keywords\s*\}\}/g;
    if (variables.query !== undefined) {
      result = result.replace(queryRegex, String(variables.query));
    }

    const categoryRegex = /\{\{\s*\.Categories\s*\}\}/g;
    if (variables.categories !== undefined) {
      result = result.replace(categoryRegex, String(variables.categories));
    }

    const imdbRegex = /\{\{\s*\.Query\.IMDBId\s*\}\}/g;
    if (variables.imdbId !== undefined) {
      result = result.replace(imdbRegex, String(variables.imdbId));
    }

    const tmdbRegex = /\{\{\s*\.Query\.TMDBId\s*\}\}/g;
    if (variables.tmdbId !== undefined) {
      result = result.replace(tmdbRegex, String(variables.tmdbId));
    }

    const seasonRegex = /\{\{\s*\.Query\.Season\s*\}\}/g;
    if (variables.season !== undefined) {
      result = result.replace(seasonRegex, String(variables.season));
    }

    const episodeRegex = /\{\{\s*\.Query\.Episode\s*\}\}/g;
    if (variables.episode !== undefined) {
      result = result.replace(episodeRegex, String(variables.episode));
    }

    return result;
  }

  replaceFilters(
    value: string,
    filters: Array<{ name: string; args?: (string | number)[] }>
  ): string {
    let result = value;

    for (const filter of filters) {
      result = this.applyFilter(result, filter.name, filter.args || []);
    }

    return result;
  }

  private applyFilter(value: string, filterName: string, args: (string | number)[]): string {
    switch (filterName) {
      case "append":
        return value + (args[0] || "");

      case "prepend":
        return (args[0] || "") + value;

      case "replace":
        if (args.length >= 2) {
          return value.replace(new RegExp(String(args[0]), "g"), String(args[1]));
        }
        return value;

      case "split":
        if (args.length >= 2) {
          const parts = value.split(String(args[0]));
          const index = Number(args[1]);
          return parts[index] || "";
        }
        return value;

      case "trim":
        return value.trim();

      case "urlencode":
        return encodeURIComponent(value);

      case "urldecode":
        return decodeURIComponent(value);

      case "toupper":
        return value.toUpperCase();

      case "tolower":
        return value.toLowerCase();

      case "diacritics":
        return this.removeDiacritics(value);

      case "regexp":
        if (args.length >= 1) {
          const match = value.match(new RegExp(String(args[0])));
          return match ? match[0] : value;
        }
        return value;

      case "re_replace":
        if (args.length >= 2) {
          return value.replace(new RegExp(String(args[0]), "g"), String(args[1]));
        }
        return value;

      case "querystring":
        if (args.length >= 1) {
          const params = new URLSearchParams(value);
          return params.get(String(args[0])) || "";
        }
        return value;

      case "timeparse":
      case "dateparse":
        return this.parseDate(value, args[0] as string);

      case "timeago":
        return this.parseTimeAgo(value);

      case "fuzzytime":
        return this.parseFuzzyTime(value);

      default:
        console.warn(`Unknown filter: ${filterName}`);
        return value;
    }
  }

  private removeDiacritics(str: string): string {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  private parseDate(value: string, _layout?: string): string {
    try {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        return date.toISOString();
      }
    } catch (_e) {
      console.error("Failed to parse date:", value);
    }
    return value;
  }

  private parseTimeAgo(value: string): string {
    const now = new Date();
    const match = value.match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago/i);

    if (match) {
      const amount = parseInt(match[1], 10);
      const unit = match[2].toLowerCase();

      switch (unit) {
        case "minute":
          now.setMinutes(now.getMinutes() - amount);
          break;
        case "hour":
          now.setHours(now.getHours() - amount);
          break;
        case "day":
          now.setDate(now.getDate() - amount);
          break;
        case "week":
          now.setDate(now.getDate() - amount * 7);
          break;
        case "month":
          now.setMonth(now.getMonth() - amount);
          break;
        case "year":
          now.setFullYear(now.getFullYear() - amount);
          break;
      }

      return now.toISOString();
    }

    return value;
  }

  private parseFuzzyTime(value: string): string {
    const now = new Date();
    const lowerValue = value.toLowerCase();

    if (lowerValue.includes("today") || lowerValue.includes("aujourd'hui")) {
      return now.toISOString();
    }

    if (lowerValue.includes("yesterday") || lowerValue.includes("hier")) {
      now.setDate(now.getDate() - 1);
      return now.toISOString();
    }

    const timeMatch = value.match(/(\d{1,2}):(\d{2})/);
    if (timeMatch) {
      now.setHours(parseInt(timeMatch[1], 10), parseInt(timeMatch[2], 10), 0, 0);
      return now.toISOString();
    }

    return this.parseTimeAgo(value);
  }
}

export const cardigannParser = new CardigannParser();
