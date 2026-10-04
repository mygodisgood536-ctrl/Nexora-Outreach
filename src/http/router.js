/**
 * Tiny path-pattern router for `node:http`.
 *
 * Patterns use `:name` segments, e.g. `/api/missions/:id/pause`.
 * Matching is exact on segment count, so `/api/missions` never matches
 * `/api/missions/:id` by accident.
 */
export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler, options = {}) {
    const segments = pattern.split('/').filter(Boolean);
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      segments,
      handler,
      // `auth` defaults to true; only explicitly public routes opt out.
      auth: options.auth !== false,
      csrf: options.csrf !== false && method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD',
    });
    return this;
  }

  get(pattern, handler, options) { return this.add('GET', pattern, handler, options); }
  post(pattern, handler, options) { return this.add('POST', pattern, handler, options); }
  put(pattern, handler, options) { return this.add('PUT', pattern, handler, options); }
  patch(pattern, handler, options) { return this.add('PATCH', pattern, handler, options); }
  delete(pattern, handler, options) { return this.add('DELETE', pattern, handler, options); }

  /** Returns { route, params } or { allowed } when only the method mismatched. */
  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        else if (seg !== parts[i]) { ok = false; break; }
      }
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method.toUpperCase()) return { route, params };
    }
    return pathMatched ? { allowed: true } : null;
  }

  /** Every path that exists, for correct 405 vs 404 responses. */
  hasPath(pathname) {
    const parts = pathname.split('/').filter(Boolean);
    return this.routes.some((r) => r.segments.length === parts.length);
  }
}

export default Router;