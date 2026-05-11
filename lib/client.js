import { loadConfig } from "./config.js";

const NO_RETRY = new Set([400, 401, 403, 404]);

/**
 * Create an HTTP client with Basic Auth.
 *
 * @param {object} log - logger instance
 * @param {object} credentials - { username, password } from ensureCredentials()
 * @param {object} [opts] - optional overrides
 * @param {string} [opts.baseUrl] - override the base URL from config
 * @param {number} [opts.maxRetries] - max retries on retryable HTTP errors (default 3)
 */
export async function createClient(log, credentials, opts = {}) {
  const baseUrl = (opts.baseUrl || loadConfig().api.base_url).replace(/\/+$/, "");
  const maxRetries = opts.maxRetries ?? 3;
  const auth = "Basic " + Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64");

  async function request(method, endpoint, body, extraHeaders, { retry = true } = {}) {
    const url = `${baseUrl}${endpoint}`;

    const fetchOpts = {
      method,
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...extraHeaders,
      },
    };

    if (body !== undefined) {
      fetchOpts.body = JSON.stringify(body);
    }

    log.debug(`${method} ${url}`, body);

    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, fetchOpts);
      } catch (err) {
        if (retry && attempt < maxRetries) {
          const delay = Math.min(1000 * 2 ** attempt, 30000);
          log.info(`Network error: ${err.message}, retrying in ${(delay / 1000).toFixed(1)}s (${attempt + 1}/${maxRetries})`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        log.debug(`Network error: ${err.message}`);
        return { ok: false, status: 0, data: { error: err.message } };
      }

      let data;
      const text = await res.text();
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }

      if (retry && !res.ok && !NO_RETRY.has(res.status) && attempt < maxRetries) {
        let delay;
        const retryAfter = res.headers.get("Retry-After");
        if (res.status === 429 && retryAfter) {
          // Retry-After can be seconds or an HTTP date
          const parsed = Number(retryAfter);
          delay = Number.isNaN(parsed)
            ? Math.max(0, new Date(retryAfter).getTime() - Date.now())
            : parsed * 1000;
        } else {
          delay = Math.min(1000 * 2 ** attempt, 30000);
        }
        log.info(`HTTP ${res.status}, retrying in ${(delay / 1000).toFixed(1)}s (${attempt + 1}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      log.debug(`Response ${res.status}`, data);
      return { ok: res.ok, status: res.status, data };
    }
  }

  return {
    get: (endpoint, params) => {
      let url = endpoint;
      if (params) {
        const qs = new URLSearchParams(params).toString();
        url = `${endpoint}?${qs}`;
      }
      return request("GET", url);
    },
    post: (endpoint, body, headers, opts) => request("POST", endpoint, body, headers, opts),
    patch: (endpoint, body, headers, opts) => request("PATCH", endpoint, body, headers, opts),
    delete: (endpoint) => request("DELETE", endpoint),
  };
}
