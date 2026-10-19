import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';

/**
 * Directus-style server endpoints that need no token, for load balancers and
 * uptime checks: `GET /server/ping` and `GET /server/health`.
 */
export class ServerRoutes {
  constructor(private readonly knex: Knex) {}

  register = async (fastify: FastifyInstance): Promise<void> => {
    fastify.route({
      method: 'GET',
      url: '/server/ping',
      schema: { response: { 200: { type: 'string' } } },
      handler: async (_request, reply) => reply.type('text/plain').send('pong'),
    });

    fastify.route({
      method: 'GET',
      url: '/server/health',
      handler: async (request, reply) => {
        try {
          await this.knex.raw('select 1');
          return reply.type('application/health+json').send({ status: 'ok' });
        } catch (error) {
          request.log.error(error, 'database health check failed');
          return reply.status(503).type('application/health+json').send({ status: 'error', checks: { database: 'down' } });
        }
      },
    });
  };
}
