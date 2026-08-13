import { createReadStream, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const inputArgument = process.argv.find((argument) =>
  argument.startsWith('--input='),
);

export const scenarioDirectory = resolve(
  inputArgument?.slice('--input='.length) ||
    '../vitacura-dashboard-react/generated-mongo',
);

export const scenarioManifest = JSON.parse(
  readFileSync(resolve(scenarioDirectory, 'manifest.json'), 'utf8'),
);

export async function forEachJsonLine(name, callback) {
  const lines = createInterface({
    input: createReadStream(resolve(scenarioDirectory, `${name}.jsonl`), {
      encoding: 'utf8',
    }),
    crlfDelay: Infinity,
  });
  let index = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    await callback(JSON.parse(line), index);
    index += 1;
  }
  return index;
}

export async function readFirstJsonLine(name) {
  let first;
  await forEachJsonLine(name, (document) => {
    first ??= document;
  });
  if (!first) throw new Error(`${name}.jsonl está vacío`);
  return first;
}
