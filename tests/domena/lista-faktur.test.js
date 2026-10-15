import { describe, it, expect } from 'vitest';
import {
  dniDoTerminu, stanTerminu, opisTerminu, zakresMiesiaca, stanKsef, scalDokumenty, PROG_WKROTCE_DNI,
  czekaNaPrzelew, stanZaplaty,
} from '../../src/domena/lista-faktur.js';

// Dokument taki, jaki oddaje lista inFaktu — nadpisywane pole po polu w każdym teście niżej.
const dok = (nadpisz) => ({
  number: '64/07/2026', status: 'sent', left_to_pay: 88842, payment_method: 'transfer', ...nadpisz,
});

describe('czeka na przelew', () => {
  // ⚠️ POWÓD ISTNIENIA TEJ FUNKCJI, ZMIERZONY 10.08.2026 NA ŻYWYM KONCIE: `q[left_to_pay_gt]=0`
  // dawało 67 dokumentów, z czego **65 miało `status: paid`** i komplet `paid_date`. Właściciel
  // oznacza zapłatę w inFakcie, a to ustawia status i datę, ale `left_to_pay` ZOSTAWIA NIETKNIĘTE
  // (ta sama pułapka, co przy `/paid.json` — patrz domain/termin-platnosci.js). Pas długów
  // pokazywał więc 67 pozycji, gdy realnie nikt nie zalegał poza dwiema.
  it('opłacona w inFakcie NIE czeka na przelew, choćby left_to_pay zostało niewyzerowane', () => {
    expect(czekaNaPrzelew(dok({ status: 'paid', left_to_pay: 88842 }))).toBe(false);
  });

  it('wystawiona i niezapłacona czeka', () => {
    expect(czekaNaPrzelew(dok({ status: 'sent' }))).toBe(true);
    expect(czekaNaPrzelew(dok({ status: 'printed' }))).toBe(true);
  });

  // ⚠️ ZAPŁATA Z GÓRY: panel wystawia dokument z `paid_price`, co daje `left_to_pay: 0`, ale
  // status zostaje `sent` (pomiar 04.08.2026). Sam status odsiewałby więc ODWROTNIE: cała
  // przedpłacona sprzedaż ze sklepów wjechałaby na listę długów z kwotą „0,00 zł". Oba warunki
  // muszą zachodzić naraz i każdy stoi przed inną awarią.
  it('zapłacona z góry nie czeka, mimo statusu innego niż paid', () => {
    expect(czekaNaPrzelew(dok({ status: 'sent', left_to_pay: 0 }))).toBe(false);
  });

  // ⚠️ POBRANIE (`payment_method: 'delivery'` — pomiar 07.08.2026, domain/sposob-platnosci.js).
  // Pieniądze odbiera kurier, więc nikt nie czeka na przelew i nikogo nie ma o co upominać.
  // Dziś wszystkie 31 takich dokumentów ma już status `paid`, więc ten warunek zdejmuje ZERO
  // wierszy — stoi tu za dokument wystawiony DZIŚ, zanim pobranie wróci z DPD.
  it('pobranie nie trafia na listę, nawet gdy jeszcze nieopłacone', () => {
    expect(czekaNaPrzelew(dok({ status: 'sent', payment_method: 'delivery' }))).toBe(false);
  });

  // ⚠️ ODSIEWAMY WYŁĄCZNIE NA DOWÓD ZAPŁATY. Nieznany status i nieznana metoda płatności
  // ZOSTAJĄ na liście: fałszywy alarm o pieniądzach jest widoczny i da się go wyjaśnić, a cicho
  // ukryty dług nie daje o sobie znać w ogóle. Ta sama zasada, co przy odmowie zamiast pustej
  // listy w services/faktury-widok.js.
  it('nieznanego statusu i nieznanej metody NIE ukrywa', () => {
    expect(czekaNaPrzelew(dok({ status: 'jakis_nowy_status' }))).toBe(true);
    expect(czekaNaPrzelew(dok({ status: null }))).toBe(true);
    expect(czekaNaPrzelew(dok({ payment_method: null }))).toBe(true);
    expect(czekaNaPrzelew(dok({ left_to_pay: null }))).toBe(true);
  });

  it('nie wywraca się na braku dokumentu', () => {
    expect(czekaNaPrzelew(null)).toBe(true);
    expect(czekaNaPrzelew(undefined)).toBe(true);
  });
});

// ⚠️ NAZWA ARGUMENTU ZMIENIONA 28.08.2026 (recenzja poprawkowa, W4): `pobranieZwrocone` →
// `pobranieBezGotowki`. Zwrot NIE JEST jedynym sposobem, w jaki gotówka przy pobraniu nie
// dochodzi — nieudane doręczenie („adresat nieobecny", awizo) ma etap `doreczona` i pod starą
// nazwą wypadało z pasa długów na stałe. Fakt składa `czyPaczkaBezGotowki`
// (domain/pobranie-zaplacone.js), ta sama funkcja, z której czyta czuwacz pobrań.
describe('pobranie bez gotówki wraca na pas długów', () => {
  const pobranie = { status: 'sent', left_to_pay: 8399, payment_method: 'delivery' };

  it('pobranie w drodze jest odsiane — nikt nie czeka na przelew', () => {
    expect(czekaNaPrzelew(pobranie)).toBe(false);
    expect(czekaNaPrzelew(pobranie, { pobranieBezGotowki: false })).toBe(false);
  });

  // ⚠️⚠️ PACZKA NIEODEBRANA WRACA ZWROTEM I PIENIĘDZY NIE MA. Odsianie „bo pobranie"
  // ukrywałoby wtedy realny dług — a to jedyne miejsce, w którym ktokolwiek go zobaczy.
  it('pobranie bez zainkasowanej gotówki CZEKA — bo nikt za nie nie zapłacił', () => {
    expect(czekaNaPrzelew(pobranie, { pobranieBezGotowki: true })).toBe(true);
  });

  it('bez gotówki, ale już opłacone w inFakcie, nadal nie czeka', () => {
    expect(czekaNaPrzelew({ ...pobranie, status: 'paid' }, { pobranieBezGotowki: true })).toBe(false);
  });
});

describe('dni do terminu', () => {
  it('liczy dni w przód i w tył', () => {
    expect(dniDoTerminu('2026-08-20', '2026-08-06')).toBe(14);
    expect(dniDoTerminu('2026-08-06', '2026-08-06')).toBe(0);
    expect(dniDoTerminu('2025-12-24', '2026-08-06')).toBe(-225);
  });

  // ⚠️ ARYTMETYKA NA NUMERZE DNIA, nie na milisekundach. Ostatnia niedziela października ma
  // w Warszawie 25 godzin, więc `(a - b) / 86400000` gubi dzień — a „po terminie o 1 dzień"
  // to inna informacja niż „dziś ostatni dzień".
  it('nie gubi dnia na zmianie czasu', () => {
    expect(dniDoTerminu('2026-10-26', '2026-10-24')).toBe(2);
    expect(dniDoTerminu('2026-03-30', '2026-03-28')).toBe(2);
  });

  it('nieczytelna albo pusta data daje null, nigdy wyjątek', () => {
    expect(dniDoTerminu(null, '2026-08-06')).toBeNull();
    expect(dniDoTerminu('2026-02-30', '2026-08-06')).toBeNull();
    expect(dniDoTerminu('kiedyś', '2026-08-06')).toBeNull();
  });
});

describe('stan terminu', () => {
  it('rozdziela cztery przypadki', () => {
    expect(stanTerminu('2026-08-01', '2026-08-06')).toBe('po_terminie');
    expect(stanTerminu('2026-08-06', '2026-08-06')).toBe('dzis');
    expect(stanTerminu('2026-08-13', '2026-08-06')).toBe('wkrotce');
    expect(stanTerminu('2026-09-30', '2026-08-06')).toBe('odlegly');
    expect(stanTerminu(null, '2026-08-06')).toBe('brak');
  });

  it('granica „wkrótce" jest domknięta', () => {
    const granica = `2026-08-${String(6 + PROG_WKROTCE_DNI).padStart(2, '0')}`;
    expect(stanTerminu(granica, '2026-08-06')).toBe('wkrotce');
  });
});

describe('opis terminu', () => {
  it('mówi po polsku, z liczbą dni', () => {
    expect(opisTerminu('2025-12-24', '2026-08-06')).toBe('po terminie o 225 dni');
    expect(opisTerminu('2026-08-06', '2026-08-06')).toBe('termin dzisiaj');
    expect(opisTerminu('2026-08-11', '2026-08-06')).toBe('za 5 dni');
    expect(opisTerminu('2026-08-07', '2026-08-06')).toBe('za 1 dzień');
    expect(opisTerminu(null, '2026-08-06')).toBe('bez terminu');
  });
});

describe('zakres miesiąca', () => {
  it('zna długość każdego miesiąca, także lutego w roku przestępnym', () => {
    expect(zakresMiesiaca('2026-06')).toEqual({ od: '2026-06-01', do: '2026-06-30' });
    expect(zakresMiesiaca('2026-02')).toEqual({ od: '2026-02-01', do: '2026-02-28' });
    expect(zakresMiesiaca('2024-02')).toEqual({ od: '2024-02-01', do: '2024-02-29' });
    expect(zakresMiesiaca('2026-12')).toEqual({ od: '2026-12-01', do: '2026-12-31' });
  });

  it('śmieciowy miesiąc daje null, a nie zakres obejmujący wszystko', () => {
    expect(zakresMiesiaca('2026-13')).toBeNull();
    expect(zakresMiesiaca('')).toBeNull();
    expect(zakresMiesiaca(undefined)).toBeNull();
  });
});

describe('stan KSeF', () => {
  // ⚠️ NA FAKTURZE VAT NIE MA POLA `ksef_data` — zmierzone 06.08.2026: `fields=…,ksef_data`
  // po prostu go nie oddaje, a jedynym śladem jest `ksef_number`. Korekta `ksef_data` MA.
  // Dlatego pytamy o numer, nie o obiekt.
  it('rozstrzyga po numerze KSeF', () => {
    expect(stanKsef({ ksef_number: '1234563218-20260806-5EB04B000005-18' })).toBe('jest');
    expect(stanKsef({ ksef_number: null })).toBe('brak');
    expect(stanKsef({ ksef_number: '' })).toBe('brak');
    expect(stanKsef({})).toBe('brak');
  });

  // ⚠️⚠️ TRZECI STAN (recenzja całości, Finding 1). Między zleceniem wysyłki a nadaniem numeru
  // mija ~70 sekund — i przez ten czas „brak" jest po prostu NIEPRAWDĄ: panel wysyłkę zlecił,
  // a ekran zapraszał do drugiego, nieodwracalnego zgłoszenia. Fakt („panel zlecił") przychodzi
  // argumentem, bo ta funkcja jest CZYSTA i do bazy nie sięga.
  it('trzeci stan: panel zlecił wysyłkę, numeru jeszcze nie ma', () => {
    expect(stanKsef({ ksef_number: null }, true)).toBe('wyslana_czeka');
    expect(stanKsef({}, true)).toBe('wyslana_czeka');
    expect(stanKsef({ ksef_number: '' }, true)).toBe('wyslana_czeka');
  });

  // Numer rozstrzyga NAD rezerwacją: dokument, który numer już dostał, JEST w KSeF, a nie
  // „czeka" — inaczej wiersz zostawałby w stanie przejściowym na zawsze.
  it('numer KSeF ma pierwszeństwo przed rezerwacją', () => {
    expect(stanKsef({ ksef_number: 'KS-1' }, true)).toBe('jest');
  });

  it('bez rezerwacji odpowiedź się nie zmienia', () => {
    expect(stanKsef({ ksef_number: null }, false)).toBe('brak');
    expect(stanKsef({ ksef_number: null }, undefined)).toBe('brak');
  });
});

describe('scalanie faktur z korektami', () => {
  it('daje jedną listę, od najnowszej', () => {
    const w = scalDokumenty(
      [{ number: '1/06/2026', invoice_date: '2026-06-01', rodzaj: 'vat' }],
      [{ number: '1/KOR/06/2026', invoice_date: '2026-06-19', rodzaj: 'korekta' }],
    );
    expect(w.map((d) => d.number)).toEqual(['1/KOR/06/2026', '1/06/2026']);
  });

  it('pustych list nie wywraca', () => {
    expect(scalDokumenty([], [])).toEqual([]);
    expect(scalDokumenty(null, undefined)).toEqual([]);
  });

  // ⚠️ Zdegradowana odpowiedź API potrafi oddać PRAWDZIWY, niepusty obiekt (np. `{ error: … }`)
  // albo liczbę zamiast tablicy — `?? []` tego nie łapie, bo obie wartości są truthy.
  // Ten ekran nie ma prawa się wywalić na taki payload, więc traktujemy go jak brak dokumentów.
  it('zepsuty payload (obiekt albo liczba zamiast tablicy) daje pustą listę, nigdy wyjątek', () => {
    expect(scalDokumenty({ error: 'awaria' }, [])).toEqual([]);
    expect(scalDokumenty([], 42)).toEqual([]);
  });
});

describe('stan zapłaty dokumentu', () => {
  // ⚠️ POMIAR NA ŻYWYM KONCIE 28.08.2026 — to jest DOKŁADNIE zgłoszona FV 51/08/2026:
  // status `paid`, `paid_date` wypełniona, a `left_to_pay` dalej 99000 (990,00 zł).
  // Oznaczenie zapłaty w inFakcie tego pola NIE ZERUJE i nie ustawia też `paid_price`.
  it('opłacona w inFakcie jest zapłacona, choćby left_to_pay zostało niewyzerowane', () => {
    expect(stanZaplaty({ status: 'paid', left_to_pay: 99000, paid_price: 0 })).toBe('zaplacona');
  });

  // Przedpłata: kwota wpłaty poleciała na dokument przy tworzeniu (`paid_price`), więc
  // `left_to_pay` jest zerem — ale status zostaje `sent`, bo ten przestawia dopiero
  // `paid_date`. Pomiar 04.08.2026. Sam status uznałby to za dług.
  it('przedpłacona z zerem do zapłaty jest zapłacona mimo statusu sent', () => {
    expect(stanZaplaty({ status: 'sent', left_to_pay: 0 })).toBe('zaplacona');
  });

  it('wystawiona i niezapłacona jest do zapłaty', () => {
    expect(stanZaplaty({ status: 'sent', left_to_pay: 99000 })).toBe('do_zaplaty');
    expect(stanZaplaty({ status: 'printed', left_to_pay: 5489 })).toBe('do_zaplaty');
  });

  // ⚠️ `Number(null)` TO `0`, a `Number('')` TEŻ. Sprawdzenie typu PRZED przeliczeniem jest
  // jedyną rzeczą, która broni przed uznaniem BRAKU POLA za dowód zapłaty.
  it('brak kwoty nie jest dowodem zapłaty', () => {
    expect(stanZaplaty({ status: 'sent', left_to_pay: null })).toBe('do_zaplaty');
    expect(stanZaplaty({ status: 'sent', left_to_pay: '' })).toBe('do_zaplaty');
    expect(stanZaplaty({ status: 'sent', left_to_pay: '  ' })).toBe('do_zaplaty');
  });

  // Nie udajemy wiedzy: dokument bez statusu I bez kwoty nie mówi nic.
  it('brak obu danych to „nieznany", a nie zgadywanie', () => {
    expect(stanZaplaty({})).toBe('nieznany');
    expect(stanZaplaty(null)).toBe('nieznany');
    expect(stanZaplaty(undefined)).toBe('nieznany');
  });

  it('sam status bez kwoty wystarcza w obie strony', () => {
    expect(stanZaplaty({ status: 'paid' })).toBe('zaplacona');
    expect(stanZaplaty({ status: 'sent' })).toBe('do_zaplaty');
  });
});

describe('stanZaplaty i czekaNaPrzelew mówią to samo', () => {
  // Ta zgodność jest CAŁYM POWODEM istnienia wspólnej reguły. Rozjechały się raz —
  // poprawka z 10.08 trafiła w pas długów i minęła kolumnę obok.
  const przypadki = [
    { status: 'paid', left_to_pay: 99000, payment_method: 'transfer' },
    { status: 'sent', left_to_pay: 0, payment_method: 'transfer' },
    { status: 'sent', left_to_pay: 5489, payment_method: 'transfer' },
    { status: 'printed', left_to_pay: 14900, payment_method: 'transfer' },
  ];
  it.each(przypadki)('zapłacona wg stanu ⇔ nie czeka na przelew: %o', (d) => {
    expect(czekaNaPrzelew(d)).toBe(stanZaplaty(d) === 'do_zaplaty');
  });
});
