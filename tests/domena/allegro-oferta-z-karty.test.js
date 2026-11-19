import { describe, expect, it } from 'vitest';
import {
  PROBLEMY_ALLEGRO,
  ZNACZNIK_WGRANIA,
  ofertaAllegroZKarty,
  podstawWgraneZdjecia,
} from '../../src/domena/allegro-oferta-z-karty.js';
import { cenaZNarzutem, kwotaDziesietna } from '../../src/domena/cena-kanalu.js';
import { brakiUstawienOfert } from '../../src/domena/erli-oferty-ustawienia.js';

// Dane zmyślone: katalog lamp „Pracownia Półcień” (scripts/demo-dane-katalog.mjs), kategoria demo 257 „Lampy”.
const KAT = '257';
const KAT_INNA = '258';

function opisKategorii(zmiany = {}) {
  return {
    wersja: 2,
    lisc: true,
    tworzenieProduktu: true,
    sciezka: [
      { id: '5', nazwa: 'Dom' },
      { id: KAT, nazwa: 'Lampy' },
    ],
    parametry: [
      {
        id: '11323',
        nazwa: 'Stan',
        typ: 'dictionary',
        opisujeProdukt: false,
        wymagany: true,
        wymaganyDlaProduktu: false,
      },
      {
        id: '248811',
        nazwa: 'Marka',
        typ: 'dictionary',
        opisujeProdukt: true,
        wymagany: false,
        wymaganyDlaProduktu: true,
      },
      {
        id: '225693',
        nazwa: 'EAN (GTIN)',
        typ: 'string',
        opisujeProdukt: true,
        wymagany: false,
        wymaganyDlaProduktu: false,
      },
      {
        id: '4100',
        nazwa: 'Szerokość',
        typ: 'float',
        jednostka: 'cm',
        opisujeProdukt: true,
        wymagany: false,
        wymaganyDlaProduktu: true,
      },
      {
        id: '5100',
        nazwa: 'Kolor klosza',
        typ: 'string',
        opisujeProdukt: false,
        wymagany: false,
        wymaganyDlaProduktu: false,
      },
    ],
    ...zmiany,
  };
}

const REGULY = [
  { kategoriaAllegroId: KAT, parametrId: '11323', rodzaj: 'stala', wartosc: { valuesIds: ['11323_1'] } },
  { kategoriaAllegroId: KAT, parametrId: '248811', rodzaj: 'pole', pole: 'marka' },
  { kategoriaAllegroId: KAT, parametrId: '225693', rodzaj: 'pole', pole: 'ean' },
  { kategoriaAllegroId: KAT, parametrId: '4100', rodzaj: 'pole', pole: 'szerokosc_mm', przelicznik: 'mm_na_cm' },
  { kategoriaAllegroId: KAT, parametrId: '5100', rodzaj: 'na_karcie' },
];

function zdjecie(n, zmiany = {}) {
  return {
    id: 100 + n,
    kolejnosc: n,
    adres_zrodlowy: null,
    sha256: String(n % 10).repeat(64),
    typ: 'image/jpeg',
    ai: 0,
    ai_reczne: 1,
    ...zmiany,
  };
}

/** Karta bez EAN w zmapowanej kategorii — droga `nowy`. Zmiany nadpisują pola poziomu pierwszego i karty. */
function wejscie(zmiany = {}) {
  return {
    konto: { klucz: 'allegro-polcien', nazwa: 'Półcień Allegro' },
    znakInstalacji: 'OMS7',
    kategorieKarty: ['Lampy stołowe'],
    zdjecia: [zdjecie(1), zdjecie(2)],
    wgraneZdjecia: [],
    daneImportu: null,
    kartaAllegro: {
      nazwa: null,
      kategoria_id: null,
      produkt_id: null,
      parametry: [{ id: '5100', values: ['mleczny'] }],
    },
    mapaKategorii: [{ kategoriaKarty: 'Lampy stołowe', kategoriaAllegroId: KAT }],
    reguly: REGULY,
    opisyKategorii: {
      [KAT]: opisKategorii(),
      [KAT_INNA]: opisKategorii({ sciezka: [{ id: KAT_INNA, nazwa: 'Kinkiety' }] }),
    },
    marki: [
      {
        marka: 'Pracownia Półcień',
        parametrId: '248811',
        wartoscId: '248811_9001',
        kategorieSprawdzone: [KAT, KAT_INNA],
      },
    ],
    producenciMarek: [{ marka: 'Pracownia Półcień', zrodlo: 'konto' }],
    ofertyKarty: [],
    teraz: '2026-11-14T12:00:00.000Z',
    ...zmiany,
    karta: {
      id: 42,
      nazwa: 'Lampa stołowa Gliwka z kloszem',
      sku: 'LMP-STO-001',
      ean: null,
      marka: 'Pracownia Półcień',
      cena_gr: 5900,
      stawka_vat: '23',
      szerokosc_mm: 255,
      kategoria_glowna: 'Lampy stołowe',
      opis: { sekcje: [{ elementy: [{ typ: 'tekst', html: '<p>Lampa z mlecznym kloszem.</p>' }] }] },
      informacja_bezpieczenstwa: JSON.stringify({ typ: 'TEXT', tekst: 'Nie zostawiaj włączonej lampy bez nadzoru.' }),
      ...zmiany.karta,
    },
    ustawienia: {
      klucz: 'allegro-polcien',
      narzutBp: 0,
      stalaIlosc: 5,
      czasWysylkiDni: 2,
      cennikDostaw: 'cennik-1',
      stawkaVat: '23',
      zwrotyId: 'zwrot-1',
      reklamacjeId: 'rekl-1',
      gwarancjaId: null,
      producentId: 'prod-konta',
      osobaOdpowiedzialnaId: null,
      bezpieczenstwoDomyslne: null,
      lokalizacja: null,
      ...zmiany.ustawienia,
    },
  };
}

/** Lampa z importu Allegro: produkt z Katalogu, kategoria importu, bez reguł. */
function zImportu(zmiany = {}) {
  return wejscie({
    mapaKategorii: [],
    reguly: [],
    kartaAllegro: null,
    producenciMarek: [],
    daneImportu: {
      kategoria_id: KAT,
      produkt_id: 'prod-sowa-30',
      parametry: {
        produkt: [{ id: '248811', nazwa: 'Marka', wartosci: [], wartosciId: ['248811_9001'], zakres: null }],
        oferta: [{ id: '5100', nazwa: 'Kolor klosza', wartosci: ['mleczny'], wartosciId: null, zakres: null }],
      },
    },
    zdjecia: [zdjecie(1, { adres_zrodlowy: 'https://a.allegroimg.com/original/aa/sowa-1', ai: null, ai_reczne: 0 })],
    ...zmiany,
    karta: { nazwa: 'Pracownia Półcień — Lampa Sowa 30 cm', ...zmiany.karta },
  });
}

const kody = (lista) => lista.map((b) => b.kod);
const teksty = (lista) => lista.map((b) => b.tekst).join('\n');
const parametr = (lista, id) => (lista ?? []).find((p) => p.id === id);

describe('E3.06 — droga produktu (D34)', () => {
  it('lampa z importu → katalog-id, bez parametrów produktu', () => {
    const w = ofertaAllegroZKarty(zImportu());
    expect(w.bledy).toEqual([]);
    expect(w.droga).toBe('katalog-id');
    expect(w.zadanie.productSet[0].product).toEqual({ id: 'prod-sowa-30' });
    expect(parametr(w.zadanie.parameters, '248811')).toBeUndefined();
    expect(parametr(w.zadanie.parameters, '5100')).toEqual({ id: '5100', values: ['mleczny'] });
    expect(w.zadanie.name).toBe('Pracownia Półcień — Lampa Sowa 30 cm');
    expect(w.zadanie.category).toEqual({ id: KAT });
  });

  it('karta z EAN bez importu → ean, produkt po GTIN', () => {
    const w = ofertaAllegroZKarty(wejscie({ karta: { ean: '5901234123457' } }));
    expect(w.bledy).toEqual([]);
    expect(w.droga).toBe('ean');
    expect(w.zadanie.productSet[0].product).toEqual({ id: '5901234123457', idType: 'GTIN' });
    expect(parametr(w.zadanie.parameters, '248811')).toBeUndefined();
  });

  it('karta bez EAN w zmapowanej kategorii → nowy z parametrami z reguł, mm → cm', () => {
    const w = ofertaAllegroZKarty(wejscie());
    expect(w.bledy).toEqual([]);
    expect(w.droga).toBe('nowy');
    const produkt = w.zadanie.productSet[0].product;
    expect(produkt.name).toBe('Lampa stołowa Gliwka z kloszem');
    expect(produkt.category).toEqual({ id: KAT });
    expect(parametr(produkt.parameters, '248811')).toEqual({ id: '248811', valuesIds: ['248811_9001'] });
    expect(parametr(produkt.parameters, '4100')).toEqual({ id: '4100', values: ['25.50'] });
    expect(parametr(produkt.parameters, '11323')).toBeUndefined();
    expect(parametr(w.zadanie.parameters, '5100')).toEqual({ id: '5100', values: ['mleczny'] });
    expect(parametr(w.zadanie.parameters, '248811')).toBeUndefined();
    expect(produkt.images).toEqual(w.zadanie.images);
  });

  it('wybór „brak w Katalogu” z pętli → nowy mimo EAN; wybrany produkt → katalog-id', () => {
    expect(ofertaAllegroZKarty(wejscie({ karta: { ean: '5901234123457' }, katalog: { brak: true } })).droga).toBe(
      'nowy',
    );
    const w = ofertaAllegroZKarty(wejscie({ katalog: { produktId: 'prod-wybrany' } }));
    expect(w.droga).toBe('katalog-id');
    expect(w.zadanie.productSet[0].product).toEqual({ id: 'prod-wybrany' });
  });

  it('nadpisanie kategorii na karcie wygrywa z kategorią importu', () => {
    const w = ofertaAllegroZKarty(
      zImportu({
        kartaAllegro: { kategoria_id: KAT_INNA },
        producenciMarek: [{ marka: 'Pracownia Półcień', zrodlo: 'konto' }],
        karta: { ean: '5901234123457' },
      }),
    );
    expect(w.bledy).toEqual([]);
    expect(w.zadanie.category).toEqual({ id: KAT_INNA });
  });

  it('import w innej kategorii niż wybrana → produkt importu nie idzie (D34 pkt 1)', () => {
    const w = ofertaAllegroZKarty(
      zImportu({
        kartaAllegro: { kategoria_id: KAT_INNA },
        producenciMarek: [{ marka: 'Pracownia Półcień', zrodlo: 'konto' }],
        karta: { ean: '5901234123457' },
      }),
    );
    expect(w.droga).toBe('ean');
    expect(w.zadanie.productSet[0].product).toEqual({ id: '5901234123457', idType: 'GTIN' });
  });

  it('katalog-id: wymagany parametr produktu (EAN) pusty → bez błędu, parametry produktu pominięte', () => {
    const opis = opisKategorii();
    opis.parametry = opis.parametry.map((p) =>
      p.id === '225693' ? { ...p, wymagany: true, wymaganyDlaProduktu: true } : p,
    );
    const w = ofertaAllegroZKarty(wejscie({ katalog: { produktId: 'prod-wybrany' }, opisyKategorii: { [KAT]: opis } }));
    expect(w.bledy).toEqual([]);
    expect(w.droga).toBe('katalog-id');
    expect(parametr(w.zadanie.parameters, '225693')).toBeUndefined();
  });

  it('nowy w kategorii bez tworzenia produktów → błąd', () => {
    const w = ofertaAllegroZKarty(wejscie({ opisyKategorii: { [KAT]: opisKategorii({ tworzenieProduktu: false }) } }));
    expect(kody(w.bledy)).toContain('kategoria-bez-produktow');
    expect(w.zadanie).toBeNull();
  });

  it('GTIN wymagany dla produktu przy pustym EAN → błąd', () => {
    const opis = opisKategorii();
    opis.parametry = opis.parametry.map((p) => (p.id === '225693' ? { ...p, wymaganyDlaProduktu: true } : p));
    const w = ofertaAllegroZKarty(wejscie({ opisyKategorii: { [KAT]: opis } }));
    expect(teksty(w.bledy)).toMatch(/EAN/);
    expect(kody(w.bledy)).toContain('gtin');
  });

  it('parametr „uzupełnij na karcie” bez wartości na karcie nie trafia do oferty; wymagany → błąd', () => {
    const opis = opisKategorii();
    opis.parametry = opis.parametry.map((p) => (p.id === '5100' ? { ...p, wymagany: true } : p));
    const w = ofertaAllegroZKarty(wejscie({ kartaAllegro: null, opisyKategorii: { [KAT]: opis } }));
    expect(teksty(w.bledy)).toMatch(/Kolor klosza/);
  });

  it('PROBLEMY_ALLEGRO ma kształty z §4.0', () => {
    expect(Object.keys(PROBLEMY_ALLEGRO).sort()).toEqual(
      [
        'aktywacja',
        'bez-potwierdzenia',
        'brak-w-allegro',
        'duplikat',
        'komenda',
        'parameter-mismatch',
        'walidacja',
        'wiele-produktow',
        'zakonczona',
        'zdejmowanie',
      ].sort(),
    );
    expect(PROBLEMY_ALLEGRO.komenda('ilosc', 't')).toEqual({ kod: 'komenda', rodzaj: 'ilosc', tekst: 't' });
    expect(PROBLEMY_ALLEGRO.wieleProduktow ?? PROBLEMY_ALLEGRO['wiele-produktow']).toBeTypeOf('function');
    expect(PROBLEMY_ALLEGRO['wiele-produktow']([{ id: 'p1', nazwa: 'Lampa', ean: '1' }])).toEqual({
      kod: 'wiele-produktow',
      produkty: [{ id: 'p1', nazwa: 'Lampa', ean: '1' }],
    });
    expect(PROBLEMY_ALLEGRO['parameter-mismatch']('p2', '248811')).toEqual({
      kod: 'parameter-mismatch',
      produktId: 'p2',
      parametr: '248811',
    });
    expect(PROBLEMY_ALLEGRO.duplikat([{ id: 'o1', nazwa: 'L', status: 'INACTIVE' }])).toEqual({
      kod: 'duplikat',
      oferty: [{ id: 'o1', nazwa: 'L', status: 'INACTIVE' }],
    });
    expect(PROBLEMY_ALLEGRO.walidacja([{ kod: 'x', tekst: 'y' }])).toEqual({
      kod: 'walidacja',
      bledy: [{ kod: 'x', tekst: 'y' }],
    });
    expect(PROBLEMY_ALLEGRO.aktywacja('t')).toEqual({ kod: 'aktywacja', tekst: 't' });
    expect(PROBLEMY_ALLEGRO.zakonczona(3)).toEqual({ kod: 'zakonczona', sztuk: 3 });
    expect(PROBLEMY_ALLEGRO['brak-w-allegro']()).toEqual({ kod: 'brak-w-allegro' });
    expect(PROBLEMY_ALLEGRO['bez-potwierdzenia']()).toEqual({ kod: 'bez-potwierdzenia' });
    expect(PROBLEMY_ALLEGRO.zdejmowanie('t')).toEqual({ kod: 'zdejmowanie', tekst: 't' });
  });
});

describe('E3.06 — nazwa i kategoria (D33)', () => {
  it('nazwa 75 znaków przechodzi, 76 → błąd', () => {
    expect(ofertaAllegroZKarty(wejscie({ karta: { nazwa: 'L'.repeat(75) } })).bledy).toEqual([]);
    expect(kody(ofertaAllegroZKarty(wejscie({ karta: { nazwa: 'L'.repeat(76) } })).bledy)).toContain('nazwa');
  });

  it('nazwa 72 znaki z jednym & (= 76 po encjach) → błąd; 71 z & (= 75) przechodzi', () => {
    expect(kody(ofertaAllegroZKarty(wejscie({ karta: { nazwa: `${'L'.repeat(71)}&` } })).bledy)).toContain('nazwa');
    expect(ofertaAllegroZKarty(wejscie({ karta: { nazwa: `${'L'.repeat(70)}&` } })).bledy).toEqual([]);
  });

  it('pusta nazwa → błąd; nazwa z karty Allegro wygrywa', () => {
    expect(kody(ofertaAllegroZKarty(wejscie({ karta: { nazwa: '  ' } })).bledy)).toContain('nazwa');
    const w = ofertaAllegroZKarty(
      wejscie({
        kartaAllegro: { nazwa: 'Lampa Gliwka — wersja Allegro', parametry: [{ id: '5100', values: ['mleczny'] }] },
      }),
    );
    expect(w.zadanie.name).toBe('Lampa Gliwka — wersja Allegro');
  });

  it('karta w dwóch kategoriach, główna niezmapowana → druga + ostrzeżenie', () => {
    const w = ofertaAllegroZKarty(
      wejscie({
        kategorieKarty: ['Lampy stołowe', 'Kinkiety'],
        mapaKategorii: [{ kategoriaKarty: 'Kinkiety', kategoriaAllegroId: KAT }],
      }),
    );
    expect(w.bledy).toEqual([]);
    expect(w.zadanie.category).toEqual({ id: KAT });
    expect(teksty(w.ostrzezenia)).toMatch(/Kinkiety/);
  });

  it('żadna kategoria niezmapowana → błąd z odnośnikiem do Kategorii', () => {
    const w = ofertaAllegroZKarty(wejscie({ mapaKategorii: [] }));
    expect(kody(w.bledy)).toContain('kategoria');
    expect(teksty(w.bledy)).toMatch(/Magazyn → Kategorie/);
    expect(w.bledy.find((b) => b.kod === 'kategoria').adres).toBe('/magazyn/kategorie');
  });

  it('nadpisanie kategorii na karcie wygrywa z mapą; kategoria nie-liść → błąd', () => {
    const w = ofertaAllegroZKarty(
      wejscie({
        kartaAllegro: { kategoria_id: KAT_INNA, parametry: [] },
        reguly: [...REGULY, ...REGULY.map((r) => ({ ...r, kategoriaAllegroId: KAT_INNA }))],
      }),
    );
    expect(w.zadanie.category).toEqual({ id: KAT_INNA });
    const lisc = ofertaAllegroZKarty(wejscie({ opisyKategorii: { [KAT]: opisKategorii({ lisc: false }) } }));
    expect(kody(lisc.bledy)).toContain('kategoria-nie-lisc');
  });

  it('brak opisu kategorii w pamięci → błąd', () => {
    const w = ofertaAllegroZKarty(wejscie({ opisyKategorii: {} }));
    expect(teksty(w.bledy)).toMatch(/pobierz opis kategorii/i);
  });
});

describe('E3.06 — marka (D36) i GPSR (D35)', () => {
  it('brak marki w mapie → błąd z odnośnikiem do Marek', () => {
    const w = ofertaAllegroZKarty(wejscie({ marki: [] }));
    const blad = w.bledy.find((b) => b.kod === 'marka');
    expect(blad.tekst).toMatch(/Pracownia Półcień/);
    expect(blad.adres).toBe('/magazyn/producenci#marki');
  });

  it('marka zmapowana, kategoria spoza listy sprawdzonych → błąd', () => {
    const w = ofertaAllegroZKarty(
      wejscie({
        marki: [
          {
            marka: 'Pracownia Półcień',
            parametrId: '248811',
            wartoscId: '248811_9001',
            kategorieSprawdzone: [KAT_INNA],
          },
        ],
      }),
    );
    expect(teksty(w.bledy)).toMatch(/sprawdź markę Pracownia Półcień w kategorii Lampy/i);
  });

  it('marka zmapowana na „bez marki” przy wymaganej Marce → błąd z odnośnikiem do Marek; niewymagana → bez parametru', () => {
    const marki = [
      { marka: 'Pracownia Półcień', parametrId: '248811', wartoscId: '', wartoscTekst: '', kategorieSprawdzone: [KAT] },
    ];
    const w = ofertaAllegroZKarty(wejscie({ marki }));
    const blad = w.bledy.find((b) => b.kod === 'marka');
    expect(blad?.adres).toBe('/magazyn/producenci#marki');
    expect(blad.tekst).toMatch(/Pracownia Półcień/);
    expect(w.zadanie).toBeNull();
    const opis = opisKategorii();
    opis.parametry = opis.parametry.map((p) => (p.id === '248811' ? { ...p, wymaganyDlaProduktu: false } : p));
    const luzna = ofertaAllegroZKarty(wejscie({ marki, opisyKategorii: { [KAT]: opis } }));
    expect(luzna.bledy).toEqual([]);
    expect(parametr(luzna.zadanie.productSet[0].product.parameters, '248811')).toBeUndefined();
  });

  it('marka „Inna” bez przypisania producenta → błąd', () => {
    const w = ofertaAllegroZKarty(
      wejscie({
        karta: { marka: 'Inna' },
        marki: [{ marka: 'Inna', parametrId: '248811', wartoscId: '248811_9100', kategorieSprawdzone: [KAT] }],
      }),
    );
    expect(teksty(w.bledy)).toMatch(/przypisz producenta marki Inna na koncie Półcień Allegro/i);
  });

  it('karta bez marki → producent konta', () => {
    const opis = opisKategorii();
    opis.parametry = opis.parametry.map((p) => (p.id === '248811' ? { ...p, wymaganyDlaProduktu: false } : p));
    const w = ofertaAllegroZKarty(wejscie({ karta: { marka: null }, opisyKategorii: { [KAT]: opis } }));
    expect(w.bledy).toEqual([]);
    expect(w.zadanie.productSet[0].responsibleProducer).toEqual({ type: 'ID', id: 'prod-konta' });
  });

  it('marka przypisana „wybrany” → producent z listy i osoba odpowiedzialna', () => {
    const w = ofertaAllegroZKarty(
      wejscie({
        producenciMarek: [
          { marka: 'Pracownia Półcień', zrodlo: 'wybrany', producentId: 'prod-x', osobaOdpowiedzialnaId: 'osoba-y' },
        ],
      }),
    );
    expect(w.zadanie.productSet[0].responsibleProducer).toEqual({ type: 'ID', id: 'prod-x' });
    expect(w.zadanie.productSet[0].responsiblePerson).toEqual({ id: 'osoba-y' });
  });

  it('katalog-id bez przypisania marki → żądanie bez responsibleProducer', () => {
    const w = ofertaAllegroZKarty(zImportu());
    expect(w.bledy).toEqual([]);
    expect(w.zadanie.productSet[0]).not.toHaveProperty('responsibleProducer');
  });

  it('informacja TEXT → safetyInformation tekstem', () => {
    const w = ofertaAllegroZKarty(wejscie());
    expect(w.zadanie.productSet[0].safetyInformation).toEqual({
      type: 'TEXT',
      description: 'Nie zostawiaj włączonej lampy bez nadzoru.',
    });
  });

  it('ATTACHMENTS z innego konta → błąd; z tego konta → załączniki', () => {
    const zal = (konto) => JSON.stringify({ typ: 'ATTACHMENTS', konto, zalaczniki: [{ id: 'zal-1' }] });
    const obce = ofertaAllegroZKarty(wejscie({ karta: { informacja_bezpieczenstwa: zal('allegro-inne') } }));
    expect(teksty(obce.bledy)).toMatch(/wpisz informację tekstem/);
    const swoje = ofertaAllegroZKarty(wejscie({ karta: { informacja_bezpieczenstwa: zal('allegro-polcien') } }));
    expect(swoje.zadanie.productSet[0].safetyInformation).toEqual({
      type: 'ATTACHMENTS',
      attachments: [{ id: 'zal-1' }],
    });
  });

  it('brak informacji → tekst domyślny konta, a bez niego błąd', () => {
    const zDomyslnym = ofertaAllegroZKarty(
      wejscie({
        karta: { informacja_bezpieczenstwa: null },
        ustawienia: { bezpieczenstwoDomyslne: 'Instrukcja w pudełku.' },
      }),
    );
    expect(zDomyslnym.zadanie.productSet[0].safetyInformation).toEqual({
      type: 'TEXT',
      description: 'Instrukcja w pudełku.',
    });
    const bez = ofertaAllegroZKarty(wejscie({ karta: { informacja_bezpieczenstwa: null } }));
    expect(kody(bez.bledy)).toContain('bezpieczenstwo');
  });
});

describe('E3.06 — zdjęcia (D32) i opis', () => {
  it('zdjęcie ai NULL → błąd', () => {
    const w = ofertaAllegroZKarty(wejscie({ zdjecia: [zdjecie(1), zdjecie(2, { ai: null })] }));
    expect(teksty(w.bledy)).toMatch(/określ, czy zdjęcie 2 jest wygenerowane przez AI/i);
  });

  it('allegroimg z ai_reczne = 1 → błąd; z ai_reczne = 0 → adres bez wgrywania', () => {
    const adres = 'https://7.allegroimg.com/original/aa/lampa';
    const reczne = ofertaAllegroZKarty(
      wejscie({ zdjecia: [zdjecie(1, { adres_zrodlowy: adres, ai: 1, ai_reczne: 1 })] }),
    );
    expect(kody(reczne.bledy)).toContain('zdjecie-ai');
    const imp = ofertaAllegroZKarty(wejscie({ zdjecia: [zdjecie(1, { adres_zrodlowy: adres, ai: 0, ai_reczne: 0 })] }));
    expect(imp.bledy).toEqual([]);
    expect(imp.zadanie.images).toEqual([adres]);
    expect(imp.doWgrania).toEqual([]);
  });

  it('wgrane zdjęcie z innym ai → błąd; z tym samym → adres z mapy; wygasłe → do wgrania', () => {
    const inne = ofertaAllegroZKarty(
      wejscie({ wgraneZdjecia: [{ zdjecie_id: 101, adres: 'https://a.allegroimg.com/x1', ai: 1, wygasa_at: null }] }),
    );
    expect(teksty(inne.bledy)).toMatch(/zdjęcie 1 wgrano do Allegro z innym oznaczeniem AI/i);
    const to = ofertaAllegroZKarty(
      wejscie({
        wgraneZdjecia: [
          { zdjecie_id: 101, adres: 'https://a.allegroimg.com/x1', ai: 0, wygasa_at: '2026-12-01T00:00:00Z' },
        ],
      }),
    );
    expect(to.zadanie.images[0]).toBe('https://a.allegroimg.com/x1');
    expect(to.doWgrania.map((z) => z.id)).toEqual([102]);
    const stare = ofertaAllegroZKarty(
      wejscie({
        wgraneZdjecia: [
          { zdjecie_id: 101, adres: 'https://a.allegroimg.com/x1', ai: 0, wygasa_at: '2026-11-01T00:00:00Z' },
        ],
      }),
    );
    expect(stare.doWgrania.map((z) => z.id)).toEqual([101, 102]);
    expect(stare.zadanie.images).toEqual([`${ZNACZNIK_WGRANIA}101`, `${ZNACZNIK_WGRANIA}102`]);
  });

  it('0 zdjęć → błąd', () => {
    expect(kody(ofertaAllegroZKarty(wejscie({ zdjecia: [] })).bledy)).toContain('zdjecia');
  });

  it('karta z 18 zdjęciami → 16 w images + ostrzeżenie', () => {
    const zdjecia = Array.from({ length: 18 }, (_, i) => zdjecie(i + 1));
    const w = ofertaAllegroZKarty(wejscie({ zdjecia }));
    expect(w.bledy).toEqual([]);
    expect(w.zadanie.images).toHaveLength(16);
    expect(w.doWgrania).toHaveLength(16);
    expect(teksty(w.ostrzezenia)).toMatch(/Allegro przyjmie 16 z 18 zdjęć/);
  });

  it('opis: zdjęcie z galerii → IMAGE z adresem z images; spoza galerii → błąd; podstawienie po wgraniu', () => {
    const adres = 'https://sklep.example/gliwka.jpg';
    const opis = {
      sekcje: [
        {
          elementy: [
            { typ: 'zdjecie', adres },
            { typ: 'tekst', html: '<p>Klosz.</p>' },
          ],
        },
      ],
    };
    const w = ofertaAllegroZKarty(wejscie({ karta: { opis }, zdjecia: [zdjecie(1, { adres_zrodlowy: adres })] }));
    expect(w.bledy).toEqual([]);
    expect(w.zadanie.description.sections[0].items[0]).toEqual({ type: 'IMAGE', url: `${ZNACZNIK_WGRANIA}101` });
    const po = podstawWgraneZdjecia(w.zadanie, { 101: 'https://a.allegroimg.com/nowe' });
    expect(po.images).toEqual(['https://a.allegroimg.com/nowe']);
    expect(po.description.sections[0].items[0].url).toBe('https://a.allegroimg.com/nowe');
    expect(po.productSet[0].product.images).toEqual(['https://a.allegroimg.com/nowe']);
    const obce = ofertaAllegroZKarty(
      wejscie({
        karta: { opis: { sekcje: [{ elementy: [{ typ: 'zdjecie', adres: 'https://obcy.example/x.jpg' }] }] } },
      }),
    );
    expect(kody(obce.bledy)).toContain('opis');
  });
});

describe('E3.06 — parametr „Stan”, cena, VAT i pozostałe pola', () => {
  it('każde żądanie ma parametr „Stan” w parameters[]', () => {
    for (const w of [
      ofertaAllegroZKarty(zImportu()),
      ofertaAllegroZKarty(wejscie({ karta: { ean: '5901234123457' } })),
      ofertaAllegroZKarty(wejscie()),
    ]) {
      expect(w.bledy).toEqual([]);
      expect(parametr(w.zadanie.parameters, '11323')).toEqual({ id: '11323', valuesIds: ['11323_1'] });
    }
  });

  it('narzut 12,5% od 59,00 zł = "66.38"', () => {
    const w = ofertaAllegroZKarty(wejscie({ ustawienia: { narzutBp: 1250 } }));
    expect(w.zadanie.sellingMode).toEqual({ format: 'BUY_NOW', price: { amount: '66.38', currency: 'PLN' } });
  });

  it('T-M1: ręczna cena konta 105 zł wygrywa z narzutem; bez ręcznej złoty wynik bez zmian', () => {
    const bezRecznej = ofertaAllegroZKarty(wejscie({ ustawienia: { narzutBp: 1250 }, recznaGr: null }));
    expect(bezRecznej.bledy).toEqual([]);
    expect(bezRecznej.zadanie.sellingMode.price).toEqual({ amount: '66.38', currency: 'PLN' });
    const zReczna = ofertaAllegroZKarty(wejscie({ ustawienia: { narzutBp: 1250 }, recznaGr: 10500 }));
    expect(zReczna.bledy).toEqual([]);
    expect(zReczna.zadanie.sellingMode).toEqual({ format: 'BUY_NOW', price: { amount: '105.00', currency: 'PLN' } });
    // Ręczna cena nie zależy od ceny karty: karta bez ceny i tak daje ofertę po cenie ustawionej dla konta.
    const bezCenyKarty = ofertaAllegroZKarty(wejscie({ karta: { cena_gr: 0 }, recznaGr: 10500 }));
    expect(bezCenyKarty.bledy).toEqual([]);
    expect(bezCenyKarty.zadanie.sellingMode.price.amount).toBe('105.00');
  });

  it('T-M1: błędna ręczna cena → błąd ceny, bez cichego przejścia na narzut', () => {
    for (const recznaGr of [0, -100, 104.5]) {
      const w = ofertaAllegroZKarty(wejscie({ ustawienia: { narzutBp: 1250 }, recznaGr }));
      expect(w.zadanie).toBeNull();
      expect(w.bledy).toEqual([{ kod: 'cena', tekst: expect.stringContaining('Ręczna cena') }]);
    }
  });

  it('cena-kanalu: zaokrąglenie połówką w górę i zapis kwoty', () => {
    expect(cenaZNarzutem(5900, 1250)).toEqual({ bledy: [], grosze: 6638 });
    expect(cenaZNarzutem(5900, 0)).toEqual({ bledy: [], grosze: 5900 });
    expect(cenaZNarzutem(0, 1250).bledy).toEqual(['cena']);
    expect(cenaZNarzutem(5900, -1).bledy).toEqual(['narzut']);
    expect(cenaZNarzutem(Number.MAX_SAFE_INTEGER, 10000).bledy).toEqual(['zakres']);
    expect(kwotaDziesietna(6638)).toBe('66.38');
    expect(kwotaDziesietna(5)).toBe('0.05');
    expect(kwotaDziesietna(100000)).toBe('1000.00');
  });

  it('ilość z ustawień (D14), bez wartości domyślnej', () => {
    expect(ofertaAllegroZKarty(wejscie()).zadanie.stock).toEqual({ available: 5, unit: 'UNIT' });
    expect(teksty(ofertaAllegroZKarty(wejscie({ ustawienia: { stalaIlosc: null } })).bledy)).toMatch(
      /stała liczba sztuk/,
    );
  });

  it('handlingTime: najbliższa dozwolona wartość nie krótsza; dostawa i warunki po id', () => {
    const czas = (dni) =>
      ofertaAllegroZKarty(wejscie({ ustawienia: { czasWysylkiDni: dni } })).zadanie.delivery.handlingTime;
    expect(czas(0)).toBe('PT0S');
    expect(czas(1)).toBe('PT24H');
    expect(czas(2)).toBe('P2D');
    expect(czas(6)).toBe('P7D');
    expect(czas(15)).toBe('P21D');
    expect(kody(ofertaAllegroZKarty(wejscie({ ustawienia: { czasWysylkiDni: 61 } })).bledy)).toContain('czas-wysylki');
    const w = ofertaAllegroZKarty(wejscie({ ustawienia: { gwarancjaId: 'gw-1' } }));
    expect(w.zadanie.delivery.shippingRates).toEqual({ id: 'cennik-1' });
    expect(w.zadanie.afterSalesServices).toEqual({
      returnPolicy: { id: 'zwrot-1' },
      impliedWarranty: { id: 'rekl-1' },
      warranty: { id: 'gw-1' },
    });
    expect(ofertaAllegroZKarty(wejscie()).zadanie.afterSalesServices).not.toHaveProperty('warranty');
  });

  it('taxSettings ze stawki karty albo konta; zw → exemption', () => {
    expect(ofertaAllegroZKarty(wejscie()).zadanie.taxSettings).toEqual({
      subject: 'GOODS',
      rates: [{ rate: '23.00', countryCode: 'PL' }],
    });
    expect(
      ofertaAllegroZKarty(wejscie({ karta: { stawka_vat: null }, ustawienia: { stawkaVat: '8' } })).zadanie.taxSettings
        .rates,
    ).toEqual([{ rate: '8.00', countryCode: 'PL' }]);
    const zw = ofertaAllegroZKarty(wejscie({ karta: { stawka_vat: 'zw' } })).zadanie.taxSettings;
    expect(zw.subject).toBe('GOODS');
    expect(typeof zw.exemption).toBe('string');
    expect(zw.exemption.length).toBeGreaterThan(0);
  });

  it('external.id (D31), szkic, język; brak znaku instalacji → błąd', () => {
    const z = ofertaAllegroZKarty(wejscie()).zadanie;
    expect(z.external).toEqual({ id: 'OMS7-K42' });
    expect(z.publication).toEqual({ status: 'INACTIVE' });
    expect(z.language).toBe('pl-PL');
    expect(kody(ofertaAllegroZKarty(wejscie({ znakInstalacji: '' })).bledy)).toContain('znak-instalacji');
  });

  it('D43: ≥ 2 aktywne albo czekające oferty karty → ostrzeżenie', () => {
    const jedna = ofertaAllegroZKarty(
      wejscie({
        ofertyKarty: [
          { zrodlo: 'rejestr', stan: 'aktywna' },
          { zrodlo: 'lustro', stan: 'ENDED' },
        ],
      }),
    );
    expect(kody(jedna.ostrzezenia)).not.toContain('dwie-oferty');
    const dwie = ofertaAllegroZKarty(
      wejscie({
        ofertyKarty: [
          { zrodlo: 'rejestr', stan: 'sprawdzana' },
          { zrodlo: 'lustro', stan: 'ACTIVE' },
        ],
      }),
    );
    expect(kody(dwie.ostrzezenia)).toContain('dwie-oferty');
  });

  it('braki ustawień konta Allegro: zwroty i reklamacje; ERLI bez zmian', () => {
    expect(brakiUstawienOfert(null)).toEqual(['stała liczba sztuk', 'czas wysyłki', 'cennik dostaw', 'stawka VAT']);
    expect(brakiUstawienOfert(null, 'allegro')).toEqual([
      'stała liczba sztuk',
      'czas wysyłki',
      'cennik dostaw',
      'stawka VAT',
      'warunki zwrotów',
      'warunki reklamacji',
    ]);
    expect(
      brakiUstawienOfert(
        { stalaIlosc: 1, czasWysylkiDni: 1, cennikDostaw: 'c', stawkaVat: '23', zwrotyId: 'z', reklamacjeId: 'r' },
        'allegro',
      ),
    ).toEqual([]);
    expect(teksty(ofertaAllegroZKarty(wejscie({ ustawienia: { zwrotyId: null } })).bledy)).toMatch(/warunki zwrotów/);
  });
});
