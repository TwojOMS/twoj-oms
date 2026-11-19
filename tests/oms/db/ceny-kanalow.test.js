import { describe, it, expect, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { importMozeZapisac } from '../../../src/domena/zrodla-pol.js';
import {
  cenyReczneKarty,
  cenyReczneKart,
  ustawCeneReczna,
  usunCeneReczna,
  zapiszZmianeWKanale,
  chronCeneKarty,
  ustawStatusPublikacji,
} from '../../../src/oms/db/ceny-kanalow.js';

// Warstwa bazy ręcznych cen kanałów, dziennika zmian w kanałach, ochrony ceny karty przed importem
// i statusu publikacji w lustrze. Dane zmyślone: „Pracownia Półcień”, konta `polcien` i `allegro_polcien`.

const T0 = '2026-11-18T10:00:00.000Z';
const T1 = '2026-11-18T11:30:00.000Z';
const bazy = [];
afterEach(() => {
  for (const db of bazy.splice(0)) if (db.isOpen) db.close();
});
const pelna = () => {
  const db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO), teraz: () => new Date(T0) });
  bazy.push(db);
  return db;
};
const karta = (db, sku, cenaGr = 10000) =>
  utworzKarte(db, { sku, nazwa: `Lampa Półcień ${sku}`, cena_gr: cenaGr }, { at: T0 });
const zrodloCeny = (db, kartaId) => {
  const w = db
    .prepare("SELECT zrodlo, reczne, zmieniono_at FROM karty_zrodla_pol WHERE karta_id = ? AND pole = 'cena_gr'")
    .get(kartaId);
  return w ? { ...w } : null;
};

describe('ręczna cena kanału', () => {
  it('ustawienie, zastąpienie i usunięcie; mapa per konto, cudzej karty nie rusza', () => {
    const db = pelna();
    const a = karta(db, 'LMP-1');
    const b = karta(db, 'LMP-2');
    expect(cenyReczneKarty(db, a)).toEqual(new Map());
    ustawCeneReczna(db, { kartaId: a, kanal: 'polcien', cenaGr: 10500, kto: 'administrator', at: T0 });
    ustawCeneReczna(db, { kartaId: a, kanal: 'allegro_polcien', cenaGr: 11900, kto: 'administrator', at: T0 });
    ustawCeneReczna(db, { kartaId: b, kanal: 'polcien', cenaGr: 4900, kto: 'administrator', at: T0 });
    expect(cenyReczneKarty(db, a)).toEqual(
      new Map([
        ['allegro_polcien', 11900],
        ['polcien', 10500],
      ]),
    );

    // Drugi zapis tego samego konta zastępuje kwotę, kto i kiedy — nie dokłada wiersza.
    ustawCeneReczna(db, { kartaId: a, kanal: 'polcien', cenaGr: 9900, kto: 'magazynier', at: T1 });
    expect(
      db
        .prepare("SELECT cena_gr, kto, zmieniono_at FROM ceny_kanalow_kart WHERE karta_id = ? AND kanal = 'polcien'")
        .all(a)
        .map((w) => ({ ...w })),
    ).toEqual([{ cena_gr: 9900, kto: 'magazynier', zmieniono_at: T1 }]);

    expect(usunCeneReczna(db, { kartaId: a, kanal: 'polcien' })).toBe(1);
    expect(usunCeneReczna(db, { kartaId: a, kanal: 'polcien' })).toBe(0);
    expect(cenyReczneKarty(db, a)).toEqual(new Map([['allegro_polcien', 11900]]));
    expect(cenyReczneKarty(db, b)).toEqual(new Map([['polcien', 4900]]));
  });

  it('hurtem: mapa karta → (konto → cena), karta bez ręcznej ceny bez klucza', () => {
    const db = pelna();
    const [a, b, c] = ['LMP-3', 'LMP-4', 'LMP-5'].map((s) => karta(db, s));
    ustawCeneReczna(db, { kartaId: a, kanal: 'polcien', cenaGr: 10500, kto: 'administrator', at: T0 });
    ustawCeneReczna(db, { kartaId: c, kanal: 'allegro_polcien', cenaGr: 2500, kto: 'administrator', at: T0 });
    const wynik = cenyReczneKart(db, [a, b, c]);
    expect(wynik).toEqual(
      new Map([
        [a, new Map([['polcien', 10500]])],
        [c, new Map([['allegro_polcien', 2500]])],
      ]),
    );
    expect(cenyReczneKart(db, [b])).toEqual(new Map());
    expect(cenyReczneKart(db, [])).toEqual(new Map());
  });

  it('odmawia ceny zerowej, ujemnej i ułamkowej oraz pustego konta — bez zapisu', () => {
    const db = pelna();
    const a = karta(db, 'LMP-6');
    for (const cenaGr of [0, -100, 10.5, '105', null]) {
      expect(() => ustawCeneReczna(db, { kartaId: a, kanal: 'polcien', cenaGr, kto: 'administrator', at: T0 })).toThrow(
        /cen/i,
      );
    }
    expect(() => ustawCeneReczna(db, { kartaId: a, kanal: ' ', cenaGr: 100, kto: 'administrator', at: T0 })).toThrow(
      /kana/i,
    );
    expect(cenyReczneKarty(db, a)).toEqual(new Map());
  });
});

describe('chronCeneKarty', () => {
  it('cena z importu dostaje źródło oms/reczne=1, wartość ceny karty bez zmian, import już jej nie zmieni', () => {
    const db = pelna();
    const a = karta(db, 'LMP-7', 10000);
    db.prepare(
      "INSERT INTO karty_zrodla_pol (karta_id, pole, zrodlo, reczne, zmieniono_at) VALUES (?, 'cena_gr', 'woo:polcien', 0, ?)",
    ).run(a, T0);
    expect(importMozeZapisac('cena_gr', 10000, zrodloCeny(db, a), 'woo:polcien')).toBe(true);

    expect(chronCeneKarty(db, a, T1)).toBe(true);
    expect(zrodloCeny(db, a)).toEqual({ zrodlo: 'oms', reczne: 1, zmieniono_at: T1 });
    expect(db.prepare('SELECT cena_gr FROM karty_produktow WHERE id = ?').get(a).cena_gr).toBe(10000);
    expect(importMozeZapisac('cena_gr', 10000, zrodloCeny(db, a), 'woo:polcien')).toBe(false);
  });

  it('karta bez wiersza źródła dostaje go; ręczna cena (reczne=1) zostaje nietknięta', () => {
    const db = pelna();
    const a = karta(db, 'LMP-8');
    const b = karta(db, 'LMP-9');
    db.prepare(
      "INSERT INTO karty_zrodla_pol (karta_id, pole, zrodlo, reczne, zmieniono_at) VALUES (?, 'cena_gr', 'reczne', 1, ?)",
    ).run(b, T0);
    expect(zrodloCeny(db, a)).toBe(null);
    expect(chronCeneKarty(db, a, T1)).toBe(true);
    expect(zrodloCeny(db, a)).toEqual({ zrodlo: 'oms', reczne: 1, zmieniono_at: T1 });
    expect(chronCeneKarty(db, b, T1)).toBe(false);
    expect(zrodloCeny(db, b)).toEqual({ zrodlo: 'reczne', reczne: 1, zmieniono_at: T0 });
    // Inne pola karty bez zmian.
    expect(db.prepare("SELECT count(*) AS n FROM karty_zrodla_pol WHERE pole != 'cena_gr'").get().n).toBe(0);
  });
});

describe('dziennik zmian w kanałach', () => {
  it('zapis wpisu: liczby jako tekst, karta może być pusta, zły wynik odrzucony', () => {
    const db = pelna();
    const a = karta(db, 'LMP-10');
    const id = zapiszZmianeWKanale(db, {
      kanal: 'polcien',
      kartaId: a,
      cel: 'produkt:123',
      pole: 'cena',
      stara: 10000,
      nowa: 11000,
      kto: 'administrator',
      at: T0,
      wynik: 'ok',
    });
    zapiszZmianeWKanale(db, {
      kanal: 'allegro_polcien',
      kartaId: null,
      cel: 'oferta:7700000001',
      pole: 'status',
      stara: 'ACTIVE',
      nowa: 'ENDED',
      kto: 'administrator',
      at: T1,
      wynik: 'blad',
      blad: 'Allegro odmówiło',
    });
    expect(typeof id).toBe('number');
    expect(
      db
        .prepare('SELECT * FROM zmiany_w_kanalach ORDER BY id')
        .all()
        .map((w) => ({ ...w })),
    ).toEqual([
      {
        id,
        kanal: 'polcien',
        karta_id: a,
        cel: 'produkt:123',
        pole: 'cena',
        stara: '10000',
        nowa: '11000',
        kto: 'administrator',
        at: T0,
        wynik: 'ok',
        blad: null,
      },
      {
        id: id + 1,
        kanal: 'allegro_polcien',
        karta_id: null,
        cel: 'oferta:7700000001',
        pole: 'status',
        stara: 'ACTIVE',
        nowa: 'ENDED',
        kto: 'administrator',
        at: T1,
        wynik: 'blad',
        blad: 'Allegro odmówiło',
      },
    ]);
    expect(() =>
      zapiszZmianeWKanale(db, {
        kanal: 'polcien',
        cel: 'produkt:1',
        pole: 'cena',
        kto: 'administrator',
        at: T0,
        wynik: 'moze',
      }),
    ).toThrow(/CHECK/);
  });
});

describe('ustawStatusPublikacji', () => {
  it('zmienia produkt i wszystkie jego warianty w lustrze tego konta, nic więcej', () => {
    const db = pelna();
    const wstaw = db.prepare(
      `INSERT INTO produkty_sklepowe (kanal, produkt_id, wariant_id, nazwa, status_publikacji, odczytane_at)
       VALUES (?, ?, ?, 'Lampa Półcień 40', 'publish', ?)`,
    );
    for (const [kanal, produkt, wariant] of [
      ['polcien', '123', ''],
      ['polcien', '123', '501'],
      ['polcien', '123', '502'],
      ['polcien', '124', ''],
      ['polcien_hurt', '123', ''],
    ])
      wstaw.run(kanal, produkt, wariant, T0);
    expect(ustawStatusPublikacji(db, 'polcien', '123', 'draft')).toBe(3);
    expect(
      db
        .prepare('SELECT kanal, produkt_id, wariant_id, status_publikacji FROM produkty_sklepowe ORDER BY id')
        .all()
        .map((w) => [w.kanal, w.produkt_id, w.wariant_id, w.status_publikacji]),
    ).toEqual([
      ['polcien', '123', '', 'draft'],
      ['polcien', '123', '501', 'draft'],
      ['polcien', '123', '502', 'draft'],
      ['polcien', '124', '', 'publish'],
      ['polcien_hurt', '123', '', 'publish'],
    ]);
    expect(ustawStatusPublikacji(db, 'polcien', '999', 'draft')).toBe(0);
  });
});

describe('baza bez migracji', () => {
  it('odczyt ręcznych cen daje pustą mapę bez wyjątku; zapis odmawia z czytelnym powodem', () => {
    const db = openOmsDb(':memory:', {
      moduly: [{ ...modulRdzen, migracje: modulRdzen.migracje.filter((m) => m.numer !== 19) }],
    });
    bazy.push(db);
    const a = karta(db, 'LMP-11');
    expect(cenyReczneKarty(db, a)).toEqual(new Map());
    expect(cenyReczneKart(db, [a])).toEqual(new Map());
    expect(() =>
      ustawCeneReczna(db, { kartaId: a, kanal: 'polcien', cenaGr: 100, kto: 'administrator', at: T0 }),
    ).toThrow(/ceny_kanalow_kart/);
    expect(() =>
      zapiszZmianeWKanale(db, {
        kanal: 'polcien',
        cel: 'produkt:1',
        pole: 'cena',
        kto: 'administrator',
        at: T0,
        wynik: 'ok',
      }),
    ).toThrow(/zmiany_w_kanalach/);
  });
});
