import { expect, it, vi } from 'vitest';
import { MODULY_KANALOW } from '../../src/domena/moduly-kanalow.ts';
import { MODUL_ERLI } from '../../src/domena/modul-erli.ts';
import { METODA_UMIEJETNOSCI, katalogErli, katalogKanalu } from '../../src/integracje/kanal-modul.ts';

const metody = ['odczytOfert', 'wystawOferte', 'zmienOferte', 'zmienIloscCene', 'stanOferty'] as const;
const wywolania = (k: ReturnType<typeof katalogKanalu>) => [
  () => k.odczytOfert({ limit: 10 }),
  () => k.wystawOferte('LMP-1', { name: 'Lampa', status: 'inactive' }),
  () => k.zmienOferte('LMP-1', { status: 'inactive' }),
  () => k.zmienIloscCene([{ externalId: 'LMP-1', stock: 2, price: 66.38 }]),
  () => k.stanOferty('LMP-1'),
];

it('ERLI deklaruje cały katalog D20 i rodzaj stany produkty', () => {
  expect(MODUL_ERLI.umiejetnosci.stany).toBe('produkty');
  for (const metoda of metody) {
    expect(METODA_UMIEJETNOSCI).toHaveProperty(metoda, metoda);
    expect(MODUL_ERLI.umiejetnosci).toHaveProperty(metoda, true);
  }
});

// Allegro deklaruje katalog — odmowę bez deklaracji dla Allegro pilnuje katalog-allegro.test.ts.
it.each(['woo'] as const)('%s bez umiejętności odmawia nawet z metodą zwracającą sukces', async (typ) => {
  const sukces = vi.fn(async () => ({ ok: true as const, dane: {} }));
  const atrapa = Object.fromEntries(metody.map((m) => [m, sukces]));
  const katalog = katalogKanalu(MODULY_KANALOW[typ], atrapa);
  for (const [i, wywolaj] of wywolania(katalog).entries()) {
    expect(await wywolaj()).toEqual({ ok: false, powod: `kanał ${typ} nie umie ${metody[i]}` });
  }
  expect(sukces).not.toHaveBeenCalled();
});

it('ERLI bez metody klienta odmawia zamiast udawać sukces', async () => {
  for (const [i, wywolaj] of wywolania(katalogErli({})).entries()) {
    expect(await wywolaj()).toEqual({ ok: false, powod: `kanał erli: ${metody[i]} niezaimplementowane` });
  }
});

it('kanał deklarujący umiejętność bez implementacji dostaje odmowę', async () => {
  const katalog = katalogKanalu(MODUL_ERLI, {});
  for (const [i, wywolaj] of wywolania(katalog).entries()) {
    expect(await wywolaj()).toEqual({ ok: false, powod: `kanał erli: ${metody[i]} niezaimplementowane` });
  }
});

it('ERLI przekazuje argumenty, kontekst i odpowiedzi wszystkich metod klienta', async () => {
  const klient = {
    wynik: { przyjete: true },
    szukajProduktow: vi.fn(async function (this: { wynik: object }, _dane: object) {
      return this.wynik;
    }),
    utworzProdukt: vi.fn(async function (this: { wynik: object }, _id: string, _dane: object) {
      return this.wynik;
    }),
    zmienProdukt: vi.fn(async function (this: { wynik: object }, _id: string, _dane: object) {
      return this.wynik;
    }),
    zmienProdukty: vi.fn(async function (this: { wynik: object }, _dane: readonly object[]) {
      return this.wynik;
    }),
    pobierzProdukt: vi.fn(async function (this: { wynik: object }, _id: string) {
      return this.wynik;
    }),
  };
  for (const wywolaj of wywolania(katalogErli(klient))) {
    expect(await wywolaj()).toEqual({ ok: true, dane: klient.wynik });
  }
  expect(klient.szukajProduktow.mock.calls).toEqual([[{ limit: 10 }]]);
  expect(klient.utworzProdukt.mock.calls).toEqual([['LMP-1', { name: 'Lampa', status: 'inactive' }]]);
  expect(klient.zmienProdukt.mock.calls).toEqual([['LMP-1', { status: 'inactive' }]]);
  expect(klient.zmienProdukty.mock.calls).toEqual([[[{ externalId: 'LMP-1', stock: 2, price: 66.38 }]]]);
  expect(klient.pobierzProdukt.mock.calls).toEqual([['LMP-1']]);
});

it('pojedynczy brak metody nie blokuje odczytu ani nie daje sukcesu zapisu', async () => {
  const klient = { pobierzProdukt: vi.fn(async () => null) };
  const katalog = katalogErli(klient);
  expect(await katalog.stanOferty('LMP-1')).toEqual({ ok: true, dane: null });
  expect(await katalog.wystawOferte('LMP-1', {})).toEqual({
    ok: false,
    powod: 'kanał erli: wystawOferte niezaimplementowane',
  });
});

it('wyjątek klienta ERLI przechodzi jako odrzucenie, nigdy sukces', async () => {
  const blad = new Error('HTTP 500');
  const rzuca = vi.fn(async () => {
    throw blad;
  });
  const klient = {
    szukajProduktow: rzuca,
    utworzProdukt: rzuca,
    zmienProdukt: rzuca,
    zmienProdukty: rzuca,
    pobierzProdukt: rzuca,
  };
  for (const wywolaj of wywolania(katalogErli(klient))) await expect(wywolaj()).rejects.toBe(blad);
  expect(rzuca).toHaveBeenCalledTimes(5);
});
