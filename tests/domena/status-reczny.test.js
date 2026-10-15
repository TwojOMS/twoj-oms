import { describe, it, expect } from 'vitest';
import {
  STATUSY_RECZNE, OPCJE_STATUSU, faktyDlaStatusu, powodOdmowyStatusu,
  anulowaneWSklepie, anulowaneEfektywnie,
} from '../../src/domena/status-reczny.js';
import { wyliczStatus } from '../../src/domena/status.js';

const TERAZ = '2026-07-30T12:00:00.000Z';

// Wiersz zamowienia w postaci, jaka oddaje zLinii(): `anulowane` to juz wartosc EFEKTYWNA,
// a `anulowane_sklep` niesie to, co powiedzial sklep.
const z = (o = {}) => ({
  anulowane: 0, anulowane_sklep: 0, anulowane_recznie: 0,
  w_realizacji_at: null, zwrot_at: null, zwrot_powod: null, przesylki: [], faktura: null, ...o,
});

// Zastosowanie faktow do wiersza — dokladnie to, co robi zapiszFaktyStatusu w bazie.
// Dzieki temu kazdy test moze zapytac o RZECZ ISTOTNA: „czy wyliczStatus oddaje to,
// co czlowiek wybral", zamiast sprawdzac same nazwy kolumn.
// Wartosc EFEKTYWNA liczy sie zawsze OD NOWA z faktu sklepowego i recznego (tak robi
// zLinii) — nigdy z poprzedniej wartosci efektywnej. Inaczej raz zapalone anulowanie
// podtrzymywaloby samo siebie i nie dalo by sie go cofnac nawet recznie.
const poZmianie = (wiersz, docelowy, powod = null) => {
  const fakty = faktyDlaStatusu(wiersz, docelowy, { powod, teraz: TERAZ });
  const nowy = { ...wiersz, ...fakty };
  nowy.anulowane = anulowaneEfektywnie({ anulowane: wiersz.anulowane_sklep, anulowane_recznie: nowy.anulowane_recznie }) ? 1 : 0;
  return nowy;
};

describe('faktyDlaStatusu — wybor statusu zapisuje FAKTY, nie etykiete', () => {
  // Sedno calego zadania: kazdy reczny status musi dac sie ODCZYTAC z powrotem przez
  // wyliczStatus. Gdyby ktos zaczal odkladac status do kolumny, ta petla przestalaby
  // cokolwiek znaczyc — i wlasnie ona jest dowodem, ze tego nie zrobiono.
  it.each(STATUSY_RECZNE)('wybor „%s" daje status „%s" z samych faktow', (klucz) => {
    expect(wyliczStatus(poZmianie(z(), klucz, 'powód'))).toBe(klucz);
  });

  it('„w realizacji" nie zmysla przeszlosci — zachowuje date juz zapisana', () => {
    const fakty = faktyDlaStatusu(z({ w_realizacji_at: '2026-07-01T08:00:00' }), 'w_realizacji', { teraz: TERAZ });
    expect(fakty.w_realizacji_at).toBe('2026-07-01T08:00:00');
  });

  it('„nowe" kasuje WSZYSTKIE reczne fakty naraz', () => {
    const fakty = faktyDlaStatusu(
      z({ w_realizacji_at: '2026-07-01', zwrot_at: '2026-07-02', zwrot_powod: 'x', anulowane_recznie: 1 }),
      'nowe', { teraz: TERAZ },
    );
    expect(fakty).toEqual({ w_realizacji_at: null, wyslane_at: null, zwrot_at: null, zwrot_powod: null, anulowane_recznie: 0 });
  });

  // ⚠️ 08.2026 (Zadanie 3): „zwrot" ZNIKLO z STATUSY_RECZNE, wiec straznik na gorze
  // `faktyDlaStatusu` rzuca ZANIM dojdzie do galezi 'zwrot' w switchu — ten test byl
  // „«zwrot» zapisuje powod razem z data" i sprawdzal wlasnie ta galaz. Galaz zostala w
  // kodzie (zeby nie zmieniac zachowania starego `zwrot_at`), ale jest juz NIEOSIAGALNA
  // stad — sprawdzamy wiec, ze proba w ogole nie przechodzi.
  it('„zwrot" nie da sie juz ustawic przez faktyDlaStatusu — straznik rzuca pierwszy', () => {
    expect(() => faktyDlaStatusu(z(), 'zwrot', { powod: 'uszkodzony w transporcie', teraz: TERAZ }))
      .toThrow(/Nieznany status/);
  });

  it('pusty powod tez nie omija straznika — „zwrot" jest odrzucany zawsze', () => {
    expect(() => faktyDlaStatusu(z({ zwrot_at: '2026-07-02', zwrot_powod: 'stary' }), 'zwrot', { powod: '  ', teraz: TERAZ }))
      .toThrow(/Nieznany status/);
  });

  // Anulowanie NIE jest wymazaniem historii: paczka pojechala, zwrot byl — te fakty zostaja.
  it('„anulowane" zostawia pozostale fakty nietkniete', () => {
    const fakty = faktyDlaStatusu(z({ w_realizacji_at: '2026-07-01', zwrot_at: '2026-07-02', zwrot_powod: 'x' }), 'anulowane', { teraz: TERAZ });
    expect(fakty).toEqual({
      w_realizacji_at: '2026-07-01', wyslane_at: null, zwrot_at: '2026-07-02', zwrot_powod: 'x', anulowane_recznie: 1,
    });
  });

  it('nieznany klucz rzuca, zamiast po cichu nic nie zapisac', () => {
    expect(() => faktyDlaStatusu(z(), 'wymyslony', { teraz: TERAZ })).toThrow(/wymyslony/);
  });
});

describe('powodOdmowyStatusu', () => {
  // ⚠️ ZMIANA 2026-07-31: „wyslane" JEST teraz do ustawienia ręcznie. Do tej pory
  // wynikało z istnienia nadanej paczki i było odmawiane — ale etykieta powstaje przy
  // pakowaniu, a paczka wyjeżdża dopiero z kurierem, więc panel nie zna momentu wyjazdu.
  // Zna go człowiek, więc to on go zapisuje (fakt `wyslane_at`).
  it('„wyslane" jest do ustawienia recznie i nie jest juz odmawiane', () => {
    expect(powodOdmowyStatusu(z(), 'wyslane')).toBeNull();
    expect(STATUSY_RECZNE).toContain('wyslane');
    expect(OPCJE_STATUSU.map((o) => o.klucz)).toContain('wyslane');
  });

  it.each(STATUSY_RECZNE)('„%s" na zwyklym zamowieniu przechodzi', (klucz) => {
    expect(powodOdmowyStatusu(z(), klucz)).toBeNull();
  });

  // Anulowanie dziala TYLKO w jedna strone: pozwolenie na odanulowanie otworzyloby droge
  // do nadania paczki do zamowienia, ktore klient anulowal.
  // ⚠️ 08.2026: 'zwrot' zastapione 'wyslane' — 'zwrot' zniknelo z STATUSY_RECZNE (Zadanie 3),
  // wiec dla niego `powodOdmowyStatusu` zwraca dzis „Nieznany status", NIEZALEZNIE od
  // anulowania (patrz test nizej „nieznany status dostaje odmowe"). Uzycie go tutaj
  // sprawdzaloby wiec zla galaz kodu, a nie te, ktora ten test ma chronic.
  it.each(['nowe', 'w_realizacji', 'wyslane'])('anulowane W SKLEPIE odmawia zmiany na „%s"', (klucz) => {
    const powod = powodOdmowyStatusu(z({ anulowane: 1, anulowane_sklep: 1 }), klucz);
    expect(powod).toMatch(/wycofaj anulowanie w sklepie/i);
  });

  it('anulowane w sklepie NIE blokuje ponownego wyboru „anulowane"', () => {
    expect(powodOdmowyStatusu(z({ anulowane: 1, anulowane_sklep: 1 }), 'anulowane')).toBeNull();
  });

  // Odwrotnie niz wyzej: anulowanie zapisane RECZNIE jest naszym wlasnym faktem, wiec
  // panel musi umiec z niego wyjsc — inaczej jedno omylkowe klikniecie bylo by wieczne.
  it('anulowane RECZNIE da sie cofnac', () => {
    const wiersz = z({ anulowane: 1, anulowane_sklep: 0, anulowane_recznie: 1 });
    expect(powodOdmowyStatusu(wiersz, 'nowe')).toBeNull();
    expect(wyliczStatus(poZmianie(wiersz, 'nowe'))).toBe('nowe');
  });

  it('nieznany status dostaje odmowe, a nie ciche przejscie', () => {
    expect(powodOdmowyStatusu(z(), 'wymyslony')).toMatch(/Nieznany status/i);
  });
});

describe('anulowaneWSklepie / anulowaneEfektywnie', () => {
  it('anulowanie sklepu i reczne sumuja sie do efektywnego', () => {
    expect(anulowaneEfektywnie({ anulowane: 0, anulowane_recznie: 1 })).toBe(true);
    expect(anulowaneEfektywnie({ anulowane: 1, anulowane_recznie: 0 })).toBe(true);
    expect(anulowaneEfektywnie({ anulowane: 0, anulowane_recznie: 0 })).toBe(false);
  });

  // Na surowym wierszu (przed zLinii) `anulowane` to jeszcze wartosc ze sklepu — funkcja
  // musi dawac te sama odpowiedz po obu stronach tej granicy.
  it('czyta wartosc ze sklepu takze na surowym wierszu, bez kolumny _sklep', () => {
    expect(anulowaneWSklepie({ anulowane: 1, anulowane_recznie: 0 })).toBe(true);
    expect(anulowaneWSklepie({ anulowane: 0, anulowane_recznie: 1 })).toBe(false);
    expect(anulowaneWSklepie({ anulowane: 1, anulowane_sklep: 0, anulowane_recznie: 1 })).toBe(false);
  });
});

// „Indywidualne" WYNIKA ze znacznika zamówienia, więc nie ma czego ustawiać ręcznie —
// a gdyby było na liście, operator dostałby wybór, który przy zwykłym zamówieniu nie
// zrobiłby NIC (wyliczStatus i tak oddałby „nowe"). Wyjście ze statusu jest jedno
// i już istnieje: „W realizacji".
describe('status indywidualny nie jest do ustawienia ręcznie', () => {
  it('nie ma go na liście statusów ręcznych', () => {
    expect(STATUSY_RECZNE).not.toContain('indywidualne');
  });
});
