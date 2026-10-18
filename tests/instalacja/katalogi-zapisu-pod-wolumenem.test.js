// PRZ-094.29: katalog, który aplikacja zapisuje, a którego domyślna wartość w kodzie to /data-oms/…,
// musi być w compose klienta ustawiony pod zamontowany wolumen — inaczej zapis idzie do warstwy kontenera
// (u UID 10001 pada na mkdir w katalogu głównym) albo znika przy odtworzeniu kontenera.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const compose = () => fs.readFileSync(path.join(ROOT, 'deploy/klient/compose.yaml'), 'utf8');

// Zmienne katalogów zapisu. Plik bazy (OMS_DB_PATH) ma osobny wpis, bo to plik, nie katalog.
const KATALOGI_ZAPISU = [
  { zmienna: 'OMS_REKLAMY_SEKRETY_DIR', plik: 'src/moduly/marketing/konfiguracja.ts' },
  { zmienna: 'OMS_PROFORMY_KATALOG', plik: 'src/moduly/faktury/modul.ts' },
  { zmienna: 'OMS_ETYKIETY_KATALOG', plik: 'src/moduly/wysylka/modul.ts' },
  { zmienna: 'OMS_DB_PATH', plik: 'src/main.ts' },
];

function usluga(nazwa) {
  const linie = compose().split(/\r?\n/);
  const start = linie.indexOf(`  ${nazwa}:`);
  const koniec = linie.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
  return linie.slice(start, koniec < 0 ? undefined : koniec).join('\n');
}

describe('katalogi zapisu w compose klienta (PRZ-094.29)', () => {
  it('wolumeny zapisywalne w usłudze oms to /opt/oms/data (backups jest :ro)', () => {
    const u = usluga('oms');
    expect(u).toContain('- /opt/oms/data:/opt/oms/data\n');
    expect(u).toMatch(/- \/opt\/oms\/backups:\/opt\/oms\/backups:ro/);
  });

  for (const { zmienna, plik } of KATALOGI_ZAPISU) {
    it(`${zmienna} ma w usłudze oms ścieżkę pod /opt/oms/data`, () => {
      expect(fs.readFileSync(path.join(ROOT, plik), 'utf8')).toContain(zmienna);
      const wpis = usluga('oms').match(new RegExp(`^\\s+${zmienna}:\\s*"?([^"\\s#]+)"?`, 'm'));
      expect(wpis, `brak ${zmienna} w environment usługi oms`).not.toBeNull();
      expect(wpis[1]).toMatch(/^\/opt\/oms\/data\//);
    });
  }

  it('żaden domyślny /data-oms z kodu aplikacji nie dotyczy zmiennej katalogu bez wpisu w compose', () => {
    // Skan src: każda zmienna OMS_*, której domyślna wartość zaczyna się od /data-oms, musi być w compose.
    const znalezione = new Set();
    const idz = katalog => {
      for (const e of fs.readdirSync(katalog, { withFileTypes: true })) {
        const p = path.join(katalog, e.name);
        if (e.isDirectory()) idz(p);
        else if (/\.(ts|js|mjs)$/.test(e.name)) {
          const tresc = fs.readFileSync(p, 'utf8');
          for (const m of tresc.matchAll(/env\.(OMS_[A-Z_]+)\s*(?:\|\||\?\?)\s*'\/data-oms\//g)) znalezione.add(m[1]);
        }
      }
    };
    idz(path.join(ROOT, 'src'));
    expect([...znalezione].length).toBeGreaterThan(0);
    for (const zmienna of znalezione) {
      expect(compose(), `${zmienna} z domyślnym /data-oms nie jest ustawiona w compose klienta`)
        .toMatch(new RegExp(`^\\s+${zmienna}:\\s*/opt/oms/data/`, 'm'));
    }
  });
});
