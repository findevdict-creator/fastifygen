import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Knex } from 'knex';
import { InvalidPayloadError, UnauthorizedError } from './errors.js';
import { ItemsService, type ServiceContext } from './ItemsService.js';
import { QueryParser } from './query/QueryParser.js';
import type { SchemaOverview } from './SchemaOverview.js';
import type { Accountability, PrimaryKey, Query } from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Who is calling. Set by the auth hook before the controller runs. */
    accountability?: Accountability;
  }
}

export interface ControllerContext {
  knex: Knex;
  schema: SchemaOverview;
  /** Builds the service per request. Pass a subclass of {@link ItemsService} to customize one table. */
  createService?: (table: string, ctx: ServiceContext) => ItemsService;
}

type ItemsRequest = FastifyRequest<{
  Params: { id?: string };
  Querystring: Record<string, unknown>;
  Body: unknown;
}>;

/**
 * HTTP layer for one table: reads the request, calls the service, shapes the
 * response as `{ data, meta? }`. Handlers are arrow-function properties so
 * they can be passed straight to `fastify.route({ handler })`.
 */
export class ItemsController {
  protected readonly parser: QueryParser;

  constructor(
    readonly table: string,
    protected readonly ctx: ControllerContext,
  ) {
    this.parser = new QueryParser(ctx.schema.api);
  }

  /** `GET /` */
  readMany = async (request: ItemsRequest) => {
    return this.service(request).readByQuery(this.query(request));
  };

  /** `GET /:id` */
  readOne = async (request: ItemsRequest) => {
    return { data: await this.service(request).readOne(this.id(request), this.query(request)) };
  };

  /** `POST /` with one item or an array of items. */
  create = async (request: ItemsRequest, reply: FastifyReply) => {
    const service = this.service(request);
    const query = this.query(request);
    const data = Array.isArray(request.body)
      ? await service.createMany(request.body, query)
      : await service.createOne(request.body, query);
    return this.respond(reply, data);
  };

  /** `PATCH /:id` */
  updateOne = async (request: ItemsRequest, reply: FastifyReply) => {
    const data = await this.service(request).updateOne(this.id(request), request.body, this.query(request));
    return this.respond(reply, data);
  };

  /** `PATCH /` with `{ keys, data }`, or an array of items that each carry their primary key. */
  updateMany = async (request: ItemsRequest, reply: FastifyReply) => {
    const service = this.service(request);
    const query = this.query(request);
    const body = request.body;
    if (Array.isArray(body)) return this.respond(reply, await service.updateBatch(body, query));
    if (this.isObject(body) && Array.isArray(body.keys)) {
      return this.respond(reply, await service.updateMany(body.keys as PrimaryKey[], body.data, query));
    }
    throw new InvalidPayloadError('Body must be an array of items or { "keys": [...], "data": {...} }');
  };

  /** `DELETE /:id` */
  deleteOne = async (request: ItemsRequest, reply: FastifyReply) => {
    await this.service(request).deleteOne(this.id(request));
    return reply.status(204).send();
  };

  /** `DELETE /` with an array of keys or `{ keys }`. */
  deleteMany = async (request: ItemsRequest, reply: FastifyReply) => {
    const body = request.body;
    const keys = Array.isArray(body) ? body : this.isObject(body) ? body.keys : undefined;
    if (!Array.isArray(keys)) throw new InvalidPayloadError('Body must be an array of keys or { "keys": [...] }');
    await this.service(request).deleteMany(keys as PrimaryKey[]);
    return reply.status(204).send();
  };

  protected service(request: FastifyRequest): ItemsService {
    const accountability = request.accountability;
    if (!accountability) throw new UnauthorizedError();
    const serviceCtx: ServiceContext = { knex: this.ctx.knex, schema: this.ctx.schema, accountability };
    return this.ctx.createService ? this.ctx.createService(this.table, serviceCtx) : new ItemsService(this.table, serviceCtx);
  }

  protected query(request: ItemsRequest): Query {
    return this.parser.parse(request.query ?? {});
  }

  protected id(request: ItemsRequest): PrimaryKey {
    const id = request.params.id;
    if (id === undefined || id === '') throw new InvalidPayloadError('Missing item id');
    return id;
  }

  private respond(reply: FastifyReply, data: unknown) {
    if (data === null) return reply.status(204).send();
    return reply.send({ data });
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
}
