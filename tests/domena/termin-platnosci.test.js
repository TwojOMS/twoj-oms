import { describe, it, expect } from 'vitest';
import {
  datyFaktury, PRZY_ODBIORZE, BEZ_TERMINU, ZAPLACONE, TERMINY_DNI,
} from '../../src/domena/termin-platnosci.js';

// Nazwy pól są z dokumentacji API inFakt v3 („Definicja faktury VAT"):
// `invoice_date` = „Data wystawienia (RRRR-MM-DD)", `payment_date` = „Termin zapłaty".
//
// `sale_date` i `paid_price` NIE są brane z dokumentacji, tylko ZMIERZONE na żywym API
// 2026-08-04 (notatki/2026-08-04-infakt-daty-i-oplacenie-rozpoznanie.md): osiem faktur
// wystawionych na koncie produkcyjnym, odczytanych z dokumentu i skasowanych.
//
// ⚠️ Drugi argument `datyFaktury` to KWOTA W GROSZACH (potrzebna wariantowi „zapłacone"),
// a „dzisiaj" przesunęło się na trzeci. Testy, które podpowiadają dzień, podają `null`
// w miejscu kwoty — dla wszystkich wariantów poza „zapłacone" jest ona nieużywana.

describe('termin płatności — liczenie daty zapłaty', () => {
  it('termin N dni to data wystawienia + N dni', () => {
    expect(datyFaktury({ dataWystawienia: '2026-08-03', termin: 14 }))
      .toEqual({ invoice_date: '2026-08-03', payment_date: '2026-08-17' });
  });

  it('liczba dni z formularza przychodzi NAPISEM i ma działać tak samo', () => {
    expect(datyFaktury({ dataWystawienia: '2026-08-03', termin: '14' }).payment_date)
      .toBe('2026-08-17');
  });

  // Wszystkie terminy z listy w widoku, policzone jawnie — żeby test nie powtarzał wzoru
  // z implementacji, tylko sprawdzał wynik.
  it.each([[7, '2026-08-10'], [14, '2026-08-17'], [21, '2026-08-24'], [30, '2026-09-02']])(
    'termin %i dni od 2026-08-03 daje %s',
    (dni, oczekiwana) => {
      expect(datyFaktury({ dataWystawienia: '2026-08-03', termin: dni }).payment_date).toBe(oczekiwana);
    },
  );

  it('lista terminów w widoku to 7 / 14 / 21 / 30', () => {
    expect(TERMINY_DNI).toEqual([7, 14, 21, 30]);
  });
});

// ⚠️ DATY GRANICZNE. Arytmetyka na milisekundach (`+ n*86400000`) gubi albo dokłada dzień
// przy zmianie czasu, a `new Date('RRRR-MM-DD')` czyta napis jako UTC. Termin przesunięty
// o jeden dzień to termin, którego klient nie uzgodnił — na dokumencie księgowym.
describe('termin płatności — przejścia graniczne w kalendarzu', () => {
  it('przez koniec miesiąca (31-dniowego)', () => {
    expect(datyFaktury({ dataWystawienia: '2026-01-25', termin: 14 }).payment_date).toBe('2026-02-08');
  });

  it('przez koniec lutego w roku zwykłym — 28 lutego + 1 to 1 marca', () => {
    expect(datyFaktury({ dataWystawienia: '2026-02-28', termin: 1 }).payment_date).toBe('2026-03-01');
  });

  it('przez koniec lutego w roku przestępnym — 28 lutego + 1 to 29 lutego', () => {
    expect(datyFaktury({ dataWystawienia: '2028-02-28', termin: 1 }).payment_date).toBe('2028-02-29');
  });

  it('przez koniec roku', () => {
    expect(datyFaktury({ dataWystawienia: '2026-12-28', termin: 7 }).payment_date).toBe('2027-01-04');
  });

  it('przez koniec roku dłuższym terminem', () => {
    expect(datyFaktury({ dataWystawienia: '2026-12-20', termin: 30 }).payment_date).toBe('2027-01-19');
  });

  // Ostatnia niedziela października (25.10.2026) ma w Warszawie 25 godzin — doba „cofa się"
  // o godzinę. To jest dokładnie ten dzień, na którym liczenie milisekundami się przewraca.
  it('przez ostatnią niedzielę października (koniec czasu letniego) — dzień w dzień', () => {
    expect(datyFaktury({ dataWystawienia: '2026-10-24', termin: 1 }).payment_date).toBe('2026-10-25');
  });

  it('przez ostatnią niedzielę października — termin przeskakujący ją w środku', () => {
    expect(datyFaktury({ dataWystawienia: '2026-10-20', termin: 14 }).payment_date).toBe('2026-11-03');
  });

  it('z samej ostatniej niedzieli października, przez koniec miesiąca', () => {
    expect(datyFaktury({ dataWystawienia: '2026-10-25', termin: 7 }).payment_date).toBe('2026-11-01');
  });

  // Druga strona tej samej pułapki: ostatnia niedziela marca (29.03.2026) ma 23 godziny.
  it('przez ostatnią niedzielę marca (początek czasu letniego)', () => {
    expect(datyFaktury({ dataWystawienia: '2026-03-28', termin: 1 }).payment_date).toBe('2026-03-29');
  });

  it('przez cały czas letni — od marca do listopada', () => {
    expect(datyFaktury({ dataWystawienia: '2026-03-28', termin: 231 }).payment_date).toBe('2026-11-14');
  });
});

describe('termin płatności — data wystawienia', () => {
  // Operator, który niczego w polu nie zmienia, wystawia dzisiejszą datą. Odmowa byłaby tu
  // zwykłym utrudnieniem, a nie ochroną.
  it('pusta data wystawienia znaczy DZISIAJ, nie błąd', () => {
    expect(datyFaktury({ dataWystawienia: '', termin: 7 }, null, '2026-08-01'))
      .toEqual({ invoice_date: '2026-08-01', payment_date: '2026-08-08' });
  });

  it('brak pola daty w ogóle też znaczy dzisiaj', () => {
    expect(datyFaktury({ termin: PRZY_ODBIORZE }, null, '2026-08-01').invoice_date).toBe('2026-08-01');
  });

  it('same spacje w polu daty to nadal dzisiaj', () => {
    expect(datyFaktury({ dataWystawienia: '   ', termin: 7 }, null, '2026-08-01').invoice_date).toBe('2026-08-01');
  });

  // Bez podpowiedzi „dzisiaj" moduł musi sam wziąć dzień z zegara — a że kontener chodzi
  // z TZ=UTC, dzień ma być WARSZAWSKI (patrz domain/format-daty.js).
  it('bez podanego „dzisiaj" bierze bieżący dzień warszawski z zegara', () => {
    const dzis = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    expect(datyFaktury({ termin: BEZ_TERMINU }).invoice_date).toBe(dzis);
  });

  // Regex sam przepuściłby „2026-02-30" — data, której nie ma w kalendarzu, poleciałaby
  // na dokument księgowy.
  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '01.08.2026', 'jutro'])(
    'nieistniejąca albo źle zapisana data „%s" → błąd operatora',
    (zla) => {
      expect(() => datyFaktury({ dataWystawienia: zla, termin: 7 })).toThrow(/Data wystawienia/);
    },
  );

  it('odmowa daty jest otagowana dla operatora', () => {
    try {
      datyFaktury({ dataWystawienia: '2026-02-30', termin: 7 });
      expect.unreachable('miało rzucić');
    } catch (e) {
      expect(e.dlaOperatora).toBe(true);
    }
  });
});

// ⚠️ SEDNO TEGO PLIKU. „Przy odbiorze" i „bez terminu" to DWA RÓŻNE stany dokumentu i nie
// wolno ich sprowadzić do jednego: pierwszy WYSYŁA `payment_date` (równe dacie wystawienia),
// drugi nie wysyła go W OGÓLE. Sklejenie ich dałoby fakturę z terminem, którego nikt nie
// uzgodnił — na dokumencie, którego w inFakcie się nie edytuje, tylko kasuje i wystawia od nowa.
describe('termin płatności — „przy odbiorze" kontra „bez terminu"', () => {
  it('„przy odbiorze" to termin ZERO dni: data płatności równa dacie wystawienia', () => {
    expect(datyFaktury({ dataWystawienia: '2026-08-03', termin: PRZY_ODBIORZE }))
      .toEqual({ invoice_date: '2026-08-03', payment_date: '2026-08-03' });
  });

  it('jawne „0 dni" znaczy to samo, co „przy odbiorze"', () => {
    expect(datyFaktury({ dataWystawienia: '2026-08-03', termin: '0' }).payment_date).toBe('2026-08-03');
  });

  it('„bez terminu" NIE MA właściwości payment_date — nie ma jej wcale, nie jest pusta', () => {
    const daty = datyFaktury({ dataWystawienia: '2026-08-03', termin: BEZ_TERMINU });
    expect(daty).toEqual({ invoice_date: '2026-08-03' });
    expect(daty).not.toHaveProperty('payment_date');
  });

  // Ten test czerwieni się, gdy ktoś skleji oba warianty w jeden (np. „bez terminu" zacznie
  // wysyłać payment_date równe invoice_date).
  it('oba warianty dają RÓŻNY kształt wyniku dla tej samej daty wystawienia', () => {
    const odbior = datyFaktury({ dataWystawienia: '2026-08-03', termin: PRZY_ODBIORZE });
    const bez = datyFaktury({ dataWystawienia: '2026-08-03', termin: BEZ_TERMINU });
    expect(Object.keys(odbior)).toEqual(['invoice_date', 'payment_date']);
    expect(Object.keys(bez)).toEqual(['invoice_date']);
  });

  it('krótkie aliasy z formularza („odbior", „brak") znaczą to samo', () => {
    expect(datyFaktury({ dataWystawienia: '2026-08-03', termin: 'odbior' }).payment_date).toBe('2026-08-03');
    expect(datyFaktury({ dataWystawienia: '2026-08-03', termin: 'brak' })).not.toHaveProperty('payment_date');
  });
});

describe('termin płatności — śmieć w polu terminu', () => {
  // Ujemny termin to faktura płatna PRZED wystawieniem, ułamkowy to literówka.
  it.each(['-3', -3, '7.5', 7.5, 'czternaście', '', '  ', null, undefined, '14 dni'])(
    'termin „%s" → błąd operatora, bez zgadywania',
    (smiec) => {
      expect(() => datyFaktury({ dataWystawienia: '2026-08-03', termin: smiec })).toThrow(/Termin płatności/);
    },
  );

  it('odmowa terminu jest otagowana dla operatora i pisana po polsku', () => {
    try {
      datyFaktury({ dataWystawienia: '2026-08-03', termin: '-3' });
      expect.unreachable('miało rzucić');
    } catch (e) {
      expect(e.dlaOperatora).toBe(true);
      expect(e.message).toMatch(/przy odbiorze/);
    }
  });

  it('wywołanie bez żadnego argumentu też odmawia, zamiast wymyślać termin', () => {
    expect(() => datyFaktury()).toThrow(/Termin płatności/);
  });
});

// ⚠️ DATA SPRZEDAŻY to nie ozdobnik, tylko obowiązkowy element faktury (art. 106e ust. 1
// pkt 6). Zmierzone na żywym API 2026-08-04: BRAK `sale_date` w payloadzie daje na dokumencie
// datę sprzedaży równą dacie wystawienia — czyli każda faktura wystawiona dotąd z panelu dla
// zamówienia opłaconego wcześniej niosła datę niezgodną z prawem.
describe('data sprzedaży — sale_date w payloadzie', () => {
  it('data sprzedaży przechodzi do payloadu obok daty wystawienia', () => {
    expect(datyFaktury({ dataWystawienia: '2026-08-04', dataSprzedazy: '2026-08-01', termin: 14 }))
      .toEqual({ invoice_date: '2026-08-04', sale_date: '2026-08-01', payment_date: '2026-08-18' });
  });

  // Zmierzone (pytanie 4 rozpoznania): inFakt przyjmuje sprzedaż PÓŹNIEJSZĄ od wystawienia.
  // Potrzebne dla faktury do pobrania wystawionej w przeddzień wyjazdu paczki.
  it('data sprzedaży późniejsza od daty wystawienia też przechodzi', () => {
    expect(datyFaktury({ dataWystawienia: '2026-08-04', dataSprzedazy: '2026-08-05', termin: PRZY_ODBIORZE }).sale_date)
      .toBe('2026-08-05');
  });

  // „Czego nie podano, tego nie wysyłamy" — pusta data sprzedaży ma zostawić payload
  // dokładnie takim, jaki panel wysyłał przed tą zmianą.
  it.each([['pusta', ''], ['same spacje', '   '], ['null', null], ['brak pola', undefined]])(
    'data sprzedaży %s NIE dokłada pola sale_date',
    (_opis, pusta) => {
      const daty = datyFaktury({ dataWystawienia: '2026-08-04', dataSprzedazy: pusta, termin: 14 });
      expect(daty).not.toHaveProperty('sale_date');
      expect(daty).toEqual({ invoice_date: '2026-08-04', payment_date: '2026-08-18' });
    },
  );

  // Ta sama pułapka, co przy dacie wystawienia: sam regex przepuszcza „2026-02-30".
  // Data, której nie ma w kalendarzu, poleciałaby na dokument księgowy.
  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '01.08.2026', 'wczoraj'])(
    'nieistniejąca albo źle zapisana data sprzedaży „%s" → błąd operatora',
    (zla) => {
      expect(() => datyFaktury({ dataWystawienia: '2026-08-04', dataSprzedazy: zla, termin: 7 }))
        .toThrow(/Data sprzedaży/);
    },
  );

  it('odmowa daty sprzedaży jest otagowana dla operatora', () => {
    try {
      datyFaktury({ dataWystawienia: '2026-08-04', dataSprzedazy: '2026-02-30', termin: 7 });
      expect.unreachable('miało rzucić');
    } catch (e) {
      expect(e.dlaOperatora).toBe(true);
    }
  });

  it('data sprzedaży dokłada się do KAŻDEGO wariantu terminu', () => {
    const dla = (termin, kwota) => datyFaktury(
      { dataWystawienia: '2026-08-04', dataSprzedazy: '2026-08-01', termin },
      kwota,
    );
    expect(dla(PRZY_ODBIORZE).sale_date).toBe('2026-08-01');
    expect(dla(BEZ_TERMINU).sale_date).toBe('2026-08-01');
    expect(dla(30).sale_date).toBe('2026-08-01');
    expect(dla(ZAPLACONE, 12300).sale_date).toBe('2026-08-01');
  });

  it('sale_date stoi w payloadzie zaraz za invoice_date', () => {
    const daty = datyFaktury({ dataWystawienia: '2026-08-04', dataSprzedazy: '2026-08-01', termin: 7 });
    expect(Object.keys(daty)).toEqual(['invoice_date', 'sale_date', 'payment_date']);
  });
});

// ⚠️ SEDNO WARIANTU „ZAPŁACONE". Zmierzone 2026-08-04 na żywym API:
//   - `POST /v3/async/invoices/{uuid}/paid.json` zmienia tylko WEWNĘTRZNY status faktury —
//     dokument dla klienta dalej mówi „Zapłacono: 0,00 / Pozostało: 123,00". Odpadł.
//   - `paid_price` W PAYLOADZIE PRZY TWORZENIU daje `left_to_pay: 0` i na dokumencie
//     „Zapłacono: 123,00 / Pozostało do zapłaty: 0,00". To jest ta droga.
// Dlatego wynik jest JEDNYM płaskim obiektem: nie ma drugiego wywołania, nie ma stanu
// „faktura wystawiona, ale nieoznaczona jako opłacona".
describe('faktura zapłacona z góry — wariant ZAPLACONE', () => {
  it('daje paid_price równe kwocie w groszach i NIE daje payment_date', () => {
    const daty = datyFaktury({ dataWystawienia: '2026-08-03', termin: ZAPLACONE }, 12300);
    expect(daty).toEqual({ invoice_date: '2026-08-03', paid_price: 12300 });
    expect(daty).not.toHaveProperty('payment_date');
  });

  it('paid_price jest LICZBĄ groszy, nie napisem i nie złotówkami', () => {
    const { paid_price: zaplacono } = datyFaktury({ dataWystawienia: '2026-08-03', termin: ZAPLACONE }, 9999);
    expect(zaplacono).toBe(9999);
    expect(typeof zaplacono).toBe('number');
  });

  // ⚠️ „Zapłacone" i „bez terminu" to DWA RÓŻNE stany dokumentu i nie wolno ich skleić:
  // pierwszy mówi klientowi „nic nie jesteś winien", drugi to faktura NIEOPŁACONA.
  it('BEZ_TERMINU nie daje paid_price — to nadal faktura nieopłacona', () => {
    const daty = datyFaktury({ dataWystawienia: '2026-08-03', termin: BEZ_TERMINU }, 12300);
    expect(daty).not.toHaveProperty('paid_price');
    expect(daty).toEqual({ invoice_date: '2026-08-03' });
  });

  it.each([[PRZY_ODBIORZE], [14], ['0']])(
    'wariant „%s" też nie dokłada paid_price, nawet gdy kwota jest znana',
    (termin) => {
      expect(datyFaktury({ dataWystawienia: '2026-08-03', termin }, 12300)).not.toHaveProperty('paid_price');
    },
  );

  it('trzy warianty dają TRZY różne kształty wyniku dla tej samej daty', () => {
    const dla = (termin) => Object.keys(datyFaktury({ dataWystawienia: '2026-08-03', termin }, 12300));
    expect(dla(PRZY_ODBIORZE)).toEqual(['invoice_date', 'payment_date']);
    expect(dla(BEZ_TERMINU)).toEqual(['invoice_date']);
    expect(dla(ZAPLACONE)).toEqual(['invoice_date', 'paid_price']);
  });

  // Bez kwoty wariant NIE MA prawa wystawić cichej faktury z `paid_price: undefined` —
  // dokument powiedziałby wtedy „Pozostało do zapłaty: 123,00", czyli dokładnie odwrotnie
  // do tego, co operator wybrał. Odmowa ma odbić się od formularza.
  it.each([[undefined], [null], [''], ['12300'], [0], [-1], [12.5], [NaN]])(
    'ZAPLACONE z kwotą „%s" → błąd operatora, bez cichej faktury',
    (kwota) => {
      expect(() => datyFaktury({ dataWystawienia: '2026-08-03', termin: ZAPLACONE }, kwota))
        .toThrow(/kwot/i);
    },
  );

  it('odmowa braku kwoty jest otagowana dla operatora', () => {
    try {
      datyFaktury({ dataWystawienia: '2026-08-03', termin: ZAPLACONE });
      expect.unreachable('miało rzucić');
    } catch (e) {
      expect(e.dlaOperatora).toBe(true);
    }
  });
});

// Bariera na regresję: dopóki formularz nie poda daty sprzedaży ani wariantu „zapłacone",
// panel ma wysyłać payload BAJT W BAJT taki, jak przed tą zmianą. Nowe pole dołożone
// po cichu do dokumentu księgowego byłoby zmianą, o którą nikt nie prosił.
describe('zgodność wstecz — payload bez nowych pól', () => {
  it.each([
    [7, { invoice_date: '2026-08-03', payment_date: '2026-08-10' }],
    [PRZY_ODBIORZE, { invoice_date: '2026-08-03', payment_date: '2026-08-03' }],
    [BEZ_TERMINU, { invoice_date: '2026-08-03' }],
  ])('wariant „%s" bez daty sprzedaży daje dokładnie to, co dawał dotąd', (termin, oczekiwany) => {
    expect(datyFaktury({ dataWystawienia: '2026-08-03', termin })).toEqual(oczekiwany);
  });

  it('kwota podana bez wariantu „zapłacone" niczego nie zmienia', () => {
    expect(datyFaktury({ dataWystawienia: '2026-08-03', termin: 7 }, 12300))
      .toEqual(datyFaktury({ dataWystawienia: '2026-08-03', termin: 7 }));
  });
});
