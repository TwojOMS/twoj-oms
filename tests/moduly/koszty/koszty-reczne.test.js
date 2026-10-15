import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  zapiszKoszt, kosztyMiesiaca, kosztPoNumerze, kosztyBezArchiwum, zapiszSciezki,
  zapiszRecznyKoszt, zaktualizujRecznyKoszt, usunRecznyKoszt, przypnijKategorieDoDokumentu,
} from '../../../src/oms/db/koszty.js';
import { naWierszReczny, czyKluczReczny } from '../../../src/domena/koszt-reczny.js';
import { kategoriaDlaNip } from '../../../src/oms/db/kategorie-kosztow.js';
import { zlozWidok } from '../../../src/domena/lista-kosztow.js';
import { createCzuwaczKosztow } from '../../../src/moduly/koszty/services/czuwacz-kosztow.js';

// Dokument Z KSeF — ten sam kształt, co oddaje `naWiersz` (kwoty jako napisy).
const zKsef = (n = {}) => ({
  ksefNumber: 'K-1', numerDokumentu: 'FV/1', sprzedawcaNip: '5252674798',
  sprzedawcaNazwa: 'Allegro', dataWystawienia: '2026-08-05',
  dataTrwalegoZapisu: '2026-08-05T14:00:00Z', netto: '100.00', vat: '23.00', brutto: '123.00',
  waluta: 'PLN', rodzaj: 'Vat', maZalacznik: 0, ...n,
});

// Dokument WPISANY RĘKĄ — Facebook, Google, Anthropic, paragon. W KSeF go nie ma i nie będzie.
//
// ⚠️ TRZY POLA (13.08.2026): firma, data, kwota. Definicja firmy przychodzi ze słownika
// (db/firmy-reczne.js) i to ona niesie nazwę sprzedawcy, kategorię i typ.
const GOOGLE = {
  nazwa: 'Google', sprzedawca: 'Google Ireland Limited', kategoria: 'Reklama', typ: 'zmienny',
};
const reczny = (n = {}, firma = GOOGLE) => naWierszReczny(
  { dataWystawienia: '2026-08-06', kwota: '200.00', ...n },
  firma,
);

describe('reczna faktura kosztowa — zapis, edycja, usuniecie', () => {
  it('zapisany wiersz leży w TEJ SAMEJ tabeli i wchodzi do miesiąca', () => {
    const db = openOmsDb();
    zapiszKoszt(db, zKsef());
    const klucz = zapiszRecznyKoszt(db, reczny());
    expect(czyKluczReczny(klucz)).toBe(true);
    const wiersze = kosztyMiesiaca(db, '2026-08');
    expect(wiersze).toHaveLength(2);
    // ⚠️ JEDNA PRAWDA O KOSZTACH: suma miesiąca liczy się z obu źródeł naraz.
    // ⚠️ Wiersz ręczny wnosi 200,00 do netto I do brutto, a do VAT-u zero — import usług
    // rozliczany odwrotnym obciążeniem (domain/koszt-reczny.js).
    const widok = zlozWidok({ wiersze, kategoria: (nip) => (nip ? { kategoria: 'X', typ: 'staly' } : null) });
    expect(widok.suma).toEqual({ netto: '300.00', vat: '23.00', brutto: '323.00' });
  });

  // ⚠️⚠️ WIERSZ RĘCZNY JEST ZAWSZE W PLN — i to jest poprawka usterki, nie kosmetyka.
  // Formularz miał pole waluty, więc faktura Anthropica w USD lądowała w pasie „obca waluta",
  // czyli POZA sumą miesiąca: koszt, dla którego cała ta funkcja powstała, nie wchodził
  // do liczby, którą miał zasilić. Teraz operator wpisuje kwotę z rozliczenia banku.
  it('⚠️ wiersz ręczny wchodzi do sumy, bo jest w PLN — nie w pas „obca waluta"', () => {
    const db = openOmsDb();
    zapiszRecznyKoszt(db, reczny());
    const widok = zlozWidok({ wiersze: kosztyMiesiaca(db, '2026-08'), kategoria: () => null });
    expect(widok.obcaWaluta).toEqual([]);
    expect(widok.suma.netto).toBe('200.00');
  });

  // ⚠️ ŹRÓDŁO JEST JEDYNĄ RÓŻNICĄ, KTÓREJ NIE WIDAĆ PO TREŚCI DOKUMENTU — musi więc stać
  // w kolumnie, a nie „wynikać" z kształtu numeru.
  it('wiersz ręczny ma zrodlo „reczne", a dokument z KSeF — „ksef"', () => {
    const db = openOmsDb();
    zapiszKoszt(db, zKsef());
    const klucz = zapiszRecznyKoszt(db, reczny());
    expect(kosztPoNumerze(db, 'K-1').zrodlo).toBe('ksef');
    expect(kosztPoNumerze(db, klucz).zrodlo).toBe('reczne');
  });

  // Wpisane ręką znaczy pomyłkę w kwocie prędzej czy później.
  it('edycja poprawia kwoty i NIE zmienia klucza', () => {
    const db = openOmsDb();
    const klucz = zapiszRecznyKoszt(db, reczny());
    zaktualizujRecznyKoszt(db, klucz, reczny({ kwota: '100.00' }));
    const w = kosztPoNumerze(db, klucz);
    expect(w.netto).toBe('100.00');
    expect(w.brutto).toBe('100.00');
    expect(db.prepare('SELECT COUNT(*) c FROM koszty').get().c).toBe(1);
  });

  it('usunięcie kasuje wiersz ręczny', () => {
    const db = openOmsDb();
    const klucz = zapiszRecznyKoszt(db, reczny());
    expect(usunRecznyKoszt(db, klucz)).toBe(1);
    expect(kosztPoNumerze(db, klucz)).toBeUndefined();
  });

  // ⚠️⚠️ DOKUMENTU Z KSeF NIE WOLNO SKASOWAĆ ANI NADPISAĆ Z PANELU. Panel jest LUSTREM KSeF-u:
  // skasowany wiersz wróciłby dopiero po ręcznym cofnięciu kursora o miesiące (okno przyrostowe
  // już obok niego przejechało), a do tego czasu suma miesiąca byłaby zaniżona bez śladu.
  it('⚠️ usunięcie dokumentu z KSeF jest ODMAWIANE, a wiersz zostaje na miejscu', () => {
    const db = openOmsDb();
    zapiszKoszt(db, zKsef());
    expect(() => usunRecznyKoszt(db, 'K-1')).toThrow(/KSeF/);
    expect(kosztPoNumerze(db, 'K-1')).toBeTruthy();
  });

  it('⚠️ edycja dokumentu z KSeF jest ODMAWIANA — treść dokumentu jest po stronie sprzedawcy', () => {
    const db = openOmsDb();
    zapiszKoszt(db, zKsef());
    expect(() => zaktualizujRecznyKoszt(db, 'K-1', reczny())).toThrow(/KSeF/);
    expect(kosztPoNumerze(db, 'K-1').netto).toBe('100.00');
  });

  it('edycja i usunięcie nieznanego klucza odmawiają zdaniem, a nie po cichu', () => {
    const db = openOmsDb();
    expect(() => zaktualizujRecznyKoszt(db, 'RECZNY-nie-ma', reczny())).toThrow();
    expect(() => usunRecznyKoszt(db, 'RECZNY-nie-ma')).toThrow();
  });
});

// ⚠️⚠️ NAJWAŻNIEJSZY NIEZMIENNIK TEJ ZMIANY: CZUWACZ KSeF NIE MA PRAWA TKNĄĆ WIERSZA RĘCZNEGO.
//
// Wiersze ręczne leżą w tej samej tabeli, co lustro KSeF-u — i to jest decyzja (jedna prawda
// o kosztach). Ceną jest ten niezmiennik: nocny przebieg, który potraktowałby wiersz ręczny
// jak swój, mógłby go nadpisać, policzyć jako „nowy" albo wciągnąć do kolejki archiwum
// i co noc pobierać z KSeF XML dokumentu, którego tam nie ma.
describe('⚠️ czuwacz KSeF nie tyka wierszy recznych', () => {
  const wNocy = () => new Date('2026-08-13T01:30:00Z');
  const sesja = { accessToken: async () => 'ACC' };
  const pustyKlient = { pobierzMetadane: async () => ({ faktury: [], hasMore: false, isTruncated: false }) };

  it('⚠️ kolejka archiwum XML pomija wiersze ręczne — nie ma czego pobierać z KSeF', () => {
    const db = openOmsDb();
    zapiszKoszt(db, zKsef());
    const klucz = zapiszRecznyKoszt(db, reczny());
    const kolejka = kosztyBezArchiwum(db).map((w) => w.ksef_number);
    expect(kolejka).toEqual(['K-1']);
    expect(kolejka).not.toContain(klucz);
  });

  it('⚠️ nocny przebieg NIE pyta KSeF o dokument wpisany ręcznie', async () => {
    const db = openOmsDb();
    const klucz = zapiszRecznyKoszt(db, reczny());
    const pytania = [];
    const czuwacz = createCzuwaczKosztow({
      db,
      klient: { ...pustyKlient, pobierzXml: async ({ ksefNumber }) => { pytania.push(ksefNumber); return '<x/>'; } },
      sesja,
      teraz: wNocy,
      katalogArchiwum: 'C:/nie-istnieje-i-nie-ma-byc-uzyte',
    });

    const wynik = await czuwacz.przebieg();

    expect(pytania).toEqual([]);
    expect(wynik.nowych).toBe(0);
    expect(wynik.zarchiwizowanych).toBe(0);
    // ...a sam wiersz stoi nietknięty.
    expect(kosztPoNumerze(db, klucz).netto).toBe('200.00');
  });

  it('⚠️ wiersz ręczny nie liczy się jako „nowy" i nie ląduje w kwarantannie', async () => {
    const db = openOmsDb();
    zapiszRecznyKoszt(db, reczny());
    const czuwacz = createCzuwaczKosztow({ db, klient: pustyKlient, sesja, teraz: wNocy });
    const wynik = await czuwacz.przebieg();
    expect(wynik).toMatchObject({ nowych: 0, przeczytanych: 0, odrzuconych: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM koszty_odrzucone').get().c).toBe(0);
  });

  it('⚠️ zapis ścieżki archiwum nie ma jak trafić w wiersz ręczny', () => {
    const db = openOmsDb();
    const klucz = zapiszRecznyKoszt(db, reczny());
    zapiszSciezki(db, klucz, { xml: 'Kosztowe 2026/Sierpien/cokolwiek.xml' });
    expect(kosztPoNumerze(db, klucz).sciezka_xml).toBeNull();
  });

  // Klucz syntetyczny nie ma jak zderzyć się z numerem KSeF, ale to jest cecha KLUCZA,
  // a nie zbieg okoliczności — i dlatego ma test.
  it('⚠️ pobranie dokumentu o tym samym numerze faktury nie nadpisuje wiersza ręcznego', () => {
    const db = openOmsDb();
    const klucz = zapiszRecznyKoszt(db, reczny());
    const numer = kosztPoNumerze(db, klucz).numer_dokumentu;
    expect(zapiszKoszt(db, zKsef({ numerDokumentu: numer }))).toBe(true);
    expect(kosztPoNumerze(db, klucz).sprzedawca_nazwa).toBe('Google Ireland Limited');
    expect(kosztPoNumerze(db, klucz).zrodlo).toBe('reczne');
  });
});

// ⚠️⚠️ DOKUMENT BEZ POLSKIEGO NIP-U NIE MA JAK TRAFIĆ DO MAPY KATEGORII — mapa jest kluczowana
// NIP-em. Kategoria musi więc dać się przypiąć WPROST DO DOKUMENTU, a rozstrzygnięcie „która
// wygrywa" siedzi w JEDNYM miejscu (domain/lista-kosztow.js), a nie w dwóch obok siebie.
describe('kategoria przypieta wprost do dokumentu', () => {
  // ⚠️ KATEGORIA PRZYCHODZI ZE SŁOWNIKA FIRM, a nie z formularza (13.08.2026) — operator jej
  // nie wpisuje, bo za pozycją listy „Firma" stoi już kategoria i typ.
  it('dokument bez NIP-u dostaje kategorię i wchodzi do rozbicia', () => {
    const db = openOmsDb();
    const klucz = zapiszRecznyKoszt(db, reczny());
    const widok = zlozWidok({
      wiersze: kosztyMiesiaca(db, '2026-08'),
      kategoria: (nip) => kategoriaDlaNip(db, nip),
    });
    expect(widok.nieprzypisane.ile).toBe(0);
    expect(widok.kategorie).toEqual([
      { kategoria: 'Reklama', typ: 'zmienny', netto: '200.00', udzial: 100 },
    ]);
    expect(kosztPoNumerze(db, klucz).kategoria_dokumentu).toBe('Reklama');
  });

  // Kategoria ze słownika firm jest wartością POCZĄTKOWĄ, a nie kajdanami: operator dalej
  // przepina pojedynczy dokument formularzem w wierszu tabeli (np. gdy jedna faktura Google
  // dotyczy czego innego niż wszystkie poprzednie).
  it('przypięcie działa też po fakcie, na wierszu już leżącym w bazie', () => {
    const db = openOmsDb();
    const klucz = zapiszRecznyKoszt(db, reczny());
    przypnijKategorieDoDokumentu(db, klucz, 'Sprzęt', 'staly');
    const [w] = kosztyMiesiaca(db, '2026-08');
    expect(w.kategoria_dokumentu).toBe('Sprzęt');
    expect(w.typ_dokumentu).toBe('staly');
  });

  // ⚠️ KATEGORIA DOKUMENTU JEST BARDZIEJ SZCZEGÓŁOWA NIŻ MAPA PO NIP-IE i dlatego wygrywa:
  // ktoś przypiął ją do TEGO dokumentu ręką, a mapa opisuje całego sprzedawcę.
  it('⚠️ kategoria dokumentu wygrywa z kategorią po NIP-ie', () => {
    const db = openOmsDb();
    zapiszKoszt(db, zKsef());
    const widok = zlozWidok({
      wiersze: [{ ...kosztPoNumerze(db, 'K-1'), kategoria_dokumentu: 'Reklama', typ_dokumentu: 'zmienny' }],
      kategoria: () => ({ kategoria: 'Prowizje sprzedażowe', typ: 'zmienny' }),
    });
    expect(widok.kategorie.map((k) => k.kategoria)).toEqual(['Reklama']);
  });

  it('bez kategorii na dokumencie dalej rządzi mapa po NIP-ie', () => {
    const widok = zlozWidok({
      wiersze: [{
        ksef_number: 'K-1', numer_dokumentu: 'FV/1', sprzedawca_nip: '5252674798',
        data_wystawienia: '2026-08-05', netto: '100.00', vat: '23.00', brutto: '123.00',
        waluta: 'PLN', rodzaj: 'Vat', kategoria_dokumentu: null, typ_dokumentu: null,
      }],
      kategoria: () => ({ kategoria: 'Prowizje sprzedażowe', typ: 'zmienny' }),
    });
    expect(widok.kategorie.map((k) => k.kategoria)).toEqual(['Prowizje sprzedażowe']);
  });
});
