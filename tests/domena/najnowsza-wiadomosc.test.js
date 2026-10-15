import { describe, it, expect } from 'vitest';
import { najnowszaWiadomosc } from '../../src/domena/najnowsza-wiadomosc.js';

// ⚠️⚠️ ZMIERZONE NA PRODUKCJI 29.08.2026: `GET /messaging/messages` ODDAJE OD NAJNOWSZEJ.
// Poller brał `wiadomosci[wiadomosci.length - 1]`, czyli — przy prawdziwej kolejności —
// NAJSTARSZĄ wiadomość wątku, prawie zawsze pytanie kupującego. Skutek: wszystkie 18 wątków
// szkicownia miało `ostatnia_od_kupujacego = 1` i NIGDY BY NIE ZGASŁO, mimo że właściciel
// odpisał na każdy z nich jeszcze 7 sierpnia. Dokładnie ta „lampka na zawsze", przed którą
// ostrzega komentarz w `czyj-ruch-watku.js`.
//
// Prawdziwy wątek, wypisany z sondy (bez treści):
//     [0] 2026-08-07T07:14:04.265Z  isInterlocutor=false   <- NASZA odpowiedź
//     [1] 2026-08-06T18:22:05.982Z  isInterlocutor=true    <- pytanie kupującego
// `lastMessageDateTime` wątku = 2026-08-07T07:14:04.265Z, czyli element ZEROWY.
//
// ⚠️ GROŹNIEJSZE NIŻ ZŁY KOLOR: czuwacz formułki wysyła DOKŁADNIE do wątków z
// `ostatnia_od_kupujacego`. Przy tej usterce kwalifikowało się wszystkie 18 — czyli
// włączenie autorespondera wysłałoby formułkę osiemnastu osobom, które pytały trzy tygodnie
// temu i JUŻ dostały odpowiedź. Nie wystrzeliło wyłącznie dlatego, że autoresponder nie był
// jeszcze włączony.
//
// ⚠️ DLATEGO REGUŁA NIE UFA KOLEJNOŚCI W OGÓLE — wybiera po dacie. Allegro nie obiecuje
// kolejności ani przy wątkach, ani przy wiadomościach; oparcie się na pozycji w tablicy
// to zakład o niepisany szczegół cudzego API.

const m = (createdAt, odKupujacego) => ({
  id: `m_${createdAt}`, text: 't', createdAt, author: { isInterlocutor: odKupujacego },
});

describe('najnowsza wiadomość wątku', () => {
  it('przy PRAWDZIWEJ kolejności Allegro (od najnowszej) bierze pierwszą', () => {
    const lista = [m('2026-08-07T07:14:04.265Z', false), m('2026-08-06T18:22:05.982Z', true)];
    expect(najnowszaWiadomosc(lista).createdAt).toBe('2026-08-07T07:14:04.265Z');
    expect(najnowszaWiadomosc(lista).author.isInterlocutor).toBe(false);
  });

  it('przy kolejności ODWROTNEJ bierze ostatnią — reguła nie zależy od kolejności', () => {
    const lista = [m('2026-08-06T18:22:05.982Z', true), m('2026-08-07T07:14:04.265Z', false)];
    expect(najnowszaWiadomosc(lista).createdAt).toBe('2026-08-07T07:14:04.265Z');
  });

  it('przy kolejności POMIESZANEJ też bierze najnowszą', () => {
    const lista = [
      m('2026-08-06T18:22:05.982Z', true),
      m('2026-08-07T07:14:04.265Z', false),
      m('2026-08-01T09:00:00.000Z', true),
    ];
    expect(najnowszaWiadomosc(lista).createdAt).toBe('2026-08-07T07:14:04.265Z');
  });

  it('pusta lista daje null', () => {
    expect(najnowszaWiadomosc([])).toBeNull();
    expect(najnowszaWiadomosc(null)).toBeNull();
    expect(najnowszaWiadomosc(undefined)).toBeNull();
  });

  it('⚠️ BEZ DATY NIE ZGADUJEMY — oddaje null, a nie „którąś"', () => {
    // `null` konczy w pollerze jako `ostatnia_od_kupujacego = 0`, czyli „nie czeka".
    // To jest BEZPIECZNA strona: falszywe „czeka" wysyla formulke do czlowieka, ktory
    // o nic nie prosil, a falszywe „zalatwione" najwyzej gasi lampke przy watku, ktory
    // i tak stoi na liscie. Nieodwracalne jest tylko jedno z tych dwoch.
    expect(najnowszaWiadomosc([{ text: 'bez daty' }, { text: 'tez bez' }])).toBeNull();
  });

  it('pomija wiadomości bez daty, gdy inne ją mają', () => {
    const lista = [{ text: 'bez daty' }, m('2026-08-07T07:14:04.265Z', false)];
    expect(najnowszaWiadomosc(lista).createdAt).toBe('2026-08-07T07:14:04.265Z');
  });

  it('pomija daty niemożliwe do odczytania', () => {
    const lista = [m('kiedys', true), m('2026-08-07T07:14:04.265Z', false)];
    expect(najnowszaWiadomosc(lista).createdAt).toBe('2026-08-07T07:14:04.265Z');
  });

  it('przy remisie dat bierze PÓŹNIEJSZĄ w tablicy — rozstrzygnięcie musi być jednoznaczne', () => {
    const lista = [m('2026-08-07T07:14:04.265Z', true), m('2026-08-07T07:14:04.265Z', false)];
    expect(najnowszaWiadomosc(lista).author.isInterlocutor).toBe(false);
  });
});
