import { describe, it, expect } from 'vitest';
import { mapujZamowienie } from '../../src/domena/mapowanie.js';

// Od Etapu 2 mapowanie to CALA tablica dostaw sklepu (instancje + reguly zapasowe
// po pozycji), a nie sama mapa instancji — patrz domain/mapowanie-wysylki.js.
// Instancja 2 to TEN SAM kurier za pobraniem — od 2026-08-01 pobranie jest flaga obok
// metody, a nie osobna nazwa metody.
const mapa = {
  instancje: { 1: { metoda: 'dpd' }, 2: { metoda: 'dpd', pobranie: true }, 3: { metoda: 'dpd' } },
  poPozycji: [],
};

const surowe = {
  id: 1301, number: '1301', status: 'processing', total: '212.90',
  date_paid: '2026-07-29T13:21:26', date_created: '2026-07-29T13:19:52',
  billing: { first_name: 'Jan', last_name: 'Kowalski', email: 'j@k.pl', phone: '+48500600700', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL', company: 'ACME' },
  shipping: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL' },
  shipping_lines: [{ method_id: 'flat_rate', instance_id: '1' }],
  // Woo trzyma koszt wysylki na poziomie ZAMOWIENIA, netto + osobny podatek.
  // 73.09 + 16.81 = 89.90; razem z pozycjami (123.00) daje total 212.90.
  shipping_total: '73.09', shipping_tax: '16.81',
  line_items: [{ id: 4321, name: 'STOP', sku: 'PRO-STOP-001', quantity: 2, total: '100.00', total_tax: '23.00', subtotal: '100.00', subtotal_tax: '23.00' }],
  meta_data: [{ key: '_billing_faktura', value: '1' }, { key: '_billing_nip', value: '1000001201' }],
};

describe('mapujZamowienie', () => {
  it('przenosi identyfikatory, kwotę i datę zapłaty', () => {
    const z = mapujZamowienie(surowe, mapa);
    expect(z.zrodlo_id).toBe(1301);
    expect(z.numer).toBe('1301');
    expect(z.kwota_brutto).toBe('212.90');
    expect(z.oplacone_at).toBe('2026-07-29T13:21:26');
    expect(z.status_woo).toBe('processing');
  });

  it('czyta chęć faktury i NIP z meta', () => {
    const z = mapujZamowienie(surowe, mapa);
    expect(z.chce_fakture).toBe(1);
    expect(z.nip).toBe('1000001201');
  });

  // Puste _billing_faktura znaczy "nie chce" — tak wyglada zamowienie bez zaznaczonego pola.
  it('puste _billing_faktura → brak chęci faktury', () => {
    const z = mapujZamowienie({ ...surowe, meta_data: [{ key: '_billing_faktura', value: '' }] }, mapa);
    expect(z.chce_fakture).toBe(0);
  });

  // W JS "0" jest PRAWDZIWE, wiec naiwne sprawdzenie wystawiloby fakture komus,
  // kto jej nie chcial. Woo zapisuje pola wyboru raz jako '', raz jako '0'.
  it('_billing_faktura = "0" → brak chęci faktury', () => {
    const z = mapujZamowienie({ ...surowe, meta_data: [{ key: '_billing_faktura', value: '0' }] }, mapa);
    expect(z.chce_fakture).toBe(0);
  });

  it('brak klucza _billing_faktura → brak chęci faktury', () => {
    const z = mapujZamowienie({ ...surowe, meta_data: [] }, mapa);
    expect(z.chce_fakture).toBe(0);
    expect(z.nip).toBeNull();
  });

  // Sedno naprawy A. pro.szkicownia.pl (jedyny sklep Etapu 1) NIE ustawia w ogóle
  // `_billing_faktura` — tylko szkicownia.pl to robi. Bez tego testu fakturowanie jest
  // martwe na jedynym sklepie, dla którego panel je zbudował. Dane zgodne z prawdziwym
  // zamówieniem 1267: NIP jest, `_billing_faktura` nie istnieje wcale.
  it('brak _billing_faktura, ale jest NIP → chce faktury (pro.szkicownia.pl)', () => {
    const z = mapujZamowienie({ ...surowe, meta_data: [{ key: '_billing_nip', value: '1000001081' }] }, mapa);
    expect(z.chce_fakture).toBe(1);
    expect(z.nip).toBe('1000001081');
  });

  it('brak date_paid → oplacone_at null', () => {
    expect(mapujZamowienie({ ...surowe, date_paid: null }, mapa).oplacone_at).toBeNull();
  });

  it('status cancelled → anulowane', () => {
    expect(mapujZamowienie({ ...surowe, status: 'cancelled' }, mapa).anulowane).toBe(1);
  });

  it('pobranie przenosi kwotę COD równą całości zamówienia', () => {
    const z = mapujZamowienie({ ...surowe, shipping_lines: [{ method_id: 'flat_rate', instance_id: '2' }] }, mapa);
    expect(z.metoda_wysylki).toBe('dpd');
    // ⚠️ TO SA PIENIADZE: pobranie MUSI dojechac do wlasnej kolumny, bo to ona steruje
    // polem <cod> w kopercie DPD. Sama kwota bez tej flagi nie znaczy juz nic.
    expect(z.pobranie).toBe(1);
    expect(z.kwota_pobrania).toBe('212.90');
  });

  it('przedpłata nie ma kwoty pobrania', () => {
    expect(mapujZamowienie(surowe, mapa).pobranie).toBe(0);
    expect(mapujZamowienie(surowe, mapa).kwota_pobrania).toBeNull();
  });

  // Instancja 3 (darmowa dostawa nad progiem) to ta sama fizyczna paczka DPD co instancja 1 —
  // przedplacona. Gdyby dostala kwote pobrania, kurier probowalby inkasowac pieniadze,
  // ktorych nikt mu nie jest winien.
  it('darmowa dostawa (instancja 3) mapuje się na dpd bez kwoty pobrania', () => {
    const z = mapujZamowienie({ ...surowe, shipping_lines: [{ method_id: 'free_shipping', instance_id: '3' }] }, mapa);
    expect(z.metoda_wysylki).toBe('dpd');
    expect(z.kwota_pobrania).toBeNull();
  });

  it('mapuje pozycje z ceną jednostkową liczoną brutto (total + total_tax)', () => {
    expect(mapujZamowienie(surowe, mapa).pozycje).toEqual([
      // 100,00 netto + 23,00 VAT = 123,00 brutto linii; 123,00 / 2 szt. = 61,50 za sztuke.
      // Netto WPROST z Woo: 100,00 linii, 50,00 za sztuke — bez zadnego dzielenia brutta.
      // Wszystkie wartosci policzone jawnie: cena sluzy widokowi, *_linii — fakturze i barierze.
      {
        // Identyfikator linii U ZRODLA — trwaly klucz recznych nadpisan tej pozycji
        // (kluczPozycji w domain/pozycje-reczne.js). Nasze `pozycje.id` sie do tego nie
        // nadaje, bo poller kasuje i wstawia pozycje sklepowe przy kazdej synchronizacji.
        zrodlo_id: 4321,
        nazwa: 'STOP', sku: 'PRO-STOP-001', ilosc: 2,
        cena_brutto: '61.50', cena_netto: '50.00', brutto_linii: '123.00', netto_linii: '100.00', vat: null,
        // Pozycja bez zdjecia w Woo — miniatura na liscie po prostu sie nie narysuje.
        zdjecie_url: null,
        // Fikstura nie niesie `product_id`, wiec identyfikator produktu ma byc NULL-em,
        // a nie zerem — patrz osobny test nizej.
        produkt_id: null,
        // PRZ-091: bez `variation_id` — produkt prosty, wariantu nie ma.
        wariant_id: null,
      },
    ]);
  });

  it('PRZ-091: pozycja wariantu niesie variation_id jako wariant_id (tekst), produkt prosty (0) — null', () => {
    const zWariantem = { ...surowe, line_items: [{ ...surowe.line_items[0], product_id: 944, variation_id: 1091 }, { ...surowe.line_items[0], id: 4322, product_id: 945, variation_id: 0 }] };
    const [wariant, prosty] = mapujZamowienie(zWariantem, mapa).pozycje;
    expect(wariant).toMatchObject({ produkt_id: 944, wariant_id: '1091' });
    expect(prosty).toMatchObject({ produkt_id: 945, wariant_id: null });
  });

  // I2. To jest ta sama pozycja, ktora rozbijala fakture: 100,00 zl brutto na 3 sztuki.
  // Cena jednostkowa MUSI sie zaokraglic (33,33), ale brutto linii ma zostac DOKLADNE —
  // bo to ono idzie na dokument, a mnozenie 33,33 x 3 dawalo 99,99 i deterministyczna odmowe.
  it('brutto linii jest dokładne, gdy suma nie dzieli się równo przez ilość', () => {
    const zRabatem = {
      ...surowe, total: '100.00', shipping_total: '0.00', shipping_tax: '0.00',
      line_items: [{ name: 'STOP', sku: 'A', quantity: 3, total: '81.30', total_tax: '18.70' }],
    };
    const p = mapujZamowienie(zRabatem, mapa).pozycje[0];
    expect(p.brutto_linii).toBe('100.00');
    expect(p.cena_brutto).toBe('33.33');
  });

  it('brutto linii korzysta z tego samego fallbacku subtotal/subtotal_tax', () => {
    const zFallbackiem = {
      ...surowe,
      line_items: [{ name: 'STOP', sku: 'A', quantity: 7, subtotal: '123.45', subtotal_tax: '28.39' }],
    };
    // 123,45 + 28,39 = 151,84 — drugi z przypadkow zmierzonych na prawdziwej sciezce.
    expect(mapujZamowienie(zFallbackiem, mapa).pozycje[0].brutto_linii).toBe('151.84');
  });

  // Niezmiennik mocniejszy niz ten na cenach jednostkowych nizej: brutta linii PLUS dostawa
  // musza trafic w kwote zamowienia CO DO GROSZA, bo dokladnie te liczby sprawdza bariera.
  it('brutta linii + dostawa trafiają w kwotę zamówienia co do grosza', () => {
    const trudne = {
      // 100,00 (3 szt., nie dzieli sie rowno) + 48,00 (7 szt., nie dzieli sie rowno)
      // + 41,00 dostawy = 189,00. Kwoty policzone jawnie, nie przepisane z przebiegu.
      ...surowe, total: '189.00', shipping_total: '33.33', shipping_tax: '7.67',
      line_items: [
        { name: 'A', sku: 'A', quantity: 3, total: '81.30', total_tax: '18.70' },
        { name: 'B', sku: 'B', quantity: 7, total: '39.02', total_tax: '8.98' },
      ],
    };
    const z = mapujZamowienie(trudne, mapa);
    const suma = z.pozycje.reduce((acc, p) => acc + Math.round(Number(p.brutto_linii) * 100), 0)
      + Math.round(Number(z.koszt_dostawy_brutto) * 100);
    expect(suma).toBe(18900);
    // Ta sama suma liczona po staremu (cena jednostkowa x ilosc) CHYBIA — czyli dokladnie
    // to, o co panel sam sie odbijal: 33,33x3 = 99,99 (zanizone) i 6,86x7 = 48,02
    // (zawyzone), razem z dostawa 189,01 zamiast 189,00.
    const poStaremu = z.pozycje.reduce((acc, p) => acc + Math.round(Number(p.cena_brutto) * 100) * p.ilosc, 0)
      + Math.round(Number(z.koszt_dostawy_brutto) * 100);
    expect(poStaremu).toBe(18901);
  });

  // Dane ze zweryfikowanego, prawdziwego zamowienia: total='80.49' + total_tax='18.51' to
  // faktycznie 99.00 zl brutto. Sama kolumna `total` (bez podatku) dawalaby 80.49 — za nisko.
  it('cena jednostkowa liczy total_tax, nie tylko total (realne dane)', () => {
    const zRealnaPozycja = {
      ...surowe,
      line_items: [{ name: 'STOP', sku: 'PRO-STOP-001', quantity: 1, total: '80.49', total_tax: '18.51' }],
    };
    expect(mapujZamowienie(zRealnaPozycja, mapa).pozycje[0].cena_brutto).toBe('99.00');
  });

  // Fallback do subtotal/subtotal_tax dziala PARAMI: brak total → uzywamy subtotal I subtotal_tax,
  // nigdy nie mieszamy pol z roznych par.
  it('brak total/total_tax → fallback do subtotal/subtotal_tax', () => {
    const zFallbackiem = {
      ...surowe,
      line_items: [{ name: 'STOP', sku: 'PRO-STOP-001', quantity: 1, subtotal: '80.49', subtotal_tax: '18.51' }],
    };
    expect(mapujZamowienie(zFallbackiem, mapa).pozycje[0].cena_brutto).toBe('99.00');
  });

  // C3b. Koszt dostawy jest czescia `total`, ale NIE MA GO w `line_items`. Bez tego pola
  // faktura wystawiana z panelu byla zanizona o cala wysylke.
  it('zbiera koszt dostawy brutto z shipping_total + shipping_tax', () => {
    expect(mapujZamowienie(surowe, mapa).koszt_dostawy_brutto).toBe('89.90');
  });

  it('darmowa dostawa → koszt 0.00, a nie null', () => {
    const zDarmowa = { ...surowe, shipping_total: '0.00', shipping_tax: '0.00' };
    expect(mapujZamowienie(zDarmowa, mapa).koszt_dostawy_brutto).toBe('0.00');
  });

  // Stare/niekompletne zamowienie ze sklepu nie ma prawa wywrocic mapowania na NaN —
  // NaN w JSON-ie staje sie `null` i cicho gubi kwote.
  it('brak pól wysyłki w odpowiedzi sklepu → 0.00', () => {
    const bezWysylki = { ...surowe, shipping_total: undefined, shipping_tax: undefined };
    expect(mapujZamowienie(bezWysylki, mapa).koszt_dostawy_brutto).toBe('0.00');
  });

  // Weryfikacja niezmiennika: ceny brutto pozycji (razy ilosc) PLUS koszt dostawy musza
  // sumowac sie do kwoty brutto calego zamowienia. To dokladnie ten niezmiennik, ktory
  // sprawdza bariera arytmetyczna przed wystawieniem faktury — tu pilnujemy zrodla danych.
  it('pozycje + dostawa sumują się do kwoty brutto zamówienia (realistyczne wielopozycyjne)', () => {
    const wielopozycyjne = {
      ...surowe,
      total: '190.00',
      shipping_total: '33.33', shipping_tax: '7.67',
      line_items: [
        { name: 'STOP A', sku: 'A', quantity: 1, total: '80.49', total_tax: '18.51' },
        { name: 'STOP B', sku: 'B', quantity: 2, total: '40.66', total_tax: '9.34' },
      ],
    };
    const z = mapujZamowienie(wielopozycyjne, mapa);
    const sumaPozycji = z.pozycje.reduce((acc, p) => acc + Number(p.cena_brutto) * p.ilosc, 0);
    expect((sumaPozycji + Number(z.koszt_dostawy_brutto)).toFixed(2)).toBe(z.kwota_brutto);
  });

  // Ten sam niezmiennik na fiksturze glownej: 123.00 (pozycje) + 89.90 (dostawa) = 212.90.
  it('pozycje + dostawa sumują się do kwoty brutto także na fiksturze bazowej', () => {
    const z = mapujZamowienie(surowe, mapa);
    const sumaPozycji = z.pozycje.reduce((acc, p) => acc + Number(p.cena_brutto) * p.ilosc, 0);
    expect((sumaPozycji + Number(z.koszt_dostawy_brutto)).toFixed(2)).toBe('212.90');
  });

  // Zadanie D: uwagi klienta z zamówienia. WooCommerce trzyma je w `customer_note` na
  // poziomie zamówienia (nie w meta_data, jak NIP/faktura) — sprawdzone na produkcji,
  // zamówienia 1267 („moje uwagi") i 1276 („uwagi") mają to pole wypełnione.
  it('mapuje uwagi klienta z customer_note', () => {
    const z = mapujZamowienie({ ...surowe, customer_note: 'proszę zadzwonić przed dostawą' }, mapa);
    expect(z.uwagi).toBe('proszę zadzwonić przed dostawą');
  });

  // Woo zwraca pusty string, gdy klient nic nie napisał — to ma wyjść jako brak uwag,
  // nie jako pusty wiersz na karcie (patrz widok: renderuje się TYLKO gdy z.uwagi jest prawdziwe).
  it('pusty customer_note → brak uwag (null), nie pusty string', () => {
    expect(mapujZamowienie({ ...surowe, customer_note: '' }, mapa).uwagi).toBeNull();
  });

  it('brak pola customer_note w odpowiedzi sklepu → brak uwag', () => {
    const { customer_note, ...bezUwag } = { ...surowe, customer_note: 'x' };
    expect(mapujZamowienie(bezUwag, mapa).uwagi).toBeNull();
  });

  // ⚠️ ZAWSZE `product_id` RODZICA, NIGDY `variation_id` — adres produktu zlozony
  // z identyfikatora wariantu sie nie renderuje, a odnosnik raz dzialajacy, a raz nie,
  // jest gorszy niz jego brak. Ksztalt z prawdziwej odpowiedzi sklepu (zamowienie 28046,
  // notatka 2026-08-04-zamowienia-indywidualne-rozpoznanie.md): pozycja niesie
  // `product_id` i `variation_id: 0` obok siebie.
  it('pozycja niesie product_id ze sklepu', () => {
    const z = mapujZamowienie({
      ...surowe,
      line_items: [{ id: 1, name: 'A', quantity: 1, product_id: 28040, variation_id: 0 }],
    }, mapa);
    expect(z.pozycje[0].produkt_id).toBe(28040);
  });

  // ⚠️ TEN TEST POWSTAL Z RECENZJI GALEZI: mutacja preferujaca `variation_id`, gdy jest
  // wiekszy od zera, PRZECHODZILA caly pakiet `tests/oms`. Powod byl prosty i latwy do
  // przeoczenia — WSZYSTKIE fikstury (tutaj i w produkt-id-db.test.js) mialy
  // `variation_id: 0`, czyli dokladnie ten ksztalt, w ktorym reguly NIE DA SIE
  // zaobserwowac: zero odpada przez warunek `> 0` niezaleznie od tego, ktore pole wygrywa.
  //
  // Reguly broni tu pozycja z PRAWDZIWYM wariantem (`product_id` i `variation_id` oba
  // dodatnie i rozne). Wariant jest zly, bo adres produktu zlozony z identyfikatora
  // wariantu SIE NIE RENDERUJE — a odnosnik raz dzialajacy, a raz nie (zaleznie od tego,
  // czy klient kupil produkt prosty czy wariantowy) jest gorszy niz jego brak: operator
  // przestaje mu ufac i przestaje w niego klikac.
  it('wariant produktu daje product_id RODZICA, nigdy variation_id', () => {
    const z = mapujZamowienie({
      ...surowe,
      line_items: [{ id: 1, name: 'A', quantity: 1, product_id: 28040, variation_id: 28041 }],
    }, mapa);
    expect(z.pozycje[0].produkt_id).toBe(28040);
  });

  // ⚠️ Brak identyfikatora ma dac NULL, a nie zero: „produkt numer 0" nie istnieje,
  // a adres do niego prowadzi donikad. Zadanie 9 buduje odnosnik WLASNIE na tej wartosci,
  // wiec zero zamiast NULL-a znaczyloby link na kazdej pozycji — i kazdy zepsuty.
  it('brak product_id daje null, nie zero', () => {
    const z = mapujZamowienie({ ...surowe, line_items: [{ id: 1, name: 'A', quantity: 1 }] }, mapa);
    expect(z.pozycje[0].produkt_id).toBe(null);
  });

  // ===== Zadanie 4: kolumny netto obok istniejących kolumn brutto =====
  //
  // ⚠️ Netto MUSI iść wprost z Woo (total/total_tax), NIGDY dzieleniem brutto przez 1,23 —
  // dokładnie ten błąd zablokował już raz fakturowanie zamówień z rabatem (przewodnik, 4.5).
  // Poniższe fikstury mają NIERÓWNY iloraz brutto/1,23 właśnie po to, żeby dzielenie i to
  // wprost-ze-sklepu dawały RÓŻNE liczby — inaczej test przechodziłby przy obu podejściach.
  describe('kolumny netto', () => {
    it('mapuje netto linii wprost z total (bez VAT)', () => {
      const z = mapujZamowienie(surowe, mapa);
      // total=100.00, quantity=2 -> netto linii 100.00, cena netto jednostkowa 50.00.
      expect(z.pozycje[0].netto_linii).toBe('100.00');
      expect(z.pozycje[0].cena_netto).toBe('50.00');
    });

    it('netto linii korzysta z tego samego fallbacku subtotal, PARAMI z brutto', () => {
      const zFallbackiem = {
        ...surowe,
        line_items: [{ name: 'STOP', sku: 'PRO-STOP-001', quantity: 7, subtotal: '123.45', subtotal_tax: '28.39' }],
      };
      expect(mapujZamowienie(zFallbackiem, mapa).pozycje[0].netto_linii).toBe('123.45');
    });

    it('zbiera koszt dostawy netto wprost z shipping_total, bez doliczania podatku', () => {
      // shipping_total='73.09', shipping_tax='16.81' (fiksura bazowa) — brutto to 89.90,
      // ale netto ma zostać SAMYM shipping_total, bez VAT-u doliczonego do brutta.
      expect(mapujZamowienie(surowe, mapa).koszt_dostawy_netto).toBe('73.09');
    });

    it('darmowa dostawa → koszt netto 0.00, a nie null', () => {
      const zDarmowa = { ...surowe, shipping_total: '0.00', shipping_tax: '0.00' };
      expect(mapujZamowienie(zDarmowa, mapa).koszt_dostawy_netto).toBe('0.00');
    });

    // DOWÓD, że netto NIE jest liczone dzieleniem brutto/1,23: linia, dla której
    // brutto_linii/1,23 zaokrąglone do groszy daje LICZBĘ RÓŻNĄ od prawdziwego netto ze
    // sklepu. 81,30 (netto) + 18,70 (VAT, czyli STAWKA ~23%, ale NIE dokładnie 23% —
    // sprzedaż B2B z rabatem potrafi mieć inny efektywny VAT po zaokrągleniach) = 100,00
    // brutto. 100,00 / 1,23 = 81,300813... -> zaokrąglone 81,30 — więc dokładamy DRUGI,
    // ostrzejszy przypadek: 100,00 brutto zbudowane z netto 81,00 + VAT 19,00 (nietypowy,
    // ale to WŁAŚNIE dowodzi, że panel nie ma prawa zgadywać VAT-u z ilorazu).
    it('netto pochodzi ze sklepu, nie z dzielenia brutto przez 1,23 (VAT inny niż 23%)', () => {
      const nietypowy = {
        ...surowe,
        line_items: [{ name: 'STOP', sku: 'A', quantity: 1, total: '81.00', total_tax: '19.00' }],
      };
      const p = mapujZamowienie(nietypowy, mapa).pozycje[0];
      expect(p.brutto_linii).toBe('100.00');
      // Prawdziwe netto ze sklepu.
      expect(p.netto_linii).toBe('81.00');
      // Gdyby ktoś policzył netto dzieleniem brutto przez 1,23, wyszłoby 81,30 — inna liczba.
      expect(p.netto_linii).not.toBe((Number(p.brutto_linii) / 1.23).toFixed(2));
    });
  });

  // Kupony rabatowe (kampania WRZESIEN30, 2026-08-25) — mapowanie przenosi je z coupon_lines
  // ta sama reguła, co przeliczenie wstecz (domain/kupony.js). Dane zamówienia 28224.
  describe('kupony', () => {
    it('przenosi kod i rabat brutto z coupon_lines', () => {
      const zKuponem = {
        ...surowe,
        coupon_lines: [{ code: 'wrzesien30', discount: '47.29', discount_tax: '10.88' }],
      };
      expect(mapujZamowienie(zKuponem, mapa).kupony).toEqual([{ kod: 'wrzesien30', rabat: '58.17' }]);
    });

    it('zamówienie bez kuponów ma pustą listę', () => {
      expect(mapujZamowienie(surowe, mapa).kupony).toEqual([]);
    });
  });

  // ⚠️ TE ASERCJE POWSTALY PO WERYFIKACJI MUTACYJNEJ (Etap 3): testy widoku podaja
  // `atrybucja` WPROST w atrapie zamowienia, wiec przechodzily takze wtedy, gdy mapowanie
  // gubilo ja calkowicie. Na produkcji znaczyloby to poller, ktory przestaje zapisywac
  // zrodlo NOWYCH zamowien — a stare i tak maja je z przeliczenia wstecz, wiec ekran
  // wygladalby na dzialajacy.
  describe('atrybucja', () => {
    it('przenosi źródło, stronę wejścia i urządzenie z meta_data', () => {
      const zAtrybucja = {
        ...surowe,
        meta_data: [
          { key: '_wc_order_attribution_source_type', value: 'typein' },
          { key: '_wc_order_attribution_utm_source', value: '(direct)' },
          { key: '_wc_order_attribution_session_entry', value: 'https://szkicownia.pl/produkt/x/' },
          { key: '_wc_order_attribution_device_type', value: 'Mobile' },
        ],
      };
      expect(mapujZamowienie(zAtrybucja, mapa).atrybucja).toMatchObject({
        typ: 'typein', zrodlo: '(direct)', wejscie: 'https://szkicownia.pl/produkt/x/', urzadzenie: 'Mobile',
      });
    });

    // ⚠️ `null`, nie pusty obiekt: „sklep tego nie zapisał" to CO INNEGO niż „wejście
    // bezpośrednie" (21 produkcyjnych zamówień powstało przed włączeniem atrybucji).
    it('zamówienie bez pól atrybucji → null', () => {
      expect(mapujZamowienie(surowe, mapa).atrybucja).toBeNull();
    });
  });
});
