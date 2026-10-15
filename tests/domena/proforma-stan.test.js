import { describe, it, expect } from 'vitest';
import {
  formatNumeru, aktualnaProforma, czyWolnoWystawic, rozjazdKwotyProformy,
} from '../../src/domena/proforma-stan.js';

// ⚠️ SERIA `PF/`, NIE `PRO/`. Apilo wystawia dzis proformy w serii `PRO/` i ma chodzic
// rownolegle jako siatka bezpieczenstwa — przejecie tej samej serii znaczyloby, ze przy
// jednej pomylce dwoch roznych klientow trzyma w reku dokument o TYM SAMYM numerze
// i przelewa pieniadze z tym samym tytulem. Osobna seria czyni te kolizje niemozliwa.
describe('formatNumeru', () => {
  it('daje numer w postaci PF/{n}/{mm}/{rrrr}', () => {
    expect(formatNumeru({ kolejny: 1, miesiac: 8, rok: 2026 })).toBe('PF/1/08/2026');
  });

  // Miesiac DWUCYFROWO, licznik BEZ wiodacych zer — dokladnie tak, jak we wzorze z Apilo
  // (PRO_1_08_2026). To nie jest kosmetyka: numer trafia do tytulu przelewu klienta,
  // wiec „PF/01/8/2026" byloby innym dokumentem niz ten, ktory panel ma w bazie.
  it('miesiąc jest dwucyfrowy, a licznik bez wiodących zer', () => {
    expect(formatNumeru({ kolejny: 7, miesiac: 1, rok: 2027 })).toBe('PF/7/01/2027');
    expect(formatNumeru({ kolejny: 12, miesiac: 12, rok: 2026 })).toBe('PF/12/12/2026');
  });

  it('licznik trzycyfrowy nie jest ucinany ani dopełniany', () => {
    expect(formatNumeru({ kolejny: 143, miesiac: 10, rok: 2026 })).toBe('PF/143/10/2026');
  });

  // Straznik na przypadkowe przejecie serii Apilo przy pozniejszej edycji.
  it('nie używa serii PRO/, którą wystawia Apilo', () => {
    const numer = formatNumeru({ kolejny: 1, miesiac: 8, rok: 2026 });
    expect(numer.startsWith('PF/')).toBe(true);
    expect(numer).not.toMatch(/^PRO\//);
  });
});

// Aktualna jest DOKLADNIE JEDNA proforma — ta nieuniewazniona. Dwie wazne naraz to klient
// placacy wedlug starej kwoty, dlatego historia zostaje, ale „ta obowiazujaca" musi byc
// jednoznaczna dla karty, dla PDF-a i dla komunikatu operatora.
describe('aktualnaProforma', () => {
  const p = (id, uniewazniona_at = null, utworzona_at = '2026-08-04T10:00:00.000Z') =>
    ({ id, uniewazniona_at, utworzona_at });

  it('pusta lista nie ma aktualnej proformy', () => {
    expect(aktualnaProforma([])).toBeNull();
  });

  it('brak listy czyta się tak samo jak pusta lista', () => {
    expect(aktualnaProforma(undefined)).toBeNull();
    expect(aktualnaProforma(null)).toBeNull();
  });

  it('pomija unieważnione', () => {
    const lista = [p(1, '2026-08-05T09:00:00.000Z'), p(2)];
    expect(aktualnaProforma(lista).id).toBe(2);
  });

  // Wszystkie uniewaznione to normalny, przejsciowy stan (np. proforma wystawiona omylkowo
  // i uniewazniona recznie) — ma dac `null`, a nie ostatni uniewazniony dokument.
  it('same unieważnione dają null', () => {
    const lista = [p(1, '2026-08-05T09:00:00.000Z'), p(2, '2026-08-05T09:01:00.000Z')];
    expect(aktualnaProforma(lista)).toBeNull();
  });

  // Gdyby (przez awarie miedzy zapisem a uniewaznieniem) zostaly dwie wazne, karta ma
  // pokazac NOWSZA — to ona ma kwote, ktora klient dostal ostatnia.
  it('przy dwóch ważnych bierze najnowszą', () => {
    const lista = [
      p(1, null, '2026-08-04T10:00:00.000Z'),
      p(2, null, '2026-08-06T11:00:00.000Z'),
    ];
    expect(aktualnaProforma(lista).id).toBe(2);
  });

  // Kolejnosc na wejsciu nie ma prawa zmieniac odpowiedzi: lista bywa sortowana inaczej
  // w widoku niz w serwisie.
  it('nie zależy od kolejności elementów na liście', () => {
    const starsza = p(1, null, '2026-08-04T10:00:00.000Z');
    const nowsza = p(2, null, '2026-08-06T11:00:00.000Z');
    expect(aktualnaProforma([nowsza, starsza]).id).toBe(2);
  });

  // Dwie proformy z tej samej sekundy (dwuklik) rozstrzyga `id` — inaczej odpowiedz
  // zalezalaby od kolejnosci wierszy z bazy i karta potrafilaby pokazac raz jedna, raz druga.
  it('przy równych datach rozstrzyga wyższe id', () => {
    const lista = [p(5), p(6)];
    expect(aktualnaProforma(lista).id).toBe(6);
  });
});

// ⚠️ JEDNA WAZNA PROFORMA NA INNA KWOTE NIZ ZAMOWIENIE daje ten sam skutek, przed ktorym
// broni automatyczne uniewaznianie poprzednich: klient placi wedlug dokumentu, ktory ma
// przed soba. Migawka kwoty jest przy tym SLUSZNA i nie wolno jej ruszac — brakowalo
// wylacznie SYGNALU, ze obowiazujacy dokument opiewa juz na co innego.
describe('rozjazdKwotyProformy', () => {
  // 164,55 zl w pozycjach, potem doplata 10,00 — scenariusz z recenzji.
  const zamowienie = (nad = {}) => ({
    sklep: 'pro',
    kwota_brutto: '164.55',
    koszt_dostawy_brutto: '0.00',
    pozycje: [{ nazwa: 'Szablon', ilosc: 1, cena_brutto: '164.55', brutto_linii: '164.55', zrodlo: 'sklep' }],
    ...nad,
  });
  const p = (nad = {}) => ({ id: 1, numer: 'PF/1/08/2026', kwota_brutto: '164.55', uniewazniona_at: null, ...nad });

  it('zgodna kwota — brak ostrzeżenia', () => {
    expect(rozjazdKwotyProformy(zamowienie(), p())).toBeNull();
  });

  it('dopisana pozycja podnosi kwotę zamówienia — ostrzeżenie z obiema kwotami', () => {
    const z = zamowienie({
      pozycje: [
        { nazwa: 'Szablon', ilosc: 1, cena_brutto: '164.55', brutto_linii: '164.55', zrodlo: 'sklep' },
        { nazwa: 'Dopłata', ilosc: 1, cena_brutto: '10.00', brutto_linii: '10.00', zrodlo: 'reczna' },
      ],
    });
    expect(rozjazdKwotyProformy(z, p())).toEqual({
      numer: 'PF/1/08/2026', proformaZl: '164.55', zamowienieZl: '174.55',
    });
  });

  // Uniewazniony dokument nie obowiazuje, wiec nikt wedlug niego nie zaplaci — ostrzeżenie
  // przy kazdej starej proformie zamienilo by pasek w tlo.
  it('unieważniona proforma nie jest powodem do ostrzeżenia', () => {
    const z = zamowienie({ kwota_brutto: '999.00' });
    expect(rozjazdKwotyProformy(z, p({ uniewazniona_at: '2026-08-05T10:00:00.000Z' }))).toBeNull();
  });

  it('brak proformy albo brak zamówienia — null, nie wyjątek', () => {
    expect(rozjazdKwotyProformy(zamowienie(), null)).toBeNull();
    expect(rozjazdKwotyProformy(null, p())).toBeNull();
  });

  // ⚠️ Funkcja liczy sie przy KAZDYM otwarciu karty, wiec uszkodzona kwota nie ma prawa
  // wywalic ekranu. „Nie wiem, ile to jest" ma na karcie swoje osobne miejsce (ostrzeżenie
  // pod tabela pozycji), a tu daje po prostu brak sygnalu.
  it('nieczytelna kwota nie wywraca karty', () => {
    expect(() => rozjazdKwotyProformy(zamowienie({ kwota_brutto: null }), p())).not.toThrow();
    expect(rozjazdKwotyProformy(zamowienie({ kwota_brutto: null }), p())).toBeNull();
    expect(rozjazdKwotyProformy(zamowienie(), p({ kwota_brutto: 'undefined' }))).toBeNull();
  });
});

describe('czyWolnoWystawić', () => {
  const zamowienie = (n = {}) => ({ anulowane: 0, pozycje: [{ nazwa: 'Szablon', ilosc: 1 }], ...n });

  it('zwykłe zamówienie z pozycjami — wolno', () => {
    expect(czyWolnoWystawic(zamowienie())).toEqual({ wolno: true, powod: null });
  });

  it('zamówienie anulowane w sklepie — nie wolno, z powodem', () => {
    const wynik = czyWolnoWystawic(zamowienie({ anulowane: 1 }));
    expect(wynik.wolno).toBe(false);
    expect(wynik.powod).toMatch(/anulowan/i);
  });

  // Anulowanie ma DWA zrodla (sklep i reka operatora) i oba musza blokowac tak samo —
  // patrz anulowaneEfektywnie w domain/status-reczny.js. Proforma do anulowanego zamowienia
  // to prosba o przelew za cos, czego nikt nie zrealizuje.
  it('zamówienie anulowane ręcznie — też nie wolno', () => {
    expect(czyWolnoWystawic(zamowienie({ anulowane: 0, anulowane_recznie: 1 })).wolno).toBe(false);
  });

  // Proforma bez pozycji to dokument na 0,00 zl — klient nie ma czego zaplacic, a numer
  // z serii zostalby zuzyty bezpowrotnie.
  it('zamówienie bez pozycji — nie wolno', () => {
    const wynik = czyWolnoWystawic(zamowienie({ pozycje: [] }));
    expect(wynik.wolno).toBe(false);
    expect(wynik.powod).toMatch(/pozycj/i);
  });

  it('brak listy pozycji czyta się tak samo jak pusta', () => {
    expect(czyWolnoWystawic(zamowienie({ pozycje: undefined })).wolno).toBe(false);
  });

  // ⚠️ WARUNEK PATRZY NA KWOTE, NIE NA DLUGOSC TABLICY. Komunikat od poczatku mowil
  // o kwocie („proforma wyszlaby na 0,00 zl, a numer z serii zostalby zuzyty bezpowrotnie"),
  // ale sprawdzana byla wylacznie PUSTA lista — wiec zamowienie z jedna pozycja za 0,00 zl
  // (gratis, wymiana reklamacyjna, kupon na 100%) przechodzilo: numer spalony, a do klienta
  // szla prosba o przelew zera zlotych.
  const gratis = (nad = {}) => zamowienie({
    pozycje: [{ nazwa: 'Gratis (wymiana reklamacyjna)', ilosc: 1, cena_brutto: '0.00', brutto_linii: '0.00' }],
    ...nad,
  });

  it('jedna pozycja za 0,00 zł — nie wolno, choć lista pozycji nie jest pusta', () => {
    const wynik = czyWolnoWystawic(gratis());
    expect(wynik.wolno).toBe(false);
    expect(wynik.powod).toMatch(/0[.,]00/);
    expect(wynik.powod).toMatch(/numer/i);
  });

  it('kilka pozycji sumujących się do zera też nie przechodzi', () => {
    const wynik = czyWolnoWystawic(zamowienie({
      pozycje: [
        { nazwa: 'Szablon', ilosc: 1, cena_brutto: '61.50', brutto_linii: '61.50' },
        { nazwa: 'Rabat 100%', ilosc: 1, cena_brutto: '-61.50', brutto_linii: '-61.50' },
      ],
    }));
    expect(wynik.wolno).toBe(false);
  });

  // Kwota UJEMNA to nie proforma, tylko korekta — dokument prosilby klienta o przelew
  // minusowej kwoty.
  it('suma ujemna też nie przechodzi', () => {
    expect(czyWolnoWystawic(zamowienie({
      pozycje: [{ nazwa: 'Zwrot', ilosc: 1, cena_brutto: '-10.00', brutto_linii: '-10.00' }],
    })).wolno).toBe(false);
  });

  // Pozycja za zero, ale z platna dostawa, to normalny dokument: klient MA co przelac.
  // Blokada ma dotyczyc kwoty dokumentu, a nie ceny pojedynczej linii.
  it('pozycja za 0,00 zł z płatną dostawą — wolno, bo dokument nie jest na zero', () => {
    expect(czyWolnoWystawic(gratis({ koszt_dostawy_brutto: '20.00' })).wolno).toBe(true);
  });

  // ⚠️ NIECZYTELNA KWOTA TO NIE JEST ZERO, tylko „nie wiem" — i nie ma prawa wywalic tej
  // funkcji, bo wola ja KARTA przy kazdym otwarciu (routes/zamowienia.js). Odmowa nalezy
  // wtedy do bariery arytmetycznej, ktora umie wskazac zepsuta pozycje.
  it('pozycja bez ceny nie wywraca funkcji ani nie udaje zera', () => {
    const wynik = czyWolnoWystawic(zamowienie({ pozycje: [{ nazwa: 'Bez ceny', ilosc: 1 }] }));
    expect(wynik.wolno).toBe(true);
  });

  // ⚠️ `chce_fakture` NIE JEST tu warunkiem i to jest decyzja, nie przeoczenie: o proforme
  // klient prosi telefonicznie albo mailem, a sklep o tej prosbie nie wie — znacznik chęci
  // faktury VAT nie ma z nia nic wspolnego.
  it('brak chęci faktury NIE blokuje proformy', () => {
    expect(czyWolnoWystawic(zamowienie({ chce_fakture: 0, nip: null })).wolno).toBe(true);
  });

  // ⚠️ Brak wplaty tez NIE blokuje — proforma istnieje DOKLADNIE po to, zeby klient mial
  // na podstawie czego zaplacic. Odmowa „bo nieoplacone" wywracalaby caly sens dokumentu.
  it('brak wpłaty NIE blokuje proformy', () => {
    const wynik = czyWolnoWystawic(zamowienie({ oplacone_at: null, platnosci: [] }));
    expect(wynik).toEqual({ wolno: true, powod: null });
  });

  // Wystawienie kolejnej proformy jest dozwolone (poprzednia zostanie uniewazniona) —
  // to jest cala roznica wobec faktury VAT, ktora ma UNIQUE (zamowienie_id).
  it('istniejąca proforma NIE blokuje wystawienia kolejnej', () => {
    expect(czyWolnoWystawic(zamowienie({ proformy: [{ id: 1, numer: 'PF/1/08/2026' }] })).wolno).toBe(true);
  });

  it('brak zamówienia — nie wolno, z powodem', () => {
    const wynik = czyWolnoWystawic(null);
    expect(wynik.wolno).toBe(false);
    expect(typeof wynik.powod).toBe('string');
  });
});
