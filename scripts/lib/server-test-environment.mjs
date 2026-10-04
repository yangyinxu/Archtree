import { devNull } from 'node:os';

/**
 * Synthetic loopback configuration that replaces inherited values in every server test process.
 * Tests run from the repository root next to a developer's private `.env`; dotenv never overrides a
 * variable that is already set, and any unmocked database or AWS call fails on 127.0.0.1:9 instead of
 * reaching a real service.
 */
export const syntheticServerTestEnvironment = Object.freeze({
  DB_CONN_STRING: 'mongodb://127.0.0.1:9/?directConnection=true&serverSelectionTimeoutMS=2000',
  DB_NAME: 'archtree_lorem_ipsum_test',
  JWT_SECRET: 'synthetic-server-test-jwt-secret-lorem-ipsum',
  AWS_ACCESS_KEY_ID: 'synthetic-server-test-access-key',
  AWS_SECRET_ACCESS_KEY: 'synthetic-server-test-secret-key',
  AWS_REGION: 'us-east-1',
  S3_BUCKET_NAME: 'archtree-lorem-ipsum-test',
  AWS_ENDPOINT_URL: 'http://127.0.0.1:9',
  AWS_EC2_METADATA_DISABLED: 'true'
});

/**
 * Builds the environment for unit, Linux and integration test processes. `DOTENV_CONFIG_PATH` points
 * `dotenv/config` at the empty null device, so entry points that tests spawn (`src/app.ts`, operational
 * scripts) cannot read the repository `.env` either. An inherited session token is removed so it never
 * accompanies the synthetic keys.
 */
export const serverTestEnvironment = (inherited = process.env) => {
  const environment = { ...inherited, ...syntheticServerTestEnvironment, DOTENV_CONFIG_PATH: devNull };
  delete environment.AWS_SESSION_TOKEN;
  return environment;
};
