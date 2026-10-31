// Minimal structured logger for the worker and CLI (the API server uses Fastify's logger).
export function log(msg: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...fields }));
}

export function logError(msg: string, err: unknown, fields: Record<string, unknown> = {}) {
  const error = err instanceof Error ? { message: err.message, stack: err.stack } : err;
  console.error(
    JSON.stringify({ time: new Date().toISOString(), level: 'error', msg, error, ...fields }),
  );
}
