import {
  MongoNetworkError, MongoParseError, MongoServerError, MongoServerSelectionError
} from 'mongodb';
import { DatabaseCollectionInitializationError, DatabaseIndexInitializationError } from './databaseIndexes';
import { DatabaseTopologyUnavailableError } from './databaseTopology';

const requiredVariables = ['DB_CONN_STRING', 'DB_NAME'] as const;
type RequiredVariable = typeof requiredVariables[number];
export type StartupStage = 'configuration' | 'database_connection' | 'database_topology'
  | 'database_initialization' | 'application' | 'listener_configuration' | 'listener';
const failureStages = new WeakMap<object, StartupStage>();

/** Carries variable names only; configuration values are never attached to this error. */
export class MissingStartupConfigurationError extends Error {
  readonly code = 'startup_configuration_missing';
  readonly missingVariables: readonly RequiredVariable[];
  constructor(missingVariables: readonly RequiredVariable[]) {
    super('Required startup configuration is missing.');
    this.missingVariables = requiredVariables.filter(name => missingVariables.includes(name));
  }
}

/** Preserves error identity for callers while keeping stage metadata out of raw errors. */
export const recordStartupFailureStage = (error: unknown, stage: StartupStage) => {
  const failure = error !== null && (typeof error === 'object' || typeof error === 'function')
    ? error : new Error('Startup failed.');
  if (!failureStages.has(failure)) failureStages.set(failure, stage);
  return failure;
};

const diagnosticActions = {
  configuration_missing: 'Set the listed variables in the process environment or the project .env, then restart.',
  database_configuration_invalid: 'Check DB_CONN_STRING syntax and database connection options without sharing their values.',
  database_authentication_failed: 'Check database credentials, authentication settings, and the deployment account permissions.',
  database_connection_unavailable: 'Check database availability, network access, DNS, TLS, and the configured connection timeouts.',
  database_topology_unavailable: 'Use a writable replica set or mongos with logical sessions and MongoDB 4.2 or newer.',
  database_collection_unavailable: 'Check catalogDeletionOperations provisioning and the startup create-collection permission.',
  database_index_unavailable: 'Check required unique indexes, duplicate data, migration permissions, and schemaMigrations access.',
  database_initialization_failed: 'Check database initialization requirements and permissions in docs/architecture.md.',
  application_initialization_failed: 'Check application configuration and generated runtime assets.',
  listener_configuration_invalid: 'Set PORT to an integer from 0 through 65535.',
  listener_address_in_use: 'Stop the application already using the configured port or choose another PORT.',
  listener_permission_denied: 'Choose an allowed PORT or correct the operating system listen permission.',
  listener_failed: 'Check the configured PORT and local network binding availability.',
  module_load_failed: 'Check the supported Node runtime, installed dependencies, and application build.'
} as const;
type FailureReason = keyof typeof diagnosticActions;

/** Reads only a data property used for exact matching, never a getter or arbitrary text. */
const ownCode = (error: object) => Object.getOwnPropertyDescriptor(error, 'code')?.value;

/** Emits only fixed categories/actions and allowlisted names, never exception payloads. */
export const createStartupFailureDiagnostic = (error: unknown) => {
  let stage: StartupStage | 'module_load' = 'module_load';
  let reason: FailureReason = 'module_load_failed';
  let missingVariables: RequiredVariable[] | undefined;
  try {
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
      stage = failureStages.get(error) ?? stage;
      if (error instanceof MissingStartupConfigurationError) {
        reason = 'configuration_missing';
        stage = 'configuration';
        missingVariables = requiredVariables.filter(name => error.missingVariables.includes(name));
      } else if (error instanceof DatabaseTopologyUnavailableError) {
        reason = 'database_topology_unavailable';
      } else if (error instanceof DatabaseCollectionInitializationError) {
        reason = 'database_collection_unavailable';
      } else if (error instanceof DatabaseIndexInitializationError) {
        reason = 'database_index_unavailable';
      } else if (error instanceof MongoParseError) {
        reason = 'database_configuration_invalid';
      } else if (error instanceof MongoServerError && [13, 18].includes(ownCode(error))) {
        reason = 'database_authentication_failed';
      } else if (error instanceof MongoNetworkError || error instanceof MongoServerSelectionError) {
        reason = 'database_connection_unavailable';
      } else if (stage === 'listener' && ownCode(error) === 'EADDRINUSE') {
        reason = 'listener_address_in_use';
      } else if (stage === 'listener' && ownCode(error) === 'EACCES') {
        reason = 'listener_permission_denied';
      } else {
        reason = stage === 'configuration' ? 'database_configuration_invalid'
          : stage === 'database_connection' ? 'database_connection_unavailable'
          : stage === 'database_topology' ? 'database_topology_unavailable'
          : stage === 'database_initialization' ? 'database_initialization_failed'
          : stage === 'application' ? 'application_initialization_failed'
          : stage === 'listener_configuration' ? 'listener_configuration_invalid'
          : stage === 'listener' ? 'listener_failed' : 'module_load_failed';
      }
    }
  } catch {
    // Malformed or proxy exceptions cannot make the diagnostic path disclose their values.
    reason = 'module_load_failed';
    stage = 'module_load';
    missingVariables = undefined;
  }
  return {
    category: 'server_start_failed' as const,
    stage,
    reason,
    action: diagnosticActions[reason],
    ...(missingVariables ? { missingVariables } : {})
  };
};
