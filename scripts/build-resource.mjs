import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildResource } = require('../dist/src/resources/builder.js');
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const input = path.resolve(option('--input', 'resources'));
const config = JSON.parse(await readFile(path.join(input, 'resource-build.json'), 'utf8'));
const output = path.resolve(option('--output', 'dist/resource'));
const resourceVersion = option('--version', config.resourceVersion);
const result = await buildResource({ ...config, input, output, resourceVersion,
  packageUrl: option('--package-url', `https://github.com/WangXiangpu0916/Arknights-Training-Room/releases/download/resource-${resourceVersion}/resource.atr.gz`),
  previous: option('--previous', undefined),
});
console.log(JSON.stringify({ resourceVersion: result.resourceVersion, files: Object.keys(result.files).length, bytes: result.package.size, sha256: result.package.sha256, fallbackSkills: result.fallbacks.skills.length }));
