/**
 * node:sqlite ships very narrow row types (`Record<string, SQLOutputValue>`).
 * We treat rows as opaque and cast them to domain rows in the repo layer, so
 * widen the statement return types to `unknown`.
 */
import 'node:sqlite';

declare module 'node:sqlite' {
  interface StatementSync {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  }
}