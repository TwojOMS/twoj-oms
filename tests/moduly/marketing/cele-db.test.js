import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  zalozCel, zapiszCel, ustawCzynny, listaCelow, celPoId,
  dopiszZdarzenie, sumaZdarzen, zdarzeniaCelu, cofnijOstatnie,
} from '../../../src/oms/db/cele.js';

let db;
let kolejneKonto = 0;
beforeEach(() => { db = openOmsDb(':memory:'); kolejneKonto = 0; });

// ⚠️ KLUCZ OBCY DO `konta` JEST EGZEKWOWANY — wymyslone id konta wywala zapis zdarzenia
// bledem „FOREIGN KEY constraint failed". Fikstura musi zalozyc PRAWDZIWE konto, i to jest
// dobra wiadomosc o bazie: historia celu nie moze wskazywac na osobe, ktorej nie ma.
const konto = (imie = 'Ktoś') => {
  kolejneKonto += 1;
  const info = db.prepare(
    'INSERT INTO konta (login, imie, hash_hasla, rola, czynne, admin, utworzone_at)'
    + " VALUES (?,?,'x','sprzedaz',1,0,'2026-09-01T00:00:00Z')",
  ).run(`login${kolejneKonto}`, imie);
  return Number(info.lastInsertRowid);
};

const nowy = (n = {}) => zalozCel(db, {
  nazwa: 'Nowe wzory', kontoId: null, rytm: 'tydzien', celIle: 5,
  miernik: 'reczny', odDnia: null, doDnia: null, ...n,
});

describe('zakladanie i odczyt celu', () => {
  it('zaklada cel i oddaje go po id', () => {
    const c = celPoId(db, nowy());
    expect(c.nazwa).toBe('Nowe wzory');
    expect(c.rytm).toBe('tydzien');
    expect(c.cel_ile).toBe(5);
    expect(c.czynny).toBe(1);
  });

  it('cel wspolny ma konto_id NULL i to jest poprawny stan', () => {
    expect(celPoId(db, nowy({ kontoId: null })).konto_id).toBe(null);
  });

  it('BAZA odrzuca cel_ile = 0 — „cel: zero" dzieli przez zero w pasku', () => {
    // Warunek stoi w CHECK, nie w kodzie: walidacje w kodzie da sie obejsc innym zapisem,
    // a przez baze nie przejdzie nic.
    expect(() => nowy({ celIle: 0 })).toThrow();
  });

  it('BAZA odrzuca cel_ile ujemny', () => {
    expect(() => nowy({ celIle: -3 })).toThrow();
  });

  it('cel_ile NULL przechodzi — to zadanie tak/nie', () => {
    expect(celPoId(db, nowy({ celIle: null })).cel_ile).toBe(null);
  });

  it('celPoId oddaje null na nieistniejacym, a nie undefined', () => {
    expect(celPoId(db, 999)).toBe(null);
  });
});

describe('lista celow', () => {
  it('domyslnie oddaje wszystkie, takze wygaszone', () => {
    const a = nowy({ nazwa: 'A' });
    nowy({ nazwa: 'B' });
    ustawCzynny(db, a, false);
    expect(listaCelow(db).map((c) => c.nazwa).sort()).toEqual(['A', 'B']);
  });

  it('tylkoCzynne odcina wygaszone', () => {
    const a = nowy({ nazwa: 'A' });
    nowy({ nazwa: 'B' });
    ustawCzynny(db, a, false);
    expect(listaCelow(db, { tylkoCzynne: true }).map((c) => c.nazwa)).toEqual(['B']);
  });

  it('wygaszone ida na koniec — lista ma byc stabilna miedzy odswiezeniami', () => {
    // Inaczej przycisk „+1" wedruje pod kursorem po kazdym wygaszeniu.
    const a = nowy({ nazwa: 'A' });
    nowy({ nazwa: 'B' });
    ustawCzynny(db, a, false);
    expect(listaCelow(db).map((c) => c.nazwa)).toEqual(['B', 'A']);
  });
});

describe('zdarzenia', () => {
  it('sumuje WYLACZNIE zdarzenia z zakresu dni', () => {
    const id = nowy();
    dopiszZdarzenie(db, { celId: id, dzien: '2026-09-06', ile: 9, kontoId: konto() }); // przed
    dopiszZdarzenie(db, { celId: id, dzien: '2026-09-08', ile: 2, kontoId: konto() });
    dopiszZdarzenie(db, { celId: id, dzien: '2026-09-13', ile: 1, kontoId: konto() });
    dopiszZdarzenie(db, { celId: id, dzien: '2026-09-14', ile: 9, kontoId: konto() }); // po
    expect(sumaZdarzen(db, id, { od: '2026-09-07', do: '2026-09-13' }).ile).toBe(3);
  });

  it('granice zakresu sa WLACZNE z obu stron', () => {
    const id = nowy();
    dopiszZdarzenie(db, { celId: id, dzien: '2026-09-07', ile: 1, kontoId: konto() });
    dopiszZdarzenie(db, { celId: id, dzien: '2026-09-13', ile: 1, kontoId: konto() });
    expect(sumaZdarzen(db, id, { od: '2026-09-07', do: '2026-09-13' }).ile).toBe(2);
  });

  it('oddaje DZIEN OSTATNIEGO wpisu — to jest zrodloAt miernika recznego', () => {
    const id = nowy();
    dopiszZdarzenie(db, { celId: id, dzien: '2026-09-08', ile: 1, kontoId: konto() });
    dopiszZdarzenie(db, { celId: id, dzien: '2026-09-11', ile: 1, kontoId: konto() });
    expect(sumaZdarzen(db, id, { od: '2026-09-07', do: '2026-09-13' }).ostatniDzien)
      .toBe('2026-09-11');
  });

  it('brak zdarzen to ile=0 i ostatniDzien=null — uczciwe zero, nie brak wiedzy', () => {
    expect(sumaZdarzen(db, nowy(), { od: '2026-09-07', do: '2026-09-13' }))
      .toEqual({ ile: 0, ostatniDzien: null });
  });

  it('okres bez granic (jednorazowy bez dat) liczy WSZYSTKIE zdarzenia celu', () => {
    // ⚠️ `dzien >= NULL` daje w SQLite NULL, czyli falsz. Bez warunku `? IS NULL` cel bez
    // terminu sumowalby ZERO zdarzen i wygladal na nietkniety.
    const id = nowy({ rytm: 'jednorazowy', celIle: null });
    dopiszZdarzenie(db, { celId: id, dzien: '2020-01-01', ile: 1, kontoId: konto() });
    dopiszZdarzenie(db, { celId: id, dzien: '2030-01-01', ile: 1, kontoId: konto() });
    expect(sumaZdarzen(db, id, { od: null, do: null }).ile).toBe(2);
  });

  it('zakres otwarty z JEDNEJ strony dziala tak samo', () => {
    const id = nowy();
    dopiszZdarzenie(db, { celId: id, dzien: '2020-01-01', ile: 1, kontoId: konto() });
    dopiszZdarzenie(db, { celId: id, dzien: '2030-01-01', ile: 1, kontoId: konto() });
    expect(sumaZdarzen(db, id, { od: '2025-01-01', do: null }).ile).toBe(1);
    expect(sumaZdarzen(db, id, { od: null, do: '2025-01-01' }).ile).toBe(1);
  });

  it('nie miesza zdarzen dwoch celow', () => {
    const a = nowy({ nazwa: 'A' });
    const b = nowy({ nazwa: 'B' });
    dopiszZdarzenie(db, { celId: a, dzien: '2026-09-08', ile: 5, kontoId: konto() });
    expect(sumaZdarzen(db, b, { od: null, do: null }).ile).toBe(0);
  });

  it('BAZA odrzuca zdarzenie wskazujace na NIEISTNIEJACE konto', () => {
    // Klucz obcy jest wlaczony i to jest celowe: historia celu nie moze wskazywac na osobe,
    // ktorej nie ma. Bez niego skasowanie konta zostawialoby wpisy przypisane w prozni,
    // a karta celu pokazywalaby „—" nieodroznialne od konta serwisowego.
    expect(() => dopiszZdarzenie(db, {
      celId: nowy(), dzien: '2026-09-08', ile: 1, kontoId: 9999,
    })).toThrow(/FOREIGN KEY/);
  });

  it('kontoId null przechodzi — to konto serwisowe albo czuwacz, nie brak danych', () => {
    const id = nowy();
    dopiszZdarzenie(db, { celId: id, dzien: '2026-09-08', ile: 1, kontoId: null });
    expect(zdarzeniaCelu(db, id)[0].konto_id).toBe(null);
  });

  it('zapisuje KTO kliknal i notatke', () => {
    const id = nowy();
    const ewa = konto('Ewa');
    dopiszZdarzenie(db, { celId: id, dzien: '2026-09-08', ile: 1, kontoId: ewa, notatka: 'FLORA' });
    const [z] = zdarzeniaCelu(db, id);
    expect(z.konto_id).toBe(ewa);
    expect(z.imie_konta).toBe('Ewa');
    expect(z.notatka).toBe('FLORA');
  });
});

describe('cofniecie', () => {
  it('zdejmuje OSTATNIE zdarzenie w okresie, czyjekolwiek', () => {
    const id = nowy();
    dopiszZdarzenie(db, { celId: id, dzien: '2026-09-08', ile: 1, kontoId: konto() });
    dopiszZdarzenie(db, { celId: id, dzien: '2026-09-11', ile: 1, kontoId: konto() });
    expect(cofnijOstatnie(db, id, { od: '2026-09-07', do: '2026-09-13' })).toBe(true);
    expect(sumaZdarzen(db, id, { od: '2026-09-07', do: '2026-09-13' }).ile).toBe(1);
    expect(zdarzeniaCelu(db, id)[0].dzien).toBe('2026-09-08');
  });

  it('NIE rusza zdarzen spoza okresu', () => {
    // Cofniecie ma naprawiac omylkowy klik SPRZED chwili, a nie przepisywac zamkniety
    // tydzien. Bez tego warunku „cofnij" w pustym tygodniu zjadaloby historie wstecz.
    const id = nowy();
    dopiszZdarzenie(db, { celId: id, dzien: '2026-08-01', ile: 1, kontoId: konto() });
    expect(cofnijOstatnie(db, id, { od: '2026-09-07', do: '2026-09-13' })).toBe(false);
    expect(zdarzeniaCelu(db, id)).toHaveLength(1);
  });

  it('przy dwoch wpisach TEGO SAMEGO dnia zdejmuje ten pozniejszy', () => {
    const id = nowy();
    dopiszZdarzenie(db, { celId: id, dzien: '2026-09-08', ile: 1, kontoId: konto(), notatka: 'pierwszy' });
    dopiszZdarzenie(db, { celId: id, dzien: '2026-09-08', ile: 1, kontoId: konto(), notatka: 'drugi' });
    cofnijOstatnie(db, id, { od: '2026-09-07', do: '2026-09-13' });
    expect(zdarzeniaCelu(db, id)).toHaveLength(1);
    expect(zdarzeniaCelu(db, id)[0].notatka).toBe('pierwszy');
  });
});

describe('edycja i wygaszanie', () => {
  it('zapiszCel zmienia pola', () => {
    const id = nowy();
    const adam = konto('Adam');
    zapiszCel(db, id, {
      nazwa: 'Posty FB', kontoId: adam, rytm: 'miesiac', celIle: 12,
      miernik: 'reczny', odDnia: null, doDnia: null,
    });
    const po = celPoId(db, id);
    expect(po.nazwa).toBe('Posty FB');
    expect(po.rytm).toBe('miesiac');
    expect(po.cel_ile).toBe(12);
    expect(po.konto_id).toBe(adam);
  });

  it('wygaszenie ZOSTAWIA zdarzenia — historia ma przezyc', () => {
    // To jedyny powod, dla ktorego wybralismy tabele zdarzen zamiast kolumny z liczba.
    const id = nowy();
    dopiszZdarzenie(db, { celId: id, dzien: '2026-09-08', ile: 2, kontoId: konto() });
    ustawCzynny(db, id, false);
    expect(celPoId(db, id).czynny).toBe(0);
    expect(zdarzeniaCelu(db, id)).toHaveLength(1);
  });
});
