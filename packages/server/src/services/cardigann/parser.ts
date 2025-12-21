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
    const { readFileSync } = require("node:fs");
    const ymlContent = readFileSync(filePath, "utf-8");
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

    // Use URL API for proper relative URL resolution
    // This correctly handles absolute paths (/) relative to the origin
    try {
      return new URL(path, baseUrl).href;
    } catch {
      // Fallback to simple concatenation if URL parsing fails
      const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
      const normalizedPath = path.startsWith("/") ? path : `/${path}`;
      return `${base}${normalizedPath}`;
    }
  }

  replaceVariables(
    template: string,
    variables: { [key: string]: string | number | boolean }
  ): string {
    let result = template;

    // Helper to get variable value
    const getVar = (path: string): string => {
      if (path === ".Keywords" || path === "Keywords") return String(variables.query || "");
      if (path === ".Categories" || path === "Categories")
        return String(variables.categories || "");
      if (path === ".Query.IMDBID" || path === ".Query.IMDBId")
        return String(variables.imdbId || "");
      if (path === ".Query.TMDBID" || path === ".Query.TMDBId")
        return String(variables.tmdbId || "");
      if (path === ".Query.Season") return String(variables.season || "");
      if (path === ".Query.Episode") return String(variables.episode || "");
      if (path.startsWith(".Config.")) {
        const key = path.substring(8);
        return String(variables[key] || "");
      }
      if (path.startsWith(".Result.")) {
        const key = path.substring(8);
        return String(variables[key] || "");
      }
      if (path === ".False" || path === ".false") return "false";
      if (path === ".True" || path === ".true") return "true";
      return "";
    };

    // Process {{ join .Categories "," }} style joins
    result = result.replace(
      /\{\{\s*join\s+([^\s]+)\s+"([^"]+)"\s*\}\}/g,
      (_, varPath, _separator) => {
        return getVar(varPath);
      }
    );

    // Process {{ if ... }}...{{ else }}...{{ end }} blocks
    result = result.replace(
      /\{\{\s*if\s+((?:and|or|\(|\)|\s|\.[\w.]+|eq\s+[\w.]+\s+[\w.]+)+)\s*\}\}([\s\S]*?)(?:\{\{\s*else\s*\}\}([\s\S]*?))?\{\{\s*end\s*\}\}/g,
      (_, condition, truthyBlock, falsyBlock) => {
        const isTrue = this.evaluateCondition(condition, variables);
        return isTrue ? truthyBlock : falsyBlock || "";
      }
    );

    // Simple variable replacements
    result = result.replace(/\{\{\s*\.Keywords\s*\}\}/g, getVar(".Keywords"));
    result = result.replace(/\{\{\s*\.Categories\s*\}\}/g, getVar(".Categories"));
    result = result.replace(/\{\{\s*\.Query\.IMDBID\s*\}\}/gi, getVar(".Query.IMDBID"));
    result = result.replace(/\{\{\s*\.Query\.TMDBId\s*\}\}/gi, getVar(".Query.TMDBID"));
    result = result.replace(/\{\{\s*\.Query\.Season\s*\}\}/g, getVar(".Query.Season"));
    result = result.replace(/\{\{\s*\.Query\.Episode\s*\}\}/g, getVar(".Query.Episode"));

    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\{\\{\\s*\\.Config\\.${key}\\s*\\}\\}`, "g");
      result = result.replace(regex, String(value));
    }

    return result;
  }

  private evaluateCondition(
    condition: string,
    variables: { [key: string]: string | number | boolean }
  ): boolean {
    const getVar = (path: string): string => {
      if (path === ".Keywords" || path === "Keywords") return String(variables.query || "");
      if (path === ".Categories" || path === "Categories")
        return String(variables.categories || "");
      if (path.startsWith(".Config.")) {
        const key = path.substring(8);
        return String(variables[key] || "");
      }
      if (path.startsWith(".Result.")) {
        const key = path.substring(8);
        return String(variables[key] || "");
      }
      return "";
    };

    // Handle "and" expressions
    if (condition.includes(" and ")) {
      const parts = condition.split(" and ");
      return parts.every((p) => this.evaluateCondition(p.trim(), variables));
    }

    // Handle "or" expressions
    if (condition.includes(" or ")) {
      const parts = condition.split(" or ");
      return parts.some((p) => this.evaluateCondition(p.trim(), variables));
    }

    // Handle "eq" comparisons
    const eqMatch = condition.match(/eq\s+([\w.]+)\s+([\w.]+)/);
    if (eqMatch) {
      const val1 = getVar(eqMatch[1]);
      const val2 = getVar(eqMatch[2]);
      return val1 === val2;
    }

    // Handle parentheses
    condition = condition.replace(/[()]/g, "");

    // Simple truthy check
    const value = getVar(condition.trim());
    return value !== "" && value !== "false" && value !== "0";
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
          try {
            const match = value.match(new RegExp(String(args[0])));
            return match ? match[0] : value;
          } catch {
            console.warn(
              `[Cardigann Parser] Invalid regex pattern in regexp filter: ${args[0]}, returning original value`
            );
            return value;
          }
        }
        return value;

      case "re_replace":
        if (args.length >= 2) {
          try {
            return value.replace(new RegExp(String(args[0]), "g"), String(args[1]));
          } catch {
            console.warn(
              `[Cardigann Parser] Invalid regex pattern in re_replace filter: ${args[0]}, returning original value`
            );
            return value;
          }
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
      // Silently fall through to return original value
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
