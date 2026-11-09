import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../lib/', import.meta.url);
const locales = readFileSync(new URL('client/codex-custom-locales.js', root), 'utf8').replace(/^export /gm, '');
const component = readFileSync(new URL('client/CodexCustomService.js', root), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '')
    .replace(/\b(useState|useRef|useEffect)\(/g, 'react.$1(')
    .replace(/\b_jsx\(/g, 'react_jsx_runtime.jsx(').replace(/\b_jsxs\(/g, 'react_jsx_runtime.jsxs(');
const marker = '//#region android/codex-custom-service';
const region = `${marker}\n${locales}\n${component}\n//#endregion android/codex-custom-service\n\n`;
const path = new URL('client.js', root);
const previous = readFileSync(path, 'utf8');
let next;
if (previous.includes(marker)) {
    const start = previous.indexOf(marker);
    const endMarker = '//#endregion android/codex-custom-service\n\n';
    const end = previous.indexOf(endMarker, start);
    if (end < 0) throw new Error('Missing custom client region end');
    next = previous.slice(0, start) + region + previous.slice(end + endMarker.length);
} else {
    const anchor = '//#region src/client/locales.ts';
    if (previous.split(anchor).length !== 2) throw new Error('Missing unique client locale anchor');
    next = previous.replace(anchor, region + anchor);
}
if (process.argv.includes('--check')) {
    if (next !== previous) throw new Error('Custom service client bundle is stale; run this script without --check');
    console.log('Codex custom client source/bundle match');
} else {
    writeFileSync(path, next);
    console.log(`Updated ${fileURLToPath(path)}`);
}
