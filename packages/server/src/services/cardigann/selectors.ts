import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { cardigannParser } from "./parser";
import type { CardigannRowsSelector, CardigannSelector } from "./types";

export class CardigannSelectorEngine {
  extractRows(html: string, rowsSelector: CardigannRowsSelector): cheerio.Cheerio<AnyNode> {
    const $ = cheerio.load(html);

    if (!rowsSelector.selector) {
      return $("body");
    }

    let rows = $(rowsSelector.selector);

    if (rowsSelector.remove) {
      $(rowsSelector.remove).remove();
      rows = $(rowsSelector.selector);
    }

    if (rowsSelector.after !== undefined) {
      const rowsArray = rows.toArray();
      rows = $(rowsArray.slice(rowsSelector.after));
    }

    return rows;
  }

  extractField(
    element: cheerio.Cheerio<AnyNode>,
    selector: CardigannSelector,
    $?: cheerio.CheerioAPI
  ): string {
    if (!$) {
      $ = cheerio.load(element.html() || "");
    }

    if (selector.text !== undefined) {
      return this.applyFilters(selector.text, selector.filters);
    }

    if (selector.case) {
      for (const [condition, value] of Object.entries(selector.case)) {
        if (this.evaluateCondition(element, condition, $)) {
          return this.applyFilters(value, selector.filters);
        }
      }
      return "";
    }

    if (!selector.selector) {
      return "";
    }

    const target =
      selector.selector === "text()" ? element : element.find(selector.selector).first();

    if (target.length === 0) {
      return "";
    }

    let value: string;

    if (selector.attribute) {
      if (selector.attribute === "text") {
        value = target.text().trim();
      } else {
        value = target.attr(selector.attribute) || "";
      }
    } else {
      value = target.text().trim();
    }

    if (selector.remove) {
      const tempElement = cheerio.load(`<div>${value}</div>`)("div");
      tempElement.find(selector.remove).remove();
      value = tempElement.text().trim();
    }

    return this.applyFilters(value, selector.filters);
  }

  extractFieldFromHtml(html: string, selector: CardigannSelector): string {
    const $ = cheerio.load(html);
    const element = $("body");
    return this.extractField(element, selector, $);
  }

  extractMultipleFields(
    element: cheerio.Cheerio<AnyNode>,
    fieldSelectors: { [key: string]: CardigannSelector },
    $?: cheerio.CheerioAPI
  ): { [key: string]: string } {
    const result: { [key: string]: string } = {};

    for (const [key, selector] of Object.entries(fieldSelectors)) {
      result[key] = this.extractField(element, selector, $);
    }

    return result;
  }

  private evaluateCondition(
    element: cheerio.Cheerio<AnyNode>,
    condition: string,
    $: cheerio.CheerioAPI
  ): boolean {
    if (condition.startsWith("*=")) {
      const selector = condition.substring(2).trim();
      return element.find(selector).length > 0;
    }

    if (condition.startsWith("!*=")) {
      const selector = condition.substring(3).trim();
      return element.find(selector).length === 0;
    }

    if (condition.includes(":has(")) {
      return $(element).is(condition);
    }

    return false;
  }

  private applyFilters(
    value: string,
    filters?: Array<{ name: string; args?: (string | number)[] }>
  ): string {
    if (!filters || filters.length === 0) {
      return value;
    }

    return cardigannParser.replaceFilters(value, filters);
  }

  parseSize(sizeStr: string): number {
    const cleaned = sizeStr.trim().toLowerCase();
    const match = cleaned.match(/^([\d.,]+)\s*([kmgt]?i?b?)$/i);

    if (!match) {
      return 0;
    }

    const value = parseFloat(match[1].replace(",", ""));
    const unit = match[2].toLowerCase();

    const multipliers: { [key: string]: number } = {
      b: 1,
      kb: 1024,
      kib: 1024,
      mb: 1024 * 1024,
      mib: 1024 * 1024,
      gb: 1024 * 1024 * 1024,
      gib: 1024 * 1024 * 1024,
      tb: 1024 * 1024 * 1024 * 1024,
      tib: 1024 * 1024 * 1024 * 1024,
    };

    return value * (multipliers[unit] || 1);
  }

  parseNumber(numStr: string): number {
    const cleaned = numStr.replace(/[,\s]/g, "");
    const num = parseFloat(cleaned);
    return Number.isNaN(num) ? 0 : num;
  }

  parseDate(dateStr: string): Date | null {
    try {
      const date = new Date(dateStr);
      if (!Number.isNaN(date.getTime())) {
        return date;
      }
    } catch (_e) {
      // Silently fall through to return null
    }
    return null;
  }

  extractJsonValue(json: unknown, path: string): unknown {
    const parts = path.split(".");
    let current: unknown = json;

    for (const part of parts) {
      if (current && typeof current === "object" && part in current) {
        current = (current as Record<string, unknown>)[part];
      } else {
        return "";
      }
    }

    // Return the actual value - could be array, object, string, number, etc.
    return current ?? "";
  }

  extractXmlValue(xml: string, xpath: string): string {
    const $ = cheerio.load(xml, { xmlMode: true });
    const value = $(xpath).text();
    return value.trim();
  }
}

export const selectorEngine = new CardigannSelectorEngine();
