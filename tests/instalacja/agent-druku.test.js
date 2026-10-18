// PRZ-094.21: agent druku (deploy/drukarka) jest w repo i w paczce klienta, a jego skrypty wołają
// dokładnie te trasy kolejek druku, które istnieją w kodzie. Bez tego obca firma nie wydrukuje etykiety.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { plikiPaczki } from '../../scripts/paczka-klienta.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const czytaj = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

const PLIKI = [
  'deploy/drukarka/README.md',
  'deploy/drukarka/czuwacz-etykiet.ps1',
  'deploy/drukarka/czuwacz-faktur.ps1',
  'deploy/drukarka/config.przyklad.json',
  'deploy/drukarka/config-faktury.przyklad.json',
];
const TRASY = {
  'deploy/drukarka/czuwacz-etykiet.ps1': 'src/moduly/wysylka/trasy/etykiety.js',
  'deploy/drukarka/czuwacz-faktur.ps1': 'src/moduly/faktury/trasy/druk.js',
};

/** Trasy kolejek druku zarejestrowane w kodzie: „GET /kolejka-druku/:id/zpl”. */
function trasyKodu(plik) {
  return [...czytaj(plik).matchAll(/app\.(get|post)\('(\/kolejka-druku[^']*)'/g)]
    .map((m) => `${m[1].toUpperCase()} ${m[2]}`);
}

/** Wywołania panelu w skrypcie: instrukcje z `/kolejka-druku`, z metodą i z `$($poz.id)` zamienionym na `:id`. */
function wywolaniaSkryptu(tresc) {
  const instrukcje = tresc.replace(/`\r?\n\s*/g, ' ').split(/\r?\n/);
  return instrukcje.flatMap((w) => {
    const m = /"\$\(\$k\.url\)(\/kolejka-druku[^"]*)"/.exec(w);
    if (!m) return [];
    const sciezka = m[1].replace(/\?.*$/, '').replace(/\$\(\$poz\.id\)/g, ':id');
    return [`${/-Method\s+Post/i.test(w) ? 'POST' : 'GET'} ${sciezka}`];
  });
}

const pliki = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0').filter(Boolean);

describe('PRZ-094.21: agent druku w repo i w paczce', () => {
  it('pliki agenta istnieją w repo i wchodzą do paczki klienta', () => {
    const brakuje = PLIKI.filter((p) => !existsSync(`${ROOT}${p}`));
    expect(brakuje).toEqual([]);
    expect(plikiPaczki(pliki).filter((p) => p.startsWith('deploy/drukarka/'))).toEqual([...PLIKI].sort());
  });

  it('dokładne nazwy z listy paczki: wzorzec nie wciąga cudzych plików z deploy/', () => {
    expect(plikiPaczki(['deploy/drukarka/README.md', 'deploy/nas/oms-release-remote.sh', 'deploy/wydaj.ps1']))
      .toEqual(['deploy/drukarka/README.md']);
  });

  it('skrypty wołają dokładnie te trasy (metoda i adres), które istnieją w kodzie', () => {
    for (const [skrypt, kod] of Object.entries(TRASY)) {
      const wolane = [...new Set(wywolaniaSkryptu(czytaj(skrypt)))].sort();
      expect(wolane.length, `${skrypt}: nie znaleziono wywołań panelu`).toBe(4);
      expect(wolane).toEqual([...new Set(trasyKodu(kod))].sort());
    }
  });

  it('skrypty są czystym ASCII (Windows czyta je bez BOM w dowolnym kodowaniu)', () => {
    for (const p of PLIKI.filter((f) => f.endsWith('.ps1'))) {
      expect(czytaj(p).match(/[^\x00-\x7f]/g) ?? [], p).toEqual([]);
    }
  });

  it('przykłady konfiguracji to poprawny JSON z polami, których wymagają skrypty', () => {
    const etykiety = JSON.parse(czytaj('deploy/drukarka/config.przyklad.json'));
    const faktury = JSON.parse(czytaj('deploy/drukarka/config-faktury.przyklad.json'));
    for (const pole of ['url', 'user', 'pass', 'drukarka']) expect(etykiety).toHaveProperty(pole);
    for (const pole of ['url', 'user', 'pass', 'drukarka', 'pdfProgram', 'pdfArgumenty']) expect(faktury).toHaveProperty(pole);
  });

  it('instrukcja instalacji odsyła do instrukcji agenta druku, a ta jest w paczce', () => {
    expect(czytaj('docs/instalacja-docker.md')).toContain('deploy/drukarka/README.md');
    expect(plikiPaczki(pliki)).toContain('deploy/drukarka/README.md');
  });
});
