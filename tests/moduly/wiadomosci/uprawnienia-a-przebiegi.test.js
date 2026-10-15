import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszUstawienia } from '../../../src/oms/db/ustawienia.js';
import { zapiszWatek } from '../../../src/oms/db/allegro-watki.js';
import { KLUCZE } from '../../../src/domena/ustawienia-formulki.js';
import { createPollerWiadomosci } from '../../../src/moduly/wiadomosci/services/poller-wiadomosci.js';
import { createCzuwaczFormulki } from '../../../src/moduly/wiadomosci/services/czuwacz-formulki.js';
import { createOdswiezanieSpraw } from '../../../src/moduly/wiadomosci/services/dyskusje.js';

// ⚠️⚠️ NIE WOLAMY ZASOBU, DO KTOREGO KANAL NIE MA UPRAWNIENIA.
//
// Bez tej bariery panel wdrozony PRZED przewiazaniem kanalow strzelalby 403 przy kazdym
// przebiegu: /messaging/threads co 5 minut razy dwa konta, plus /sale/issues w tym samym
// cyklu — okolo 1150 nieudanych wywolan na dobe, prosto do raportu „Bledy techniczne"
// Allegro. Tego samego dnia (28.08) skonczylismy sprzatac 744 dziennie z innego endpointu.
//
// ⚠️ Brak wiedzy o zakresach (`[]`) znaczy „pytaj" — ta sama zasada, co w
// domain/uprawnienia-kanalu.js: nie wnioskujemy z niewiedzy.

const teraz = () => new Date('2026-08-28T21:00:00Z');
const KANALY = ['allegro_szkicownia', 'allegro_amarka'];

function klientSzpieg() {
  const wolania = [];
  return {
    wolania,
    pobierzWatki: async () => { wolania.push('watki'); return { watki: [], razem: 0 }; },
    pobierzWiadomosci: async () => ({ wiadomosci: [] }),
    pobierzSprawy: async () => { wolania.push('sprawy'); return { sprawy: [], razem: 0 }; },
    wyslijWiadomosc: async () => { wolania.push('wyslij'); return { id: 'm1' }; },
  };
}

const klienci = (k) => Object.fromEntries(KANALY.map((n) => [n, k]));

describe('uprawnienia a przebiegi w tle', () => {
  it('poller NIE pyta o wątki kanału bez uprawnienia messaging', async () => {
    const db = openOmsDb(':memory:');
    const k = klientSzpieg();
    await createPollerWiadomosci({
      db, klienci: klienci(k), teraz,
      brakiKanalu: () => ['allegro:api:messaging'],
    }).przebieg();
    expect(k.wolania).toEqual([]);
  });

  it('poller pyta normalnie, gdy uprawnienie jest', async () => {
    const db = openOmsDb(':memory:');
    const k = klientSzpieg();
    await createPollerWiadomosci({ db, klienci: klienci(k), teraz, brakiKanalu: () => [] }).przebieg();
    expect(k.wolania.filter((w) => w === 'watki')).toHaveLength(2);
  });

  it('brak innego uprawnienia NIE blokuje wiadomości', async () => {
    const db = openOmsDb(':memory:');
    const k = klientSzpieg();
    await createPollerWiadomosci({
      db, klienci: klienci(k), teraz, brakiKanalu: () => ['allegro:api:disputes'],
    }).przebieg();
    expect(k.wolania.filter((w) => w === 'watki')).toHaveLength(2);
  });

  it('odświeżanie spraw NIE pyta kanału bez uprawnienia disputes', async () => {
    const db = openOmsDb(':memory:');
    const k = klientSzpieg();
    await createOdswiezanieSpraw({
      db, klienci: klienci(k), teraz, brakiKanalu: () => ['allegro:api:disputes'],
    }).przebieg();
    expect(k.wolania).toEqual([]);
  });

  it('czuwacz formułki NIE wysyła przez kanał bez uprawnienia messaging', async () => {
    const db = openOmsDb(':memory:');
    zapiszUstawienia(db, {
      [KLUCZE.wlaczony]: '1', [KLUCZE.tresc]: 'Odpiszemy rano.',
      [KLUCZE.od]: '18', [KLUCZE.do]: '8', [KLUCZE.dni]: '0,1,2,3,4,5,6', [KLUCZE.karencja]: '0',
    }, '2026-08-28T20:00:00Z');
    zapiszWatek(db, {
      kanal: 'allegro_szkicownia', threadId: 't1', interlocutorLogin: 'kup',
      lastMessageDateTime: '2026-08-28T20:00:00Z', typ: 'COMMON', przeczytany: 0,
      ostatniaOdKupujacego: 1, ostatniaTresc: 'pytanie', pobranyAt: '2026-08-28T20:00:00Z',
    });
    const k = klientSzpieg();
    const wynik = await createCzuwaczFormulki({
      db, klienci: klienci(k), teraz, brakiKanalu: () => ['allegro:api:messaging'],
    }).przebieg();

    expect(k.wolania).toEqual([]);
    expect(wynik.wyslane).toBe(0);
    // ⚠️ I NIE ZOSTAWIA DOWODU — inaczej po przewiązaniu formułka nigdy by nie poszła,
    // bo „raz na wątek" liczy KAŻDY dowód, także nieudany.
    expect(db.prepare('SELECT COUNT(*) AS n FROM allegro_odpowiedzi').get().n).toBe(0);
  });

  it('domyślnie (bez wiedzy o zakresach) przebiegi działają jak dotąd', async () => {
    const db = openOmsDb(':memory:');
    const k = klientSzpieg();
    await createPollerWiadomosci({ db, klienci: klienci(k), teraz }).przebieg();
    await createOdswiezanieSpraw({ db, klienci: klienci(k), teraz }).przebieg();
    expect(k.wolania.filter((w) => w === 'watki')).toHaveLength(2);
    expect(k.wolania.filter((w) => w === 'sprawy')).toHaveLength(2);
  });
});
