import { zawieraNazwe as porownajNazwe } from '../pomoc/skroty-nazw-firmy.js';
// PRZ-060: strażnik paczki klienta — żaden plik, który `scripts/paczka-klienta.mjs` pakuje dla
// klienta, nie niesie nazw firmy właściciela, jej identyfikatorów ani prawdziwych numerów NIP/rachunku.
// Lista plików pochodzi z TEJ SAMEJ funkcji, którą buduje się paczkę (bez kopii listy), a dane
// firmy z historycznych fixture testów (bez drugiego wpisu tych wartości tutaj).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extname, basename } from 'node:path';
import { plikiPaczki } from '../../scripts/paczka-klienta.mjs';
import { definicjeKanalowHistoryczne } from '../pomoc/kanaly-historyczne-fixture.js';
import { MARKA_HISTORYCZNA } from '../pomoc/marka-poczty-fixture.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Nazwy firmy, marek i ich miejsc. Porównanie bez wielkości liter.

// Jawne nazwy pozostają poza repo; kształt wzorca i SHA-256 zachowują kontrolę paczki.
const SKROTY_NAZW = [
  {"wzor": "\\p{L}{8}", "skrot": "3876cd847a24f6d3a8f3542919b9f6545e500e2eea8583bb58583508cefe9a57", "bezWielkosci": true},
  {"wzor": "\\p{L}{8}", "skrot": "a2ac0b2e157811634f85a0cd5e7ec6ae46b6123e724924eba975ef822566f72e", "bezWielkosci": true},
  {"wzor": "\\p{L}{7}", "skrot": "bbad42404dae7eccdb5c9da096a448d035cbe65c428a1f58cad5e8617dff6d6a", "bezWielkosci": true},
  {"wzor": "\\p{L}{7}", "skrot": "621ff5bc8c1a1c6efc971f9b84d23fd0cd4d1253e9591b25270647d40c165c4b", "bezWielkosci": true},
  {"wzor": "\\p{L}{6}\\s*\\p{L}{5}", "skrot": "bc2697af073f87f25c42ba4846fffd02becfd0a936fd018ef3c8de7def6f9347", "bezWielkosci": true},
  {"wzor": "\\p{L}{6}", "skrot": "22fd0120386bf44db9b2553babeb20e750484883331baed1e36f87aaf1dc7473", "bezWielkosci": true},
  {"wzor": "\\p{L}{6}", "skrot": "2b26c3d0b5f3fff76e52503400e750bae306b5bd3fea3f861797207eb4015b4b", "bezWielkosci": true},
  {"wzor": "\\p{L}{6} \\p{L}{2} \\p{L}{4}", "skrot": "ab34ab845f401834235d3974c5f0fd83d4858addd09ab8ab753c246b9ac81766", "bezWielkosci": true},
  {"wzor": "\\b\\p{L}{8}\\b", "skrot": "3a64ab99b4c91ad8a94560ff8d96499a527700dbaa72a8edee37e27837d11b4d", "bezWielkosci": false},
  {"wzor": "\\b\\d{2}-\\d{3}\\b", "skrot": "637a8895272c3d0e04ecfe8c8818dc7500daac7e7d0f1ec4ba474dd998061395", "bezWielkosci": false},
  {"wzor": "\\b\\d{2}-\\d{3}\\b", "skrot": "73975fb751dfa455460837a05f71f44e81b9ed556f1bf4a61f19aa577b269d77", "bezWielkosci": false},
  {"wzor": "\\b\\d{2}-\\d{3}\\b", "skrot": "48954c4096b44b8bdf88fb515026cf77e19582f2a7aab43acef7f894177566c1", "bezWielkosci": false},
  {"wzor": "\\b\\d{2}-\\d{3}\\b", "skrot": "bf0f9e5e68d108e4dc71a98499cf62440abf2d87399071985946f462267b4bf3", "bezWielkosci": false},
  {"wzor": "\\b\\d{2}-\\d{3}\\b", "skrot": "06a92ccb5b0c67a526e9c452eba1e3ef3f49504238b974757ae15dd00f34ff1d", "bezWielkosci": false},
  {"wzor": "\\b\\d{2}-\\d{3}\\b", "skrot": "a6965dd70d8e53025dc9b0699a246d53c9e46def140f312c26ef1afc73a624cf", "bezWielkosci": false},
  {"wzor": "\\b\\d{2}-\\d{3}\\b", "skrot": "23db777fcb41e369b9b0098a873ab5fb7d48ab74b1eb979b622cb7f93e1f4d2b", "bezWielkosci": false},
  {"wzor": "\\b\\d{2}-\\d{3}\\b", "skrot": "a902e662fb272308b2b3e3411ccc750b6d286919f985b3e3e6ce0dc3a341a9b0", "bezWielkosci": false},
  {"wzor": "\\b\\d{2}-\\d{3}\\b", "skrot": "434e79c5d820c9b6a5a4b59de5872317b099e93e408ff32498d9e9169a583605", "bezWielkosci": false},
  {"wzor": "\\b\\d{2}-\\d{3}\\b", "skrot": "158b2b833e1eb6f5ff3afc9d8dc9e1b515c3a9195709636542855c37ee49891b", "bezWielkosci": false},
];
const zawieraNazwe = (tresc: string, wzorce = SKROTY_NAZW) => porownajNazwe(tresc, wzorce);
const SLOWA = [
  /\bEwa\b/, /\/root\/monitoring/, /c:[\\/]+users[\\/]+adam/i, /\\\\serwer|\/\/serwer/i, /192\.168\.0\./,
];
// PRZ-073: GDD to kanał algorytmiczny produktu — jako identyfikator ('GDD' w kodzie, `GDD` w liście
// zastrzeżonych nazw w docs) zostaje. Każde INNE wystąpienie (zdanie na ekranie, komentarz
// o kliencie właściciela) to wiedza o firmie, nie o produkcie.
const gddPozaIdentyfikatorem = (tresc: string) => /\bGDD\b/.test(tresc.replaceAll("'GDD'", '').replaceAll('`GDD`', ''));
// Identyfikatory firmy (NIP, BDO, rachunek) trzymane jako SKRÓTY sha256 — jawnych wartości nie ma w repo.
// Fixture konfiguracji ma wartości zmyślone, więc nie może być źródłem prawdy o prawdziwych.
// Strażnik szuka w treści ciągów 9, 10 i 26 cyfr (także z odstępami i kreskami między cyframi) i porównuje skróty.
const SKROTY_IDENTYFIKATOROW = new Set([
  '65d7699d6857ac57618b669bb773f0796e7dcd8a2ae3857fd92394ba45a6ee49',
  'dd5521453e61d59dfef4cebbf2b33dfb7b20fb9bc7c5c635f155e64cf312b48c',
  '6574a04eb92296ce465c40627f9f643d573ae5935e3c6776be1f58276fd44b6a',
]);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function zawieraIdentyfikator(tresc: string, skroty: Set<string> = SKROTY_IDENTYFIKATOROW) {
  for (const m of tresc.matchAll(/\d(?:[ -]?\d)*/g)) {
    const cyfry = m[0].replace(/[ -]/g, '');
    for (const dl of [9, 10, 26]) {
      for (let i = 0; i + dl <= cyfry.length; i++) if (skroty.has(sha(cyfry.slice(i, i + dl)))) return true;
    }
  }
  return false;
}

// Jawne wyjątki: dokładny plik + dokładna wartość + powód. Bez wyjątków „na zapas”.
const WYJATKI_NIP: Record<string, { plik: string; powod: string }[]> = {
  '5252674798': [
    { plik: 'src/domena/wskazniki-zarzadcze.js', powod: 'NIP Allegro.pl sp. z o.o. — publiczny identyfikator platformy; po nim wskaźniki rozpoznają faktury prowizji Allegro (reguła produktu, nie dane właściciela).' },
    { plik: 'src/domena/koszt-metadane.js', powod: 'Ten sam publiczny NIP Allegro jako przykład zapisu z kreskami i bez (komentarz o normalizacji klucza kosztu).' },
    { plik: 'src/oms/db/kategorie-kosztow.js', powod: 'Ten sam publiczny NIP Allegro jako przykład zapisu z kreskami i bez (komentarz o kluczu głównym kategorii).' },
  ],
  '1234563218': [
    { plik: 'src/moduly/koszty/pdf/zestawienie-dla-biura-pdf.js', powod: 'Fikcyjny NIP przykładowy (ten sam co w fixture testów) w komentarzu o szerokości numeru KSeF.' },
  ],
  '9990001002': [
    { plik: 'scripts/instalacja-przygotuj.mjs', powod: 'Fikcyjny NIP instalacji próbnej (konfiguracja bez danych firmy, PRZ-050); przedrostek 999 = nieistniejący urząd skarbowy (06.11).' },
  ],
};
const WYJATKI_RACHUNEK: Record<string, { plik: string; powod: string }[]> = {
  '34109010140000000000000000': [{ plik: 'scripts/instalacja-przygotuj.mjs', powod: 'Fikcyjny rachunek instalacji próbnej (konfiguracja bez danych firmy, PRZ-050).' }],
};
const FIKCYJNE_VAT_UE = new Set(['SK1234567890', 'SK1098765431', 'DE123456789']);

const TEKSTOWE = new Set(['.js', '.mjs', '.ts', '.ejs', '.css', '.sql', '.json', '.md', '.sh', '.yaml', '.yml', '.txt', '']);
const tekstowy = (p: string) => TEKSTOWE.has(extname(p).toLowerCase()) || basename(p) === 'Dockerfile';

function czyNip(cyfry: string) {
  if (!/^\d{10}$/.test(cyfry)) return false;
  const wagi = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const suma = wagi.reduce((s, w, i) => s + w * Number(cyfry[i]), 0) % 11;
  return suma !== 10 && suma === Number(cyfry[9]);
}
function czyRachunekPl(cyfry: string) {
  if (!/^\d{26}$/.test(cyfry)) return false;
  const liczba = `${cyfry.slice(2)}2521${cyfry.slice(0, 2)}`; // PL = 25 21
  let reszta = 0;
  for (const c of liczba) reszta = (reszta * 10 + Number(c)) % 97;
  return reszta === 1;
}

/** Naruszenia w treści jednego pliku paczki. Czysta funkcja — sprawdzana też wprost niżej. */
export function naruszenia(plik: string, tresc: string): string[] {
  const wynik: string[] = [];
  for (const wzor of SLOWA) if (wzor.test(tresc)) wynik.push(`${plik}: słowo firmy ${wzor}`);
  if (zawieraNazwe(tresc)) wynik.push(`${plik}: nazwa firmy (sha256)`);
  if (gddPozaIdentyfikatorem(tresc)) wynik.push(`${plik}: GDD poza identyfikatorem kanału 'GDD'`);
  if (zawieraIdentyfikator(tresc)) wynik.push(`${plik}: identyfikator firmy z fixture`);
  for (const nazwa of [MARKA_HISTORYCZNA.podpis, MARKA_HISTORYCZNA.naglowek, ...definicjeKanalowHistoryczne.map((d) => d.etykieta)])
    if (nazwa && tresc.toLowerCase().includes(nazwa.toLowerCase())) wynik.push(`${plik}: historyczna nazwa „${nazwa}”`);
  if (!tekstowy(plik)) return wynik;
  for (const m of tresc.matchAll(/(?<![\d-])\d{3}[- ]?\d{3}[- ]?\d{2}[- ]?\d{2}(?![\d-])/g)) {
    const cyfry = m[0].replace(/[- ]/g, '');
    if (!czyNip(cyfry)) continue;
    if (WYJATKI_NIP[cyfry]?.some((w) => w.plik === plik)) continue;
    wynik.push(`${plik}: NIP z poprawną sumą kontrolną ${cyfry}`);
  }
  for (const m of tresc.matchAll(/(?<!\d)(?:PL)?\d{2}(?: ?\d{4}){6}(?!\d)/g)) {
    const cyfry = m[0].replace(/^PL/, '').replaceAll(' ', '');
    if (czyRachunekPl(cyfry) && !WYJATKI_RACHUNEK[cyfry]?.some((w) => w.plik === plik)) wynik.push(`${plik}: numer rachunku z poprawną sumą kontrolną`);
  }
  for (const m of tresc.matchAll(/\b(?:SK|CZ|DE|AT|LT|LV|EE|HU|SI|HR|RO|BG|FR|IT|ES|NL|BE|LU|DK|SE|FI|IE|PT|GR|CY|MT)\d{8,12}\b/g))
    if (!FIKCYJNE_VAT_UE.has(m[0])) wynik.push(`${plik}: numer VAT UE ${m[0].slice(0, 2)}… spoza fikcyjnych przykładów`);
  return wynik;
}

const sledzone = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean);
const paczka = plikiPaczki(sledzone).filter((p: string) => { try { readFileSync(`${ROOT}${p}`); return true; } catch { return false; } });

describe('PRZ-060 — paczka klienta bez danych firmy właściciela', () => {
  it('lista skrótów nazw zachowuje pełny zestaw wzorców', () => {
    expect(SKROTY_NAZW).toHaveLength(19);
    // Kopia: skroty zneutralizowane (patche.mjs 1b) — odcisk listy wlasciciela tu nie obowiazuje.
  });

  it('lista plików jest tą z paczki i obejmuje src/, deploy/klient/ i package.json', () => {
    expect(SKROTY_IDENTYFIKATOROW.size).toBe(3);
    expect(paczka.length).toBeGreaterThan(400);
    expect(paczka).toContain('package.json');
    expect(paczka.some((p: string) => p.startsWith('deploy/klient/'))).toBe(true);
    expect(paczka.filter((p: string) => p.startsWith('src/')).length).toBeGreaterThan(400);
  });

  it('żaden plik paczki nie niesie nazw, identyfikatorów ani prawdziwych numerów firmy', () => {
    const wszystkie = paczka.flatMap((p: string) => {
      const bajty = readFileSync(`${ROOT}${p}`);
      return naruszenia(p, tekstowy(p) ? bajty.toString('utf8') : bajty.toString('latin1'));
    });
    expect(wszystkie).toEqual([]);
  });

  it('każdy wyjątek wskazuje plik paczki, który naprawdę go zawiera', () => {
    for (const [nip, lista] of [...Object.entries(WYJATKI_NIP), ...Object.entries(WYJATKI_RACHUNEK)]) for (const w of lista) {
      expect(paczka).toContain(w.plik);
      expect(readFileSync(`${ROOT}${w.plik}`, 'utf8')).toContain(nip);
      expect(w.powod.length).toBeGreaterThan(20);
    }
  });

  it('skaner łapie każde słowo i każdy rodzaj numeru (bez tego zielone nic nie znaczy)', () => {
    const kontrolna = [{ wzor: String.raw`\b\p{L}{14}\b`, skrot: sha('markakontrolna'), bezWielkosci: true }];
    expect(zawieraNazwe('MarkaKontrolna', kontrolna)).toBe(true);
    expect(zawieraNazwe('MARKAKONTROLNA', kontrolna)).toBe(true);
    expect(zawieraNazwe('InnaNazwa', kontrolna)).toBe(false);
    expect(zawieraNazwe('SuperMarkaKontrolna', kontrolna)).toBe(false);
    const odstepy = [{ ...kontrolna[0], wzor: String.raw`\p{L}{5}\s*\p{L}{9}` }];
    expect(zawieraNazwe('Marka  Kontrolna', odstepy)).toBe(true);
    const wielkieLitery = [{ ...kontrolna[0], skrot: sha('MarkaKontrolna'), bezWielkosci: false }];
    expect(zawieraNazwe('MarkaKontrolna', wielkieLitery)).toBe(true);
    expect(zawieraNazwe('markakontrolna', wielkieLitery)).toBe(false);
    const kod = [{ wzor: String.raw`\b\d{2}-\d{3}\b`, skrot: sha('12-345'), bezWielkosci: false }];
    expect(zawieraNazwe('kod 12-345', kod)).toBe(true);
    expect(zawieraNazwe('kod 12-346', kod)).toBe(false);
    for (const tekst of ['C:\\Users\\adam\\x', '\\\\serwer\\indyw', '192.168.0.10', 'rola Ewa', '/root/monitoring.sh']) expect(naruszenia('src/x.js', tekst)).not.toEqual([]);
    const probka = new Set([sha('918273645')]);
    expect(zawieraIdentyfikator('bdo 918273645 x', probka)).toBe(true);
    expect(zawieraIdentyfikator('bdo 918 273-645 x', probka)).toBe(true);
    expect(zawieraIdentyfikator('bdo 918273646 x', probka)).toBe(false);
    expect(naruszenia('src/x.js', 'NIP 120-000-11-92')).toEqual(['src/x.js: NIP z poprawną sumą kontrolną 1200001192']);
    expect(naruszenia('src/x.js', 'NIP 120 000 11 92')).toEqual(['src/x.js: NIP z poprawną sumą kontrolną 1200001192']);
    expect(naruszenia('src/x.js', 'saga i Julia')).toEqual([]);
    expect(naruszenia('src/x.js', 'paragraf 3 regulaminu')).toEqual([]);
    expect(naruszenia('src/x.js', "tresc: 'Po granicy historii kanał GDD nie istnieje —'")).not.toEqual([]);
    expect(naruszenia('src/x.js', '// klient GDD zamawia z konta 21')).not.toEqual([]);
    expect(naruszenia('src/x.js', "return 'GDD'; const t = klasyfikacja.tagGdd;")).toEqual([]);
    expect(naruszenia('docs/x.md', 'zastrzeżone: `DROPSHIPPING`, `GDD`, `INDYWIDUALNE`')).toEqual([]);
    expect(naruszenia('src/x.js', 'rachunek PL61 1090 1014 0000 0712 1981 2874')).toEqual(['src/x.js: numer rachunku z poprawną sumą kontrolną']);
    expect(naruszenia('src/x.js', 'VAT SK1000000001')).not.toEqual([]);
    expect(naruszenia('src/x.js', '5252674798')).not.toEqual([]); // wyjątek działa tylko w swoim pliku
    expect(naruszenia('src/x.js', 'zwykły tekst 1234567890 i 12345678901234567890123456')).toEqual([]);
  });
});
