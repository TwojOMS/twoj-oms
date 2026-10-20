// PRZ-102.17 — model maila o płatności bierze zdania z panelu (domena/zdania-platnosci.js), a reguły treści pilnują
// pobrania i opłaconego. Bez bazy i bez serwera; scenariusze te same, co w teście „bajt w bajt".
import { describe, it, expect } from 'vitest';
import { modelWiadomosci, jakoTekstWiadomosci } from '../../src/domena/wiadomosc-platnicza.js';
import { renderWiadomoscHtml } from '../../src/core/poczta/wiadomosc-html.js';
import { DOMYSLNE_ZDANIA, regulaTresci, zdaniaDoMaila, odczytajZdania } from '../../src/domena/zdania-platnosci.js';
import { sprawdzZdanie } from '../../src/moduly/wiadomosci/zdania-platnosci.js';
import { SCENARIUSZE, OPRAWA } from '../pomoc/zdania-platnosci-scenariusze.js';

const S = Object.fromEntries(SCENARIUSZE);

// Klucz → scenariusz, w którym to zdanie pada.
const GDZIE = {
  pobranie: 'faktura za pobraniem',
  oplacone: 'faktura opłacona',
  bez_danych_z_zalacznikiem: 'faktura bez rachunku, z załącznikiem',
  bez_danych_bez_zalacznika: 'przypomnienie bez rachunku, bez załącznika',
  proforma: 'proforma do zapłaty',
  przypomnienie: 'przypomnienie bez załącznika',
  pozostale: 'faktura do zapłaty',
  naglowek_do_zaplaty: 'faktura do zapłaty',
  naglowek_przelew: 'faktura do zapłaty',
  zalacznik_proformy: 'przypomnienie z proformą w załączniku',
  zalacznik_wywozu: 'faktura WDT z potwierdzeniem wywozu',
};
const NOWE = {
  pobranie: 'Zapłacisz kurierowi przy odbiorze paczki.',
  oplacone: 'Wpłata dotarła — dziękujemy.',
  bez_danych_z_zalacznikiem: 'Kwotę i konto znajdziesz w dokumencie.',
  bez_danych_bez_zalacznika: 'Odpisz, a podamy kwotę i konto.',
  proforma: 'Ruszamy z pracą po wpłacie.',
  przypomnienie: 'Jeśli już zapłaciłeś, zignoruj tę wiadomość.',
  pozostale: 'Pytania? Odpisz na tego maila.',
  naglowek_do_zaplaty: 'Kwota',
  naglowek_przelew: 'Dane do wpłaty',
  zalacznik_proformy: 'Proforma {numer_proformy} w załączniku.',
  zalacznik_wywozu: 'Prosimy podpisać potwierdzenie wywozu (WDT) i odesłać skan.',
};

const zlozone = (nazwa, zdania) => {
  const { z, opcje } = S[nazwa];
  const m = modelWiadomosci(z, { ...opcje, zdania });
  return { tekst: jakoTekstWiadomosci(m), html: renderWiadomoscHtml(m, OPRAWA), m };
};

describe('model maila bierze zdania z panelu', () => {
  for (const [klucz, nowe] of Object.entries(NOWE)) {
    it(`${klucz}: nowe brzmienie w tekście i w HTML-u, domyślnego nie ma`, () => {
      const { tekst, html } = zlozone(GDZIE[klucz], zdaniaDoMaila({ [klucz]: nowe }));
      const oczekiwane = klucz.startsWith('naglowek_') ? nowe.toLocaleUpperCase('pl-PL') : nowe.replace('{numer_proformy}', 'PF 7/10/2026');
      expect(tekst).toContain(oczekiwane);
      expect(html).toContain(klucz.startsWith('naglowek_') ? `>${nowe}</p>` : oczekiwane);
      const domyslne = klucz.startsWith('naglowek_') ? DOMYSLNE_ZDANIA[klucz].toLocaleUpperCase('pl-PL') : DOMYSLNE_ZDANIA[klucz].replace('{numer_proformy}', 'PF 7/10/2026');
      expect(tekst).not.toContain(domyslne);
    });
  }

  it('dane w bloku zostają liczone przez kod: kwota, odbiorca, rachunek, tytuł, termin', () => {
    const { tekst } = zlozone('faktura do zapłaty', zdaniaDoMaila(NOWE));
    expect(tekst).toContain('\nKWOTA\n  476,00 zł brutto\n\nDANE DO WPŁATY\n  Odbiorca: Pracownia Półcień\n  Rachunek: 00 1111 2222 3333 4444 5555 6666\n  Tytuł przelewu: FV 12/10/2026\n  Termin:');
  });

  it('zdanie częściowe albo zepsute w zapisie nie psuje maila (brakujące = domyślne)', () => {
    expect(zdaniaDoMaila({ oplacone: '', pobranie: 7 })).toEqual(DOMYSLNE_ZDANIA);
    expect(odczytajZdania('{zepsuty')).toEqual({});
    expect(odczytajZdania('[1,2]')).toEqual({});
    expect(odczytajZdania(JSON.stringify({ oplacone: 'X', obce: 'Y', pobranie: '  ' }))).toEqual({ oplacone: 'X' });
  });
});

describe('reguły treści', () => {
  it('pobranie: „kurier" albo „doręczeni…" bez względu na wielkość liter i polskie znaki', () => {
    for (const ok of ['Kurier pobierze należność.', 'ZAPŁACISZ KURIEROWI.', 'Płatność przy Doręczeniu.', 'Platnosc przy DORECZENIU.']) {
      expect(regulaTresci('pobranie', ok), ok).toBeNull();
    }
    for (const zle of ['Prosimy o przelew.', 'Płatność przy odbiorze.', 'Dziękujemy.']) {
      expect(regulaTresci('pobranie', zle), zle).toMatch(/drugi raz kurierowi/);
    }
  });

  it('opłacone: prośba o zapłatę odrzucona, opis zapłaty przyjęty', () => {
    for (const zle of ['Prosimy przelać resztę.', 'PRZELEJ do piątku.', 'Zapłać szybko.', 'Prosimy zapłacić.', 'Wpłać 10 zł.',
      'Prosimy o dopłatę.', 'Kwota do zapłaty: 0 zł.', 'Termin minął.', 'Numer rachunku w stopce.', 'Prosimy uregulować.', 'Zaplac.']) {
      expect(regulaTresci('oplacone', zle), zle).toMatch(/nie może prosić o zapłatę/);
    }
    for (const ok of ['Zamówienie jest opłacone — dziękujemy.', 'Zapłacone, dziękujemy za przelew.', 'Wpłata dotarła.', 'Dziękujemy za wpłatę.']) {
      expect(regulaTresci('oplacone', ok), ok).toBeNull();
    }
  });

  it('sprawdzZdanie: znaki sterujące odrzucone tym samym wyrażeniem co podpis maili; Enter = odstęp; domyślne = puste', () => {
    expect(sprawdzZdanie('pozostale', 'a\tb').blad).toMatch(/znaków sterujących/);
    expect(sprawdzZdanie('pozostale', 'a\u0007b').blad).toMatch(/znaków sterujących/);
    expect(sprawdzZdanie('pozostale', 'a⁦b').blad).toMatch(/znaków sterujących/);
    expect(sprawdzZdanie('pozostale', 'raz\ndwa')).toEqual({ wartosc: 'raz dwa', blad: null });
    expect(sprawdzZdanie('pozostale', `  ${DOMYSLNE_ZDANIA.pozostale}  `)).toEqual({ wartosc: '', blad: null });
    expect(sprawdzZdanie('nieznane', 'x').blad).toBe('Nieznane zdanie.');
  });
});

// Recenzja PRZ-102.17: pierwszy filtr przepuszczał zwykłe prośby o zapłatę rzeczownikiem („Prosimy o zapłatę").
describe('reguły treści po recenzji — prośba o zapłatę i drugi kanał przy pobraniu', () => {
  const ODMOWA_OPLACONE = [
    'Prosimy o zapłatę 476 zł.',
    'Prosimy o zapłatę.',
    'Prosimy o przelew na konto 00 1111 2222.',
    'Prosimy o przelanie należności.',
    'Prosimy o uregulowanie należności w ciągu 7 dni.',
    'Czekamy na wpłatę.',
    'Prosimy o płatność.',
    'PROSIMY O ZAPLATE.',
    'Oczekujemy na dopłatę.',
    'Należność: 476 zł.',
    'Wpłata na konto firmy.',
    'Prosimy pamiętać o płatności.',
    'Nie zapomnij zapłacić.',
    'Dziękujemy za zamówienie, prosimy o wpłatę.',
  ];
  const DOZWOLONE_OPLACONE = [
    'Zamówienie jest opłacone — dziękujemy.',
    'Dziękujemy za wpłatę.',
    'Wpłata dotarła.',
    'Wpłata dotarła — dziękujemy.',
    'Płatność zaksięgowana.',
    'Platnosc zaksiegowana, dziekujemy.',
    'Zapłacone, dziękujemy za przelew.',
    'Otrzymaliśmy płatność — dziękujemy.',
    'Nie trzeba nic dopłacać — dziękujemy.',
    'Nie musisz już nic przelewać.',
    'Dziękujemy, bierzemy się do pracy.',
  ];
  it.each(ODMOWA_OPLACONE)('opłacone — odmowa: %s', (t) => {
    expect(regulaTresci('oplacone', t)).toMatch(/nie może prosić o zapłatę/);
  });
  it.each(DOZWOLONE_OPLACONE)('opłacone — przechodzi: %s', (t) => {
    expect(regulaTresci('oplacone', t)).toBeNull();
  });

  const ODMOWA_POBRANIE = [
    'Należność pobierze kurier, ale prosimy też o przelew.',
    'Nie płać kurierowi, zapłać przelewem.',
    'Kurier albo wpłata na konto 00 1111 2222 3333.',
    'Zapłacisz kurierowi albo wpłacisz na rachunek.',
  ];
  const DOZWOLONE_POBRANIE = [
    DOMYSLNE_ZDANIA.pobranie,
    'Zapłać kurierowi przy odbiorze.',
    'Należność pobierze kurier — nie musisz nic przelewać.',
    'Kurier pobierze 476 zł przy doręczeniu, nie ma potrzeby przelewania.',
    'Płatność przy doręczeniu paczki.',
  ];
  it.each(ODMOWA_POBRANIE)('pobranie — odmowa: %s', (t) => {
    expect(regulaTresci('pobranie', t)).toMatch(/nie może odsyłać do przelewu ani konta/);
  });
  it.each(DOZWOLONE_POBRANIE)('pobranie — przechodzi: %s', (t) => {
    expect(regulaTresci('pobranie', t)).toBeNull();
  });

  it('teksty domyślne przechodzą własne reguły', () => {
    for (const [klucz, tekst] of Object.entries(DOMYSLNE_ZDANIA)) expect(regulaTresci(klucz, tekst), klucz).toBeNull();
  });
});
