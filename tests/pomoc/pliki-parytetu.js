import { readFileSync as odczytaj } from 'node:fs';
import { fileURLToPath } from 'node:url';
export * from 'node:fs';
const widoki = new URL('../../src/moduly/zamowienia/widoki/', import.meta.url);
/** Tylko przekładanie dawnej ścieżki źródła widoku na rzeczywisty przeniesiony plik. */
export function readFileSync(path, ...args) {
  const s = typeof path === 'string' ? path.replaceAll('\\','/') : '';
  const prefix='src/oms/web/views/';
  const i=s.indexOf(prefix);
  return odczytaj(i>=0 ? fileURLToPath(new URL(s.slice(i+prefix.length),widoki)) : path,...args);
}
