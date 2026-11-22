import {writeFile} from 'node:fs/promises';
// The directory adapter deploys dist as its runtime root. Keep an explicit
// ESM entry alongside the Vite assets, without copying development secrets.
await writeFile(new URL('../dist/package.json',import.meta.url),JSON.stringify({type:'module'}));
await writeFile(new URL('../dist/index.js',import.meta.url),"process.env.NODE_ENV ??= 'production';\nawait import('./server/index.js');\n");
