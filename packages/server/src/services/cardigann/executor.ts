import * as cheerio from "cheerio";
import { loginHandler } from "./login";
import { cardigannParser } from "./parser";
import { selectorEngine } from "./selectors";
import type {
  CardigannContext,
  CardigannRowsSelector,
  CardigannSearchParams,
  CardigannSearchPath,
  CardigannSearchResult,
  CardigannSelector,
} from "./types";

export class CardigannExecutor {
  async search(
    context: CardigannContext,
    params: CardigannSearchParams
  ): Promise<CardigannSearchResult[]> {
    const { definition, settings, baseUrl } = context;

    if (!definition.search || !definition.search.paths) {
      throw new Error("No search configuration found in definition");
    }

    const loginResult = await loginHandler.login(context);
    if (!loginResult.success) {
      throw new Error(`Login failed: ${loginResult.error}`);
    }

    const allCookies = { ...context.cookies, ...loginResult.cookies };

    const results: CardigannSearchResult[] = [];

    console.log(`[Cardigann Executor] Executing ${definition.search.paths.length} search path(s)`);

    // Get search-level rows and fields as defaults
    const searchRows = definition.search.rows;
    const searchFields = definition.search.fields;

    for (const searchPath of definition.search.paths) {
      try {
        const pathResults = await this.executeSearchPath(
          searchPath,
          params,
          settings,
          baseUrl,
          allCookies,
          searchRows,
          searchFields
        );
        console.log(`[Cardigann Executor] Search path returned ${pathResults.length} results`);
        results.push(...pathResults);
      } catch (error) {
        console.error(`[Cardigann Executor] Search path failed:`, error);
        // Skip failed search paths and continue with others
      }
    }

    return this.deduplicateResults(results);
  }

  private async executeSearchPath(
    searchPath: CardigannSearchPath,
    params: CardigannSearchParams,
    settings: { [key: string]: string | boolean },
    baseUrl: string,
    cookies: { [key: string]: string },
    defaultRows?: CardigannRowsSelector,
    defaultFields?: { [key: string]: CardigannSelector }
  ): Promise<CardigannSearchResult[]> {
    const method = searchPath.method || "get";

    // Build variables for template replacement
    const variables = {
      ...settings,
      query: params.query || "",
      categories: params.categories?.join(",") || "",
      imdbId: params.imdbId || "",
      tmdbId: params.tmdbId || "",
      season: params.season || "",
      episode: params.episode || "",
    };

    // Process row selector templates if present
    const processedRows = this.processRowsSelector(defaultRows, variables);
    const processedPathRows = this.processRowsSelector(searchPath.rows, variables);
    const finalRows = processedPathRows || processedRows;

    // Process path template BEFORE creating URL
    const processedPath = cardigannParser.replaceVariables(searchPath.path, variables);
    let url = cardigannParser.normalizeUrl(baseUrl, processedPath);

    const inputs = { ...searchPath.inputs };
    for (const [key, value] of Object.entries(inputs)) {
      inputs[key] = cardigannParser.replaceVariables(value, variables);
    }

    const headers: { [key: string]: string } = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      ...(searchPath.headers || {}),
    };

    let responseText: string;

    if (method.toLowerCase() === "get") {
      const params = new URLSearchParams(inputs);
      url += `?${params.toString()}`;
      console.log(`[Cardigann Executor] GET ${url}`);
      responseText = await this.fetchUrl(url, headers, cookies);
    } else {
      console.log(`[Cardigann Executor] POST ${url} with data:`, inputs);
      responseText = await this.postUrl(url, inputs, headers, cookies);
    }

    console.log(`[Cardigann Executor] Response received (${responseText.length} bytes)`);
    const responseType = searchPath.response?.type || "html";

    if (responseType === "json") {
      return this.parseJsonResponse(responseText, baseUrl, finalRows, defaultFields);
    } else if (responseType === "xml") {
      return this.parseXmlResponse(responseText, baseUrl, finalRows, defaultFields);
    } else {
      return this.parseHtmlResponse(responseText, baseUrl, finalRows, defaultFields);
    }
  }

  private processRowsSelector(
    rows: CardigannRowsSelector | undefined,
    variables: { [key: string]: string | number | boolean }
  ): CardigannRowsSelector | undefined {
    if (!rows) return undefined;

    const processed: CardigannRowsSelector = { ...rows };

    if (rows.selector) {
      processed.selector = cardigannParser.replaceVariables(rows.selector, variables);
    }

    return processed;
  }

  private async fetchUrl(
    url: string,
    headers: { [key: string]: string },
    cookies: { [key: string]: string }
  ): Promise<string> {
    const cookieString = Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");

    const response = await fetch(url, {
      method: "GET",
      headers: {
        ...headers,
        Cookie: cookieString,
      },
    });

    return response.text();
  }

  private async postUrl(
    url: string,
    data: { [key: string]: string },
    headers: { [key: string]: string },
    cookies: { [key: string]: string }
  ): Promise<string> {
    const cookieString = Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");

    const body = new URLSearchParams(data).toString();

    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        Cookie: cookieString,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    return response.text();
  }

  private parseHtmlResponse(
    html: string,
    baseUrl: string,
    rows?: CardigannRowsSelector,
    fields?: { [key: string]: CardigannSelector }
  ): CardigannSearchResult[] {
    const $ = cheerio.load(html);
    const results: CardigannSearchResult[] = [];

    if (!rows || !rows.selector) {
      return results;
    }

    const extractedRows = selectorEngine.extractRows(html, rows);

    extractedRows.each((_, element) => {
      try {
        const $row = $(element);

        const extractedFields = selectorEngine.extractMultipleFields($row, fields || {}, $);

        const result = this.buildSearchResult(extractedFields, baseUrl);
        if (result.title && result.downloadUrl) {
          results.push(result);
        }
      } catch (_error) {
        // Skip failed rows and continue parsing
      }
    });

    return results;
  }

  private parseJsonResponse(
    jsonText: string,
    baseUrl: string,
    rows?: CardigannRowsSelector,
    fields?: { [key: string]: CardigannSelector }
  ): CardigannSearchResult[] {
    const results: CardigannSearchResult[] = [];

    try {
      const json = JSON.parse(jsonText);

      // Extract items array using rows.selector if specified
      let items: unknown[];
      if (rows?.selector) {
        console.log(`[Cardigann Executor] JSON: Using rows.selector: ${rows.selector}`);
        const extracted = selectorEngine.extractJsonValue(json, rows.selector);
        console.log(`[Cardigann Executor] JSON: Extracted value type: ${Array.isArray(extracted) ? 'array' : typeof extracted}, length: ${Array.isArray(extracted) ? extracted.length : 'N/A'}`);
        items = Array.isArray(extracted) ? extracted : [extracted];
      } else {
        console.log(`[Cardigann Executor] JSON: No rows.selector found, using fallback`);
        // Fallback: assume top-level array or single object
        items = Array.isArray(json) ? json : [json];
      }

      console.log(`[Cardigann Executor] JSON: Extracted ${items.length} items from response`);

      for (const item of items) {
        const extractedFields: { [key: string]: string } = {};

        // First pass: extract all fields from JSON
        for (const [key, selector] of Object.entries(fields || {})) {
          if (selector.text) {
            extractedFields[key] = selector.text;
          } else if (selector.selector) {
            const value = selectorEngine.extractJsonValue(item, selector.selector);
            extractedFields[key] = String(value ?? "");
          }

          if (selector.filters) {
            extractedFields[key] = cardigannParser.replaceFilters(
              extractedFields[key],
              selector.filters
            );
          }
        }

        // Second pass: process .Result.xxx references in text fields
        for (const [key, selector] of Object.entries(fields || {})) {
          if (selector.text && selector.text.includes(".Result.")) {
            // Build variables object with extracted fields accessible as .Result.xxx
            const resultVars: { [key: string]: string | number | boolean } = {};
            for (const [fieldKey, fieldValue] of Object.entries(extractedFields)) {
              resultVars[fieldKey] = fieldValue;
            }
            extractedFields[key] = cardigannParser.replaceVariables(selector.text, resultVars);
          }
        }

        const result = this.buildSearchResult(extractedFields, baseUrl);
        if (result.title && result.downloadUrl) {
          results.push(result);
        }
      }
    } catch (error) {
      console.error(`[Cardigann Executor] JSON parse error:`, error);
    }

    return results;
  }

  private parseXmlResponse(
    xmlText: string,
    baseUrl: string,
    rows?: CardigannRowsSelector,
    fields?: { [key: string]: CardigannSelector }
  ): CardigannSearchResult[] {
    const results: CardigannSearchResult[] = [];

    try {
      const $ = cheerio.load(xmlText, { xmlMode: true });

      const extractedRows = rows?.selector ? $(rows.selector) : $("item");

      extractedRows.each((_, element) => {
        const $row = $(element);
        const extractedFields = selectorEngine.extractMultipleFields($row, fields || {}, $);

        const result = this.buildSearchResult(extractedFields, baseUrl);
        if (result.title && result.downloadUrl) {
          results.push(result);
        }
      });
    } catch (_error) {
      // Return empty results on XML parse failure
    }

    return results;
  }

  private buildSearchResult(
    fields: { [key: string]: string },
    baseUrl: string
  ): CardigannSearchResult {
    const result: CardigannSearchResult = {
      title: fields.title || "",
      downloadUrl: this.normalizeDownloadUrl(fields.download || "", baseUrl),
      infoUrl: fields.details ? cardigannParser.normalizeUrl(baseUrl, fields.details) : undefined,
      size: fields.size ? selectorEngine.parseSize(fields.size) : undefined,
      seeders: fields.seeders ? selectorEngine.parseNumber(fields.seeders) : undefined,
      leechers: fields.leechers ? selectorEngine.parseNumber(fields.leechers) : undefined,
      grabs: fields.grabs ? selectorEngine.parseNumber(fields.grabs) : undefined,
      publishDate: fields.date ? selectorEngine.parseDate(fields.date) || undefined : undefined,
      category: fields.category ? [fields.category] : undefined,
      imdbId: fields.imdbid || undefined,
      downloadVolumeFactor: fields.downloadvolumefactor
        ? parseFloat(fields.downloadvolumefactor)
        : undefined,
      uploadVolumeFactor: fields.uploadvolumefactor
        ? parseFloat(fields.uploadvolumefactor)
        : undefined,
      minimumRatio: fields.minimumratio ? parseFloat(fields.minimumratio) : undefined,
      minimumSeedTime: fields.minimumseedtime ? parseInt(fields.minimumseedtime, 10) : undefined,
      infohash: fields.infohash || undefined,
    };

    return result;
  }

  private normalizeDownloadUrl(url: string, baseUrl: string): string {
    if (url.startsWith("magnet:")) {
      return url;
    }

    return cardigannParser.normalizeUrl(baseUrl, url);
  }

  private deduplicateResults(results: CardigannSearchResult[]): CardigannSearchResult[] {
    const seen = new Set<string>();
    const deduplicated: CardigannSearchResult[] = [];

    for (const result of results) {
      const key = result.infohash || result.downloadUrl;

      if (!seen.has(key)) {
        seen.add(key);
        deduplicated.push(result);
      }
    }

    return deduplicated;
  }
}

export const cardigannExecutor = new CardigannExecutor();
