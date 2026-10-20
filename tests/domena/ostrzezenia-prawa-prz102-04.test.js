// PRZ-102.04 — wiersz ostrzeżenia widzi tylko konto, które ma prawo do ekranu za jego przyciskiem.
// Zgłoszenie: rola Produkcja widziała „Nowa wiadomość z Allegro…” z przyciskiem „Wiadomości”,
// a klik dawał 403 (Produkcja nie ma ekranu `wiadomosci`).
import { it, expect } from 'vitest';
import {
  ostrzezeniaDlaKonta, ostrzezeniaWiadomosci, ostrzezeniaFaktur, ostrzezeniaTerminow,
  ostrzezeniaZwrotow, ostrzezeniaIntegracji,
} from '../../src/domena/ostrzezenia.js';
import { ekranyRoli } from '../../src/domena/ekrany.js';

const teraz = new Date('2026-10-20T10:00:00Z');
const konto = (rola, admin = false) => ({ id: 1, admin, uprawnienia: new Set(ekranyRoli(rola)) });

// Wiersze z PRAWDZIWYCH budowniczych — adres przycisku ma być ten, który naprawdę stoi na ekranie.
const wiersze = [
  ...ostrzezeniaIntegracji({ zdrowie: { poller: { zrodla: [{ zrodlo: 'woo', zdrowy: false, blad: 'timeout' }] } } }),
  ...ostrzezeniaFaktur({ luki: [{ uuid: 'u1', numer: 'FV 1/10/2026', invoice_date: '2026-10-01' }], dzis: '2026-10-20' }),
  ...ostrzezeniaTerminow({ poTerminie: [{ uuid: 'u2', numer: 'FV 2/09/2026', payment_date: '2026-09-30', pozostalo_gr: 12300 }] }),
  ...ostrzezeniaZwrotow({ zwroty: [{ id: 7, zamowienie_id: 42, zamowienie_numer: 'Z-42', data: '2026-10-10', utworzony_at: '2026-10-10T08:00:00Z' }], dzis: '2026-10-20' }),
  ...ostrzezeniaWiadomosci({
    watki: [{ kanal: 'allegro', thread_id: 't1', interlocutor_login: 'kupujacy_1', last_message_date_time: '2026-10-19T12:00:00Z', ostatnia_od_kupujacego: 1 }],
    teraz,
  }),
];
const typy = (lista) => lista.map((w) => w.typ);

it('budowniczy dali po jednym wierszu każdego badanego typu (inaczej test niczego nie dowodzi)', () => {
  expect(typy(wiersze)).toEqual(['integracja', 'faktura-ksef', 'faktura-termin', 'zwrot-korekta', 'wiadomosc-allegro']);
});

it('Produkcja nie dostaje wiersza wiadomości ani faktur, ani integracji — dostaje zwrot (karta zamówienia)', () => {
  const widoczne = typy(ostrzezeniaDlaKonta({ wiersze, konto: konto('produkcja') }));
  expect(widoczne).not.toContain('wiadomosc-allegro');
  expect(widoczne).not.toContain('faktura-ksef');
  expect(widoczne).not.toContain('faktura-termin');
  expect(widoczne).not.toContain('integracja');
  expect(widoczne).toEqual(['zwrot-korekta']);
});

it('administrator dostaje wszystkie wiersze', () => {
  expect(ostrzezeniaDlaKonta({ wiersze, konto: konto('administrator', true) })).toEqual(wiersze);
});

it('Sprzedaż (bez finansów i ustawień) widzi faktury, zwrot i wiadomość, ale nie integrację (/ustawienia)', () => {
  expect(typy(ostrzezeniaDlaKonta({ wiersze, konto: konto('sprzedaz') })))
    .toEqual(['faktura-ksef', 'faktura-termin', 'zwrot-korekta', 'wiadomosc-allegro']);
});

it('pojedynczy ptaszek rozstrzyga: Produkcja z dopisanym ekranem Wiadomości widzi wiadomość', () => {
  const k = konto('produkcja');
  k.uprawnienia.add('wiadomosci');
  expect(typy(ostrzezeniaDlaKonta({ wiersze, konto: k }))).toEqual(['zwrot-korekta', 'wiadomosc-allegro']);
});

it('konto null (pierwszy start, jak w menu) — pełny widok', () => {
  expect(ostrzezeniaDlaKonta({ wiersze, konto: null })).toEqual(wiersze);
  expect(ostrzezeniaDlaKonta({ wiersze })).toEqual(wiersze);
});

it('adres nieznany mapie ekranów albo brak przycisku — wiersz zostaje (na braku danych nie chowamy)', () => {
  const dziwne = [
    { typ: 'przesylka', klucz: 'a', przycisk: { href: '/nieznany-ekran', etykieta: 'X' } },
    { typ: 'przesylka', klucz: 'b' },
  ];
  expect(ostrzezeniaDlaKonta({ wiersze: dziwne, konto: konto('produkcja') })).toEqual(dziwne);
});

it('nie zmienia tablicy wejściowej', () => {
  const kopia = [...wiersze];
  ostrzezeniaDlaKonta({ wiersze, konto: konto('produkcja') });
  expect(wiersze).toEqual(kopia);
});
