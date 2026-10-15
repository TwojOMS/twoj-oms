import { readFileSync as odczytaj } from 'node:fs';
import { fileURLToPath } from 'node:url';
export * from 'node:fs';

const root = new URL('../../../', import.meta.url);
// Przekłada tylko dawne ścieżki. Odczytuje rzeczywisty kod używany przez moduł.
export function readFileSync(path, ...args) {
  const s = (path instanceof URL ? fileURLToPath(path) : String(path)).replaceAll('\\', '/');
  const prefix = 'src/oms/';
  const i = s.indexOf(prefix);
  if (i < 0) return odczytaj(path, ...args);
  const stara = s.slice(i + prefix.length);
  if (stara === 'web/routes/magazyn.js') {
    // Kontrolery są rozdzielone; dowód braku klientów obejmuje każdy z nich.
    return ['karta.js','pomocniki.js','lista.js','akcje.js','synchronizacja.js','zapis.js']
      .map(p => odczytaj(new URL(`src/moduly/magazyn/${p}`, root), ...args)).join('\n');
  }
  const cel = stara.startsWith('web/views/')
    ? (stara === 'web/views/layout-oms.ejs'
      ? 'src/core/web/widoki/layout-oms.ejs'
      : `src/moduly/magazyn/widoki/${stara.slice('web/views/'.length)}`)
    : stara.startsWith('domain/') ? `src/domena/${stara.slice('domain/'.length)}` : `${prefix}${stara}`;
  return odczytaj(new URL(cel, root), ...args);
}
