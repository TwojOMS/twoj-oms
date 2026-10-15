import { describe, it, expect } from 'vitest';
import { daneSpecyfikacji } from '../../pomoc/specyfikacja-parytetu.js';
import { zl, kwotaOczekiwanaGrosze } from '../../../src/domena/suma-pozycji.js';
import { buildOmsOrderInput } from '../../../src/domena/z-panelu/oms-order.js';

// Dane „Specyfikacji zamowienia" — kartki wkladanej do kazdej paczki. Ten modul TYLKO
// sklada dane (zadnego rysowania PDF-a, to Zadanie 7) i NIE LICZY WLASNYCH KWOT — wszystkie
// ida przez te same funkcje, ktore licza karte i fakture (domain/suma-pozycji.js), zeby
// klient nigdy nie dostal w paczce kartki niezgodnej z faktura.

const SPRZEDAWCA = { nazwa: 'Lumina Marek Zywiecki', bdo: '000123456' };

const zam = (n) => ({
  id: 1,
  numer: '3001',
  utworzone_at: '2026-08-05T10:00:00.000Z',
  pozycje: [{
    nazwa: 'STOP 70x100', sku: 'STOP-70', ilosc: 2, cena_brutto: '50.00', brutto_linii: '100.00',
  }],
  platnosci: [{ kwota: '110.00' }],
  kwota_brutto: '110.00',
  koszt_dostawy_brutto: '10.00',
  metoda_wysylki: 'dpd',
  metoda_platnosci: 'Przelew',
  faktura: null,
  ...n,
});

describe('dane specyfikacji zamowienia', () => {
  it('sklada pozycje z symbolem wzoru i kwotami w zlotowkach', () => {
    const d = daneSpecyfikacji(zam(), { sprzedawca: SPRZEDAWCA });
    expect(d.pozycje[0]).toMatchObject({ nazwa: 'STOP 70x100', symbol: 'STOP-70', ilosc: 2 });
    expect(d.pozycje[0].wartoscZl).toBe('100.00');
  });

  // Cena jednostkowa idzie WPROST z `cena_brutto` — zaden mnoznik razy 100 (Number('19.99')
  // * 100 daje 1998.9999999999998). Test lapie kazda proba przeliczenia tej wartosci.
  it('cena jednostkowa idzie wprost, bez przeliczania na grosze i z powrotem', () => {
    const d = daneSpecyfikacji(zam(), { sprzedawca: SPRZEDAWCA });
    expect(d.pozycje[0].cenaZl).toBe('50.00');
  });

  // ⚠️ Zdarza sie przy Allegro (`sku: null` w domain/allegro-mapowanie.js). Pusta komorka,
  // NIGDY symbol zgadywany z nazwy — dokument ma sie wygenerowac.
  it('pozycja bez sku daje pusty symbol, a nie wywala dokumentu', () => {
    const d = daneSpecyfikacji(
      zam({ pozycje: [{ nazwa: 'X', sku: null, ilosc: 1, cena_brutto: '10.00', brutto_linii: '10.00' }] }),
      { sprzedawca: SPRZEDAWCA },
    );
    expect(d.pozycje[0].symbol).toBe('');
  });

  // ⚠️ SKU ZASLEPKI NIE JEST SYMBOLEM WZORU (21.08.2026). `psm-zam-placeholder` to ukryty
  // produkt techniczny wtyczki panelu indywidualnego — na kartce do paczki, ktora czyta
  // KLIENT, stalby przy kazdej pozycji zamowienia z oferty i nie znaczyl nic.
  it('SKU zaslepki daje pusty symbol, tak samo jak brak SKU', () => {
    const d = daneSpecyfikacji(
      zam({ pozycje: [{ nazwa: 'wysylka kurierem DPD', sku: 'psm-zam-placeholder', ilosc: 1, cena_brutto: '19.00', brutto_linii: '19.00' }] }),
      { sprzedawca: SPRZEDAWCA },
    );
    expect(d.pozycje[0].symbol).toBe('');
  });

  it('niesie numer BDO sprzedawcy', () => {
    expect(daneSpecyfikacji(zam(), { sprzedawca: SPRZEDAWCA }).sprzedawca.bdo).toBe('000123456');
  });

  it('podaje numer faktury, gdy juz istnieje', () => {
    const d = daneSpecyfikacji(zam({ faktura: { numer: '24/08/2026' } }), { sprzedawca: SPRZEDAWCA });
    expect(d.faktura).toEqual({ numer: '24/08/2026' });
  });

  // Dokument powstaje czesto PRZED faktura — kolejnosc „najpierw faktury, potem wydruki"
  // nie jest wymuszana, wiec brak faktury nie jest bledem.
  it('bez faktury oddaje null, a nie pusty napis', () => {
    expect(daneSpecyfikacji(zam(), { sprzedawca: SPRZEDAWCA }).faktura).toBeNull();
  });

  // Dane nabywcy WYLACZNIE przez daneFaktury(z) — operator poprawia je na karcie, bo klient
  // podal zle. Firma tu jest sklepowa (klient.company), zeby test faktycznie przeszedl przez
  // funkcje skladajaca, a nie tylko odbil pole zamowienia jeden do jednego.
  it('dane nabywcy skladaja sie ta sama regula, co na fakturze (daneFaktury)', () => {
    const d = daneSpecyfikacji(
      zam({ klient: { first_name: 'Jan', last_name: 'Kowalski', company: 'ACME' }, nip: '1111111111' }),
      { sprzedawca: SPRZEDAWCA },
    );
    expect(d.nabywca).toMatchObject({ firma: 'ACME', nip: '1111111111' });
  });

  it('koszt dostawy i kwota razem licza sie ta sama funkcja, co na fakturze — nie drugi raz', () => {
    const z = zam();
    const d = daneSpecyfikacji(z, { sprzedawca: SPRZEDAWCA });
    expect(d.dostawaZl).toBe('10.00');
    expect(d.razemZl).toBe('110.00');
  });

  // ⚠️ SEDNO GRANICY MODULU: pozycja dopisana recznie PO ZLOZENIU zamowienia podnosi kwote
  // oczekiwana ponad `kwota_brutto` ze sklepu. Gdyby ten modul liczyl `razemZl` jako prosta
  // sume pozycji plus dostawa (zamiast wolac `kwotaOczekiwanaGrosze`), test wciaz przeszedlby
  // dla zamowien bez dopiskow — dlatego dopiero TEN fixture odroznia „woła te sama funkcje"
  // od „liczy podobnie, ale osobno".
  it('dopisana recznie pozycja podnosi razemZl dokladnie tak, jak liczy to bariera faktury', () => {
    const z = zam({
      pozycje: [
        {
          zrodlo: 'sklep', sklep: null, nazwa: 'STOP 70x100', sku: 'STOP-70', ilosc: 2, cena_brutto: '50.00', brutto_linii: '100.00',
        },
        {
          zrodlo: 'reczna', sklep: null, nazwa: 'Dopłata za projekt', sku: null, ilosc: 1, cena_brutto: '25.00', brutto_linii: '25.00',
        },
      ],
    });
    const d = daneSpecyfikacji(z, { sprzedawca: SPRZEDAWCA });
    expect(d.razemZl).toBe(zl(kwotaOczekiwanaGrosze(z)));
    expect(d.razemZl).toBe('135.00');
  });

  it('numer i data zamowienia (czas warszawski) przechodza na dokument', () => {
    const d = daneSpecyfikacji(zam(), { sprzedawca: SPRZEDAWCA });
    expect(d.numer).toBe('3001');
    expect(d.dataZamowienia).toBe('2026-08-05');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SPOSOB DOSTAWY — NAZWA DLA CZLOWIEKA (recenzja 12.08.2026).
  //
  // ⚠️ Do tego dnia szlo tu wprost `z.metoda_wysylki`, czyli na kartke DO KLIENTA trafialy
  // napisy `dpd`, `inpost_paczkomat`, `odbior_osobisty`, a w najgorszym razie „Sposób
  // dostawy: nieznana". Kartka idzie do KAZDEJ paczki i przy firmach zastepuje wydruk
  // faktury — to jest usterka, ktora klient zglasza.
  // ─────────────────────────────────────────────────────────────────────────────
  describe('sposob dostawy', () => {
    it('drukuje nazwe dla czlowieka, nie wewnetrzny kod metody', () => {
      expect(daneSpecyfikacji(zam(), { sprzedawca: SPRZEDAWCA }).dostawa).toBe('Kurier DPD');
    });

    it('paczkomat i odbior osobisty tez maja nazwy, a nie klucze', () => {
      expect(daneSpecyfikacji(zam({ metoda_wysylki: 'inpost_paczkomat' }), { sprzedawca: SPRZEDAWCA }).dostawa)
        .toBe('InPost Paczkomat');
      expect(daneSpecyfikacji(zam({ metoda_wysylki: 'odbior_osobisty' }), { sprzedawca: SPRZEDAWCA }).dostawa)
        .toBe('Odbiór osobisty');
    });

    // „nieznana" JEST realna wartoscia kolumny (metoda, ktorej panel nie rozpoznal), a nie
    // brakiem danych — i wlasnie ona wygladala na kartce najgorzej.
    it('nierozpoznana metoda daje zdanie po polsku, a nie napis „nieznana"', () => {
      const d = daneSpecyfikacji(zam({ metoda_wysylki: 'nieznana' }), { sprzedawca: SPRZEDAWCA });
      expect(d.dostawa).toBe('Nieznana metoda');
      expect(d.dostawa).not.toBe('nieznana');
    });

    it('dokleja informacje o pobraniu — ta sama funkcja, co lista i karta', () => {
      const d = daneSpecyfikacji(zam({ pobranie: 1 }), { sprzedawca: SPRZEDAWCA });
      expect(d.dostawa).toBe('Kurier DPD (pobranie)');
    });

    // ⚠️ WARTOSC EFEKTYWNA, nie kolumna sklepu: reczna korekta metody na karcie ma trafic
    // na dokument. Bez tego poprawka operatora i tresc kartki rozjezdzalyby sie po cichu —
    // klient dostawalby w paczce napis o dostawie, ktorej nie zamowiono.
    it('reczna korekta metody z karty wygrywa nad kolumna sklepu', () => {
      const d = daneSpecyfikacji(
        zam({
          metoda_wysylki_sklep: 'dpd',
          metoda_wysylki: 'dpd',
          wysylka_reczna_json: JSON.stringify({ metoda: 'odbior_osobisty' }),
        }),
        { sprzedawca: SPRZEDAWCA },
      );
      expect(d.dostawa).toBe('Odbiór osobisty');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // PLATNOSC ZE STANEM (recenzja 12.08.2026). Spec wymienial „metode platnosci ZE STANEM",
  // a dokument drukowal sama metode: klient dostawal w paczce „Płatność: Za pobraniem" bez
  // ani jednego slowa o tym, czy pieniadze juz wplynely, czy odbierze je kurier.
  //
  // Regule (ktory z trzech stanow) rozstrzyga `ikonaPlatnosci` — ta sama, ktora rzadzi ikona
  // na liscie. Zadnego liczenia salda od nowa.
  // ─────────────────────────────────────────────────────────────────────────────
  describe('platnosc ze stanem', () => {
    it('oplacone: metoda plus stan', () => {
      const d = daneSpecyfikacji(zam({ oplacone_at: '2026-08-05T10:00:00.000Z' }), { sprzedawca: SPRZEDAWCA });
      expect(d.platnosc).toBe('Przelew — opłacone');
    });

    it('nieoplacone mowi o tym wprost', () => {
      expect(daneSpecyfikacji(zam(), { sprzedawca: SPRZEDAWCA }).platnosc).toBe('Przelew — nieopłacone');
    });

    // ⚠️ POBRANIE WYGRYWA nad oplacone/nieoplacone — przy pobraniu brak wplaty jest stanem
    // NORMALNYM, nie niedoplata. Ta sama regula rzadzi ikona na liscie i paskiem na karcie;
    // gdyby dokument liczyl to sam, kartka klamalaby panelowi.
    it('pobranie: mowi, ze pieniadze odbiera kurier — mimo braku wplaty', () => {
      const d = daneSpecyfikacji(
        zam({ metoda_platnosci: 'Za pobraniem', pobranie: 1, platnosci: [] }),
        { sprzedawca: SPRZEDAWCA },
      );
      expect(d.platnosc).toBe('Za pobraniem — do zapłaty kurierowi przy odbiorze');
    });

    // ⚠️ Pobranie wygrywa TAKZE nad zaksiegowana wplata — inaczej zamowienie za pobraniem
    // z wplata dopisana recznie po doreczeniu drukowaloby „opłacone" na kartce, ktora jedzie
    // razem z paczka, czyli PRZED zaplata.
    it('pobranie wygrywa nad oplacone_at', () => {
      const d = daneSpecyfikacji(
        zam({ metoda_platnosci: 'Za pobraniem', pobranie: 1, oplacone_at: '2026-08-05T10:00:00.000Z' }),
        { sprzedawca: SPRZEDAWCA },
      );
      expect(d.platnosc).toBe('Za pobraniem — do zapłaty kurierowi przy odbiorze');
    });

    // Zamowienie reczne bywa bez metody platnosci. Sam stan, a NIE „ — opłacone" z wiszacym
    // mysnikiem na dokumencie dla klienta.
    it('brak metody daje sam stan, bez wiszacego mysnika', () => {
      const d = daneSpecyfikacji(
        zam({ metoda_platnosci: null, oplacone_at: '2026-08-05T10:00:00.000Z' }),
        { sprzedawca: SPRZEDAWCA },
      );
      expect(d.platnosc).toBe('opłacone');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cztery uzupelnienia kartki z 24.08.2026 (prosba wlasciciela): paragon zamiast ciszy
// przy sprzedazy bez faktury, data platnosci, uwagi klienta oraz jednoznaczny podpis
// pod data u gory dokumentu.
// ─────────────────────────────────────────────────────────────────────────────

describe('data zamowienia i data platnosci', () => {
  // Pytanie wlasciciela wprost: „czy data na gorze to data zamowienia?". Tak — i ten test
  // ma to utrwalic, zeby odpowiedz nie zalezala od pamieci.
  it('data u gory to dzien ZLOZENIA zamowienia, w czasie warszawskim', () => {
    // 22:30 UTC 4 sierpnia to juz 5 sierpnia w Polsce — gdyby data szla z UTC, wyszedlby 04.
    const d = daneSpecyfikacji(zam({ utworzone_at: '2026-08-04T22:30:00.000Z' }), { sprzedawca: SPRZEDAWCA });
    expect(d.dataZamowienia).toBe('2026-08-05');
  });

  // ⚠️ Latem Polska jest UTC+2, wiec dzien przeskakuje o 22:00 UTC — i wlasnie tam stoi ten
  // test. Godzina 21:10 UTC to jeszcze 9 sierpnia w Polsce i taki test przechodzilby TAKZE
  // przy liczeniu w UTC, czyli nie dowodzilby niczego (pomylka zlapana przy pisaniu).
  it('data platnosci bierze sie z `oplacone_at`, tez po warszawsku', () => {
    const d = daneSpecyfikacji(
      zam({ oplacone_at: '2026-08-09T22:10:00.000Z' }),
      { sprzedawca: SPRZEDAWCA },
    );
    expect(d.dataPlatnosci).toBe('2026-08-10');
  });

  // ⚠️ Przy pobraniu pieniadze odbiera kurier przy doreczeniu — data platnosci jeszcze
  // NIE ISTNIEJE. Kazda liczba wydrukowana w tym miejscu bylaby zmyslona.
  it('brak wplaty daje `null`, a nie dzisiejsza date', () => {
    const d = daneSpecyfikacji(zam({ oplacone_at: null }), { sprzedawca: SPRZEDAWCA });
    expect(d.dataPlatnosci).toBeNull();
  });
});

describe('informacja o dokumencie sprzedazy', () => {
  it('klient bez faktury dostaje znacznik paragonu', () => {
    const d = daneSpecyfikacji(zam({ chce_fakture: 0 }), { sprzedawca: SPRZEDAWCA });
    expect(d.paragon).toBe(true);
  });

  it('klient z faktura NIE dostaje znacznika paragonu', () => {
    const d = daneSpecyfikacji(zam({ chce_fakture: 1 }), { sprzedawca: SPRZEDAWCA });
    expect(d.paragon).toBe(false);
    expect(d.fakturaWybrana).toBe(true);
  });

  // ⚠️ WARTOSC EFEKTYWNA, nie kolumna ze sklepu. Operator przestawia to pole wlasnie wtedy,
  // gdy klient rozmyslil sie po zlozeniu zamowienia — kartka ma mowic o stanie PO poprawce.
  it('reczna poprawka na karcie wygrywa z tym, co przyslal sklep', () => {
    const zeSklepu = daneSpecyfikacji(
      zam({ chce_fakture: 1, chce_fakture_reczne: 0 }),
      { sprzedawca: SPRZEDAWCA },
    );
    expect(zeSklepu.paragon).toBe(true);
    expect(zeSklepu.fakturaWybrana).toBe(false);

    const odwrotnie = daneSpecyfikacji(
      zam({ chce_fakture: 0, chce_fakture_reczne: 1 }),
      { sprzedawca: SPRZEDAWCA },
    );
    expect(odwrotnie.paragon).toBe(false);
    expect(odwrotnie.fakturaWybrana).toBe(true);
  });
});

describe('uwagi klienta', () => {
  it('przechodza na kartke tak, jak je napisal klient', () => {
    const d = daneSpecyfikacji(
      zam({ uwagi: 'Proszę zapakować na prezent, bez cennika w środku.' }),
      { sprzedawca: SPRZEDAWCA },
    );
    expect(d.uwagiKlienta).toBe('Proszę zapakować na prezent, bez cennika w środku.');
  });

  // ⚠️ Pusty napis i same biale znaki to BRAK uwag, nie uwagi puste. Inaczej kartka
  // dostawalaby naglowek „Uwagi klienta" nad niczym.
  it.each([null, undefined, '', '   ', '\n\t '])('brak uwag daje null (%p)', (wartosc) => {
    const d = daneSpecyfikacji(zam({ uwagi: wartosc }), { sprzedawca: SPRZEDAWCA });
    expect(d.uwagiKlienta).toBeNull();
  });
});

// ⚠️⚠️ ZNACZNIK TECHNICZNY NIE MA PRAWA TRAFIC NA KARTKE DO KLIENTA.
//
// `zamowienia.uwagi` niesie DWIE rozne rzeczy: slowa klienta (`customer_note`,
// `messageToSeller`) oraz slad, ktory panel indywidualny wpisuje KAZDEMU zamowieniu
// zalozonemu z karty — razem z wewnetrznym odnosnikiem do niej. Pomiar na produkcji
// (25.08.2026): z pieciu ostatnich zamowien z niepustymi uwagami CZTERY mialy wlasnie
// ten znacznik. Bez filtra kazda taka paczka wyjechalaby z kartka „Uwagi klienta:
// Zamówienie indywidualne — karta e218b78e-… https://…".
describe('znacznik techniczny panelu nie jest uwagami klienta', () => {
  // ⚠️ NAPIS BUDUJE TEN SAM KOD, KTORY ROBI TO NA PRODUKCJI — nie kopia literalu w tescie.
  // Gdyby ktos zmienil brzmienie znacznika w panelu, a filtr w OMS-ie zostal przy starym,
  // TEN test spadnie na czerwono. Kopia napisu przechodzilaby dalej, a wyciek pokazalby sie
  // dopiero na wydrukowanej kartce w paczce.
  const zPanelu = buildOmsOrderInput(
    {
      id: 'e218b78e-f3ab-43d4-a8a9-bd89aaaa1111',
      klientNazwa: 'Jan Kowalski',
      klientEmail: 'jan@example.pl',
      quote: { items: [], total: '100.00' },
    },
    { publicBaseUrl: 'https://panel.example.pl' },
  );

  it('uwagi zbudowane przez panel są rozpoznane jako techniczne i NIE wychodzą na dokument', () => {
    expect(zPanelu.uwagi).toContain('Zamówienie indywidualne');
    const d = daneSpecyfikacji(zam({ uwagi: zPanelu.uwagi }), { sprzedawca: SPRZEDAWCA });
    expect(d.uwagiKlienta).toBeNull();
  });

  it('wewnętrzny odnośnik do karty nie wycieka na kartkę', () => {
    const d = daneSpecyfikacji(zam({ uwagi: zPanelu.uwagi }), { sprzedawca: SPRZEDAWCA });
    expect(d.uwagiKlienta ?? '').not.toContain('panel.example.pl');
  });

  // Filtr celuje w PRZEDROSTEK, nie w wystapienie gdziekolwiek — zdanie klienta, ktory sam
  // napisze „zamówienie indywidualne", ma dojechac na kartke nietkniete.
  it('zdanie klienta zawierające podobne słowa NIE jest odsiewane', () => {
    const uwagaKlienta = 'Czy to zamówienie indywidualne da się spakować na prezent?';
    const d = daneSpecyfikacji(zam({ uwagi: uwagaKlienta }), { sprzedawca: SPRZEDAWCA });
    expect(d.uwagiKlienta).toBe(uwagaKlienta);
  });
});

describe('kwota netto w podsumowaniu', () => {
  it('netto liczy sie od sumy zamowienia przy stawce 23%', () => {
    const d = daneSpecyfikacji(zam(), { sprzedawca: SPRZEDAWCA });
    expect(d.razemZl).toBe('110.00');
    expect(d.nettoZl).toBe('89.43');
  });

  // ⚠️⚠️ KLIENT WDT MA STAWKE 0% — netto ROWNA SIE brutto. Slepe dzielenie przez 1,23
  // daloby Alfatrendowi w paczce kartke z netto zanizonym o 23% wzgledem faktury I wzgledem
  // raportu sprzedazy. To jedyny powod, dla ktorego ta liczba nie jest liczona na miejscu,
  // tylko wspolna regula z `sprzedaz-okresu.js`.
  it('klient WDT ma netto rowne brutto, bez dzielenia', () => {
    const d = daneSpecyfikacji(
      zam({ klient: { email: 'peter.novak@alfatrend.sk' } }),
      { sprzedawca: SPRZEDAWCA },
    );
    expect(d.nettoZl).toBe('110.00');
    expect(d.nettoZl).toBe(d.razemZl);
  });

  // ⚠️ WDT rozpoznajemy po mailu KLIENTA, nie po mailu z danych faktury — ten drugi jest
  // nieobowiazkowy i bywa inny (dokumenty ida na osobny adres do ksiegowosci).
  it('rozpoznanie WDT nie zalezy od wielkosci liter w mailu', () => {
    const d = daneSpecyfikacji(
      zam({ klient: { email: 'Info@Alfatrend.SK' } }),
      { sprzedawca: SPRZEDAWCA },
    );
    expect(d.nettoZl).toBe('110.00');
  });

  it('zamowienie bez maila klienta liczy netto zwyklą stawką', () => {
    const d = daneSpecyfikacji(zam({ klient: null }), { sprzedawca: SPRZEDAWCA });
    expect(d.nettoZl).toBe('89.43');
  });
});
