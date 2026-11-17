import { afterEach, expect, it, vi } from 'vitest';
import { MODUL_ALLEGRO } from '../../src/domena/modul-allegro.ts';
import { MODULY_KANALOW } from '../../src/domena/moduly-kanalow.ts';
import { katalogAllegro, katalogKanalu, wezlyAllegro } from '../../src/integracje/kanal-modul.ts';

// Allegro deklaruje katalog, łącznik `katalogAllegro` idzie przez `katalogKanalu`,
// a operacje spoza kontraktu dostaje wąski obiekt `wezlyAllegro` (9 metod klienta konta).

const metody = ['odczytOfert', 'wystawOferte', 'zmienOferte', 'zmienIloscCene', 'stanOferty'] as const;
const ofertaLampy = { name: 'Lampa biurkowa Półcień', external: { id: 'PLC-K12' } };
const wywolania = (k: ReturnType<typeof katalogKanalu>) => [
  () => k.odczytOfert({ offset: 0 }),
  () => k.wystawOferte('PLC-K12', ofertaLampy),
  () => k.zmienOferte('7700000001', { name: 'Lampa biurkowa Półcień II' }),
  () => k.zmienIloscCene([{ externalId: '7700000001', stock: 2, commandIdIlosci: 'kom-ilosc-1' } as never]),
  () => k.stanOferty('7700000001'),
];

const umiejetnosci = MODUL_ALLEGRO.umiejetnosci as Record<string, unknown>;
const zapamietane = { ...umiejetnosci };
afterEach(() => { Object.assign(umiejetnosci, zapamietane); });

function klientAllegro() {
  const wynik = { przyjete: true };
  const fn = () => vi.fn(async function (this: { wynik: object }, ..._a: unknown[]) { return this.wynik; });
  return {
    wynik,
    ofertyKonta: fn(), utworzOferte: fn(), edytujOferte: fn(), komendaIlosci: fn(), komendaCeny: fn(), pobierzOferte: fn(),
    wgrajZdjecie: fn(), stanOperacji: fn(), szukajProduktow: fn(), ofertyPoSygnaturze: fn(), wynikKomendy: fn(), oplatyOferty: fn(),
    podgladOplat: fn(),
  };
}

it('Allegro deklaruje cały katalog D20, rodzaj stanów zostaje „oferty”', () => {
  expect(MODUL_ALLEGRO.umiejetnosci.stany).toBe('oferty');
  for (const m of metody) expect(MODUL_ALLEGRO.umiejetnosci).toHaveProperty(m, true);
});

it('kanał bez umiejętności (Woo) nadal odmawia, nawet z metodą zwracającą sukces', async () => {
  const sukces = vi.fn(async () => ({ ok: true as const, dane: {} }));
  const katalog = katalogKanalu(MODULY_KANALOW.woo, Object.fromEntries(metody.map(m => [m, sukces])));
  for (const [i, wywolaj] of wywolania(katalog).entries()) {
    expect(await wywolaj()).toEqual({ ok: false, powod: `kanał woo nie umie ${metody[i]}` });
  }
  expect(sukces).not.toHaveBeenCalled();
});

it('katalogAllegro idzie przez katalogKanalu: zdjęta deklaracja = odmowa bez wołania klienta', async () => {
  const klient = klientAllegro();
  const katalog = katalogAllegro(klient);
  for (const m of metody) umiejetnosci[m] = false;
  for (const [i, wywolaj] of wywolania(katalog).entries()) {
    expect(await wywolaj()).toEqual({ ok: false, powod: `kanał allegro nie umie ${metody[i]}` });
  }
  for (const [nazwa, f] of Object.entries(klient)) if (nazwa !== 'wynik') expect(f).not.toHaveBeenCalled();
});

it('Allegro bez metody klienta odmawia zamiast udawać sukces', async () => {
  for (const [i, wywolaj] of wywolania(katalogAllegro({})).entries()) {
    expect(await wywolaj()).toEqual({ ok: false, powod: `kanał allegro: ${metody[i]} niezaimplementowane` });
  }
});

it('mapuje metody kontraktu na klienta Allegro z argumentami, kontekstem i odpowiedzią', async () => {
  const klient = klientAllegro();
  const katalog = katalogAllegro(klient);
  expect(await katalog.odczytOfert({ offset: 40 })).toEqual({ ok: true, dane: klient.wynik });
  expect(await katalog.wystawOferte('PLC-K12', ofertaLampy)).toEqual({ ok: true, dane: klient.wynik });
  expect(await katalog.zmienOferte('7700000001', { name: 'Nowa' })).toEqual({ ok: true, dane: klient.wynik });
  expect(await katalog.stanOferty('7700000001')).toEqual({ ok: true, dane: klient.wynik });
  expect(klient.ofertyKonta.mock.calls).toEqual([[{ offset: 40 }]]);
  expect(klient.utworzOferte.mock.calls).toEqual([[ofertaLampy]]);
  expect(klient.edytujOferte.mock.calls).toEqual([['7700000001', { name: 'Nowa' }]]);
  expect(klient.pobierzOferte.mock.calls).toEqual([['7700000001']]);
});

it('zmienIloscCene: komendy z commandId z pozycji, grosze → „zł.gr”, jedna komenda na commandId', async () => {
  const klient = klientAllegro();
  const wynik = await katalogAllegro(klient).zmienIloscCene([
    { externalId: '7700000001', stock: 3, price: 6638, commandIdIlosci: 'kom-ilosc-1', commandIdCeny: 'kom-cena-1' },
    { externalId: '7700000002', stock: 3, commandIdIlosci: 'kom-ilosc-1' },
    { externalId: '7700000003', price: 5, commandIdCeny: 'kom-cena-2' },
    { externalId: '7700000004', price: 100000, commandIdCeny: 'kom-cena-3' },
  ] as never);
  expect(klient.komendaIlosci.mock.calls).toEqual([
    ['kom-ilosc-1', [{ ofertaId: '7700000001', ilosc: 3 }, { ofertaId: '7700000002', ilosc: 3 }]],
  ]);
  expect(klient.komendaCeny.mock.calls).toEqual([
    ['kom-cena-1', [{ ofertaId: '7700000001', cena: '66.38' }]],
    ['kom-cena-2', [{ ofertaId: '7700000003', cena: '0.05' }]],
    ['kom-cena-3', [{ ofertaId: '7700000004', cena: '1000.00' }]],
  ]);
  expect(wynik).toEqual({ ok: true, dane: [
    { rodzaj: 'ilosc', commandId: 'kom-ilosc-1', wynik: klient.wynik },
    { rodzaj: 'cena', commandId: 'kom-cena-1', wynik: klient.wynik },
    { rodzaj: 'cena', commandId: 'kom-cena-2', wynik: klient.wynik },
    { rodzaj: 'cena', commandId: 'kom-cena-3', wynik: klient.wynik },
  ] });
});

it.each([
  ['bez commandIdIlosci', [{ externalId: '7700000001', stock: 1 }], /commandIdIlosci/],
  ['bez commandIdCeny', [{ externalId: '7700000001', price: 1999 }], /commandIdCeny/],
  ['pusty commandId', [{ externalId: '7700000001', stock: 1, commandIdIlosci: '' }], /commandIdIlosci/],
  ['jedna pozycja bez commandId wśród poprawnych', [
    { externalId: '7700000001', stock: 1, commandIdIlosci: 'kom-ilosc-1' },
    { externalId: '7700000002', price: 1999, commandIdCeny: 'kom-cena-1', stock: 4 },
  ], /commandIdIlosci/],
  ['cena nie w groszach', [{ externalId: '7700000001', price: 66.38, commandIdCeny: 'kom-cena-1' }], /grosz/],
  ['pozycja bez ilości i ceny', [{ externalId: '7700000001', commandIdIlosci: 'kom-ilosc-1' }], /ani ilości, ani ceny/],
  ['pusta lista', [], /brak pozycji/],
])('zmienIloscCene %s → ok:false i żadnej komendy', async (_opis, pozycje, powod) => {
  const klient = klientAllegro();
  const wynik = await katalogAllegro(klient).zmienIloscCene(pozycje as never);
  expect(wynik.ok).toBe(false);
  expect(wynik.ok === false && wynik.powod).toMatch(powod);
  expect(klient.komendaIlosci).not.toHaveBeenCalled();
  expect(klient.komendaCeny).not.toHaveBeenCalled();
});

it('zmienIloscCene bez metody komendy w kliencie odmawia przed wysłaniem czegokolwiek', async () => {
  const klient = { komendaCeny: vi.fn(async () => ({})) };
  const wynik = await katalogAllegro(klient).zmienIloscCene([
    { externalId: '7700000001', stock: 1, price: 1999, commandIdIlosci: 'kom-ilosc-1', commandIdCeny: 'kom-cena-1' },
  ] as never);
  expect(wynik).toEqual({ ok: false, powod: 'kanał allegro: zmienIloscCene niezaimplementowane' });
  expect(klient.komendaCeny).not.toHaveBeenCalled();
});

it('wyjątek klienta Allegro przechodzi jako odrzucenie, nigdy sukces', async () => {
  const blad = new Error('HTTP 500');
  const rzuca = vi.fn(async () => { throw blad; });
  const klient = { ofertyKonta: rzuca, utworzOferte: rzuca, edytujOferte: rzuca, komendaIlosci: rzuca, pobierzOferte: rzuca };
  for (const wywolaj of wywolania(katalogAllegro(klient))) await expect(wywolaj()).rejects.toBe(blad);
  expect(rzuca).toHaveBeenCalledTimes(5);
});

const WEZLY = ['wgrajZdjecie', 'stanOperacji', 'szukajProduktow', 'ofertyPoSygnaturze',
  'komendaIlosci', 'komendaCeny', 'wynikKomendy', 'oplatyOferty', 'podgladOplat'] as const;

it('wezlyAllegro to dokładnie 9 metod (D44 + podgladOplat z E3.17), przekazanych wprost do klienta konta', async () => {
  const klient = klientAllegro();
  const wezly = wezlyAllegro(klient);
  expect(Object.keys(wezly).sort()).toEqual([...WEZLY].sort());
  const bajty = new Uint8Array([1, 2, 3]);
  const argumenty: Record<(typeof WEZLY)[number], unknown[]> = {
    wgrajZdjecie: [bajty, 'image/jpeg', { ai: 1 }],
    stanOperacji: ['/sale/product-offers/7700000001/operations/op-1'],
    szukajProduktow: ['5900000000017'],
    ofertyPoSygnaturze: ['PLC-K12'],
    komendaIlosci: ['kom-ilosc-1', [{ ofertaId: '7700000001', ilosc: 2 }]],
    komendaCeny: ['kom-cena-1', [{ ofertaId: '7700000001', cena: '66.38' }]],
    wynikKomendy: ['cena', 'kom-cena-1'],
    oplatyOferty: ['7700000001'],
    podgladOplat: [{ category: { id: '257' } }],
  };
  for (const nazwa of WEZLY) {
    expect(await (wezly[nazwa] as (...a: unknown[]) => Promise<unknown>)(...argumenty[nazwa])).toBe(klient.wynik);
    expect(klient[nazwa].mock.calls).toEqual([argumenty[nazwa]]);
  }
});

it('wezlyAllegro bez metody klienta rzuca — brak nie udaje wyniku', async () => {
  const wezly = wezlyAllegro({});
  for (const nazwa of WEZLY) {
    await expect((wezly[nazwa] as () => Promise<unknown>)()).rejects.toThrow(`kanał allegro: ${nazwa} niezaimplementowane`);
  }
});
