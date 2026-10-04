/**
 * One structured line on stdout, which Elastic Beanstalk keeps in `web.stdout.log` and can stream to
 * CloudWatch Logs for JSON metric filters. Callers pass only fixed categories, bounded enums, counts and
 * opaque identifiers; account, session, address, credential and error text never belong in an entry.
 */
export type OperationalLogEntry = { category: string } & Record<string, unknown>;
export type OperationalLog = (entry: OperationalLogEntry) => void;

export const writeOperationalLog: OperationalLog = entry => { console.log(JSON.stringify(entry)); };
