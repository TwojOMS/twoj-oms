import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszWatek, listaWatkow, watek, wiadomosciWatku } from '../../../src/oms/db/allegro-watki.js';
import { createPollerWiadomosci } from '../../../src/moduly/wiadomosci/services/poller-wiadomosci.js';

const TERAZ = () => new Date('2026-08-28T22:00:00Z');

function klientAtrapa({ strony = [], wiadomosci = {} } = {}) {
  const zapytaneOWiadomosci = [];
  return {
    zapytaneOWiadomosci,
    pobierzWatki: async ({ offset }) => strony[offset / 20] ?? { watki: [], razem: 0 },
    pobierzWiadomosci: async (id) => {
      zapytaneOWiadomosci.push(id);
      return { wiadomosci: wiadomosci[id] ?? [] };
    },
  };
}

const strona = (watki, razem) => ({ watki, razem });
const w = (id, data, extra = {}) => ({
  id, lastMessageDateTime: data, read: false, type: 'COMMON',
  interlocutor: { login: `kup_${id}` }, ...extra,
});
// ⚠️ `createdAt` JEST OBOWIAZKOWE W ATRAPIE (domyslne, zeby nie przepisywac wszystkich
// wywolan). Do 29.08.2026 atrapa NIE MIALA DATY W OGOLE, wiec zaden test nie mogl zauwazyc,
// ze poller wybiera wiadomosc po POZYCJI w tablicy — a Allegro oddaje OD NAJNOWSZEJ.
const msg = (tresc, odKupujacego, createdAt = '2026-08-28T19:00:00.000Z') => ({
  id: `m_${tresc}`, text: tresc, createdAt, author: { isInterlocutor: odKupujacego },
});

describe('poller wiadomosci Allegro', () => {
  it('zapisuje nowe watki z obu kanalow', async () => {
    const db = openOmsDb(':memory:');
    const p = createPollerWiadomosci({
      db,
      klienci: {
        allegro_szkicownia: klientAtrapa({
          strony: [strona([w('a', '2026-08-28T20:00:00Z')], 1)],
          wiadomosci: { a: [msg('pytanie', true)] },
        }),
        allegro_amarka: klientAtrapa({
          strony: [strona([w('b', '2026-08-28T19:00:00Z')], 1)],
          wiadomosci: { b: [msg('inne', true)] },
        }),
      },
      teraz: TERAZ,
    });

    await p.przebieg();

    expect(listaWatkow(db).map((x) => `${x.kanal}:${x.thread_id}`))
      .toEqual(['allegro_szkicownia:a', 'allegro_amarka:b']);
  });

  it('NIE zatrzymuje sie na pierwszym znanym watku — kolejnosc nie jest zagwarantowana', async () => {
    const db = openOmsDb(':memory:');
    zapiszWatek(db, {
      kanal: 'allegro_szkicownia', threadId: 'znany', lastMessageDateTime: '2026-08-28T20:00:00Z',
      typ: 'COMMON', przeczytany: 0, ostatniaOdKupujacego: 1, ostatniaTresc: 'stare',
      pobranyAt: '2026-08-28T20:01:00Z',
    });
    const klient = klientAtrapa({
      strony: [
        strona([w('znany', '2026-08-28T20:00:00Z')], 2),   // strona 1: bez zmian
        strona([w('nowy', '2026-08-28T21:00:00Z')], 2),    // strona 2: NOWY, za znanym
      ],
      wiadomosci: { nowy: [msg('swieze', true)] },
    });
    const p = createPollerWiadomosci({ db, klienci: { allegro_szkicownia: klient }, teraz: TERAZ });

    await p.przebieg();

    expect(watek(db, 'allegro_szkicownia', 'nowy')).toBeTruthy();
  });

  it('nie dociaga wiadomosci watku, ktorego lastMessageDateTime sie nie zmienil', async () => {
    const db = openOmsDb(':memory:');
    zapiszWatek(db, {
      kanal: 'allegro_szkicownia', threadId: 'a', lastMessageDateTime: '2026-08-28T20:00:00Z',
      typ: 'COMMON', przeczytany: 0, ostatniaOdKupujacego: 1, ostatniaTresc: 'stare',
      pobranyAt: '2026-08-28T20:01:00Z',
    });
    const klient = klientAtrapa({ strony: [strona([w('a', '2026-08-28T20:00:00Z')], 1)] });
    const p = createPollerWiadomosci({ db, klienci: { allegro_szkicownia: klient }, teraz: TERAZ });

    await p.przebieg();

    expect(klient.zapytaneOWiadomosci).toEqual([]);
  });

  it('zapisuje, czy OSTATNIA wiadomosc jest od kupujacego', async () => {
    const db = openOmsDb(':memory:');
    const klient = klientAtrapa({
      strony: [strona([w('a', '2026-08-28T20:00:00Z')], 1)],
      // ⚠️ KOLEJNOSC JAK W PRAWDZIWYM ALLEGRO: OD NAJNOWSZEJ. Poprzednio fixture szedl
      // rosnaco i test przechodzil PRZYPADKIEM — brany element [-1] byl wtedy nasza
      // odpowiedzia. Na produkcji [-1] to najstarszy wpis, czyli pytanie kupujacego.
      wiadomosci: {
        a: [
          msg('nasza odpowiedz', false, '2026-08-07T07:14:04.265Z'),
          msg('pytanie', true, '2026-08-06T18:22:05.982Z'),
        ],
      },
    });
    const p = createPollerWiadomosci({ db, klienci: { allegro_szkicownia: klient }, teraz: TERAZ });

    await p.przebieg();

    const zapisany = watek(db, 'allegro_szkicownia', 'a');
    expect(zapisany.ostatnia_od_kupujacego).toBe(0);
    expect(zapisany.ostatnia_tresc).toBe('nasza odpowiedz');
  });

  it('przenosi CALA korespondencje do lustra, nie sama ostatnia wiadomosc', async () => {
    const db = openOmsDb(':memory:');
    const klient = klientAtrapa({
      strony: [strona([w('a', '2026-08-28T20:00:00Z')], 1)],
      wiadomosci: {
        a: [
          msg('odpowiedz', false, '2026-08-07T07:14:04.265Z'),
          msg('pytanie', true, '2026-08-06T18:22:05.982Z'),
        ],
      },
    });
    const p = createPollerWiadomosci({ db, klienci: { allegro_szkicownia: klient }, teraz: TERAZ });

    await p.przebieg();

    expect(wiadomosciWatku(db, 'allegro_szkicownia', 'a').map((m) => m.tresc))
      .toEqual(['pytanie', 'odpowiedz']);
  });

  it('awaria jednego kanalu NIE zabija drugiego', async () => {
    const db = openOmsDb(':memory:');
    const p = createPollerWiadomosci({
      db,
      klienci: {
        allegro_szkicownia: { pobierzWatki: async () => { throw new Error('Allegro: HTTP 500 przy /messaging/threads'); } },
        allegro_amarka: klientAtrapa({
          strony: [strona([w('b', '2026-08-28T19:00:00Z')], 1)],
          wiadomosci: { b: [msg('ok', true)] },
        }),
      },
      teraz: TERAZ,
    });

    const wynik = await p.przebieg();

    expect(watek(db, 'allegro_amarka', 'b')).toBeTruthy();
    expect(wynik.bledy).toHaveLength(1);
    expect(wynik.bledy[0]).toContain('HTTP 500');
  });

  it('drugi przebieg w trakcie pierwszego jest POMINIETY, nie rownolegly', async () => {
    const db = openOmsDb(':memory:');
    let zwolnij;
    const klient = {
      pobierzWatki: () => new Promise((res) => { zwolnij = () => res({ watki: [], razem: 0 }); }),
      pobierzWiadomosci: async () => ({ wiadomosci: [] }),
    };
    const p = createPollerWiadomosci({ db, klienci: { allegro_szkicownia: klient }, teraz: TERAZ });

    const pierwszy = p.przebieg();
    const drugi = await p.przebieg();
    expect(drugi).toEqual({ pominiety: true });
    zwolnij();
    await pierwszy;
  });

  it('zatrzymuje sie na suficie stron, zamiast zapetlic sie na blednej odpowiedzi', async () => {
    const db = openOmsDb(':memory:');
    let stron = 0;
    const klient = {
      // Allegro w kolko oddaje pelna strone i totalCount w nieskonczonosc.
      pobierzWatki: async () => {
        stron += 1;
        return { watki: Array.from({ length: 20 }, (_, i) => w(`x${stron}_${i}`, '2026-08-28T20:00:00Z')), razem: 999999 };
      },
      pobierzWiadomosci: async () => ({ wiadomosci: [msg('t', true)] }),
    };
    const p = createPollerWiadomosci({ db, klienci: { allegro_szkicownia: klient }, teraz: TERAZ });

    await p.przebieg();

    expect(stron).toBeLessThanOrEqual(50);
  });
});
