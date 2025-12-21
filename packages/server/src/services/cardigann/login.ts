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
      // If we have cached cookies, test them first
      if (Object.keys(context.cookies).length > 0) {
        console.log("[Cardigann Login] Testing cached cookies...");
        if (loginConfig.test) {
          const testSuccess = await this.testLogin(loginConfig.test, baseUrl, context.cookies);
          if (testSuccess) {
            console.log("[Cardigann Login] Cached cookies are valid, skipping login");
            return { success: true, cookies: context.cookies };
          }
          console.log("[Cardigann Login] Cached cookies expired, re-authenticating...");
        } else {
          // No test defined, assume cached cookies are valid
          console.log("[Cardigann Login] No test defined, using cached cookies");
          return { success: true, cookies: context.cookies };
        }
      }

      // Perform fresh login
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

    console.log("[Cardigann Login] Base URL:", baseUrl);
    console.log("[Cardigann Login] Login URL:", url);
    console.log(
      "[Cardigann Login] Settings:",
      Object.keys(settings).reduce(
        (acc, key) => {
          acc[key] =
            typeof settings[key] === "string"
              ? `${settings[key].substring(0, 3)}***`
              : settings[key];
          return acc;
        },
        {} as Record<string, string | boolean>
      )
    );

    const formData: { [key: string]: string } = {};

    // If method is 'form', scrape the form first to get hidden fields and action URL
    let formAction: string | undefined;
    if (loginConfig.method === "form" && loginConfig.form) {
      console.log("[Cardigann Login] Scraping form:", loginConfig.form);
      // Use a separate cookie jar for form scraping to avoid cookie conflicts
      const scrapeCookieJar = new CookieJar();
      const formHtml = await this.fetchPage(url, scrapeCookieJar);
      const $ = cheerio.load(formHtml);
      const form = $(loginConfig.form);

      if (form.length === 0) {
        console.log("[Cardigann Login] WARNING: Form not found with selector:", loginConfig.form);
      } else {
        // Get form action if present
        const action = form.attr("action");
        if (action) {
          formAction = action;
          console.log("[Cardigann Login] Form action:", action);
        }

        // Dump the form HTML for debugging
        const formOuterHtml = $.html(form);
        console.log("[Cardigann Login] Form HTML:", formOuterHtml.substring(0, 1000));

        // Extract all input fields from the form
        form.find("input").each((_, input) => {
          const $input = $(input);
          const name = $input.attr("name");
          const value = $input.attr("value") || "";
          const type = $input.attr("type") || "text";

          if (name && type !== "submit" && type !== "button") {
            formData[name] = value;
            console.log(
              `[Cardigann Login] Found form field: ${name} (${type}) = ${value ? `${value.substring(0, 10)}***` : "(empty)"}`
            );
          }
        });
      }
      // Don't copy cookies from scraping - we only needed the form structure
    }

    if (loginConfig.inputs) {
      for (const [key, value] of Object.entries(loginConfig.inputs)) {
        const replacedValue = cardigannParser.replaceVariables(value, settings);
        formData[key] = replacedValue;
        console.log(
          `[Cardigann Login] Setting input ${key} = ${replacedValue ? `${replacedValue.substring(0, 10)}***` : "(empty)"}`
        );
      }
    }

    console.log(
      "[Cardigann Login] Final form data:",
      Object.keys(formData).reduce(
        (acc, key) => {
          acc[key] = formData[key] ? `${formData[key].substring(0, 3)}***` : "(empty)";
          return acc;
        },
        {} as Record<string, string | boolean>
      )
    );

    if (loginConfig.selectorinputs) {
      const formHtml = await this.fetchPage(url, cookieJar);
      const _$ = cheerio.load(formHtml);

      for (const [key, selector] of Object.entries(loginConfig.selectorinputs)) {
        const value = selectorEngine.extractFieldFromHtml(formHtml, selector);
        formData[key] = value;
      }
    }

    const submitPath = loginConfig.submitpath || formAction || path;
    const submitUrl = cardigannParser.normalizeUrl(baseUrl, submitPath);
    console.log("[Cardigann Login] Submit URL:", submitUrl);

    const headers: { [key: string]: string } = {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(loginConfig.headers || {}),
    };

    const responseHtml = await this.postForm(submitUrl, formData, headers, cookieJar);

    const cookies = await this.extractCookies(cookieJar, baseUrl);

    if (loginConfig.error) {
      console.log("[Cardigann Login] Checking POST response for errors");
      const errorInfo = this.checkForErrorWithDetails(responseHtml, loginConfig.error);
      if (errorInfo.hasError) {
        console.log("[Cardigann Login] Error detected in POST response!");
        console.log("[Cardigann Login] Matched selector:", errorInfo.matchedSelector);
        console.log(
          "[Cardigann Login] Page title:",
          responseHtml.match(/<title>(.*?)<\/title>/)?.[1] || "Unknown"
        );
        console.log("[Cardigann Login] Page length:", responseHtml.length);

        // Dump a snippet of the response to see what's there
        const $ = cheerio.load(responseHtml);
        const h2Text = $(".login-container h2").text();
        const errorText = $("p.text-danger").text();
        console.log("[Cardigann Login] H2 text:", h2Text);
        console.log("[Cardigann Login] Error text:", errorText);
        console.log("[Cardigann Login] Response snippet:", responseHtml.substring(0, 500));

        throw new Error(`Login failed: error selector matched (${errorInfo.matchedSelector})`);
      }
      console.log("[Cardigann Login] No errors detected, login successful");
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

  private checkForErrorWithDetails(
    html: string,
    errorSelectors: CardigannSelector[]
  ): { hasError: boolean; matchedSelector?: string } {
    const $ = cheerio.load(html);

    for (const errorSelector of errorSelectors) {
      if (errorSelector.selector) {
        const elements = $(errorSelector.selector);
        if (elements.length > 0) {
          return { hasError: true, matchedSelector: errorSelector.selector };
        }
      }
    }

    return { hasError: false };
  }

  private async fetchPage(
    url: string,
    cookieJar: CookieJar,
    headers: { [key: string]: string } = {}
  ): Promise<string> {
    const cookieString = await cookieJar.getCookieString(url);
    console.log("[Cardigann Login] fetchPage URL:", url);
    console.log("[Cardigann Login] fetchPage Cookie header:", cookieString || "(none)");

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Cookie: cookieString,
        ...headers,
      },
    });

    console.log("[Cardigann Login] fetchPage response status:", response.status);

    // Extract ALL Set-Cookie headers
    const setCookieHeaders = response.headers.getSetCookie?.() || [];
    for (const cookie of setCookieHeaders) {
      await cookieJar.setCookie(cookie, url);
      console.log("[Cardigann Login] fetchPage Set-Cookie:", `${cookie.substring(0, 50)}...`);
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
    console.log(
      "[Cardigann Login] POST body (URL-encoded):",
      body
        .split("&")
        .map((pair) => {
          const [key, val] = pair.split("=");
          return `${key}=${val ? `${val.substring(0, 3)}***` : "(empty)"}`;
        })
        .join("&")
    );

    // Disable automatic redirects so we can handle cookies properly
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Cookie: cookieString,
        ...headers,
      },
      body,
      redirect: "manual",
    });

    console.log("[Cardigann Login] POST response status:", response.status, response.statusText);

    // Extract ALL Set-Cookie headers from response
    // Note: response.headers.get("set-cookie") only returns the first one
    // We need to use getSetCookie() to get all of them
    const setCookieHeaders = response.headers.getSetCookie?.() || [];
    console.log("[Cardigann Login] Set-Cookie count:", setCookieHeaders.length);
    for (const cookie of setCookieHeaders) {
      console.log("[Cardigann Login] Setting cookie:", `${cookie.substring(0, 80)}...`);
      await cookieJar.setCookie(cookie, url);
    }

    // Handle redirects manually
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      console.log("[Cardigann Login] Redirect location header:", location);
      if (location) {
        const redirectUrl = cardigannParser.normalizeUrl(url, location);
        console.log("[Cardigann Login] Following redirect to:", redirectUrl);

        // Dump all cookies in jar for debugging
        const allCookies = await this.extractCookies(cookieJar, url);
        console.log(
          "[Cardigann Login] Cookies before redirect:",
          Object.keys(allCookies)
            .map((k) => `${k}=${allCookies[k].substring(0, 10)}***`)
            .join(", ")
        );

        return this.fetchPage(redirectUrl, cookieJar);
      }
    }

    console.log("[Cardigann Login] POST response URL:", response.url);
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
