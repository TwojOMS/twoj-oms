import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../pomoc/dane-miesieczne-parytetu.js';
import { ustawGranice, zapiszHistorie } from '../../../src/oms/db/historia-sprzedazy.js';
import { KANALY } from '../../pomoc/raporty-historyczne-fixture.js';
import { zapiszDaneMiesiaca } from '../../pomoc/dane-miesieczne-parytetu.js';
import {
  zapiszKoszt, zapiszRecznyKoszt, przypnijKategorieDoDokumentu,
} from '../../../src/oms/db/koszty.js';
import { rachunekOkresu } from '../../pomoc/raporty-parytetu.js';

let db;
beforeEach(() => {
  db = openOmsDb(':memory:');
  // ⚠️ Z KANALY, nie recznie: lista urosla z 9 do 12 po pomiarze i kanal bez granicy
  // PRZERYWA raport, wiec recznie wyliczona lista rozjechalaby sie przy nastepnej zmianie.
  for (const k of KANALY) {
    ustawGranice(db, k, '2026-07-02', 'test', null);
  }
});

const sprzedaz = (dzien, brutto) => zapiszHistorie(db, {
  apiloId: `S${dzien}${brutto}`, platformAccountId: 9, dzien,
  utworzoneAt: `${dzien}T10:00:00.000Z`, brutto, tagi: [], status: 15,
  paymentStatus: 2, klientEmail: 'k@klient.pl', pozycje: [],
});

// ⚠️ `dataTrwalegoZapisu`, `waluta`, `rodzaj` i `numerDokumentu` sa NOT NULL, a `zapiszKoszt`
// idzie przez `INSERT OR IGNORE` — fikstura bez ktoregokolwiek z nich NIE ZAPISZE SIE I NIE
// RZUCI, tylko odbije sie od bazy jak dokument „juz znany". Test swiecilby wtedy na zielono
// przy zerowych kosztach. Fikstura wymaga wlasnego straznika (patrz nizej).
const koszt = (numer, dzien, netto, nip = '5252674798') => zapiszKoszt(db, {
  ksefNumber: numer, numerDokumentu: numer, sprzedawcaNip: nip, sprzedawcaNazwa: 'X',
  dataWystawienia: dzien, dataTrwalegoZapisu: `${dzien}T12:00:00Z`,
  netto, vat: '0.00', brutto: netto, waluta: 'PLN', rodzaj: 'VAT', maZalacznik: 0,
});

describe('rachunek zarzadczy', () => {
  it('STRAZNIK FIKSTURY: koszt naprawde zapisal sie do bazy', () => {
    // ⚠️ Bez tego testu cala reszta moglaby swiecic na zielono przy kosztach = 0, bo
    // `zapiszKoszt` odbija niekompletny dokument CICHO. Przy szostej fali karty trzy mutacje
    // „przezyly" wylacznie dlatego, ze fikstura nie miala czego oznaczyc.
    koszt('K0', '2026-06-05', '1000.00');
    expect(db.prepare('SELECT COUNT(*) c FROM koszty').get().c).toBe(1);
  });

  it('przychod minus koszty daje wynik, a po ZUS i PIT — „zostaje"', () => {
    sprzedaz('2026-06-10', '12300.00');           // netto 10 000
    koszt('K1', '2026-06-05', '2000.00');
    zapiszDaneMiesiaca(db, '2026-06', { zusRazem: '2821.06', pit5: '779.00' });
    const r = rachunekOkresu(db, { od: '2026-06-01', do: '2026-06-30' });
    expect(r.przychodNettoGrosze).toBe(1_000_000);
    expect(r.kosztyNettoGrosze).toBe(200_000);
    expect(r.wynikGrosze).toBe(800_000);
    expect(r.zostajeGrosze).toBe(800_000 - 282_106 - 77_900);
  });

  it('VAT STOI OSOBNO — to pieniadz przechodni, nie zysk', () => {
    zapiszDaneMiesiaca(db, '2026-06', { zusRazem: '100.00', vat7: '1617.00' });
    const r = rachunekOkresu(db, { od: '2026-06-01', do: '2026-06-30' });
    expect(r.vatGrosze).toBe(161_700);
    expect(r.zostajeGrosze).toBe(-10_000); // VAT nie wszedl do rachunku
  });

  it('BRAK WIERSZA ZUS daje ostrzezenie i pusta sekcje, NIGDY zera', () => {
    // ⚠️ MIESIAC MUSI BYC SPOZA `wgrajDaneStartowe` (db/dane-miesieczne.js) — ta migracja
    // wgrywa 2026-01…2026-06 z zus.csv przy KAZDYM otwarciu bazy, takze ':memory:'. Test
    // pisany na czerwcu nie sprawdzalby wiec niczego: wiersz tam JEST i zawsze bedzie, wiec
    // sciezka „brak danych" nigdy by sie nie wykonala. Lipiec jest pierwszym niewgranym.
    // Sprzedaz stoi 1 lipca, bo granica historii testu to 2026-07-02 — dzieki temu przychod
    // jest niezerowy i widac, ze `null` bierze sie z BRAKU ZUS-u, a nie z pustego okresu.
    sprzedaz('2026-07-01', '12300.00');
    const r = rachunekOkresu(db, { od: '2026-07-01', do: '2026-07-31' });
    expect(r.brakujaceDane).toEqual(['2026-07']);
    expect(r.wynikGrosze).toBe(1_000_000);
    expect(r.zostajeGrosze).toBeNull();
  });

  it('POKRYCIE PONIZEJ 95% wylacza kategorie i prog rentownosci', () => {
    sprzedaz('2026-03-10', '12300.00');
    koszt('K1', '2026-03-05', '500.00');
    zapiszDaneMiesiaca(db, '2026-03', { zusRazem: '2359.30', pit5: '0.00', kpirKoszty: '4245.83' });
    const r = rachunekOkresu(db, { od: '2026-03-01', do: '2026-03-31' });
    expect(r.kosztyZnane).toBe(false);
    expect(r.pokrycieKosztow).toBeCloseTo(11.8, 1);
    expect(r.kategorie).toBeNull();
    // ⚠️ Wskazniki gasna RAZEM z kategoriami. Prog rentownosci policzony z jednej osmej
    // wydatkow wychodzi niski i wiarygodny naraz — to jest dokladnie to zmyslenie, przed
    // ktorym broni prog 95%.
    expect(r.wskazniki).toBeNull();
  });

  it('POKRYCIE POWYZEJ 95% wpuszcza kategorie', () => {
    sprzedaz('2026-06-10', '12300.00');
    koszt('K1', '2026-06-05', '2881.04');
    zapiszDaneMiesiaca(db, '2026-06', { zusRazem: '2821.06', kpirKoszty: '2881.04' });
    const r = rachunekOkresu(db, { od: '2026-06-01', do: '2026-06-30' });
    expect(r.kosztyZnane).toBe(true);
    expect(r.kategorie.length).toBeGreaterThan(0);
    // Faktura ma NIP Allegro, wiec `wgrajKategorieStartowe` daje jej „Prowizje sprzedażowe"
    // (typ `zmienny`) — koszt obslugi liczy sie z tej jednej kategorii na jedno zamowienie.
    expect(r.wskazniki.kosztObslugiGrosze).toBe(288_104);
    expect(r.wskazniki.marzaPoZmiennych).toBeCloseTo(71.19, 1);
    // Numer „K1" nie niesie okresu, wiec prowizja zostaje przy miesiacu WYSTAWIENIA.
    expect(r.prowizjaAllegro).toEqual({ nettoGrosze: 288_104, dokumentow: 1 });
  });

  it('BEZ pola kontrolnego KPiR raport powstaje normalnie i o nim milczy', () => {
    sprzedaz('2026-06-10', '12300.00');
    koszt('K1', '2026-06-05', '2000.00');
    zapiszDaneMiesiaca(db, '2026-06', { zusRazem: '2821.06' });
    const r = rachunekOkresu(db, { od: '2026-06-01', do: '2026-06-30' });
    expect(r.pokrycieKosztow).toBeNull();
    expect(r.roznicaPrzychodu).toBeNull();
    expect(r.kosztyZnane).toBe(true);
  });

  it('POLE KONTROLNE PRZYCHODU pokazuje roznice, NIGDY sumy', () => {
    sprzedaz('2026-06-10', '12300.00');           // netto 10 000
    zapiszDaneMiesiaca(db, '2026-06', { zusRazem: '100.00', kpirPrzychod: '9500.00' });
    const r = rachunekOkresu(db, { od: '2026-06-01', do: '2026-06-30' });
    expect(r.roznicaPrzychodu.kpirGrosze).toBe(950_000);
    expect(r.roznicaPrzychodu.procent).toBeCloseTo(5.26, 1);
    expect(r.przychodNettoGrosze).toBe(1_000_000); // NIE zsumowane
  });

  // ⚠️⚠️ KATEGORIA PRZYPIETA DO DOKUMENTU WYGRYWA Z MAPA PO NIP-IE — ta sama regula, co na
  // zakladce KOSZTY (`kategoriaWiersza` w domain/lista-kosztow.js). Zanim rachunek zaczal
  // z niej korzystac, koszty dopisane recznie (Google, Meta, Anthropic — czyli te, ktorych
  // w KSeF NIE MA i dla ktorych to pole w ogole powstalo) wchodzily tu jako
  // „Nieprzypisane"/„drobne", a ekran kosztow pokazywal ich prawdziwa kategorie. Suma sie
  // zgadzala, wiec nic nie krzyczalo — falszywe bylo ROZBICIE i prog rentownosci.
  it('KATEGORIA DOKUMENTU wchodzi do rachunku, a nie kategoria z mapy NIP-u', () => {
    koszt('K9', '2026-06-05', '1000.00');           // NIP Allegro → mapa daje „Prowizje sprzedażowe"
    przypnijKategorieDoDokumentu(db, 'K9', 'Reklama', 'zmienny');
    // ⚠️ `wgrajDaneStartowe` wgrywa czerwiec z `kpir_koszty = 2881.04` przy KAZDYM otwarciu
    // bazy, takze ':memory:' — bez nadpisania pokrycie wychodzi 35% i rozbicie na kategorie
    // W OGOLE SIE NIE LICZY (prog 95%). Test swiecilby wtedy na `null`, nie na regule.
    zapiszDaneMiesiaca(db, '2026-06', { zusRazem: '2821.06', kpirKoszty: '1000.00' });
    const r = rachunekOkresu(db, { od: '2026-06-01', do: '2026-06-30' });
    expect(r.kategorie.map((k) => k.kategoria)).toEqual(['Reklama']);
    expect(r.kategorie[0].nettoGrosze).toBe(100_000);
  });

  it('KOSZT RECZNY BEZ NIP-u ma swoja kategorie, a nie „Nieprzypisane"', () => {
    // Dokladnie przypadek Google/Meta/Anthropic: sprzedawca bez polskiego NIP-u nie ma jak
    // trafic do mapy (jej kluczem glownym JEST NIP), wiec kategoria zyje przy dokumencie.
    zapiszRecznyKoszt(db, {
      numerDokumentu: 'GOOGLE-06', sprzedawcaNip: null, sprzedawcaNazwa: 'Google',
      dataWystawienia: '2026-06-07', netto: '400.00', vat: '0.00', brutto: '400.00',
      waluta: 'PLN', kategoriaDokumentu: 'Reklama', typDokumentu: 'zmienny',
    });
    zapiszDaneMiesiaca(db, '2026-06', { zusRazem: '2821.06', kpirKoszty: '400.00' });
    const r = rachunekOkresu(db, { od: '2026-06-01', do: '2026-06-30' });
    expect(r.kategorie).toEqual([
      { kategoria: 'Reklama', typ: 'zmienny', nettoGrosze: 40_000, dokumentow: 1 },
    ]);
    // ⚠️ TYP JEDZIE RAZEM Z KATEGORIA — na nim stoi prog rentownosci. Wpadniety do „drobne"
    // koszt reklamy nie wchodzil ani do stalych, ani do zmiennych, wiec marza po kosztach
    // zmiennych wychodzila za wysoka, a prog za niski. Oba wygladaly wiarygodnie.
    expect(r.wskazniki.kosztyZmienneGrosze).toBe(40_000);
  });

  // ⚠️⚠️ ZAKRES CZESCIOWY: prowizja za CALY miesiac przy sprzedazy z kilkunastu dni dalaby
  // wskaznik „prowizja / sprzedaz Allegro" absurdalnie wysoki — i wiarygodny. To ta sama
  // rodzina bledu, co faktura prowizyjna dotyczaca miesiaca poprzedniego.
  it('PROWIZJA ALLEGRO liczy sie tylko dla PELNEGO miesiaca kalendarzowego', () => {
    sprzedaz('2026-06-10', '12300.00');
    koszt('P1', '2026-06-01', '500.00');            // NIP Allegro, numer bez okresu
    const pelny = rachunekOkresu(db, { od: '2026-06-01', do: '2026-06-30' });
    expect(pelny.prowizjaAllegro).toEqual({ nettoGrosze: 50_000, dokumentow: 1 });
    const czesciowy = rachunekOkresu(db, { od: '2026-06-05', do: '2026-06-20' });
    expect(czesciowy.prowizjaAllegro).toBeNull();
  });

  // ⚠️ ILORAZ „prowizja ÷ sprzedaz Allegro" LICZY DOMENA, nie widok — to liczba o pieniadzach.
  // Bez sprzedazy Allegro w okresie oddaje `null`: dzielenie daloby nieskonczonosc, a wpisane
  // „0%" bylo by zdaniem o faktach, ktorych nie ma.
  it('UDZIAL PROWIZJI ALLEGRO liczy sie w domenie, a bez sprzedazy Allegro jest nullem', () => {
    koszt('P2', '2026-06-01', '500.00');            // NIP Allegro
    // Sprzedaz idzie kontem 9 (WooCommerce), wiec kanal NIE jest allegrowy.
    sprzedaz('2026-06-10', '12300.00');
    expect(rachunekOkresu(db, { od: '2026-06-01', do: '2026-06-30' }).udzialProwizjiAllegro)
      .toBeNull();

    zapiszHistorie(db, {
      apiloId: 'A1', platformAccountId: 3, dzien: '2026-06-11',
      utworzoneAt: '2026-06-11T10:00:00.000Z', brutto: '12300.00', tagi: [], status: 15,
      paymentStatus: 2, klientEmail: 'k@klient.pl', pozycje: [],
    });
    const r = rachunekOkresu(db, { od: '2026-06-01', do: '2026-06-30' });
    expect(r.sprzedazAllegroGrosze).toBe(1_000_000);
    expect(r.udzialProwizjiAllegro).toBeCloseTo(5, 3);   // 500 zl z 10 000 zl
  });

  it('ZAKRES URWANY W POLOWIE MIESIACA jest oznaczony — koszty sa miesieczne', () => {
    expect(rachunekOkresu(db, { od: '2026-06-01', do: '2026-06-30' }).pelneMiesiace).toBe(true);
    expect(rachunekOkresu(db, { od: '2026-05-01', do: '2026-06-30' }).pelneMiesiace).toBe(true);
    expect(rachunekOkresu(db, { od: '2026-06-05', do: '2026-06-20' }).pelneMiesiace).toBe(false);
    expect(rachunekOkresu(db, { od: '2026-06-01', do: '2026-06-29' }).pelneMiesiace).toBe(false);
  });

  it('PODLOGA: okres sprzed 2026-01 ODMAWIA — kosztow sprzed KSeF nie ma', () => {
    expect(() => rachunekOkresu(db, { od: '2025-06-01', do: '2025-06-30' }))
      .toThrow(/2026/);
  });

  it('miesiace sumuja sie do rachunku okresu CO DO GROSZA', () => {
    sprzedaz('2026-05-10', '12300.00');
    sprzedaz('2026-06-10', '24600.00');
    koszt('K1', '2026-05-05', '1000.00');
    koszt('K2', '2026-06-05', '2000.00');
    zapiszDaneMiesiaca(db, '2026-05', { zusRazem: '2369.59', pit5: '287.00' });
    zapiszDaneMiesiaca(db, '2026-06', { zusRazem: '2821.06', pit5: '779.00' });
    const r = rachunekOkresu(db, { od: '2026-05-01', do: '2026-06-30' });
    const suma = r.miesiacami.reduce((s, m) => s + m.wynikGrosze, 0);
    expect(suma).toBe(r.wynikGrosze);
    // ⚠️ Prowizja MILCZY na okresie dluzszym niz miesiac: rozstrzyga ja okres z numeru
    // faktury, wiec zsumowana „jakos" dalaby liczbe nie do zakwestionowania i nieprawdziwa.
    expect(r.prowizjaAllegro).toBeNull();
  });
});
