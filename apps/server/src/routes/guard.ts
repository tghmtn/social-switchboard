import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RequestWorkspace, SessionUser } from '../app';

/** preHandler for routes that need a signed-in user with a workspace. */
export async function requireWorkspace(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user || !req.workspace) return reply.code(401).send({ error: 'unauthenticated' });
}

/** The signed-in user and workspace; only call after requireWorkspace has run. */
export function who(req: FastifyRequest): { user: SessionUser; workspace: RequestWorkspace } {
  if (!req.user || !req.workspace)
    throw Object.assign(new Error('unauthenticated'), { statusCode: 401 });
  return { user: req.user, workspace: req.workspace };
}

export const notFound = (what: string) =>
  Object.assign(new Error(`${what} not found`), { statusCode: 404 });
export const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });

/** For settings only owners and admins may change (channels, team, notifications). */
export function requireAdmin(req: FastifyRequest) {
  const { workspace } = who(req);
  if (workspace.role === 'agent')
    throw Object.assign(new Error('Only owners and admins can change this.'), { statusCode: 403 });
  return who(req);
}
