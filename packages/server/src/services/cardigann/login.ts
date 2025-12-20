import * as cheerio from "cheerio";
import { CookieJar } from "tough-cookie";
import { cardigannParser } from "./parser";
import { selectorEngine } from "./selectors";
import type {
  CardigannContext,
  CardigannLogin,
  CardigannLoginResult,
  CardigannSelector,
} from "./types";

export class CardigannLoginHandler {
  async login(context: CardigannContext): Promise<CardigannLoginResult> {
    const { definition, settings, baseUrl } = context;

    if (!definition.login) {
      return { success: true, cookies: {} };
    }

    const loginConfig = definition.login;

    try {
      const cookieJar = new CookieJar();
      const cookies = await this.performLogin(loginConfig, settings, baseUrl, cookieJar);

      if (loginConfig.test) {
        const testSuccess = await this.testLogin(loginConfig.test, baseUrl, cookies);
        if (!testSuccess) {
          return { success: false, cookies: {}, error: "Login test failed" };
        }
      }

      return { success: true, cookies };
    } catch (error) {
      return {
        success: false,
        cookies: {},
        error: error instanceof Error ? error.message : "Unknown login error",
      };
    }
  }

  private async performLogin(
    loginConfig: CardigannLogin,
    settings: { [key: string]: string | boolean },
    baseUrl: string,
    cookieJar: CookieJar
  ): Promise<{ [key: string]: string }> {
    const method = loginConfig.method || "post";

    switch (method) {
      case "post":
      case "form":
        return this.performFormLogin(loginConfig, settings, baseUrl, cookieJar);

      case "cookie":
        return this.performCookieLogin(loginConfig, settings);

      case "get":
        return this.performGetLogin(loginConfig, settings, baseUrl, cookieJar);

      case "oneurl":
        return this.performOneUrlLogin(loginConfig, settings, baseUrl, cookieJar);

      default:
        throw new Error(`Unsupported login method: ${method}`);
    }
  }

  private async performFormLogin(
    loginConfig: CardigannLogin,
    settings: { [key: string]: string | boolean },
    baseUrl: string,
    cookieJar: CookieJar
  ): Promise<{ [key: string]: string }> {
    const path = loginConfig.path || "/login";
    const url = cardigannParser.normalizeUrl(baseUrl, path);

    const formData: { [key: string]: string } = {};

    if (loginConfig.inputs) {
      for (const [key, value] of Object.entries(loginConfig.inputs)) {
        formData[key] = cardigannParser.replaceVariables(value, settings);
      }
    }

    if (loginConfig.selectorinputs) {
      const formHtml = await this.fetchPage(url, cookieJar);
      const _$ = cheerio.load(formHtml);

      for (const [key, selector] of Object.entries(loginConfig.selectorinputs)) {
        const value = selectorEngine.extractFieldFromHtml(formHtml, selector);
        formData[key] = value;
      }
    }

    const submitPath = loginConfig.submitpath || path;
    const submitUrl = cardigannParser.normalizeUrl(baseUrl, submitPath);

    const headers: { [key: string]: string } = {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(loginConfig.headers || {}),
    };

    await this.postForm(submitUrl, formData, headers, cookieJar);

    const cookies = await this.extractCookies(cookieJar, baseUrl);

    if (loginConfig.error) {
      const errorHtml = await this.fetchPage(submitUrl, cookieJar);
      const hasError = this.checkForError(errorHtml, loginConfig.error);
      if (hasError) {
        throw new Error("Login failed: error selector matched");
      }
    }

    return cookies;
  }

  private async performCookieLogin(
    loginConfig: CardigannLogin,
    settings: { [key: string]: string | boolean }
  ): Promise<{ [key: string]: string }> {
    const cookies: { [key: string]: string } = {};

    if (loginConfig.cookies) {
      for (const cookieName of loginConfig.cookies) {
        const cookieValue = settings[cookieName];
        if (typeof cookieValue === "string") {
          cookies[cookieName] = cookieValue;
        }
      }
    }

    return cookies;
  }

  private async performGetLogin(
    loginConfig: CardigannLogin,
    settings: { [key: string]: string | boolean },
    baseUrl: string,
    cookieJar: CookieJar
  ): Promise<{ [key: string]: string }> {
    const path = loginConfig.path || "/login";
    let url = cardigannParser.normalizeUrl(baseUrl, path);

    if (loginConfig.inputs) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(loginConfig.inputs)) {
        params.append(key, cardigannParser.replaceVariables(value, settings));
      }
      url += `?${params.toString()}`;
    }

    const headers = loginConfig.headers || {};
    await this.fetchPage(url, cookieJar, headers);

    return this.extractCookies(cookieJar, baseUrl);
  }

  private async performOneUrlLogin(
    loginConfig: CardigannLogin,
    _settings: { [key: string]: string | boolean },
    baseUrl: string,
    cookieJar: CookieJar
  ): Promise<{ [key: string]: string }> {
    const path = loginConfig.path || "/";
    const url = cardigannParser.normalizeUrl(baseUrl, path);

    await this.fetchPage(url, cookieJar);

    return this.extractCookies(cookieJar, baseUrl);
  }

  private async testLogin(
    testConfig: { path?: string; selector?: string },
    baseUrl: string,
    cookies: { [key: string]: string }
  ): Promise<boolean> {
    const path = testConfig.path || "/";
    const url = cardigannParser.normalizeUrl(baseUrl, path);

    const cookieJar = new CookieJar();
    for (const [name, value] of Object.entries(cookies)) {
      await cookieJar.setCookie(`${name}=${value}`, url);
    }

    const html = await this.fetchPage(url, cookieJar);

    if (testConfig.selector) {
      const $ = cheerio.load(html);
      return $(testConfig.selector).length > 0;
    }

    return true;
  }

  private checkForError(html: string, errorSelectors: CardigannSelector[]): boolean {
    const $ = cheerio.load(html);

    for (const errorSelector of errorSelectors) {
      if (errorSelector.selector) {
        const elements = $(errorSelector.selector);
        if (elements.length > 0) {
          return true;
        }
      }
    }

    return false;
  }

  private async fetchPage(
    url: string,
    cookieJar: CookieJar,
    headers: { [key: string]: string } = {}
  ): Promise<string> {
    const cookieString = await cookieJar.getCookieString(url);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Cookie: cookieString,
        ...headers,
      },
    });

    const setCookieHeader = response.headers.get("set-cookie");
    if (setCookieHeader) {
      await cookieJar.setCookie(setCookieHeader, url);
    }

    return response.text();
  }

  private async postForm(
    url: string,
    formData: { [key: string]: string },
    headers: { [key: string]: string },
    cookieJar: CookieJar
  ): Promise<string> {
    const cookieString = await cookieJar.getCookieString(url);

    const body = new URLSearchParams(formData).toString();

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Cookie: cookieString,
        ...headers,
      },
      body,
    });

    const setCookieHeader = response.headers.get("set-cookie");
    if (setCookieHeader) {
      await cookieJar.setCookie(setCookieHeader, url);
    }

    return response.text();
  }

  private async extractCookies(
    cookieJar: CookieJar,
    url: string
  ): Promise<{ [key: string]: string }> {
    const cookies: { [key: string]: string } = {};
    const cookieString = await cookieJar.getCookieString(url);

    if (cookieString) {
      const cookiePairs = cookieString.split("; ");
      for (const pair of cookiePairs) {
        const [name, value] = pair.split("=");
        if (name && value) {
          cookies[name] = value;
        }
      }
    }

    return cookies;
  }
}

export const loginHandler = new CardigannLoginHandler();
