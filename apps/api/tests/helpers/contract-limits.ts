/**
 * Limits the API and its tests share, re-exported so a test does not reach across the workspace boundary.
 *
 * `apps/api` depends on `@mapirror/shared`, so importing from there is legal — this file exists for the two numbers a
 * test asserts *against the docs* rather than against the code: the login body bounds. Keeping them in one place means
 * a test that parses `04-api.md` compares the document with the same constant the route validates with.
 *
 * @module tests/helpers/contract-limits
 */

export {
  LOGIN_PASSWORD_MAX as APP_LOGIN_PASSWORD_MAX,
  LOGIN_USERNAME_MAX as APP_LOGIN_USERNAME_MAX,
} from '@mapirror/shared';
