import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist/renderer', { recursive: true });
await cp('renderer', 'dist/renderer', { recursive: true });

