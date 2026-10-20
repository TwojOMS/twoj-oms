import {
  describe, it, expect, beforeEach,
} from 'vitest';

import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { klientPoNip, wszyscyKlienci } from '../../../src/oms/db/klienci.js';
import { zalozZamowienieReczne } from '../../../src/moduly/zamowienia/services/zamowienie-reczne.js';

// „UAKTUALNIJ DANE STAŁEGO KLIENTA” NIE MA PRAWA RUSZYĆ WARUNKÓW HANDLOWYCH (PRZ-102.07).
//
// Przycisk na karcie zamówienia obiecuje w podpowiedzi: „Nadpisze dane teleadresowe
// zapamiętanego klienta danymi z tego zamówienia. Rabatu, B2B ani terminu nie zmienia”.
// Do tej poprawki trasa budowała wiersz przez `znormalizujKlienta` BEZ pól umowy
// zbiorczej, a `zapiszKlienta` pisze komplet kolumn — więc klient z umową zbiorczą
// po jednym kliknięciu miał `rozliczenie_zbiorcze = 0` i kwoty umowy NULL. Jego następne
// zamówienia przestawały trafiać do okresu i szły na pojedyncze faktury, po cichu.

const NIP = '1234500011';
const naglowek = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};
const config = { auth: { user: 'adam', pass: 'x' } };

let db;
let app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config, poller: { stan: () => ({}) } });
  await app.ready();
});

const post = (url, payload) => app.inject({ method: 'POST', url, headers: naglowek, payload });

/** Klient z umową zbiorczą i ustaleniami — założony tą samą drogą, co z ekranu Klienci. */
const KLIENT_Z_UMOWA = {
  nazwa: 'Pracownia Przykładowa', klucz: 'przykladowa', nip: NIP,
  f_firma: 'Pracownia Przykładowa sp. z o.o.', f_ulica: 'Stara 1', f_kod: '00-001', f_miasto: 'Warszawa',
  f_email: 'faktury@przyklad.test',
  w_nazwa: 'Anna Nowak', w_firma: 'Pracownia Przykładowa sp. z o.o.', w_ulica: 'Stara 1',
  w_kod: '00-001', w_miasto: 'Warszawa', w_telefon: '500000001', w_email: 'biuro@przyklad.test',
  b2b: 'on', rabat_procent: '30', chce_fakture: 'on',
  metoda_wysylki: 'dpd', koszt_dostawy_brutto: '0', platnosc: 'przelew', termin_platnosci: '14',
  komentarz: 'Umowa ramowa z 01.09, faktura zbiorcza na koniec miesiąca.',
  rozliczenie_zbiorcze: 'on', prog_darmowej_dostawy: '500', oplata_obslugi: '4', oplata_kurierska: '19',
};

// Zamówienie tego samego podmiotu z NOWYM adresem — i z ustaleniami innymi niż na karcie
// klienta (bez B2B, inny termin, płatny kurier, paczkomat), żeby każde przecieknięcie
// ustaleń z zamówienia do bazy było widać.
// `bezAdresu`: zamówienie, w którym nabywca podał tylko firmę (telefon, mail) — adresu
// ani na fakturze, ani w wysyłce nie ma. Tak wygląda część zamówień przyjmowanych telefonicznie.
const zalozZamowienie = ({ nip = NIP, firma = 'Pracownia Przykładowa sp. z o.o.', bezAdresu = false } = {}) => zalozZamowienieReczne({
  db,
  znacznik: '2026-10-20T09:00:00.000Z',
  dane: {
    klient: bezAdresu
      ? { company: firma, address_1: '  ', postcode: '', city: null }
      : {
        first_name: 'Anna', last_name: 'Nowak', company: firma, address_1: 'Nowa 5',
        postcode: '00-002', city: 'Kraków', email: 'nowy@przyklad.test',
      },
    dostawa: bezAdresu
      ? { company: firma }
      : {
        first_name: 'Anna', last_name: 'Nowak', company: firma, address_1: 'Nowa 5',
        postcode: '00-002', city: 'Kraków',
      },
    nip, chce_fakture: 0, metoda_wysylki: 'inpost_paczkomat', koszt_dostawy_brutto: '19.99',
    metoda_platnosci: 'Przelew', b2b: 0, termin_platnosci: '7', rabat_procent: 0, pozycje: [],
  },
});

describe('„Uaktualnij dane stałego klienta” u klienta z umową zbiorczą', () => {
  it('aktualizuje adres, a umowy zbiorczej i jej kwot nie rusza', async () => {
    expect((await post('/klienci', KLIENT_Z_UMOWA)).statusCode).toBe(302);
    const przed = klientPoNip(db, NIP);
    expect(przed.rozliczenie_zbiorcze).toBe(1);

    const { id } = zalozZamowienie();
    expect((await post(`/zamowienia/${id}/klient/zapamietaj`)).statusCode).toBe(302);

    const po = klientPoNip(db, NIP);
    expect(wszyscyKlienci(db)).toHaveLength(1);
    // Dane nabywcy — to, co przycisk obiecuje.
    expect(po.faktura.ulica).toBe('Nowa 5');
    expect(po.faktura.miasto).toBe('Kraków');
    expect(po.wysylka.ulica).toBe('Nowa 5');
    // Umowa zbiorcza — to, co znikało.
    expect(po.rozliczenie_zbiorcze).toBe(1);
    expect(po.prog_darmowej_dostawy_gr).toBe(50000);
    expect(po.oplata_obslugi_gr).toBe(400);
    expect(po.oplata_kurierska_gr).toBe(1900);
  });

  it('nie rusza też pozostałych ustaleń handlowych ani notatki', async () => {
    await post('/klienci', KLIENT_Z_UMOWA);
    const przed = klientPoNip(db, NIP);
    const { id } = zalozZamowienie();
    await post(`/zamowienia/${id}/klient/zapamietaj`);

    const po = klientPoNip(db, NIP);
    for (const pole of [
      'klucz', 'b2b', 'rabat_procent', 'termin_platnosci', 'platnosc', 'komentarz',
      'chce_fakture', 'metoda_wysylki', 'koszt_dostawy_brutto', 'aktywny',
    ]) {
      expect({ pole, wartosc: po[pole] }).toEqual({ pole, wartosc: przed[pole] });
    }
  });

  // Wygaszony klient wygaszony zostaje: „Uaktualnij dane” to nie „przywróć na listę”.
  it('wygaszonego klienta nie przywraca na listę podpowiedzi', async () => {
    await post('/klienci', { ...KLIENT_Z_UMOWA, aktywny: '0' });
    expect(klientPoNip(db, NIP).aktywny).toBe(0);
    const { id } = zalozZamowienie();
    await post(`/zamowienia/${id}/klient/zapamietaj`);
    expect(klientPoNip(db, NIP).aktywny).toBe(0);
    expect(klientPoNip(db, NIP).faktura.ulica).toBe('Nowa 5');
  });

  // ⚠️ PUSTE POLE Z ZAMÓWIENIA TO „NIE PODANO”, A NIE „SKASUJ”. Świadome czyszczenie pola
  // zostaje w formularzu Stałych klientów (POST /klienci).
  it('zamówienie bez adresu nie kasuje adresu ani telefonu na karcie klienta', async () => {
    await post('/klienci', KLIENT_Z_UMOWA);
    const { id } = zalozZamowienie({ bezAdresu: true });
    expect((await post(`/zamowienia/${id}/klient/zapamietaj`)).statusCode).toBe(302);

    const po = klientPoNip(db, NIP);
    expect(po.faktura).toMatchObject({
      ulica: 'Stara 1', kod: '00-001', miasto: 'Warszawa', email: 'faktury@przyklad.test', nip: NIP,
    });
    expect(po.wysylka).toMatchObject({
      nazwa: 'Anna Nowak', ulica: 'Stara 1', kod: '00-001', miasto: 'Warszawa',
      telefon: '500000001', email: 'biuro@przyklad.test',
    });
    expect(po.nip).toBe(NIP);
    expect(po.rozliczenie_zbiorcze).toBe(1);
  });

  it('niepuste pola zamówienia nadpisują kartę, puste zostawiają to, co na niej było', async () => {
    await post('/klienci', KLIENT_Z_UMOWA);
    const { id } = zalozZamowienie();
    await post(`/zamowienia/${id}/klient/zapamietaj`);

    const po = klientPoNip(db, NIP);
    // nowy adres z zamówienia
    expect(po.faktura).toMatchObject({ ulica: 'Nowa 5', kod: '00-002', miasto: 'Kraków', email: 'nowy@przyklad.test' });
    expect(po.wysylka).toMatchObject({ ulica: 'Nowa 5', kod: '00-002', miasto: 'Kraków' });
    // zamówienie nie podało telefonu — zostaje z karty (e-mail adres odbiorcy bierze z nabywcy,
    // więc ten przychodzi z zamówienia)
    expect(po.wysylka.telefon).toBe('500000001');
    expect(po.wysylka.email).toBe('nowy@przyklad.test');
  });

  // Krótka nazwa nadana na liście („Pracownia Przykładowa”) ma przeżyć pełną nazwę firmy
  // z faktury — po niej człowiek szuka klienta na liście.
  it('ręcznie nadana krótka nazwa klienta zostaje', async () => {
    await post('/klienci', KLIENT_Z_UMOWA);
    const { id } = zalozZamowienie();
    await post(`/zamowienia/${id}/klient/zapamietaj`);
    const po = klientPoNip(db, NIP);
    expect(po.nazwa).toBe('Pracownia Przykładowa');
    expect(po.faktura.firma).toBe('Pracownia Przykładowa sp. z o.o.');
  });

  // ⚠️ DOSTAWA Z ZAMÓWIENIA NIE IDZIE NA KARTĘ ISTNIEJĄCEGO KLIENTA, więc nie ma prawa jej
  // zablokować. Allegro/Woo z nierozpoznaną dostawą dają `metoda_wysylki = 'nieznana'`, a walidacja
  // `znormalizujKlienta` odbijała całe „Uaktualnij” z 400 „Nie znam sposobu dostawy”.
  it('zamówienie z nierozpoznaną dostawą nadal aktualizuje adres istniejącego klienta', async () => {
    await post('/klienci', KLIENT_Z_UMOWA);
    const przed = klientPoNip(db, NIP);
    const { id } = zalozZamowienie();
    db.prepare("UPDATE zamowienia SET metoda_wysylki = 'nieznana' WHERE id = ?").run(id);

    const odp = await post(`/zamowienia/${id}/klient/zapamietaj`);
    expect(odp.body).not.toContain('Nie znam sposobu dostawy');
    expect(odp.statusCode).toBe(302);
    const po = klientPoNip(db, NIP);
    expect(po.faktura.ulica).toBe('Nowa 5');
    expect(po.metoda_wysylki).toBe('dpd');
    expect(po.koszt_dostawy_brutto).toBe(przed.koszt_dostawy_brutto);
  });

  // ⚠️ ADRES TO CAŁOŚĆ. Ulica i miasto z zamówienia ze starym kodem z karty dałyby adres,
  // którego nikt nie podał — i paczkę na zły kod pocztowy.
  it('adres z zamówienia przechodzi w całości — pusty kod nie zostawia starego', async () => {
    await post('/klienci', KLIENT_Z_UMOWA);
    const { id } = zalozZamowienieReczne({
      db,
      znacznik: '2026-10-20T09:00:00.000Z',
      dane: {
        klient: { company: 'Pracownia Przykładowa sp. z o.o.', address_1: 'Nowa 5', postcode: '', city: 'Kraków' },
        dostawa: { company: 'Nowy Odbiorca sp. z o.o.', address_1: 'Magazynowa 9', postcode: '', city: 'Gdańsk' },
        nip: NIP, chce_fakture: 1, metoda_wysylki: 'dpd', koszt_dostawy_brutto: '0.00',
        metoda_platnosci: 'Przelew', b2b: 1, termin_platnosci: '14', rabat_procent: 0, pozycje: [],
      },
    });
    await post(`/zamowienia/${id}/klient/zapamietaj`);

    const po = klientPoNip(db, NIP);
    expect(po.faktura).toMatchObject({ ulica: 'Nowa 5', miasto: 'Kraków', kod: null });
    expect(po.wysylka).toMatchObject({
      firma: 'Nowy Odbiorca sp. z o.o.', ulica: 'Magazynowa 9', miasto: 'Gdańsk', kod: null,
    });
    // pola spoza adresu dalej tylko niepuste: telefonu zamówienie nie podało
    expect(po.wysylka.telefon).toBe('500000001');
  });

  // Strażnik: nowy klient powstaje jak dotąd — z ustaleniami z zamówienia i BEZ umowy.
  it('nowy klient nadal powstaje z danych zamówienia, bez umowy zbiorczej', async () => {
    const { id } = zalozZamowienie();
    expect((await post(`/zamowienia/${id}/klient/zapamietaj`)).statusCode).toBe(302);

    const k = klientPoNip(db, NIP);
    expect(k).not.toBeNull();
    expect(k.nazwa).toBe('Pracownia Przykładowa sp. z o.o.');
    expect(k.faktura.ulica).toBe('Nowa 5');
    expect(k.rozliczenie_zbiorcze).toBe(0);
    expect(k.prog_darmowej_dostawy_gr).toBeNull();
    expect(k.oplata_obslugi_gr).toBeNull();
    expect(k.oplata_kurierska_gr).toBeNull();
    expect(k.termin_platnosci).toBe('7');
    expect(k.metoda_wysylki).toBe('inpost_paczkomat');
    expect(k.aktywny).toBe(1);
  });
});
