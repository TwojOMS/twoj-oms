// PRZ-060: cenniki „Dodaj z magazynu" z konfiguracji instalacji zamiast stałych z nazwami sklepów.
// Bez OMS_CENNIKI → neutralnie (sklepy Woo z OMS_KANALY); z wartościami produkcji właściciela →
// dokładnie te same napisy, co przed PRZ-060 (literały skopiowane z 80e84f6).
import { describe, it, expect } from 'vitest';
import { cenniki, parsujCenniki, cennikDlaZamowienia, pozycjaZProduktu } from '../../../src/domena/magazyn-do-zamowienia.js';
import { konfiguracjaZamowien } from '../../../src/moduly/zamowienia/konfiguracja.ts';

const seller = { OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000', OMS_PROFORMY_KATALOG: '/synthetic/unused' };
const definicje = [
  { klucz: 'sklep_a', typ: 'woo', prefiks: 'SKLEP_A', etykieta: 'Sklep A' },
  { klucz: 'allegro_a', typ: 'allegro', prefiks: 'ALLEGRO_A' },
  { klucz: 'sklep_b', typ: 'woo', prefiks: 'SKLEP_B' },
];
// Wartość OMS_CENNIKI do dopisania w .env.oms produkcji właściciela przy PRZ-061 (nie jest sekretem).
const CENNIKI_TOMKA = '[{"kanal":"swietlik","nazwa":"swietlik.example.test"},{"kanal":"pro","nazwa":"pro.swietlik.example.test (PRO)"}]';
const produkt = (nad = {}) => ({ kanal: 'sklep_a', produkt_id: '1', wariant_id: '', nazwa: 'Produkt', cena_gr: 1000, rozmiar_tekst: null, ...nad });

describe('PRZ-060 — OMS_CENNIKI', () => {
  it('brak albo pusty tekst = brak listy (neutralny tryb)', () => {
    expect(parsujCenniki(undefined)).toBeNull();
    expect(parsujCenniki('')).toBeNull();
    expect(parsujCenniki('  ')).toBeNull();
  });

  it.each([
    ['nie JSON', '[{'],
    ['obiekt zamiast listy', '{"kanal":"a","nazwa":"A"}'],
    ['pusta lista', '[]'],
    ['brak nazwy', '[{"kanal":"a"}]'],
    ['pusta nazwa', '[{"kanal":"a","nazwa":"  "}]'],
    ['zły klucz', '[{"kanal":"A B","nazwa":"A"}]'],
    ['powtórzony kanał', '[{"kanal":"a","nazwa":"A"},{"kanal":"a","nazwa":"B"}]'],
  ])('odmawia: %s', (_, tekst) => {
    expect(() => parsujCenniki(tekst)).toThrow(/^OMS_CENNIKI: /);
  });

  it('zła lista odmawia startu modułu zamówień, dobra trafia do konfiguracji', () => {
    expect(() => konfiguracjaZamowien({ ...seller, OMS_CENNIKI: '[]' })).toThrow(/OMS_CENNIKI/);
    expect(konfiguracjaZamowien(seller).cenniki).toBeNull();
    expect(konfiguracjaZamowien({ ...seller, OMS_CENNIKI: CENNIKI_TOMKA }).cenniki).toEqual([
      { kanal: 'swietlik', nazwa: 'swietlik.example.test' }, { kanal: 'pro', nazwa: 'pro.swietlik.example.test (PRO)' },
    ]);
  });
});

describe('PRZ-060 — cenniki bez konfiguracji są neutralne', () => {
  it('sklepy Woo z definicji, w ich kolejności i pod etykietą; Allegro nigdy', () => {
    const c = cenniki({ definicje });
    expect(c.kanaly).toEqual(['sklep_a', 'sklep_b']);
    expect(c.domyslny).toBe('sklep_a');
    expect(c.nazwy).toEqual({ sklep_a: 'Sklep A', sklep_b: 'sklep_b' });
    expect(cennikDlaZamowienia({ sklepZamowienia: 'allegro_a' }, c)).toBe('sklep_a');
    expect(cennikDlaZamowienia({ sklepZamowienia: 'sklep_b' }, c)).toBe('sklep_b');
  });

  it('kanał Allegro z jawnej listy odmawia', () => {
    expect(() => cenniki({ lista: [{ kanal: 'allegro_a', nazwa: 'X' }], definicje })).toThrow(/Allegro nie jest cennikiem/);
  });

  it('instalacja bez sklepów nie ma cennika i mówi o tym wprost', () => {
    const c = cenniki();
    expect(c).toEqual({ kanaly: [], domyslny: null, nazwy: {} });
    expect(cennikDlaZamowienia({ sklepZamowienia: 'cokolwiek' }, c)).toBeNull();
    expect(() => pozycjaZProduktu(produkt(), '1', { cenniki: c })).toThrow(/nie ma żadnego cennika/);
  });

  it('trzy cenniki: wyliczenie „A, B i C"', () => {
    const c = cenniki({ lista: [{ kanal: 'a', nazwa: 'A' }, { kanal: 'b', nazwa: 'B' }, { kanal: 'c', nazwa: 'C' }] });
    expect(() => pozycjaZProduktu(produkt({ kanal: 'x' }), '1', { cenniki: c }))
      .toThrow('Kanał „x" nie jest cennikiem — ceny biorą się wyłącznie ze sklepów A, B i C.');
  });

  it('cena pochodzi z wiersza cennika z konfiguracji', () => {
    const c = cenniki({ definicje });
    const p = pozycjaZProduktu(produkt({ kanal: 'sklep_b', cena_gr: 2500 }), '2', { cenniki: c });
    expect([p.ilosc, Number(p.cena_brutto), Number(p.brutto_linii)]).toEqual([2, 25, 50]);
  });
});

describe('PRZ-060 — wartości produkcji właściciela dają dzisiejsze napisy', () => {
  const c = cenniki({ lista: parsujCenniki(CENNIKI_TOMKA), definicje: [] });

  it('lista, domyślny i nazwy jak stałe sprzed PRZ-060', () => {
    expect(c.kanaly).toEqual(['swietlik', 'pro']);
    expect(c.domyslny).toBe('swietlik');
    expect(c.nazwy).toEqual({ swietlik: 'swietlik.example.test', pro: 'pro.swietlik.example.test (PRO)' });
    expect(cennikDlaZamowienia({ sklepZamowienia: 'allegro_swietlik' }, c)).toBe('swietlik');
    expect(cennikDlaZamowienia({ sklepZamowienia: 'swietlik', wybrany: 'pro' }, c)).toBe('pro');
  });

  it('komunikaty odmowy co do znaku', () => {
    expect(() => pozycjaZProduktu(produkt({ kanal: 'allegro_swietlik' }), '1', { cenniki: c }))
      .toThrow('Kanał „allegro_swietlik" nie jest cennikiem — ceny biorą się wyłącznie ze sklepów swietlik.example.test i pro.swietlik.example.test (PRO).');
    expect(() => pozycjaZProduktu(produkt({ kanal: 'pro', nazwa: 'Pieszy', cena_gr: null }), '1', { cenniki: c }))
      .toThrow('Produkt „Pieszy" nie ma ceny w cenniku pro.swietlik.example.test (PRO) — dopisz go ręcznie z ceną albo wybierz drugi cennik.');
  });
});
