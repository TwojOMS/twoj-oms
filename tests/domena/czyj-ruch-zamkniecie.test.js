import { describe, it, expect } from 'vitest';
import { czyjRuch } from '../../src/domena/czyj-ruch-watku.js';

// ⚠️⚠️ RECZNE „ZALATWIONE" — prosba wlasciciela z 29.08.2026: „sa stare wiadomosci gdzie
// klient napisal na koniec «Dziekuje» - temat zamkniety".
//
// Panel nie ma jak odroznic „Dziekuje" od pytania, wiec sam tego nie zamknie. Ale reczne
// zamkniecie NIE JEST nadpisaniem wyliczonego stanu — jest KOLEJNYM FAKTEM, z data,
// dokladnie jak dowod wyslanej odpowiedzi. Regula dalej liczy, tylko z jednego zrodla wiecej.
//
// ⚠️⚠️ NAJWAZNIEJSZE: ZAMKNIECIE OBEJMUJE STAN NA CHWILE ZAMKNIECIA, NIE WATEK NA ZAWSZE.
// `zamkniete_do` trzyma date ostatniej wiadomosci Z MOMENTU klikniecia. Gdy kupujacy napisze
// PO tym, watek wraca do „czeka" SAM. Bez tego jedno klikniecie uciszaloby watek na zawsze
// i nowe pytanie tego samego czlowieka przepadloby po cichu — a cisza wyglada jak brak pytan,
// nie jak usterka.

const w = (extra = {}) => ({
  kanal: 'allegro_szkicownia',
  thread_id: 't1',
  ostatnia_od_kupujacego: 1,
  last_message_date_time: '2026-07-21T12:31:46.767Z',
  ...extra,
});

describe('czyj ruch — ręczne „Załatwione"', () => {
  it('zamknięty wątek przestaje czekać, choć ostatni pisał kupujący', () => {
    // Dokladnie przypadek z produkcji: kupujacy napisal „Dziekuje" i nie ma na co odpisywac.
    expect(czyjRuch(w())).toBe('czeka');
    expect(czyjRuch(w({ zamkniete_do: '2026-07-21T12:31:46.767Z' }))).toBe('zalatwione');
  });

  it('⚠️ NOWA wiadomość kupującego OTWIERA wątek z powrotem', () => {
    const wrocil = w({
      zamkniete_do: '2026-07-21T12:31:46.767Z',
      last_message_date_time: '2026-08-15T09:00:00.000Z',
    });
    expect(czyjRuch(wrocil)).toBe('czeka');
  });

  it('zamknięcie NIE dotyczy wątku, w którym i tak my pisaliśmy ostatni', () => {
    // Nic sie nie psuje: stan bez zamkniecia i tak byl „zalatwione".
    expect(czyjRuch(w({ ostatnia_od_kupujacego: 0, zamkniete_do: '2026-07-21T12:31:46.767Z' })))
      .toBe('zalatwione');
  });

  it('nie wywraca się na dacie nie do odczytania — zamknięcie po prostu nie obejmuje', () => {
    expect(czyjRuch(w({ zamkniete_do: 'kiedys' }))).toBe('czeka');
    expect(czyjRuch(w({ last_message_date_time: 'kiedys', zamkniete_do: '2026-07-21T12:31:46.767Z' })))
      .toBe('czeka');
  });

  it('brak zamknięcia niczego nie zmienia — stare wywołania działają jak dotąd', () => {
    expect(czyjRuch(w({ zamkniete_do: null }))).toBe('czeka');
    expect(czyjRuch(w({ zamkniete_do: undefined }))).toBe('czeka');
    expect(czyjRuch(w())).toBe('czeka');
  });

  it('dowód formułki dalej ma pierwszeństwo nad zwykłym „załatwione"', () => {
    // Watek, w ktorym poszla TYLKO formulka, ma sie wyrozniac — czlowiek jeszcze nie odpisal.
    const dowody = [{ rodzaj: 'formulka', wyslany_at: '2026-07-21T13:00:00.000Z' }];
    expect(czyjRuch(w({ ostatnia_od_kupujacego: 0 }), dowody)).toBe('formulka');
  });
});
