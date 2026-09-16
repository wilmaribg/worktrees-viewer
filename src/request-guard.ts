import net from 'node:net';
import type { MiddlewareHandler } from 'hono';

/**
 * Protege el hub (que ejecuta comandos y borra worktrees) de páginas web abiertas en el navegador:
 *
 * - DNS rebinding: un dominio ajeno que resuelve a 127.0.0.1 llega con su propio Host.
 *   Solo se aceptan `localhost`, IPs literales (no hay DNS que rebindear) y el `--host` configurado.
 * - CSRF: un POST cross-site "simple" (text/plain) no tiene preflight, pero el navegador
 *   siempre manda `Origin`. Si viene, tiene que ser el propio hub. Sin `Origin` (curl, agentes) se acepta.
 */
export function requestGuard(configuredHost?: string): MiddlewareHandler {
  return async (c, next) => {
    const requestHost = parseHost(c.req.header('host') ?? new URL(c.req.url).host);
    if (!requestHost || !isAllowedHostname(requestHost.hostname, configuredHost)) {
      return c.json({ error: 'host no permitido' }, 403);
    }

    const origin = c.req.header('origin');
    if (origin !== undefined && c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      if (parseOriginHost(origin) !== requestHost.host) {
        return c.json({ error: `origen no permitido: ${origin}` }, 403);
      }
    }

    await next();
  };
}

/** Normaliza un valor de Host (minúsculas, sin puerto por defecto); null si es inválido. */
function parseHost(raw: string): URL | null {
  try {
    return new URL(`http://${raw}`);
  } catch {
    return null;
  }
}

function parseOriginHost(origin: string): string | null {
  try {
    return new URL(origin).host; // "null" (iframe sandbox) no parsea → rechazado
  } catch {
    return null;
  }
}

function isAllowedHostname(hostname: string, configuredHost?: string): boolean {
  if (hostname === 'localhost') return true;
  if (net.isIP(hostname.replace(/^\[|\]$/g, '')) !== 0) return true;
  return configuredHost !== undefined && hostname === configuredHost.toLowerCase();
}
