/**
 * node:test reporter that feeds the server test watchdog. The spec reporter prints each file's results in file order,
 * so a stuck file hides every later file's output; dequeue and complete events arrive as they happen instead. Each
 * becomes one JSON line naming the file as the runner was given it, and, for an event inside a file, the test.
 */
export default async function* serverTestProgress(source) {
  const names = new Map();
  for await (const { type, data } of source) {
    if (type !== 'test:dequeue' && type !== 'test:complete') continue;
    if (!data.entryFile) names.set(data.file, data.name);
    const event = data.entryFile ? { type, file: names.get(data.entryFile) ?? data.entryFile, test: data.name } : { type, file: data.name };
    yield `${JSON.stringify(event)}\n`;
  }
}
