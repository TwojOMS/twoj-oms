import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plikiPaczki } from '../../scripts/paczka-klienta.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const pliki = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0').filter(Boolean);
const paczka = new Set(plikiPaczki(pliki));

function odsylacze(dokument, tresc) {
  return tresc.split(/\r?\n/).flatMap((wiersz, indeks) => {
    // Pliki pod docs/, scripts/, deploy/ i src/ (rozszerzenie albo Dockerfile), także
    // w backtickach i blokach poleceń. Nie katalogi ani ścieżki absolutne typu C:/OMS-klient, /data-oms.
    const sciezki = [...wiersz.matchAll(/(?<![\w/:.-])(?:docs|scripts|deploy|src)\/(?:[\w.-]+\/)*(?:[\w-]+(?:\.[\w-]+)+|Dockerfile)(?![\w/.-])/g)]
      .map(m => m[0]);
    // Względne cele linków Markdown rozwiązujemy względem dokumentu; kotwica nie jest częścią pliku.
    for (const m of wiersz.matchAll(/\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)) {
      const cel = m[1].split(/[?#]/)[0];
      if (!cel || /^(?:[a-z]+:|\/)/i.test(cel)) continue;
      sciezki.push(/^(?:docs|scripts|deploy|src)\//.test(cel) ? cel : posix.normalize(posix.join(posix.dirname(dokument), cel)));
    }
    return [...new Set(sciezki)].map(plik => ({ plik, linia: indeks + 1 }));
  });
}

describe('paczka klienta: odsyłacze w dokumentach', () => {
  it('każdy odsyłacz wskazuje plik dostarczany w tej samej paczce', () => {
    const dokumenty = [...paczka].filter(p => p.endsWith('.md'));
    expect(dokumenty.length).toBeGreaterThan(0);
    const braki = dokumenty.flatMap(dokument => odsylacze(dokument, readFileSync(new URL(`../../${dokument}`, import.meta.url), 'utf8'))
      .filter(({ plik }) => !paczka.has(plik))
      .map(({ plik, linia }) => `${dokument}:${linia}: brak w paczce: ${plik}`));
    expect(braki).toEqual([]);
  });

  it('rozpoznaje pliki repo w kodzie i linkach, pomija katalogi, adresy i kotwice', () => {
    expect(odsylacze('docs/instrukcja.md', [
      '`docs/brak.md` i `node scripts/brak.mjs`',
      '[opis](../src/brak.ts#sekcja) i [plik](deploy/klient/Dockerfile)',
      '[lokalny](brak.md) i [opis](docs/brak.md#sekcja)',
      '`C:/OMS-klient` `/data-oms` `deploy/klient` [www](https://example.org/docs/plik.md) [sekcja](#sekcja)',
    ].join('\n'))).toEqual([
      { plik: 'docs/brak.md', linia: 1 }, { plik: 'scripts/brak.mjs', linia: 1 },
      { plik: 'deploy/klient/Dockerfile', linia: 2 }, { plik: 'src/brak.ts', linia: 2 },
      { plik: 'docs/brak.md', linia: 3 },
    ]);
  });
});
