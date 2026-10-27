/**
 * The executor a repository accepts: the process database or a transaction opened by a service.
 *
 * Repositories never create transactions. Services compose repository calls with `withTransaction` when writes must
 * succeed or fail together (`09-development.md` §6).
 *
 * @module db/repositories/executor
 */

import type { Kysely, Transaction } from 'kysely';

import type { Database } from '../schema';

/** A Kysely database handle or an enclosing transaction. */
export type RepositoryExecutor = Kysely<Database> | Transaction<Database>;
