// PRZ-100: wersja w adresach /public/*.css|js (`?v=`). Pośrednik przed panelem (Cloudflare przed demo: max-age=14400)
// każe przeglądarce trzymać plik godzinami — bez wersji w adresie po wydaniu ekran składa nowy HTML ze starym CSS-em.
// Wersja = odcisk treści plików, liczony raz przy starcie: zmienia się dokładnie wtedy, gdy zmienia się któryś plik.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ZASOB = /\.(css|js|png)$/;

function pliki(katalog) {
  return readdirSync(katalog, { withFileTypes: true })
    .filter((w) => w.isFile() && ZASOB.test(w.name))
    .map((w) => w.name)
    .sort();
}

/** 10 znaków hex z SHA-256 nazw i treści .css/.js/.png; zamienniki to znak instalacji czytany przy starcie. */
export function wersjaZasobow(katalog, zamienniki = {}) {
  const h = createHash('sha256');
  for (const nazwa of pliki(katalog)) h.update(nazwa).update('\0').update(zamienniki[nazwa] ?? readFileSync(join(katalog, nazwa))).update('\0');
  return h.digest('hex').slice(0, 10);
}

/** zasob('oms-design.css') → '/public/oms-design.css?v=<wersja>'; nieznana nazwa = błąd renderowania (literówka). */
export function adresZasobu(katalog, zamienniki = {}) {
  const znane = new Set(pliki(katalog));
  const wersja = wersjaZasobow(katalog, zamienniki);
  return (nazwa) => {
    if (!znane.has(nazwa)) throw new Error(`zasob(): nie ma pliku ${nazwa} w katalogu publicznym`);
    return `/public/${nazwa}?v=${wersja}`;
  };
}
