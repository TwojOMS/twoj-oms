import { describe, expect, it } from 'vitest';
import {
  TEKST_BRAK_WYMIAROW, dobierzCennik, regulyKonta, regulyZFormularza, sprawdzReguly,
} from '../../src/domena/cennik-dostaw.js';
import { brakiUstawienOfert } from '../../src/domena/erli-oferty-ustawienia.js';
import { ofertaAllegroZKarty } from '../../src/domena/allegro-oferta-z-karty.js';
import { produktErliZKarty } from '../../src/domena/erli-produkt.js';

// Dane zmyślone: lampy „Pracownia Półcień”, cenniki konta nazwane jak w panelu sprzedawcy (wymyślone).
// Limity reguł celowo nie są wymiarami żadnego przewoźnika — kod nie zna stałych InPost.
const REGULY = [
  { doMm: [80, 380, 640], doG: 25000, cennik: 'Mała paczka' },
  { doMm: [190, 380, 640], doG: 25000, cennik: 'Średnia paczka' },
  { cennik: 'Kurier gabaryt' },
];

function karta(zmiany = {}) {
  return { id: 7, szerokosc_mm: 300, wysokosc_mm: 50, glebokosc_mm: 200, waga_g: 1200, ...zmiany };
}
const regula = (numer, tekst) => ({ rodzaj: 'regula', numer, tekst });
const ODMOWA_WYMIARY = { odmowa: { kod: 'brak-wymiarow', tekst: TEKST_BRAK_WYMIAROW } };

describe('E3d.02 dobierzCennik — reguły rozmiaru konta', () => {
  it('pierwsza pasująca reguła wygrywa, powód podaje numer i limity w cm i kg', () => {
    expect(dobierzCennik({ karta: karta(), reguly: REGULY })).toEqual({
      cennik: 'Mała paczka', powod: regula(1, 'reguła 1: do 8×38×64 cm, 25 kg'),
    });
  });

  it('obrót: karta 64×8×38 mieści się w 8×38×64; limity zapisane w dowolnej kolejności też są obracane', () => {
    const k = karta({ szerokosc_mm: 640, wysokosc_mm: 80, glebokosc_mm: 380 });
    expect(dobierzCennik({ karta: k, reguly: REGULY }).cennik).toBe('Mała paczka');
    const odwrocone = [{ doMm: [640, 80, 380], doG: 25000, cennik: 'Mała paczka' }, { cennik: 'Kurier gabaryt' }];
    expect(dobierzCennik({ karta: karta({ szerokosc_mm: 370, wysokosc_mm: 630, glebokosc_mm: 75 }), reguly: odwrocone }).cennik)
      .toBe('Mała paczka');
  });

  it('wymiary i waga równe limitom mieszczą się', () => {
    const k = karta({ szerokosc_mm: 640, wysokosc_mm: 380, glebokosc_mm: 80, waga_g: 25000 });
    expect(dobierzCennik({ karta: k, reguly: REGULY }).cennik).toBe('Mała paczka');
  });

  it('1 mm ponad limit przechodzi do następnej reguły, 1 g ponad wszystkie — do „dla większych”', () => {
    const k = karta({ szerokosc_mm: 640, wysokosc_mm: 380, glebokosc_mm: 81 });
    expect(dobierzCennik({ karta: k, reguly: REGULY })).toEqual({
      cennik: 'Średnia paczka', powod: regula(2, 'reguła 2: do 19×38×64 cm, 25 kg'),
    });
    expect(dobierzCennik({ karta: karta({ waga_g: 25001 }), reguly: REGULY })).toEqual({
      cennik: 'Kurier gabaryt', powod: { rodzaj: 'wieksze', tekst: 'dla większych' },
    });
  });

  it('powód z ułamkami pisze przecinkiem', () => {
    const reguly = [{ doMm: [85, 405, 600], doG: 12500, cennik: 'A' }, { cennik: 'B' }];
    expect(dobierzCennik({ karta: karta(), reguly }).powod.tekst).toBe('reguła 1: do 8,5×40,5×60 cm, 12,5 kg');
  });

  it('wymiar częściowy (null, 0, ujemny) → odmowa brak-wymiarow z tekstem z planu', () => {
    for (const pole of ['szerokosc_mm', 'wysokosc_mm', 'glebokosc_mm']) {
      for (const zla of [null, 0, -5]) {
        expect(dobierzCennik({ karta: karta({ [pole]: zla }), reguly: REGULY })).toEqual(ODMOWA_WYMIARY);
      }
    }
    expect(TEKST_BRAK_WYMIAROW).toBe('Brak wymiarów/wagi — OMS nie wie, czy produkt zmieści się w paczkomacie. '
      + 'Uzupełnij wymiary albo ustaw cennik na karcie.');
  });

  it('brak wagi → odmowa, a nie „dla większych”', () => {
    for (const waga of [null, undefined, 0, -1]) {
      expect(dobierzCennik({ karta: karta({ waga_g: waga }), reguly: REGULY })).toEqual(ODMOWA_WYMIARY);
    }
  });

  it('wyjątek na karcie wygrywa z regułą i z odmową', () => {
    expect(dobierzCennik({ karta: karta(), reguly: REGULY, wyjatek: 'Kurier gabaryt' }))
      .toEqual({ cennik: 'Kurier gabaryt', powod: { rodzaj: 'wyjatek', tekst: 'wyjątek na karcie' } });
    const bezWymiarow = karta({ szerokosc_mm: null, waga_g: null });
    expect(dobierzCennik({ karta: bezWymiarow, reguly: REGULY, wyjatek: ' Mała paczka ' }))
      .toEqual({ cennik: 'Mała paczka', powod: { rodzaj: 'wyjatek', tekst: 'wyjątek na karcie' } });
    // Pusty wyjątek nie liczy się jako wyjątek.
    expect(dobierzCennik({ karta: karta(), reguly: REGULY, wyjatek: '  ' }).powod.rodzaj).toBe('regula');
  });

  it('jedna reguła „wszystko” działa bez wymiarów i wagi — jak dziś', () => {
    expect(dobierzCennik({ karta: { id: 9 }, reguly: [{ cennik: 'Lampy' }] }))
      .toEqual({ cennik: 'Lampy', powod: { rodzaj: 'wszystko', tekst: 'jeden cennik konta' } });
  });

  it('pusta lista → brak-cennika', () => {
    expect(dobierzCennik({ karta: karta(), reguly: [] })).toMatchObject({ odmowa: { kod: 'brak-cennika' } });
    expect(dobierzCennik({ karta: karta(), reguly: undefined })).toMatchObject({ odmowa: { kod: 'brak-cennika' } });
  });
});

describe('E3d.02 regulyKonta — alias D4', () => {
  it('lista cenniki ma pierwszeństwo, stare pole tekstowe daje jedną regułę „wszystko”', () => {
    expect(regulyKonta({ cenniki: REGULY, cennikDostaw: 'stary' })).toBe(REGULY);
    expect(regulyKonta({ cennikDostaw: ' Lampy ' })).toEqual([{ cennik: 'Lampy' }]);
    expect(regulyKonta({ cennikDostaw: '  ' })).toEqual([]);
    expect(regulyKonta(null)).toEqual([]);
  });

  it('lista z bazy z pustym cennikiem albo bez limitów w środku = konto bez cennika (odmowa, nie wyjątek)', () => {
    expect(regulyKonta({ cenniki: [{ cennik: '\t' }] })).toEqual([]);
    expect(regulyKonta({ cenniki: [{ cennik: 'A' }, { cennik: 'B' }] })).toEqual([]);
    expect(regulyKonta({ cenniki: [{ doMm: [10, 10], doG: 5, cennik: 'A' }, { cennik: 'B' }] })).toEqual([]);
    expect(dobierzCennik({ karta: null, reguly: regulyKonta({ cenniki: [{ cennik: ' ' }] }) }).odmowa.kod).toBe('brak-cennika');
  });
});

describe('E3d.02 sprawdzReguly', () => {
  it('przyjmuje poprawną listę i pustą listę', () => {
    expect(sprawdzReguly(REGULY)).toEqual({ reguly: REGULY, bledy: [] });
    expect(sprawdzReguly([])).toEqual({ reguly: [], bledy: [] });
  });

  it('wymaga „dla większych” na końcu i pełnych limitów w środku', () => {
    expect(sprawdzReguly([{ doMm: [1, 2, 3], doG: 10, cennik: 'A' }]).bledy.length).toBeGreaterThan(0);
    expect(sprawdzReguly([{ doMm: [1, 2], doG: 10, cennik: 'A' }, { cennik: 'B' }]).bledy.length).toBeGreaterThan(0);
    expect(sprawdzReguly([{ doMm: [1, 2, 0], doG: 10, cennik: 'A' }, { cennik: 'B' }]).bledy.length).toBeGreaterThan(0);
    expect(sprawdzReguly([{ doMm: [1, 2, 3], doG: null, cennik: 'A' }, { cennik: 'B' }]).bledy.length).toBeGreaterThan(0);
    expect(sprawdzReguly([{ doMm: [1, 2, 3], doG: 10, cennik: ' ' }, { cennik: 'B' }]).bledy.length).toBeGreaterThan(0);
    expect(sprawdzReguly([{ cennik: '' }]).bledy.length).toBeGreaterThan(0);
    expect(sprawdzReguly('x').bledy.length).toBeGreaterThan(0);
  });
});

describe('E3d.02 regulyZFormularza — cm i kg z pól tekstowych', () => {
  it('przelicza cm/kg na mm/g, pomija puste wiersze i dokleja „dla większych”', () => {
    const wiersze = [
      { a: '8', b: '38', c: '64', waga: '25', cennik: 'Mała paczka' },
      { a: '', b: '', c: '', waga: '', cennik: '' },
      { a: '19,5', b: '38', c: '64', waga: '0,5', cennik: 'Średnia paczka' },
    ];
    expect(regulyZFormularza(wiersze, 'Kurier gabaryt')).toEqual({
      reguly: [
        { doMm: [80, 380, 640], doG: 25000, cennik: 'Mała paczka' },
        { doMm: [195, 380, 640], doG: 500, cennik: 'Średnia paczka' },
        { cennik: 'Kurier gabaryt' },
      ],
      bledy: [],
    });
  });

  it('błędy wskazują wiersz; brak „dla większych” przy regułach to błąd', () => {
    const { bledy } = regulyZFormularza([{ a: 'x', b: '38', c: '64', waga: '25', cennik: 'A' }], '');
    expect(bledy.map((b) => b.wiersz)).toEqual([0, null]);
    expect(regulyZFormularza([], ' Lampy ')).toEqual({ reguly: [{ cennik: 'Lampy' }], bledy: [] });
    expect(regulyZFormularza([], '')).toEqual({ reguly: [], bledy: [] });
  });
});

describe('E3d.02 brakiUstawienOfert — cennik z listy reguł', () => {
  it('konto z regułami bez starego pola nie zgłasza braku cennika; konto bez niczego zgłasza', () => {
    const baza = { stalaIlosc: 5, czasWysylkiDni: 2, stawkaVat: '23', zwrotyId: 'z', reklamacjeId: 'r' };
    expect(brakiUstawienOfert({ ...baza, cennikDostaw: null, cenniki: REGULY }, 'erli')).not.toContain('cennik dostaw');
    expect(brakiUstawienOfert({ ...baza, cennikDostaw: null, cenniki: [] }, 'erli')).toContain('cennik dostaw');
    expect(brakiUstawienOfert({ ...baza, cennikDostaw: 'Lampy' }, 'erli')).not.toContain('cennik dostaw');
  });
});

// --- Budowniczowie ofert ---

function wejscieErli(zmiany = {}) {
  return {
    karta: {
      id: 101, sku: 'LMP-101', nazwa: 'Lampa Pracownia Półcień', ean: '5901234123457', cena_gr: 10000,
      stawka_vat: '23', marka: 'Pracownia Półcień', opis: null,
      szerokosc_mm: 300, wysokosc_mm: 50, glebokosc_mm: 200, waga_g: 1200,
      ...zmiany.karta,
    },
    ustawienia: {
      narzutBp: 1250, stalaIlosc: 7, czasWysylkiDni: 2, cennikDostaw: null, cenniki: REGULY, stawkaVat: '8',
      ...zmiany.ustawienia,
    },
    zdjecia: [{ id: 1, adres_zrodlowy: 'https://przyklad.invalid/lampa.jpg' }],
    ...zmiany.reszta,
  };
}

describe('E3d.02 produktErliZKarty — cennik z reguł', () => {
  it('deliveryPriceList z dopasowanej reguły i dobór w wyniku', () => {
    const w = produktErliZKarty(wejscieErli());
    expect(w.bledy).toEqual([]);
    expect(w.zadanie.deliveryPriceList).toBe('Mała paczka');
    expect(w.dostawa).toEqual({ cennik: 'Mała paczka', powod: regula(1, 'reguła 1: do 8×38×64 cm, 25 kg') });
  });

  it('karta bez wagi przy regułach rozmiaru → odmowa z tekstem z planu', () => {
    const w = produktErliZKarty(wejscieErli({ karta: { waga_g: null } }));
    expect(w.bledy).toContain(TEKST_BRAK_WYMIAROW);
    expect(w.zadanie).toBeNull();
  });

  it('wyjątek karty wygrywa', () => {
    const w = produktErliZKarty(wejscieErli({ reszta: { wyjatekCennika: 'Kurier gabaryt' } }));
    expect(w.zadanie.deliveryPriceList).toBe('Kurier gabaryt');
    expect(w.dostawa.powod.rodzaj).toBe('wyjatek');
  });

  it('stare pole cennikDostaw bez wymiarów działa jak dziś', () => {
    const w = produktErliZKarty(wejscieErli({
      karta: { szerokosc_mm: null, wysokosc_mm: null, glebokosc_mm: null, waga_g: null },
      ustawienia: { cenniki: undefined, cennikDostaw: 'Lampy' },
    }));
    expect(w.bledy).toEqual([]);
    expect(w.zadanie.deliveryPriceList).toBe('Lampy');
  });
});

// Lampa z importu Allegro (produkt z Katalogu, kategoria demo 257 „Lampy”) — ten sam kształt co w
// tests/domena/allegro-oferta-z-karty.test.js (`zImportu`), z wymiarami i wagą na karcie.
const KAT = '257';
function wejscieAllegro(zmiany = {}) {
  return {
    konto: { klucz: 'allegro-polcien', nazwa: 'Półcień Allegro' },
    znakInstalacji: 'OMS7',
    kategorieKarty: ['Lampy stołowe'],
    zdjecia: [{ id: 101, kolejnosc: 1, adres_zrodlowy: 'https://a.allegroimg.com/original/aa/sowa-1', sha256: '1'.repeat(64),
      typ: 'image/jpeg', ai: null, ai_reczne: 0 }],
    wgraneZdjecia: [],
    daneImportu: {
      kategoria_id: KAT, produkt_id: 'prod-sowa-30',
      parametry: {
        produkt: [{ id: '248811', nazwa: 'Marka', wartosci: [], wartosciId: ['248811_9001'], zakres: null }],
        oferta: [],
      },
    },
    kartaAllegro: null,
    mapaKategorii: [],
    reguly: [],
    opisyKategorii: {
      [KAT]: {
        wersja: 2, lisc: true, tworzenieProduktu: true, sciezka: [{ id: KAT, nazwa: 'Lampy' }],
        parametry: [{ id: '248811', nazwa: 'Marka', typ: 'dictionary', opisujeProdukt: true, wymagany: false, wymaganyDlaProduktu: true }],
      },
    },
    marki: [{ marka: 'Pracownia Półcień', parametrId: '248811', wartoscId: '248811_9001', kategorieSprawdzone: [KAT] }],
    producenciMarek: [],
    ofertyKarty: [],
    teraz: '2026-11-14T12:00:00.000Z',
    ...zmiany.reszta,
    karta: {
      id: 42, nazwa: 'Pracownia Półcień — Lampa Sowa 30 cm', sku: 'LMP-STO-001', ean: null, marka: 'Pracownia Półcień',
      cena_gr: 5900, stawka_vat: '23', kategoria_glowna: 'Lampy stołowe',
      szerokosc_mm: 255, wysokosc_mm: 60, glebokosc_mm: 70, waga_g: 900,
      opis: { sekcje: [{ elementy: [{ typ: 'tekst', html: '<p>Lampa z mlecznym kloszem.</p>' }] }] },
      informacja_bezpieczenstwa: JSON.stringify({ typ: 'TEXT', tekst: 'Nie zostawiaj włączonej lampy bez nadzoru.' }),
      ...zmiany.karta,
    },
    ustawienia: {
      klucz: 'allegro-polcien', narzutBp: 0, stalaIlosc: 5, czasWysylkiDni: 2, cennikDostaw: null, cenniki: REGULY,
      stawkaVat: '23', zwrotyId: 'zwrot-1', reklamacjeId: 'rekl-1', gwarancjaId: null, producentId: 'prod-konta',
      osobaOdpowiedzialnaId: null, bezpieczenstwoDomyslne: null, lokalizacja: null,
      ...zmiany.ustawienia,
    },
  };
}

describe('E3d.02 ofertaAllegroZKarty — cennik z reguł', () => {
  it('karta bez wymiarów przy regułach rozmiaru → błąd „cennik” z tekstem z planu i dobór w wyniku', () => {
    const w = ofertaAllegroZKarty(wejscieAllegro({ karta: { glebokosc_mm: null } }));
    expect(w.bledy).toContainEqual(expect.objectContaining({ kod: 'cennik', tekst: TEKST_BRAK_WYMIAROW }));
    expect(w.zadanie).toBeNull();
    expect(w.dostawa).toEqual(ODMOWA_WYMIARY);
  });

  it('dobór trafia do shippingRates.id, gdy oferta się buduje', () => {
    const w = ofertaAllegroZKarty(wejscieAllegro());
    expect(w.dostawa).toEqual({ cennik: 'Mała paczka', powod: regula(1, 'reguła 1: do 8×38×64 cm, 25 kg') });
    expect(w.bledy.filter((b) => b.kod === 'cennik')).toEqual([]);
    expect(w.bledy).toEqual([]);
    expect(JSON.stringify(w.zadanie)).toContain('"shippingRates":{"id":"Mała paczka"}');
  });

  it('wyjątek karty trafia do shippingRates.id', () => {
    const w = ofertaAllegroZKarty(wejscieAllegro({ reszta: { wyjatekCennika: 'Kurier gabaryt' },
      ustawienia: { slowniki: { cenniki: [{ id: 'Kurier gabaryt', nazwa: 'Kurier gabaryt' }] } } }));
    expect(w.dostawa).toEqual({ cennik: 'Kurier gabaryt', powod: { rodzaj: 'wyjatek', tekst: 'wyjątek na karcie' } });
    expect(w.bledy).toEqual([]);
    expect(JSON.stringify(w.zadanie)).toContain('"shippingRates":{"id":"Kurier gabaryt"}');
  });

  it('wyjątek karty spoza listy cenników konta przy tworzeniu oferty → odmowa (także bez pobranej listy)', () => {
    for (const ustawienia of [{ slowniki: { cenniki: [{ id: 'inny', nazwa: 'Inny' }] } }, {}]) {
      const w = ofertaAllegroZKarty(wejscieAllegro({ reszta: { wyjatekCennika: 'Kurier gabaryt', tworzenie: true }, ustawienia }));
      expect(w.bledy).toContainEqual({ kod: 'cennik', tekst: 'Cennik z karty nie istnieje już na koncie Allegro — wybierz inny' });
      expect(w.zadanie).toBeNull();
    }
  });

  it('wyjątek karty spoza listy poza tworzeniem (synchronizacja, wznowienie) → bez odmowy, cennik z karty', () => {
    for (const ustawienia of [{ slowniki: { cenniki: [{ id: 'inny', nazwa: 'Inny' }] } }, {}]) {
      const w = ofertaAllegroZKarty(wejscieAllegro({ reszta: { wyjatekCennika: 'Kurier gabaryt' }, ustawienia }));
      expect(w.bledy.filter(b => b.kod === 'cennik')).toEqual([]);
      expect(JSON.stringify(w.zadanie)).toContain('"shippingRates":{"id":"Kurier gabaryt"}');
    }
  });
});
