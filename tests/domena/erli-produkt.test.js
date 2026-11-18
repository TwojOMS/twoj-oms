import { describe, expect, it } from 'vitest';
import { produktErliZKarty } from '../../src/domena/erli-produkt.js';

function wejscie(zmiany = {}) {
  return {
    zdjecia: [{ sha256: 'a'.repeat(64), rozszerzenie: 'jpg', adres_zrodlowy: 'https://sklep.example/lampa.jpg' }],
    allegro: null,
    adresPublicznyZdjec: null,
    ...zmiany,
    // Nadpisanie części karty i ustawień nie usuwa pozostałych poprawnych pól.
    karta: {
      sku: 'LMP-101',
      nazwa: '  Lampa Pracownia Półcień  ',
      cena_gr: 5900,
      stawka_vat: '23',
      grupa_wariantow: null,
      kategoria_glowna: 'Lampy',
      opis: { sekcje: [{ elementy: [{ typ: 'tekst', html: '<p>Lampa z kloszem.</p>' }] }] },
      ...zmiany.karta,
    },
    ustawienia: {
      narzutBp: 1250,
      stalaIlosc: 7,
      czasWysylkiDni: 2,
      cennikDostaw: 'Lampy',
      stawkaVat: '8',
      ...zmiany.ustawienia,
    },
  };
}

describe('produkt ERLI z karty', () => {
  it.each([
    ['brak ceny', { karta: { cena_gr: null } }, /cenę/i],
    ['cena zero', { karta: { cena_gr: 0 } }, /cenę/i],
    ['cena ujemna', { karta: { cena_gr: -1 } }, /cenę/i],
    ['cena ułamkowa', { karta: { cena_gr: 1.5 } }, /cenę/i],
    ['brak zdjęć', { zdjecia: [] }, /zdjęcie/i],
    ['nazwa 151', { karta: { nazwa: 'a'.repeat(151) } }, /nazwę/i],
    ['nazwa 2', { karta: { nazwa: 'ab' } }, /nazwę/i],
    [
      'zdjęcie OMS bez adresu',
      { zdjecia: [{ sha256: 'a'.repeat(64), rozszerzenie: 'jpg', adres_zrodlowy: null }] },
      /publiczny adres zdjęć/i,
    ],
    ['brak ilości', { ustawienia: { stalaIlosc: null } }, /Ustaw stałą liczbę sztuk/i],
    ['narzut ujemny', { ustawienia: { narzutBp: -1 } }, /narzut/i],
    ['narzut ułamkowy', { ustawienia: { narzutBp: 12.5 } }, /narzut/i],
    ['brak narzutu', { ustawienia: { narzutBp: null } }, /narzut/i],
    ['brak czasu wysyłki', { ustawienia: { czasWysylkiDni: null } }, /czas wysyłki/i],
    ['brak cennika', { ustawienia: { cennikDostaw: ' ' } }, /cennik dostaw/i],
    ['brak VAT', { karta: { stawka_vat: null }, ustawienia: { stawkaVat: null } }, /stawkę VAT/i],
    [
      'niepoprawny opis',
      { karta: { opis: { sekcje: [{ elementy: [{ typ: 'tekst', html: '<script>zły</script>' }] }] } } },
      /opis/i,
    ],
    ['przepełnienie ceny', { karta: { cena_gr: Number.MAX_SAFE_INTEGER } }, /zakres/i],
  ])('%s blokuje żądanie i podaje instrukcję', (_nazwa, zmiany, komunikat) => {
    const wynik = produktErliZKarty(wejscie(zmiany));
    expect(wynik.zadanie).toBeNull();
    expect(wynik.bledy.some((b) => komunikat.test(b))).toBe(true);
  });

  it.each([
    [5900, 1250, 6638],
    [5900, 0, 5900],
    [1999, 1250, 2249],
    [1, 5000, 2],
  ])('cena %i groszy, narzut %i bp → %i groszy', (cena_gr, narzutBp, cena) => {
    const wynik = produktErliZKarty(wejscie({ karta: { cena_gr }, ustawienia: { narzutBp } }));
    expect(wynik.bledy).toEqual([]);
    expect(wynik.zadanie.price).toBe(cena);
  });

  it.each([3, 150])('przyjmuje nazwę długości %i po przycięciu', (dlugosc) => {
    const wynik = produktErliZKarty(wejscie({ karta: { nazwa: `  ${'a'.repeat(dlugosc)}  ` } }));
    expect(wynik.bledy).toEqual([]);
    expect(wynik.zadanie.name).toBe('a'.repeat(dlugosc));
  });

  it('zwraca dokładne ciało żądania bez EAN i archived', () => {
    expect(produktErliZKarty(wejscie())).toEqual({
      // E3d.02 D6: wynik niesie dobrany cennik do podglądu (tu dawne pole = jedna reguła „wszystko”).
      dostawa: { cennik: 'Lampy', powod: { rodzaj: 'wszystko', tekst: 'jeden cennik konta' } },
      bledy: [],
      ostrzezenia: [],
      zadanie: {
        name: 'Lampa Pracownia Półcień',
        description: { sections: [{ items: [{ type: 'TEXT', content: '<p>Lampa z kloszem.</p>' }] }] },
        images: [{ url: 'https://sklep.example/lampa.jpg' }],
        price: 6638,
        stock: 7,
        dispatchTime: { period: 2, unit: 'day' },
        deliveryPriceList: 'Lampy',
        taxRate: 'TAX_23',
        status: 'inactive',
        externalCategories: [{ source: 'shop', breadcrumb: [{ id: 'Lampy', name: 'Lampy' }] }],
        externalAttributes: [{ id: '11323', source: 'allegro', values: [{ id: '11323_1' }] }],
      },
    });
  });

  it.each(['https://zdjecia.example', 'https://zdjecia.example/'])(
    'składa zdjęcia OMS z bazą %s i zachowuje kolejność',
    (adres) => {
      const dane = wejscie({ adresPublicznyZdjec: adres });
      dane.zdjecia.push({ sha256: 'b'.repeat(64), rozszerzenie: 'jpg', adres_zrodlowy: null });
      const wynik = produktErliZKarty(dane);
      expect(wynik.bledy).toEqual([]);
      expect(wynik.zadanie.images).toEqual([
        { url: 'https://sklep.example/lampa.jpg' },
        { url: `https://zdjecia.example/z/${'b'.repeat(64)}.jpg` },
      ]);
    },
  );

  it('brak kategorii jest tylko ostrzeżeniem', () => {
    const wynik = produktErliZKarty(wejscie({ karta: { kategoria_glowna: null } }));
    expect(wynik.bledy).toEqual([]);
    expect(wynik.ostrzezenia).toContain('ERLI nie przypisze kategorii — przypisz ją w panelu ERLI.');
    expect(wynik.zadanie).not.toBeNull();
    expect(wynik.zadanie.externalCategories ?? []).toEqual([]);
  });

  it('kategoria Allegro ma pierwszeństwo i jawne źródło', () => {
    expect(produktErliZKarty(wejscie({ allegro: { kategoria_id: '123456' } })).zadanie.externalCategories).toEqual([
      { source: 'allegro', breadcrumb: [{ id: '123456' }] },
    ]);
  });

  it.each([null, '', '  '])('pusta stawka karty %s używa VAT z ustawień', (stawka_vat) => {
    expect(produktErliZKarty(wejscie({ karta: { stawka_vat } })).zadanie.taxRate).toBe('TAX_8');
  });

  it.each([null, { sekcje: [] }])('brak opisu %j tylko ostrzega', (opis) => {
    const wynik = produktErliZKarty(wejscie({ karta: { opis } }));
    expect(wynik.bledy).toEqual([]);
    expect(wynik.zadanie).not.toBeNull();
    expect(wynik.ostrzezenia.join(' ')).toMatch(/opis/i);
  });

  it.each([null, '', '  ', 'LMP-RODZIC'])('wariant %s wysyła tylko dla niepustej grupy', (grupa_wariantow) => {
    const wynik = produktErliZKarty(wejscie({ karta: { grupa_wariantow } }));
    if (grupa_wariantow?.trim()) expect(wynik.zadanie.externalVariantGroup).toBe(grupa_wariantow);
    else expect(wynik.zadanie).not.toHaveProperty('externalVariantGroup');
    expect(wynik.zadanie.status).toBe('inactive');
    expect(JSON.stringify(wynik.zadanie)).not.toContain('archived');
  });

  it('zbiera wszystkie błędy, a brak kategorii nadal jest ostrzeżeniem', () => {
    const wynik = produktErliZKarty(
      wejscie({
        karta: { nazwa: 'ab', cena_gr: null, kategoria_glowna: null, stawka_vat: null },
        zdjecia: [],
        ustawienia: { stalaIlosc: null, czasWysylkiDni: null, cennikDostaw: null, stawkaVat: null },
      }),
    );
    expect(wynik.bledy).toHaveLength(7);
    expect(wynik.ostrzezenia).toHaveLength(1);
    expect(wynik.zadanie).toBeNull();
  });

  it('nie zmienia obiektu wejściowego i daje powtarzalny wynik', () => {
    const dane = wejscie();
    const kopia = structuredClone(dane);
    const pierwszy = produktErliZKarty(dane);
    expect(produktErliZKarty(dane)).toEqual(pierwszy);
    expect(dane).toEqual(kopia);
  });

  it.each([
    ['zw', 'TAX_ZW'],
    ['ZW', 'TAX_ZW'],
    ['0', 'TAX_0'],
    ['5', 'TAX_5'],
  ])('stawka %s → %s', (stawka_vat, oczekiwana) => {
    expect(produktErliZKarty(wejscie({ karta: { stawka_vat } })).zadanie.taxRate).toBe(oczekiwana);
  });

  it.each(['abc', '23%', 'np', '7'])('nieobsługiwana stawka %s to błąd', (stawka_vat) => {
    const wynik = produktErliZKarty(wejscie({ karta: { stawka_vat } }));
    expect(wynik.zadanie).toBeNull();
    expect(wynik.bledy.join(' ')).toMatch(/nie jest obsługiwana w ERLI/);
  });

  it.each([
    ['ujemna ilość', { ustawienia: { stalaIlosc: -1 } }, /stałą liczbę sztuk/],
    ['ujemny czas wysyłki', { ustawienia: { czasWysylkiDni: -1 } }, /czas wysyłki/],
    [
      'zdjęcie bez skrótu',
      {
        adresPublicznyZdjec: 'https://zdjecia.example',
        zdjecia: [{ sha256: undefined, rozszerzenie: 'jpg', adres_zrodlowy: null }],
      },
      /skrót albo rozszerzenie/,
    ],
    [
      'zdjęcie z obcym rozszerzeniem',
      {
        adresPublicznyZdjec: 'https://zdjecia.example',
        zdjecia: [{ sha256: 'b'.repeat(64), rozszerzenie: 'gif', adres_zrodlowy: null }],
      },
      /skrót albo rozszerzenie/,
    ],
    [
      'adres zdjęć bez schematu',
      {
        adresPublicznyZdjec: 'zdjecia.example',
        zdjecia: [{ sha256: 'b'.repeat(64), rozszerzenie: 'jpg', adres_zrodlowy: null }],
      },
      /https:\/\//,
    ],
  ])('%s to błąd', (_nazwa, zmiany, komunikat) => {
    const wynik = produktErliZKarty(wejscie(zmiany));
    expect(wynik.zadanie).toBeNull();
    expect(wynik.bledy.join(' ')).toMatch(komunikat);
  });
});
