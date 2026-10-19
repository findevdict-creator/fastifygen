import { writeFile } from 'node:fs/promises';
import { configSchema } from '../src/config/config.schema.js';

const target = new URL('../schema/config.schema.json', import.meta.url);
await writeFile(target, `${JSON.stringify(configSchema, null, 2)}\n`);
console.log(`Wrote ${target.pathname}`);
