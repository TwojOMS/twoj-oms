import { describe, it, expect } from 'vitest';
import { wierszePozycji, podsumowaniePozycji } from '../../src/domena/tabela-pozycji.js';

const zamowienie = (nad = {}) => ({
  kwota_brutto: '212.90',
  koszt_dostawy_brutto: '89.90',
  koszt_dostawy_netto: '73.09',
  pozycje: [
    { nazwa: 'STOP', sku: 'PRO-STOP-001', ilosc: 2, cena_brutto: '61.50', cena_netto: '50.00', brutto_linii: '123.00', netto_linii: '100.00' },
  ],
  ...nad,
});

describe('wierszePozycji', () => {
  it('numeruje pozycje od 1 i przenosi nazwę/SKU/ilość/ceny', () => {
    const w = wierszePozycji(zamowienie());
    expect(w[0]).toMatchObject({
      lp: 1, nazwa: 'STOP', sku: 'PRO-STOP-001', ilosc: 2,
      cenaNetto: '50.00', cenaBrutto: '61.50', suma: '123.00', wysylka: false,
    });
  });

  it('brak brutto_linii → suma liczona fallbackiem cena_brutto × ilość (wiersz sprzed migracji)', () => {
    const z = zamowienie({
      pozycje: [{ nazwa: 'STOP', sku: null, ilosc: 2, cena_brutto: '61.50', cena_netto: null, brutto_linii: null, netto_linii: null }],
    });
    expect(wierszePozycji(z)[0].suma).toBe('123.00');
  });

  it('brak netto (wiersz sprzed migracji, bez surowe_json) → null, NIGDY dzielenie brutto', () => {
    const z = zamowienie({
      pozycje: [{ nazwa: 'STOP', sku: null, ilosc: 3, cena_brutto: '33.33', cena_netto: null, brutto_linii: '100.00', netto_linii: null }],
    });
    const w = wierszePozycji(z)[0];
    expect(w.cenaNetto).toBeNull();
    // Gdyby ktoś policzył netto dzieleniem brutto przez 1,23, wyszłoby coś innego niż null.
    expect(w.cenaNetto).not.toBe((100 / 1.23).toFixed(2));
  });

  // WYSYŁKA jako pełnoprawny wiersz — PRZEDOSTATNI, bo ostatni jest wiersz sumy.
  it('dokłada wysyłkę jako ostatni wiersz PRZED podsumowaniem', () => {
    const w = wierszePozycji(zamowienie());
    expect(w).toHaveLength(3);
    const wys = w[1];
    expect(wys.wysylka).toBe(true);
    expect(wys.nazwa).toBe('Wysyłka');
    expect(wys.cenaBrutto).toBe('89.90');
    expect(wys.cenaNetto).toBe('73.09');
    expect(wys.suma).toBe('89.90');
  });

  // Wysyłka JEST pozycją, więc ma numer i ilość — nie myślniki.
  it('wiersz wysyłki ma swój numer Lp. i ilość 1', () => {
    const wys = wierszePozycji(zamowienie())[1];
    expect(wys.lp).toBe(2);
    expect(wys.ilosc).toBe(1);
  });

  it('numer wysyłki idzie po ostatniej pozycji, także przy kilku pozycjach', () => {
    const z = zamowienie({
      pozycje: [
        { nazwa: 'A', ilosc: 1, cena_brutto: '10.00', brutto_linii: '10.00' },
        { nazwa: 'B', ilosc: 1, cena_brutto: '10.00', brutto_linii: '10.00' },
      ],
    });
    expect(wierszePozycji(z)[2]).toMatchObject({ wysylka: true, lp: 3, ilosc: 1 });
  });

  // Darmowa dostawa → wiersz wysyłki ZOSTAJE, z ZEREM, nie znika i nie jest pusty.
  it('darmowa dostawa → wiersz wysyłki z zerem, nie pominięty', () => {
    const z = zamowienie({ koszt_dostawy_brutto: '0.00', koszt_dostawy_netto: '0.00' });
    const w = wierszePozycji(z);
    expect(w).toHaveLength(3);
    const wys = w[1];
    expect(wys.suma).toBe('0.00');
    expect(wys.cenaBrutto).toBe('0.00');
    expect(wys.cenaNetto).toBe('0.00');
  });

  it('zamówienie bez pozycji → wysyłka i podsumowanie', () => {
    const w = wierszePozycji(zamowienie({ pozycje: [] }));
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ wysylka: true, lp: 1, ilosc: 1 });
  });

  it('wysyłka bez danych (NULL, stara baza) → suma 0.00, nie null i nie rzuca', () => {
    const z = zamowienie({ koszt_dostawy_brutto: null, koszt_dostawy_netto: null });
    const wys = wierszePozycji(z).at(-2);
    expect(wys.suma).toBe('0.00');
    expect(wys.cenaBrutto).toBeNull();
    expect(wys.cenaNetto).toBeNull();
  });
});

// Suma przestala byc akapitem POD tabela — jest jej OSTATNIM WIERSZEM.
describe('wierszePozycji — wiersz podsumowania', () => {
  it('OSTATNIM wierszem tabeli jest podsumowanie z sumą', () => {
    const w = wierszePozycji(zamowienie());
    const ostatni = w.at(-1);
    expect(ostatni.podsumowanie).toBe(true);
    expect(ostatni.suma).toBe('212.90');
    // ...i nic po nim nie idzie.
    expect(w.filter((r) => r.podsumowanie)).toHaveLength(1);
    expect(w.findIndex((r) => r.podsumowanie)).toBe(w.length - 1);
  });

  it('wiersz podsumowania nie udaje pozycji — bez Lp., bez ilości, bez cen jednostkowych', () => {
    const p = wierszePozycji(zamowienie()).at(-1);
    expect(p.lp).toBeNull();
    expect(p.ilosc).toBeNull();
    expect(p.cenaBrutto).toBeNull();
    expect(p.wysylka).toBe(false);
  });

  it('suma w wierszu podsumowania obejmuje pozycje dopisane ręcznie', () => {
    const z = zamowienie({
      pozycje: [
        { nazwa: 'STOP', ilosc: 2, cena_brutto: '61.50', brutto_linii: '123.00', zrodlo: 'sklep' },
        { nazwa: 'Dopłata', ilosc: 1, cena_brutto: '80.00', brutto_linii: '80.00', zrodlo: 'reczna', sklep: null },
      ],
    });
    expect(wierszePozycji(z).at(-1).suma).toBe('292.90');
  });

  it('uszkodzona kwota → wiersz podsumowania dalej jest, z myślnikiem zamiast sumy', () => {
    const z = zamowienie({ pozycje: [{ nazwa: 'X', ilosc: 1, cena_brutto: 'zła', brutto_linii: null }] });
    expect(() => wierszePozycji(z)).not.toThrow();
    expect(wierszePozycji(z).at(-1)).toMatchObject({ podsumowanie: true, suma: null });
  });
});

describe('wierszePozycji — pozycje ręczne i nadpisania', () => {
  const zReczna = () => zamowienie({
    kwota_brutto: '292.90',
    pozycje: [
      // Netto ze sklepu jest tu CELOWO nizsze niz brutto/1,23 (linia z rabatem) — inaczej
      // test nie odroznilby wartosci ze zrodla od wyliczonej ze stawki VAT.
      { nazwa: 'STOP', sku: 'PRO-STOP-001', ilosc: 2, cena_brutto: '61.50', cena_netto: '45.00', brutto_linii: '123.00', netto_linii: '90.00', zrodlo: 'sklep', klucz: 's1', polaZmienione: [] },
      { id: 91, nazwa: 'Dopłata', sku: null, ilosc: 1, cena_brutto: '80.00', cena_netto: null, brutto_linii: '80.00', netto_linii: null, zrodlo: 'reczna', sklep: null, klucz: 'r91', polaZmienione: [] },
    ],
  });

  it('pozycja dopisana ręcznie jest wyraźnie oznaczona', () => {
    const w = wierszePozycji(zReczna());
    expect(w[0].reczna).toBe(false);
    expect(w[1].reczna).toBe(true);
  });

  it('przenosi klucz pozycji (adres formularzy edycji i usunięcia)', () => {
    expect(wierszePozycji(zReczna())[1].klucz).toBe('r91');
  });

  it('ręczna pozycja wchodzi do tabeli razem ze sklepowymi, ponumerowana po kolei', () => {
    const w = wierszePozycji(zReczna());
    expect(w[0].lp).toBe(1);
    expect(w[1].lp).toBe(2);
    expect(w[2]).toMatchObject({ wysylka: true, lp: 3 });
  });

  // Netto pozycji ręcznej: tu WOLNO policzyć je ze stawki VAT, bo to operator podał brutto
  // i to ono jest wartością źródłową. WYŁĄCZNIE do pokazania.
  it('ręczna pozycja pokazuje netto policzone ze stawki VAT', () => {
    expect(wierszePozycji(zReczna())[1].cenaNetto).toBe('65.04');
  });

  it('pozycja ze sklepu dalej bierze netto ZE ŹRÓDŁA, nie z dzielenia brutta', () => {
    const w = wierszePozycji(zReczna())[0];
    expect(w.cenaNetto).toBe('45.00');
    expect(w.cenaNetto).not.toBe((61.5 / 1.23).toFixed(2));
  });

  // Linia przeceniona ręcznie: netto ze sklepu do niej nie pasuje, więc kolumnę liczy
  // stawka VAT — tak samo jak przy pozycji dopisanej.
  it('pozycja sklepowa z ręcznie zmienioną ceną pokazuje netto ze stawki VAT', () => {
    const z = zamowienie({
      pozycje: [{ nazwa: 'STOP', ilosc: 2, cena_brutto: '70.00', cena_netto: null, brutto_linii: '140.00', zrodlo: 'sklep', klucz: 's1', polaZmienione: ['cena_brutto'], sklep: { nazwa: 'STOP', ilosc: 2, cena_brutto: '61.50', brutto_linii: '123.00' } }],
    });
    expect(wierszePozycji(z)[0].cenaNetto).toBe('56.91');
  });

  const zNadpisaniem = () => zamowienie({
    pozycje: [{ nazwa: 'STOP', ilosc: 3, cena_brutto: '61.50', cena_netto: null, brutto_linii: '184.50', zrodlo: 'sklep', klucz: 's1', polaZmienione: ['ilosc'], sklep: { nazwa: 'STOP', ilosc: 2, cena_brutto: '61.50', brutto_linii: '123.00' } }],
  });

  it('przenosi listę pól zmienionych ręcznie (oznaczenie na karcie)', () => {
    expect(wierszePozycji(zNadpisaniem())[0].polaZmienione).toEqual(['ilosc']);
  });

  // Wartość EFEKTYWNA musi być tym, co widzi wszystko — także kolumna „Suma" i wiersz
  // „Razem". Liczenie dalej z wartości ze sklepu rozjechałoby tabelę z kwotą oczekiwaną
  // i panel krzyczałby o rozjeździe przy każdej poprawionej pozycji.
  it('kolumna „Suma" i wiersz „Razem" idą za wartością POPRAWIONĄ, nie sklepową', () => {
    const w = wierszePozycji(zNadpisaniem());
    expect(w[0].suma).toBe('184.50');
    expect(w.at(-1).suma).toBe('274.40');
  });

  it('poprawiona pozycja nie daje fałszywego rozjazdu z kwotą oczekiwaną', () => {
    expect(podsumowaniePozycji(zNadpisaniem())).toMatchObject({ zgadzaSie: true, oczekiwanaZl: '274.40' });
  });
});

describe('podsumowaniePozycji', () => {
  it('suma pozycji razem z wysyłką zgadza się z kwotą zamówienia → zgadzaSie: true', () => {
    const p = podsumowaniePozycji(zamowienie());
    expect(p.zgadzaSie).toBe(true);
    expect(p.sumaZl).toBe('212.90');
    expect(p.oczekiwanaZl).toBe('212.90');
  });

  // TO JEST SEDNO ZADANIA: suma MUSI obejmować wysyłkę, inaczej 123.00 (same pozycje)
  // "zgadzałoby się" tylko przypadkiem, gdyby ktoś zapomniał doliczyć koszt dostawy.
  it('suma liczona BEZ wysyłki dałaby fałszywe zgadzaSie — dowód, że funkcja jej nie pomija', () => {
    const p = podsumowaniePozycji(zamowienie());
    const samePozycje = '123.00';
    expect(p.sumaZl).not.toBe(samePozycje);
    expect(p.sumaZl).toBe('212.90');
  });

  it('rozjazd → zgadzaSie: false, obie kwoty w wyniku', () => {
    const p = podsumowaniePozycji(zamowienie({ kwota_brutto: '999.99' }));
    expect(p.zgadzaSie).toBe(false);
    expect(p.sumaZl).toBe('212.90');
    expect(p.oczekiwanaZl).toBe('999.99');
  });

  // Uszkodzona/pusta kwota NIE MA PRAWA wywalić karty — bariera i tak odmówi z tego samego
  // powodu przy próbie wystawienia faktury, ale karta ma się dalej wyrenderować.
  it('pusta kwota_brutto → zgadzaSie: false, nie rzuca', () => {
    expect(() => podsumowaniePozycji(zamowienie({ kwota_brutto: null }))).not.toThrow();
    const p = podsumowaniePozycji(zamowienie({ kwota_brutto: null }));
    expect(p.zgadzaSie).toBe(false);
  });

  it('uszkodzona cena pozycji → zgadzaSie: false, nie rzuca', () => {
    const z = zamowienie({ pozycje: [{ nazwa: 'X', ilosc: 1, cena_brutto: 'zła', brutto_linii: null }] });
    expect(() => podsumowaniePozycji(z)).not.toThrow();
    expect(podsumowaniePozycji(z).zgadzaSie).toBe(false);
  });

  // Porównanie MUSI iść na liczbach całkowitych w groszach — 61.50 + 61.50 + 89.90 = 212.90
  // dokładnie, ale gdyby ktoś porównywał floaty, wystarczy inny przykład, żeby to chybiło.
  it('porównanie na groszach, nie na floatach', () => {
    const z = zamowienie({
      kwota_brutto: '0.30',
      koszt_dostawy_brutto: '0.00',
      pozycje: [
        { nazwa: 'A', ilosc: 1, cena_brutto: '0.10', brutto_linii: '0.10' },
        { nazwa: 'B', ilosc: 1, cena_brutto: '0.10', brutto_linii: '0.10' },
        { nazwa: 'C', ilosc: 1, cena_brutto: '0.10', brutto_linii: '0.10' },
      ],
    });
    // 0.1 + 0.1 + 0.1 === 0.30000000000000004 we floatach JS — na groszach to musi być równe.
    expect(podsumowaniePozycji(z).zgadzaSie).toBe(true);
  });
});

// ============================================================================
// ZAMÓWIENIE Z OFERTY (wtyczka panelu indywidualnego) — 2026-08-21, zgłoszenie
// właściciela z zam. 1184 (nr 28216 w sklepie): „zobacz co tu się stało z wysyłką".
//
// Takie zamówienie przychodzi ze sklepu BEZ `shipping_lines` — transport jest zwykłą
// POZYCJĄ („wysyłka kurierem DPD", 19 zł, SKU zaślepki). Karta rysowała wtedy DWA wiersze
// wysyłki: prawdziwy za 19 zł jako produkt i własny, syntetyczny „Wysyłka 0,00" — czyli
// pokazywała transport dwa razy, w tym raz jako darmowy. Kwoty były cały czas dobre
// (sumują się do kwoty zamówienia); kłamał sam obraz.
// ============================================================================
const zOferty = (nad = {}) => zamowienie({
  kwota_brutto: '115.00',
  koszt_dostawy_brutto: '0.00',
  koszt_dostawy_netto: '0.00',
  pozycje: [
    { nazwa: 'szablon malarski jednorazowy - samoprzylepny RUM and towel', sku: 'psm-zam-placeholder', ilosc: 2, cena_brutto: '48.00', cena_netto: '48.00', brutto_linii: '96.00', netto_linii: '96.00' },
    { nazwa: 'wysyłka kurierem DPD', sku: 'psm-zam-placeholder', ilosc: 1, cena_brutto: '19.00', cena_netto: '19.00', brutto_linii: '19.00', netto_linii: '19.00' },
  ],
  ...nad,
});

describe('wierszePozycji — zamówienie z oferty (wysyłka jako pozycja)', () => {
  it('NIE dokłada pustego wiersza „Wysyłka 0,00", gdy transport jest już pozycją', () => {
    const w = wierszePozycji(zOferty());
    expect(w.filter((x) => x.wysylka)).toHaveLength(0);
    // Dwie pozycje + wiersz sumy, bez dziury w numeracji.
    expect(w).toHaveLength(3);
    expect(w[2].podsumowanie).toBe(true);
    expect(w.map((x) => x.lp)).toEqual([1, 2, null]);
  });

  it('suma pod tabelą się NIE zmienia — to poprawka obrazu, nie arytmetyki', () => {
    expect(podsumowaniePozycji(zOferty())).toMatchObject({ sumaZl: '115.00', oczekiwanaZl: '115.00', zgadzaSie: true });
  });

  // ⚠️ GRANICA PIERWSZA: darmowa dostawa ze zwykłego koszyka. Tam zero jest PRAWDĄ o transporcie,
  // a nie brakiem wiersza — i ma być widoczne (patrz poprawka z 20.08: „bez zmian wobec sklepu").
  it('darmowa dostawa BEZ pozycji transportowej → wiersz „Wysyłka 0,00" ZOSTAJE', () => {
    const z = zamowienie({
      kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00', koszt_dostawy_netto: '0.00',
    });
    const wys = wierszePozycji(z).find((x) => x.wysylka);
    expect(wys).toBeTruthy();
    expect(wys.cenaBrutto).toBe('0.00');
  });

  // ⚠️ GRANICA DRUGA: ekspres to nie transport. Zamówienie z „realizacją priorytetową", ale bez
  // wysyłki, musi dalej pokazywać wiersz wysyłki — inaczej nie byłoby gdzie wpisać transportu.
  it('realizacja priorytetowa NIE zdejmuje wiersza wysyłki', () => {
    const z = zOferty({
      kwota_brutto: '126.00',
      pozycje: [
        { nazwa: 'Pozycja indywidualna', sku: 'psm-zam-placeholder', ilosc: 1, cena_brutto: '96.00', brutto_linii: '96.00' },
        { nazwa: 'Realizacja priorytetowa', sku: 'psm-zam-placeholder', ilosc: 1, cena_brutto: '30.00', brutto_linii: '30.00' },
      ],
    });
    expect(wierszePozycji(z).filter((x) => x.wysylka)).toHaveLength(1);
  });

  // ⚠️ GRANICA TRZECIA, najważniejsza: wysyłka WYZEROWANA RĘCZNIE zostaje na ekranie. Bez tego
  // operator, który wpisał 0, traciłby jedyne miejsce, w którym da się to cofnąć.
  it('ręcznie wyzerowana wysyłka ZOSTAJE, choć pozycja transportowa istnieje', () => {
    const z = zOferty({
      kwota_brutto: '96.00',
      koszt_dostawy_brutto: '19.00',
      pozycje_reczne_json: JSON.stringify({ wysylka: { cena_brutto: '0.00' } }),
    });
    const wys = wierszePozycji(z).find((x) => x.wysylka);
    expect(wys).toBeTruthy();
    expect(wys.polaZmienione).toContain('cena_brutto');
  });

  it('płatna dostawa ze sklepu → wiersz zostaje, choć pozycja transportowa też jest', () => {
    const z = zOferty({ kwota_brutto: '134.00', koszt_dostawy_brutto: '19.00', koszt_dostawy_netto: '19.00' });
    expect(wierszePozycji(z).filter((x) => x.wysylka)).toHaveLength(1);
  });
});

describe('wierszePozycji — SKU zaślepki', () => {
  // ⚠️⚠️ REGRESJA Z 21.08.2026, ZGLOSZONA SLOWAMI „dlaczego te produkty są linkami?".
  // Pierwsza wersja tej poprawki gasila SKU WPROST w polu `sku` — a to po nim
  // `odnosnikPozycji` (domain/link-pozycji.js) poznaje pozycje z oferty. Napis znikal razem
  // z jedyna przeslanka reguly i KAZDA pozycja zamowienia z oferty dostawala odnosnik do
  // ukrytego produktu-zaslepki (`p=28040`, ten sam pod obiema pozycjami zam. 1184).
  it('wiersz NIESIE prawdziwe SKU, choć go nie pokazuje', () => {
    const w = wierszePozycji(zOferty())[0];
    expect(w.skuDoPokazania).toBeNull();
    expect(w.sku).toBe('psm-zam-placeholder');
  });

  // Zgłoszenie właściciela 2026-08-21: „psm-zam-placeholder — trzeba się tego pozbyć,
  // wyświetla się w mailach oraz na karcie zamówienia". To identyfikator UKRYTEGO produktu
  // technicznego, którym wtyczka wstawia każdą pozycję z oferty — dla czytającego kartę nie
  // znaczy nic, a stoi pod nazwą KAŻDEJ pozycji takiego zamówienia.
  it('nie pokazuje SKU zaślepki pod nazwą pozycji', () => {
    const w = wierszePozycji(zOferty());
    expect(w[0].skuDoPokazania).toBeNull();
    expect(w[1].skuDoPokazania).toBeNull();
  });

  it('prawdziwe SKU sklepowe zostaje nietknięte', () => {
    expect(wierszePozycji(zamowienie())[0].skuDoPokazania).toBe('PRO-STOP-001');
    expect(wierszePozycji(zamowienie())[0].sku).toBe('PRO-STOP-001');
  });

  // `startsWith`, a nie równość — tak samo, jak rozpoznaje to `czyPozycjaPlaceholdera`.
  it('wariant SKU z przyrostkiem też znika', () => {
    const z = zamowienie({
      pozycje: [{ nazwa: 'X', sku: 'psm-zam-placeholder-wysylka', ilosc: 1, cena_brutto: '10.00', brutto_linii: '10.00' }],
      kwota_brutto: '99.90',
    });
    expect(wierszePozycji(z)[0].skuDoPokazania).toBeNull();
    expect(wierszePozycji(z)[0].sku).toBe('psm-zam-placeholder-wysylka');
  });
});
