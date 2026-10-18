import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { plikiPaczki } from '../../scripts/paczka-klienta.mjs';

const czytaj = plik => fs.readFileSync(new URL(`../../${plik}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const manifest = JSON.parse(czytaj('docs/konfiguracja.json'));

describe('tabela zmiennych dla instalatora', () => {
  it('jest zapisana w repo i zgodna z generatorem — przegeneruj: node scripts/zmienne-tabela.mjs', async () => {
    expect(fs.existsSync(new URL('../../docs/zmienne.md', import.meta.url)), 'brak docs/zmienne.md').toBe(true);
    const { generujTabele } = await import('../../scripts/zmienne-tabela.mjs');
    expect(czytaj('docs/zmienne.md')).toBe(generujTabele(manifest));
  });

  it('zawiera każdą zmienną dokładnie raz i żadnej spoza manifestu', () => {
    const nazwy = [...czytaj('docs/zmienne.md').matchAll(/^\| <code>(.*?)<\/code> \|/gm)]
      .map(m => m[1].replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
    expect(nazwy.sort()).toEqual(manifest.zmienne.map(z => z.nazwa).sort());
  });

  it('nie drukuje wartości sekretów i zabezpiecza składnię tabeli', async () => {
    const { generujTabele } = await import('../../scripts/zmienne-tabela.mjs');
    const tresc = generujTabele({ zmienne: [{ nazwa: '<P>_TOKEN', sekcja: 'Test', sekret: true,
      domyslna: 'NIE_WYPISUJ', wlasciciel: 'moduł | test', wymagalnosc: 'tak', skutekBraku: 'brak\npołączenia' }] });
    expect(tresc).not.toContain('NIE_WYPISUJ');
    expect(tresc).toContain('sekret — nie wklejaj do czatu ani do repo');
    expect(tresc).toContain('<code>&lt;P&gt;_TOKEN</code>');
    expect(tresc).toContain('moduł &#124; test');
    expect(tresc).toContain('brak<br>połączenia');
  });

  it('odróżnia pola formularzy od adresów API i archiwum ustawianych wyłącznie w pliku', async () => {
    const { generujTabele } = await import('../../scripts/zmienne-tabela.mjs');
    const wiersze = generujTabele(manifest).split('\n');
    for (const nazwa of ['INFAKT_API_KEY', 'DPD_LOGIN', 'INPOST_TOKEN', 'SMTP_HOST', 'OMS_ADRES_PANELU', 'DPD_NADAWCA_ULICA']) {
      expect(wiersze.find(w => w.startsWith(`| <code>${nazwa}</code> |`))).toMatch(/\| Tak — Ustawienia/);
    }
    for (const nazwa of ['INFAKT_API_URL', 'INFAKT_ARCHIWUM', 'INPOST_URL', 'DPD_URL', 'DPD_INFO_URL', 'OMS_PASS']) {
      expect(wiersze.find(w => w.startsWith(`| <code>${nazwa}</code> |`))).toMatch(/\| Nie \|$/);
    }
  });

  // Żargon programisty: ścieżki i pliki, numery zadań, nazwy bibliotek, funkcji i oznaczenia decyzji.
  // Nie ma go ani w opisie, ani w ludzkiej wersji skutku braku — właściciel firmy tego nie przeczyta.
  const ZARGON_SLOWA = /\b(?:src|tests|scripts|docs|deploy)\/|\.(?:ts|js|mjs|json)\b|PRZ-\d|Fastify|SQLite|JSON\.parse|writeFileSync|custom_attributes|modified_after|X-Forwarded|konfiguracja_integracji|kompozycj|frozen|\bD0\d\b|\bCLI\b|\bAST\b|fixture|harness|preflight|\b(?:GET|POST)\b|\b(?:409|429|503)\b/i;
  // Nazwy funkcji i pól w camelCase (zbudujOms, modulWeb, zwrotyPoznane); „inFakt” to nazwa produktu.
  const ZARGON_CAMEL = /\b(?!inFakt)[a-zęóąśłżźćń]{2,}[A-ZĘÓĄŚŁŻŹĆŃ][a-zęóąśłżźćń]+/;
  const ZARGON = { test: tekst => ZARGON_SLOWA.test(tekst) || ZARGON_CAMEL.test(tekst) };

  it('każda zmienna ma opis po ludzku: jedno zdanie do 140 znaków, bez żargonu i bez zastępczego „Moduł:”', () => {
    const bez = manifest.zmienne.filter(z => typeof z.opis !== 'string' || !z.opis.trim()).map(z => z.nazwa);
    expect(bez, 'zmienne bez pola opis').toEqual([]);
    const zaDlugie = manifest.zmienne.filter(z => z.opis.length > 140).map(z => `${z.nazwa} (${z.opis.length})`);
    expect(zaDlugie, 'opis dłuższy niż 140 znaków').toEqual([]);
    const zargon = manifest.zmienne.filter(z => ZARGON.test(z.opis) || /^Moduł:/.test(z.opis)).map(z => z.nazwa);
    expect(zargon, 'opis z żargonem albo zastępczym „Moduł:”').toEqual([]);
    const nieZdanie = manifest.zmienne.filter(z => !/[.!?]$/.test(z.opis)).map(z => z.nazwa);
    expect(nieZdanie, 'opis bez kropki na końcu').toEqual([]);
  });

  it('w tabeli nie ma wiersza z zastępczym opisem „Moduł:”', () => {
    const wiersze = czytaj('docs/zmienne.md').split('\n').filter(w => w.startsWith('| <code>'));
    expect(wiersze.length).toBe(manifest.zmienne.length);
    expect(wiersze.filter(w => w.includes('Moduł:')).map(w => w.slice(0, 60))).toEqual([]);
    expect(czytaj('docs/zmienne.md')).not.toContain('opis zastępczy');
  });

  it('skutek braku z żargonem ma wersję po ludzku, a ta wersja trafia do tabeli zamiast technicznej', async () => {
    const zZargonem = manifest.zmienne.filter(z => ZARGON.test(z.skutekBraku));
    expect(zZargonem.length, 'brak zmiennych z żargonem — test nic nie sprawdza').toBeGreaterThan(0);
    expect(zZargonem.filter(z => !z.skutekBrakuPoLudzku).map(z => z.nazwa), 'żargon bez skutekBrakuPoLudzku').toEqual([]);
    const jeszczeZargon = manifest.zmienne.filter(z => z.skutekBrakuPoLudzku !== undefined
      && (typeof z.skutekBrakuPoLudzku !== 'string' || !z.skutekBrakuPoLudzku.trim() || ZARGON.test(z.skutekBrakuPoLudzku)));
    expect(jeszczeZargon.map(z => z.nazwa), 'skutekBrakuPoLudzku pusty albo z żargonem').toEqual([]);
    const { generujTabele } = await import('../../scripts/zmienne-tabela.mjs');
    const tresc = generujTabele({ zmienne: [{ nazwa: 'X_TEST', sekcja: 'Test', wlasciciel: 'm', wymagalnosc: 'tak',
      opis: 'Opis testowy.', skutekBraku: 'Technicznie: src/a.ts', skutekBrakuPoLudzku: 'Po ludzku: panel nie wstanie.' }] });
    expect(tresc).toContain('Po ludzku: panel nie wstanie.');
    expect(tresc).not.toContain('src/a.ts');
    expect(tresc).toContain('Opis testowy.');
    expect(tresc).not.toContain('Moduł:');
  });

  // Kolumny „Wymagana?” i „Domyślnie”: ten sam żargon co wyżej oraz słownictwo programisty, którego
  // obca firma nie zna (wartości null, :memory:, Set, trim, adaptery i sondy testów, „bramka”, „rdzeń”,
  // klamry JSON) i ścieżki spoza kontenera klienta.
  const ZARGON_KOLUMNY_DODATKOWO = /:memory:|\bnull\b|\bSet\b|\btrim\b|tmpdir|Dockerfile|\bmain\b|\bmodul[A-Z]|adapter|\bsond|deklaracj|bramk|rdzeni|aktywacj|zdefiniowan|\balias|procesu|[{}]|\/var\/lib\//i;
  const zargonKolumny = tekst => ZARGON.test(tekst) || ZARGON_KOLUMNY_DODATKOWO.test(tekst);
  const komorkiWiersza = wiersz => wiersz.split(' | ');

  it('kolumny „Wymagana?” i „Domyślnie” w tabeli są bez żargonu programisty', async () => {
    const { generujTabele } = await import('../../scripts/zmienne-tabela.mjs');
    const wiersze = generujTabele(manifest).split('\n').filter(w => w.startsWith('| <code>'));
    expect(wiersze.length).toBe(manifest.zmienne.length);
    const zle = [];
    for (const w of wiersze) {
      const [nazwa, wymagana, domyslnie] = komorkiWiersza(w);
      if (zargonKolumny(wymagana)) zle.push(`${nazwa.slice(8, -7)} — Wymagana?: ${wymagana}`);
      if (zargonKolumny(domyslnie)) zle.push(`${nazwa.slice(8, -7)} — Domyślnie: ${domyslnie}`);
    }
    expect(zle, 'żargon w kolumnach Wymagana?/Domyślnie').toEqual([]);
  });

  it('wymagalnoscPoLudzku i domyslnaPoLudzku to niepuste teksty bez żargonu, obok zachowanych pól technicznych', () => {
    for (const pole of ['wymagalnoscPoLudzku', 'domyslnaPoLudzku']) {
      const zPolem = manifest.zmienne.filter(z => z[pole] !== undefined);
      expect(zPolem.length, `brak zmiennych z polem ${pole}`).toBeGreaterThan(0);
      const zle = zPolem.filter(z => typeof z[pole] !== 'string' || !z[pole].trim() || zargonKolumny(z[pole]));
      expect(zle.map(z => z.nazwa), `${pole} pusty albo z żargonem`).toEqual([]);
    }
    expect(manifest.zmienne.filter(z => z.wymagalnoscPoLudzku !== undefined && !z.wymagalnosc).map(z => z.nazwa)).toEqual([]);
    expect(manifest.zmienne.filter(z => z.domyslnaPoLudzku !== undefined && z.domyslna === undefined).map(z => z.nazwa)).toEqual([]);
  });

  it('generator bierze wymagalnoscPoLudzku i domyslnaPoLudzku, gdy są, a bez nich zostaje przy polach technicznych', async () => {
    const { generujTabele } = await import('../../scripts/zmienne-tabela.mjs');
    const baza = { nazwa: 'X_TEST', sekcja: 'Test', wlasciciel: 'm', opis: 'Opis.', skutekBraku: 's',
      wymagalnosc: 'wymagana, gdy modulWeb', domyslna: 'zbudujOms: :memory:' };
    const zPolami = generujTabele({ zmienne: [{ ...baza, wymagalnoscPoLudzku: 'wymagana — panel nie wstanie', domyslnaPoLudzku: 'plik w katalogu danych' }] });
    expect(zPolami).toContain('| wymagana — panel nie wstanie | plik w katalogu danych |');
    expect(zPolami).not.toContain('modulWeb');
    expect(zPolami).not.toContain(':memory:');
    const bez = generujTabele({ zmienne: [baza] });
    expect(bez).toContain('| wymagana, gdy modulWeb | zbudujOms: :memory: |');
  });

  // Wzorce wzięte ze strażnika tests/core/straznik-danych-firmy-prz060.test.ts (nazwy firmy, marek, jej
  // infrastruktury); do nich imiona właściciela i nazwy narzędzi jego sieci. Prawdziwych danych tu nie wpisujemy.
  const WLASCICIEL = [
    /szkicownia/i, /lumina/i, /drugamarka/i, /trzeciamarka/i, /\bAga\b/, /\bAgi\b/, /zywiecki/i,
    /\bNAS\b/, /synology/i, /monitoring/i, /192\.168\./,
    /c:[\\/]+users[\\/]+adam/i, /produkcj\w*\s+(?:właściciela|właściciela|firmy)/i,
  ];
  // Dziennik decyzji i przeglądów (decyzja, sourceReviewCommit) zostaje w manifeście; manifest nie jedzie do klienta.
  const POLA_DZIENNIKA = new Set(['decyzja', 'sourceReviewCommit']);
  const teksty = (wartosc, sciezka = []) => {
    if (typeof wartosc === 'string') return [[sciezka.join('.'), wartosc]];
    if (Array.isArray(wartosc)) return wartosc.flatMap((w, i) => teksty(w, [...sciezka, i]));
    if (wartosc && typeof wartosc === 'object') {
      return Object.entries(wartosc).filter(([k]) => !POLA_DZIENNIKA.has(k)).flatMap(([k, w]) => teksty(w, [...sciezka, k]));
    }
    return [];
  };

  it('opisy zmiennych w manifeście i tabeli nie wspominają o właścicielu ani jego infrastrukturze', () => {
    const trafienia = [];
    for (const z of manifest.zmienne) {
      for (const [sciezka, tresc] of teksty(z, [z.nazwa])) {
        for (const wzor of WLASCICIEL) if (wzor.test(tresc)) trafienia.push(`${sciezka}: ${wzor}`);
      }
    }
    const tabela = czytaj('docs/zmienne.md');
    for (const wzor of WLASCICIEL) if (wzor.test(tabela)) trafienia.push(`docs/zmienne.md: ${wzor}`);
    expect(trafienia, 'wzmianki o właścicielu w manifeście albo tabeli').toEqual([]);
  });

  it('dostarcza tabelę bez prywatnych metadanych manifestu w paczce klienta', () => {
    expect(plikiPaczki(['docs/zmienne.md', 'docs/konfiguracja.md', 'docs/konfiguracja.json'])).toEqual(['docs/zmienne.md']);
  });
});
