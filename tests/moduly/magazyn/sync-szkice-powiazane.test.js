import { afterEach, describe, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  utworzKarte,
  powiazProdukt,
  zapiszProduktSklepowy,
  niepowiazaneProdukty,
  utworzKartyZNiepowiazanych,
  zliczeniaNiepowiazanych,
} from '../../../src/oms/db/magazyn.js';
import { odswiezMagazyn } from '../../../src/moduly/magazyn/services/magazyn-sync.js';
import { planImportu, typImportu } from '../../../src/moduly/magazyn/services/import-kanalu.js';
import { powodPominiecia } from '../../../src/domena/karta-z-produktu.js';
import { createAtrapaWoo } from '../../../deploy/proba/atrapy/kanaly.mjs';
import { katalogWoo } from '../../../scripts/demo-dane-katalog.mjs';

// Szkic produktu powiązanego nie przychodzi w odczycie `status=publish`. Bez osobnego odczytu
// szkiców `oznaczZnikniete` uznałoby go za usunięty ze sklepu, a karta pokazałaby „wycofany".
const KANAL = 'polcien';
const T1 = '2026-11-18T10:00:00.000Z';
const T2 = '2026-11-18T11:00:00.000Z';
const bazy = [];
afterEach(() => {
  for (const db of bazy.splice(0)) db.close();
});

const katalog = katalogWoo(KANAL);
const prosty = katalog.produkty.find((p) => p.type === 'simple' && katalog.miniatury.has(String(p.id)));
const drugiProsty = katalog.produkty.find((p) => p.type === 'simple' && p.id !== prosty.id);
const zmienny = katalog.produkty.find((p) => p.type === 'variable');

function srodowisko() {
  const db = openOmsDb(':memory:');
  bazy.push(db);
  const klient = createAtrapaWoo({ db, kanal: KANAL, env: { OMS_TRYB: 'proba' }, log: () => {} });
  return { db, klient };
}

async function przebieg(db, klient, at) {
  const wynik = await odswiezMagazyn({
    db,
    sklepy: { [KANAL]: klient },
    kanalySklepow: [KANAL],
    kanalyAllegro: [],
    teraz: () => at,
    log: () => {},
  });
  return wynik.kanaly[0];
}

const wiersze = (db, produktId) =>
  db
    .prepare('SELECT * FROM produkty_sklepowe WHERE kanal = ? AND produkt_id = ? ORDER BY wariant_id')
    .all(KANAL, String(produktId));

function powiaz(db, produktId, { tylkoPierwszy = false } = {}) {
  const lista = wiersze(db, produktId);
  const karty = [];
  for (const w of tylkoPierwszy ? lista.slice(0, 1) : lista) {
    const karta = utworzKarte(db, { nazwa: `Karta ${w.nazwa}` });
    powiazProdukt(db, w.id, karta);
    karty.push(karta);
  }
  return karty;
}

describe('T-S1: powiązany produkt przełączony na szkic', () => {
  it('zostaje żywy, ze statusem „draft”, tą samą kartą i dotychczasową miniaturą', async () => {
    const { db, klient } = srodowisko();
    expect((await przebieg(db, klient, T1)).blad).toBeNull();
    const [karta] = powiaz(db, prosty.id);
    const [przed] = wiersze(db, prosty.id);
    expect(przed.status_publikacji).toBe('publish');
    expect(przed.miniatura).toBeTruthy();

    await klient.ustawStatusProduktu(prosty.id, 'draft');
    const wynik = await przebieg(db, klient, T2);

    expect(wynik.blad).toBeNull();
    expect(wynik.znikniete).toBe(0);
    const [po] = wiersze(db, prosty.id);
    expect(po.zniknal_at).toBeNull();
    expect(po.status_publikacji).toBe('draft');
    expect(po.karta_id).toBe(karta);
    expect(po.miniatura).toBe(przed.miniatura);
    expect(po.odczytane_at).toBe(T2);
  });

  it('warianty szkicu zostają żywe ze statusem rodzica, także te bez karty', async () => {
    const { db, klient } = srodowisko();
    await przebieg(db, klient, T1);
    const warianty = wiersze(db, zmienny.id);
    expect(warianty.length).toBeGreaterThan(1);
    powiaz(db, zmienny.id, { tylkoPierwszy: true });

    await klient.ustawStatusProduktu(zmienny.id, 'draft');
    await przebieg(db, klient, T2);

    const po = wiersze(db, zmienny.id);
    expect(po).toHaveLength(warianty.length);
    for (const w of po) {
      expect(w.zniknal_at).toBeNull();
      expect(w.status_publikacji).toBe('draft');
      expect(w.odczytane_at).toBe(T2);
    }
  });

  it('szkic bez miniatury w bazie bierze pierwsze zdjęcie z odczytu', async () => {
    const { db, klient } = srodowisko();
    await przebieg(db, klient, T1);
    powiaz(db, prosty.id);
    db.prepare('UPDATE produkty_sklepowe SET miniatura = NULL WHERE kanal = ? AND produkt_id = ?').run(
      KANAL,
      String(prosty.id),
    );

    await klient.ustawStatusProduktu(prosty.id, 'draft');
    await przebieg(db, klient, T2);

    expect(wiersze(db, prosty.id)[0].miniatura).toBe(prosty.images[0].src);
  });

  it('miniatura z bazy wygrywa ze zdjęciem z odczytu szkicu', async () => {
    const { db, klient } = srodowisko();
    await przebieg(db, klient, T1);
    powiaz(db, prosty.id);
    const wlasna = 'https://polcien.example/miniatury/lampa-40-247x296.jpg';
    expect(wlasna).not.toBe(prosty.images[0].src);
    db.prepare('UPDATE produkty_sklepowe SET miniatura = ? WHERE kanal = ? AND produkt_id = ?').run(
      wlasna,
      KANAL,
      String(prosty.id),
    );

    await klient.ustawStatusProduktu(prosty.id, 'draft');
    await przebieg(db, klient, T2);

    expect(wiersze(db, prosty.id)[0].miniatura).toBe(wlasna);
  });

  it('szkic odczytuje się jednym pytaniem o same powiązane id, których nie było w odczycie „publish”', async () => {
    const { db, klient } = srodowisko();
    await przebieg(db, klient, T1);
    powiaz(db, prosty.id);
    powiaz(db, drugiProsty.id);
    await klient.ustawStatusProduktu(prosty.id, 'draft');
    const szpieg = vi.spyOn(klient, 'pobierzProduktyPowiazane');

    await przebieg(db, klient, T2);

    expect(szpieg).toHaveBeenCalledTimes(1);
    expect(szpieg.mock.calls[0][0].map(String)).toEqual([String(prosty.id)]);
  });

  it('bez powiązanych spoza odczytu „publish” sklep nie jest pytany o szkice', async () => {
    const { db, klient } = srodowisko();
    await przebieg(db, klient, T1);
    powiaz(db, prosty.id);
    const szpieg = vi.spyOn(klient, 'pobierzProduktyPowiazane');

    await przebieg(db, klient, T2);

    expect(szpieg).not.toHaveBeenCalled();
  });
});

describe('T-S2: szkic bez karty nie wchodzi do kart', () => {
  it('niepowiązany szkic w sklepie nie trafia do lustra', async () => {
    const { db, klient } = srodowisko();
    await klient.ustawStatusProduktu(drugiProsty.id, 'draft');

    await przebieg(db, klient, T1);

    expect(wiersze(db, drugiProsty.id)).toEqual([]);
  });

  it('szkic w lustrze bez karty: import, lista niepowiązanych i tworzenie hurtem go nie widzą', async () => {
    const { db, klient } = srodowisko();
    await przebieg(db, klient, T1);
    const przed = zliczeniaNiepowiazanych(db, []).pominiete;
    // Karta odpięta od produktu, który był już szkicem — jedyna droga takiego wiersza do lustra.
    const szkic = zapiszProduktSklepowy(db, {
      kanal: KANAL,
      produkt_id: '9001',
      wariant_id: '',
      nazwa: 'Lampa Półcień 40',
      sku_sklepu: 'POL-40-SZKIC',
      rozmiar_tekst: '40 cm',
      status_publikacji: 'draft',
      odczytane_at: T1,
    });

    expect(niepowiazaneProdukty(db).map((p) => p.id)).not.toContain(szkic);
    expect(zliczeniaNiepowiazanych(db, []).pominiete).toBe(przed);

    const plan = planImportu(db, {
      kanal: KANAL,
      typ: typImportu('pelny'),
      kanalyZrodlowe: [KANAL],
      allegro: false,
    });
    const wPlanie = [...plan.utworz, ...plan.powiaz, ...plan.pominiete].map((w) => w.id);
    expect(wPlanie).not.toContain(szkic);
    expect(plan.utworz.length).toBeGreaterThan(0);

    utworzKartyZNiepowiazanych(db, { teraz: T1, kanalySklepow: [KANAL] });
    expect(db.prepare('SELECT karta_id FROM produkty_sklepowe WHERE id = ?').get(szkic).karta_id).toBeNull();
  });

  it('powodPominiecia odrzuca szkic jako druga zapora', () => {
    const wiersz = {
      kanal: KANAL,
      produkt_id: '9001',
      wariant_id: '',
      nazwa: 'Lampa Półcień 40',
      sku_sklepu: 'POL-40',
      rozmiar_tekst: '40 cm',
      status_publikacji: 'draft',
      zniknal_at: null,
    };
    expect(powodPominiecia(wiersz, [KANAL])).toMatch(/^szkic w sklepie/);
    expect(powodPominiecia({ ...wiersz, status_publikacji: 'publish' }, [KANAL])).toBeNull();
  });
});

describe('T-S3: powiązany produkt usunięty ze sklepu', () => {
  function usuniety(db) {
    const karta = utworzKarte(db, { nazwa: 'Lampa Półcień 40' });
    const id = zapiszProduktSklepowy(db, {
      kanal: KANAL,
      produkt_id: '9999',
      wariant_id: '',
      nazwa: 'Lampa Półcień 40',
      odczytane_at: T1,
    });
    powiazProdukt(db, id, karta);
    return id;
  }

  it('nie ma go ani w „publish”, ani w szkicach — dostaje zniknal_at jak dotąd', async () => {
    const { db, klient } = srodowisko();
    await przebieg(db, klient, T1);
    const id = usuniety(db);

    const wynik = await przebieg(db, klient, T2);

    expect(wynik.blad).toBeNull();
    expect(wynik.znikniete).toBe(1);
    expect(db.prepare('SELECT zniknal_at FROM produkty_sklepowe WHERE id = ?').get(id).zniknal_at).toBe(T2);
  });

  it('błąd odczytu szkiców przerywa kanał przed zapisem — nic nie zostaje oznaczone', async () => {
    const { db, klient } = srodowisko();
    await przebieg(db, klient, T1);
    const id = usuniety(db);
    const zawodny = {
      ...klient,
      pobierzProduktyPowiazane: async () => {
        throw new Error('Sklep odrzucił zapytanie (500)');
      },
    };

    const wynik = await przebieg(db, zawodny, T2);

    expect(wynik.blad).toMatch(/500/);
    expect(wynik.znikniete).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM produkty_sklepowe WHERE zniknal_at IS NOT NULL').get().n).toBe(0);
    expect(db.prepare('SELECT odczytane_at FROM produkty_sklepowe WHERE id = ?').get(id).odczytane_at).toBe(T1);
  });

  it('pusty odczyt „publish” z powiązanym szkicem nadal zatrzymuje hamulec pustego odczytu', async () => {
    const { db, klient } = srodowisko();
    await przebieg(db, klient, T1);
    powiaz(db, prosty.id);
    await klient.ustawStatusProduktu(prosty.id, 'draft');
    const zywePrzed = db.prepare('SELECT COUNT(*) AS n FROM produkty_sklepowe WHERE zniknal_at IS NULL').get().n;
    const pusty = { ...klient, pobierzWszystkieProdukty: async () => [] };

    const wynik = await przebieg(db, pusty, T2);

    expect(wynik.blad).toMatch(/0 pozycji/);
    expect(wynik.znikniete).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM produkty_sklepowe WHERE zniknal_at IS NULL').get().n).toBe(zywePrzed);
  });

  it('klient bez odczytu szkiców działa jak dotąd', async () => {
    const { db, klient } = srodowisko();
    await przebieg(db, klient, T1);
    const id = usuniety(db);
    const starszy = { ...klient, pobierzProduktyPowiazane: undefined };

    const wynik = await przebieg(db, starszy, T2);

    expect(wynik.blad).toBeNull();
    expect(db.prepare('SELECT zniknal_at FROM produkty_sklepowe WHERE id = ?').get(id).zniknal_at).toBe(T2);
  });
});

describe('T-S4: wiersz oznaczony jako zniknięty przez szkic przed wdrożeniem', () => {
  it('po przebiegu ożywa jako szkic, z tą samą kartą', async () => {
    const { db, klient } = srodowisko();
    await przebieg(db, klient, T1);
    const [karta] = powiaz(db, prosty.id);
    await klient.ustawStatusProduktu(prosty.id, 'draft');
    // Stan po dawnym przebiegu: szkic nieodczytany, więc oznaczony jako usunięty.
    db.prepare(
      'UPDATE produkty_sklepowe SET zniknal_at = ?, status_publikacji = NULL WHERE kanal = ? AND produkt_id = ?',
    ).run(T1, KANAL, String(prosty.id));

    await przebieg(db, klient, T2);

    const [po] = wiersze(db, prosty.id);
    expect(po.zniknal_at).toBeNull();
    expect(po.status_publikacji).toBe('draft');
    expect(po.karta_id).toBe(karta);
  });
});
