// PRZ-062: narzędzia przejścia na pracę muszą być u klienta — w paczce wydania i w obrazie kontenera.
// Bez inicjalizuj-granice-bez-historii.mjs w obrazie raport sprzedaży kanału dodanego po przejściu
// odmawia (400) i klient nie ma czym tego naprawić (zmierzone przed PRZ-062: skryptu nie było ani tu, ani tu).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { plikiPaczki } from '../../scripts/paczka-klienta.mjs';

const dockerfile = fs.readFileSync(new URL('../../deploy/klient/Dockerfile', import.meta.url), 'utf8');
const compose = fs.readFileSync(new URL('../../deploy/klient/compose.yaml', import.meta.url), 'utf8');
const NARZEDZIA = ['scripts/produkcja-pierwszy-start.mjs', 'scripts/inicjalizuj-granice-bez-historii.mjs'];

describe('paczka i obraz klienta: narzędzia przejścia na pracę', () => {
  it('oba skrypty są w paczce wydania', () => {
    const w = plikiPaczki([...NARZEDZIA, 'scripts/mutacje-prz062.mjs', 'src/oms.js']);
    for (const n of NARZEDZIA) expect(w).toContain(n);
    expect(w).not.toContain('scripts/mutacje-prz062.mjs');
  });
  it('oba skrypty są kopiowane do obrazu (katalog roboczy /app/scripts)', () => {
    const kopie = dockerfile.split(/\r?\n/).filter(l => l.startsWith('COPY ') && l.endsWith(' ./scripts/')).join(' ');
    for (const n of NARZEDZIA) expect(kopie).toContain(n);
  });
  it('ścieżki danych i port ustawia compose (environment wygrywa z env_file) — szablon pracy ich nie potrzebuje', () => {
    const oms = compose.slice(compose.indexOf('\n  oms:'), compose.indexOf('\n  kopia:'));
    for (const n of ['OMS_PORT: "3001"', 'OMS_DB_PATH: /opt/oms/data/oms.sqlite', 'OMS_PROFORMY_KATALOG: /opt/oms/data/proformy', 'OMS_ETYKIETY_KATALOG: /opt/oms/data/etykiety'])
      expect(oms).toContain(n);
  });
});
