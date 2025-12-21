import * as cheerio from "cheerio";
import { loginHandler } from "./login";
import { cardigannParser } from "./parser";
import { selectorEngine } from "./selectors";
import type {
  CardigannContext,
  CardigannSearchParams,
  CardigannSearchPath,
  CardigannSearchResult,
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

    for (const searchPath of definition.search.paths) {
      try {
        const pathResults = await this.executeSearchPath(
          searchPath,
          params,
          settings,
          baseUrl,
          allCookies
        );
        results.push(...pathResults);
      } catch (_error) {
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
    cookies: { [key: string]: string }
  ): Promise<CardigannSearchResult[]> {
    const method = searchPath.method || "get";
    const path = searchPath.path;
    let url = cardigannParser.normalizeUrl(baseUrl, path);

    const inputs = { ...searchPath.inputs };
    const variables = {
      ...settings,
      query: params.query || "",
      categories: params.categories?.join(",") || "",
      imdbId: params.imdbId || "",
      tmdbId: params.tmdbId || "",
      season: params.season || "",
      episode: params.episode || "",
    };

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
      responseText = await this.fetchUrl(url, headers, cookies);
    } else {
      responseText = await this.postUrl(url, inputs, headers, cookies);
    }

    const responseType = searchPath.response?.type || "html";

    if (responseType === "json") {
      return this.parseJsonResponse(responseText, searchPath, baseUrl);
    } else if (responseType === "xml") {
      return this.parseXmlResponse(responseText, searchPath, baseUrl);
    } else {
      return this.parseHtmlResponse(responseText, searchPath, baseUrl);
    }
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
    searchPath: CardigannSearchPath,
    baseUrl: string
  ): CardigannSearchResult[] {
    const $ = cheerio.load(html);
    const results: CardigannSearchResult[] = [];

    if (!searchPath.rows || !searchPath.rows.selector) {
      return results;
    }

    const rows = selectorEngine.extractRows(html, searchPath.rows);

    rows.each((_, element) => {
      try {
        const $row = $(element);
        const fields = searchPath.fields || {};

        const extractedFields = selectorEngine.extractMultipleFields($row, fields, $);

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
    searchPath: CardigannSearchPath,
    baseUrl: string
  ): CardigannSearchResult[] {
    const results: CardigannSearchResult[] = [];

    try {
      const json = JSON.parse(jsonText);
      const items = Array.isArray(json) ? json : [json];

      for (const item of items) {
        const fields = searchPath.fields || {};
        const extractedFields: { [key: string]: string } = {};

        for (const [key, selector] of Object.entries(fields)) {
          if (selector.text) {
            extractedFields[key] = selector.text;
          } else if (selector.selector) {
            extractedFields[key] = selectorEngine.extractJsonValue(item, selector.selector);
          }

          if (selector.filters) {
            extractedFields[key] = cardigannParser.replaceFilters(
              extractedFields[key],
              selector.filters
            );
          }
        }

        const result = this.buildSearchResult(extractedFields, baseUrl);
        if (result.title && result.downloadUrl) {
          results.push(result);
        }
      }
    } catch (_error) {
      // Return empty results on JSON parse failure
    }

    return results;
  }

  private parseXmlResponse(
    xmlText: string,
    searchPath: CardigannSearchPath,
    baseUrl: string
  ): CardigannSearchResult[] {
    const results: CardigannSearchResult[] = [];

    try {
      const $ = cheerio.load(xmlText, { xmlMode: true });
      const rows = searchPath.rows?.selector ? $(searchPath.rows.selector) : $("item");

      rows.each((_, element) => {
        const $row = $(element);
        const fields = searchPath.fields || {};
        const extractedFields = selectorEngine.extractMultipleFields($row, fields, $);

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
