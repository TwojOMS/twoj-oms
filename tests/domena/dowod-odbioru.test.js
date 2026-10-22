// PRZ-108.09 (zmiana C2 planu automatyzacji, test 1): BIAŁA LISTA dowodów, że kurier odebrał paczkę — podstawa zdarzenia
// „Kurier odebrał paczkę”. Mail do klienta jest nieodwracalny, więc rozstrzyga lista ZMIERZONYCH stanów, a nie
// `etapPrzesylki` (ten nieznany stan InPostu uznaje za „w drodze”, a opis z „odbiorc” za doręczenie).
//
// Przykładowe odpowiedzi to zapisane stany z repo:
//  • DPD — opisy z sondy na żywym API zdarzeń (23.08) i produkcyjnej bazy (`domena/przejecie-przesylki.js`, PRZEJETE_DPD;
//    fikstura `tests/oms/fixtures/dpd/info-events-ok.xml` — „Zarejestrowano dane przesyłki, przesyłka jeszcze nie nadana”);
//  • InPost — NASZE opisy stanów (`oms/kurierzy/inpost.js`, OPISY_STANOW; tylko stany widziane na koncie);
//  • Allegro — maszynowe kody zasobu śledzenia (sonda 25.08, `domena/etap-przesylki.js`, KODY_ALLEGRO).
import { describe, it, expect } from 'vitest';
import {
  dowodOdbioru, OPISY_ODBIORU_INPOST, STANY_INPOST_BEZ_ODBIORU, KODY_ODBIORU_ALLEGRO,
  msCzasuKuriera, chwilaDowoduUKuriera, odbiorSpozniony, ODBIOR_SPOZNIONY_H,
} from '../../src/domena/dowod-odbioru.js';
import { OPISY_STANOW } from '../../src/oms/kurierzy/inpost.js';
import { KODY_ALLEGRO } from '../../src/domena/etap-przesylki.js';

const p = (o = {}) => ({ kurier: 'dpd', status_kuriera: null, status_kuriera_kod: null, przejeta_at: null, ...o });

describe('dowodOdbioru — plan C2, test 1', () => {
  it('Allegro: PENDING → nie; IN_TRANSIT → tak (kod rozstrzyga, opis to tłumaczenie)', () => {
    expect(dowodOdbioru(p({ kurier: 'allegro', status_kuriera: 'Przesyłka przygotowana przez nadawcę', status_kuriera_kod: 'PENDING' }))).toBeNull();
    expect(dowodOdbioru(p({ kurier: 'allegro', status_kuriera: 'Przesyłka w drodze', status_kuriera_kod: 'IN_TRANSIT' }))).toBe('allegro:IN_TRANSIT');
    for (const kod of ['RELEASED_FOR_DELIVERY', 'AVAILABLE_FOR_PICKUP', 'DELIVERED']) {
      expect(dowodOdbioru(p({ kurier: 'allegro', status_kuriera_kod: kod })), kod).toBe(`allegro:${kod}`);
    }
  });

  it('Allegro: nieznany kod → nie, nawet gdy opis brzmi jak odbiór (nowy kod nie może wpaść po cichu)', () => {
    expect(dowodOdbioru(p({ kurier: 'allegro', status_kuriera: 'Przesyłka odebrana przez Kuriera', status_kuriera_kod: 'NEW_FROM_API' }))).toBeNull();
  });

  it('DPD „Przesyłka odebrana przez Kuriera” → tak; zarejestrowana → nie', () => {
    expect(dowodOdbioru(p({ status_kuriera: 'Przesyłka odebrana przez Kuriera' }))).toBe('dpd:ODEBRANA_PRZEZ_KURIERA');
    expect(dowodOdbioru(p({ status_kuriera: 'Przyjęcie przesyłki w oddziale DPD' }))).toBe('dpd:PRZYJECIE_W_ODDZIALE');
    expect(dowodOdbioru(p({ status_kuriera: '  przesyłka doręczona ' }))).toBe('dpd:DORECZONA');
    expect(dowodOdbioru(p({ status_kuriera: 'Zarejestrowano dane przesyłki, przesyłka jeszcze nie nadana' }))).toBeNull();
  });

  it('InPost confirmed („Przesyłka zarejestrowana”) → nie; stany po przyjęciu w oddziale → tak', () => {
    expect(dowodOdbioru(p({ kurier: 'inpost', status_kuriera: OPISY_STANOW.confirmed }))).toBeNull();
    expect(dowodOdbioru(p({ kurier: 'inpost', status_kuriera: OPISY_STANOW.adopted_at_source_branch }))).toBe('inpost:adopted_at_source_branch');
    expect(dowodOdbioru(p({ kurier: 'inpost', status_kuriera: OPISY_STANOW.delivered }))).toBe('inpost:delivered');
  });

  it('„InPost: nieznany stan „x”” → nie (etapPrzesylki uznałby go za „w drodze”)', () => {
    expect(dowodOdbioru(p({ kurier: 'inpost', status_kuriera: 'InPost: nieznany stan „x”' }))).toBeNull();
    expect(dowodOdbioru(p({ kurier: 'inpost', status_kuriera: 'InPost: nieznany stan „collected_from_sender”' }))).toBeNull();
  });

  it('opis „odbiorca nieobecny” → nie (etapPrzesylki uznałby go za doręczenie przez podłańcuch „odbiorc”)', () => {
    expect(dowodOdbioru(p({ status_kuriera: 'Odbiorca nieobecny, pozostawiono awizo' }))).toBeNull();
    expect(dowodOdbioru(p({ status_kuriera: 'Przesyłka w drodze' }))).toBeNull();
  });

  it('`przejeta_at` (Wysyłam z Allegro: dowód przejęcia) → tak', () => {
    expect(dowodOdbioru(p({ kurier: 'allegro_wza', przejeta_at: '2026-10-21T10:00:00.000Z' }))).toBe('przejecie');
  });

  it('najnowszy stan to zwrot → nie (mail „kurier odebrał” przy paczce wracającej do nadawcy myli)', () => {
    expect(dowodOdbioru(p({ kurier: 'inpost', status_kuriera: OPISY_STANOW.returned_to_sender }))).toBeNull();
    expect(dowodOdbioru(p({ kurier: 'allegro_wza', przejeta_at: '2026-10-21T10:00:00.000Z', status_kuriera: 'Zwrot przesyłki do nadawcy' }))).toBeNull();
  });

  it('historia odpowiedzi DPD: odbiór widać w historii, choć najnowsze zdarzenie spoza listy', () => {
    const historia = [
      { opis: 'Zarejestrowano dane przesyłki, przesyłka jeszcze nie nadana', at: '2026-10-21T08:00:00.000' },
      { opis: 'Przesyłka odebrana przez Kuriera', at: '2026-10-21T14:10:00.000' },
      { opis: 'Wydanie przesyłki do doręczenia', at: '2026-10-22T07:00:00.000' },
    ];
    expect(dowodOdbioru(p({ status_kuriera: 'Wydanie przesyłki do doręczenia' }))).toBeNull();
    expect(dowodOdbioru(p({ status_kuriera: 'Wydanie przesyłki do doręczenia' }), { historia })).toBe('historia:ODEBRANA_PRZEZ_KURIERA');
    expect(dowodOdbioru(p({ status_kuriera: 'Zarejestrowano dane przesyłki, przesyłka jeszcze nie nadana' }), { historia: historia.slice(0, 1) })).toBeNull();
  });

  it('historia Allegro: kod ruchu w historii → tak; sama rejestracja → nie', () => {
    const allegro = () => p({ kurier: 'allegro', status_kuriera_kod: 'NEW_FROM_API' });
    expect(dowodOdbioru(allegro(), { historia: [{ code: 'PENDING', occurredAt: '2026-10-21T08:00:00Z' }] })).toBeNull();
    expect(dowodOdbioru(allegro(), { historia: [{ code: 'IN_TRANSIT', occurredAt: '2026-10-21T09:00:00Z' }] })).toBe('historia:IN_TRANSIT');
  });

  it('pusta paczka, brak statusu → nie', () => {
    expect(dowodOdbioru(null)).toBeNull();
    expect(dowodOdbioru(p())).toBeNull();
  });
});

describe('strażnicy zupełności białej listy', () => {
  it('każdy stan InPost z OPISY_STANOW ma jawną decyzję: odbiór albo nie-odbiór; opisy z tego samego słownika', () => {
    const decyzje = [...Object.keys(OPISY_ODBIORU_INPOST), ...STANY_INPOST_BEZ_ODBIORU].sort();
    expect(decyzje).toEqual(Object.keys(OPISY_STANOW).sort());
    for (const [stan, opis] of Object.entries(OPISY_ODBIORU_INPOST)) expect(opis, stan).toBe(OPISY_STANOW[stan]);
    expect(STANY_INPOST_BEZ_ODBIORU).toEqual(expect.arrayContaining(['confirmed', 'returned_to_sender']));
  });

  it('każdy kod Allegro z KODY_ALLEGRO ma decyzję; odbiór = wszystko poza rejestracją (PENDING)', () => {
    expect([...KODY_ODBIORU_ALLEGRO].sort()).toEqual(Object.keys(KODY_ALLEGRO).filter((k) => KODY_ALLEGRO[k] !== 'nadana').sort());
  });
});

// Recenzja 09, usterka 1: czas zdarzenia U KURIERA (kiedy kurier naprawdę odebrał) — do odrzucenia spóźnionego dowodu.
describe('czas odbioru u kuriera i spóźniony dowód', () => {
  it('DPD bez strefy = czas warszawski (lato +2, zima +1); ze strefą — jak podano', () => {
    expect(msCzasuKuriera('2026-10-21T14:10:00.000')).toBe(Date.parse('2026-10-21T12:10:00.000Z'));
    expect(msCzasuKuriera('2026-12-01T10:00:00.000')).toBe(Date.parse('2026-12-01T09:00:00.000Z'));
    expect(msCzasuKuriera('2026-10-21T12:10:00Z')).toBe(Date.parse('2026-10-21T12:10:00Z'));
    expect(msCzasuKuriera('2026-10-21T14:10:00+02:00')).toBe(Date.parse('2026-10-21T12:10:00Z'));
    expect(Number.isNaN(msCzasuKuriera(null))).toBe(true);
    expect(Number.isNaN(msCzasuKuriera('x'))).toBe(true);
  });

  it('chwila dowodu: NAJWCZEŚNIEJSZY odbiór w historii; bez historii — przejęcie WzA, potem czas najnowszego zdarzenia', () => {
    const historia = [
      { opis: 'Zarejestrowano dane przesyłki, przesyłka jeszcze nie nadana', at: '2026-10-21T08:00:00.000' },
      { opis: 'Przesyłka odebrana przez Kuriera', at: '2026-10-21T14:10:00.000' },
      { opis: 'Przesyłka doręczona', at: '2026-10-22T09:00:00.000' },
    ];
    expect(chwilaDowoduUKuriera(p({ status_kuriera: 'Przesyłka doręczona', status_kuriera_at: '2026-10-22T09:00:00.000' }), { historia }))
      .toBe('2026-10-21T12:10:00.000Z');
    expect(chwilaDowoduUKuriera(p({ przejeta_at: '2026-10-23T00:00:00.000Z', przejecie_zdarzenie_at: '2026-10-21T10:00:00Z' })))
      .toBe('2026-10-21T10:00:00.000Z');
    expect(chwilaDowoduUKuriera(p({ kurier: 'inpost', status_kuriera: 'Odebrana przez klienta', status_kuriera_at: '2026-10-21T12:00:00.000Z' })))
      .toBe('2026-10-21T12:00:00.000Z');
    expect(chwilaDowoduUKuriera(p({ status_kuriera: 'Przesyłka odebrana przez Kuriera' }))).toBeNull();
  });

  it(`odbiór u kuriera ponad ${ODBIOR_SPOZNIONY_H} h przed zapisem → odbior_spozniony; 47 h → spełnione; brak czasu kuriera → spełnione`, () => {
    const zapis = '2026-10-24T12:00:00.000Z';
    const z = (kurierAt) => ({ przesylki: [{ id: 7, odebrana_at: zapis, odebrana_kurier_at: kurierAt }] });
    expect(odbiorSpozniony(z('2026-10-22T11:00:00.000Z'), { przesylka_id: 7 })).toMatchObject({ ok: false, kod: 'odbior_spozniony' });
    expect(odbiorSpozniony(z('2026-10-22T11:00:00.000Z'), { przesylka_id: 7 }).powod).toContain('49 godzin');
    expect(odbiorSpozniony(z('2026-10-22T13:00:00.000Z'), { przesylka_id: 7 })).toEqual({ ok: true });
    expect(odbiorSpozniony(z(null), { przesylka_id: 7 })).toEqual({ ok: true });
    expect(odbiorSpozniony(z('2026-10-01T00:00:00.000Z'), { przesylka_id: 8 })).toEqual({ ok: true });
  });
});
