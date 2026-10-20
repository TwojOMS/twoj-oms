import {
  describe, it, expect, beforeEach,
} from 'vitest';

import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { klientPoNip, wszyscyKlienci } from '../../../src/oms/db/klienci.js';
import { zalozZamowienieReczne } from '../../../src/moduly/zamowienia/services/zamowienie-reczne.js';

// „ZAPAMIĘTAJ KLIENTA” DLA NOWEGO KLIENTA PRZY NIEROZPOZNANEJ DOSTAWIE (PRZ-102.24).
//
// Allegro/Woo z dostawą, której panel nie zna, dają `metoda_wysylki = 'nieznana'` (albo
// nazwę spoza `DOSTAWY`). U nowego klienta trasa walidowała tę dostawę przez
// `znormalizujKlienta` i odbijała całe „Zapamiętaj” z 400 „Nie znam sposobu dostawy”.
// Klient ma się zapisać BEZ dostawy: nierozpoznana dostawa z jednego zamówienia nie jest
// ustaleniem z klientem, a podstawione „dpd” udawałoby, że ktoś je ustalił.

const NIP = '1234500022';
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
const get = (url) => app.inject({ method: 'GET', url, headers: naglowek });

/** Zamówienie nabywcy, którego nie ma w bazie klientów; dostawę nadpisujemy po założeniu. */
const zalozZamowienie = (metoda) => {
  const { id } = zalozZamowienieReczne({
    db,
    znacznik: '2026-10-20T09:00:00.000Z',
    dane: {
      klient: {
        first_name: 'Jan', last_name: 'Kowalski', company: 'Lampy Przykładowe sp. z o.o.',
        address_1: 'Świetlna 3', postcode: '00-003', city: 'Łódź', email: 'zakupy@lampy.test',
      },
      dostawa: {
        first_name: 'Jan', last_name: 'Kowalski', company: 'Lampy Przykładowe sp. z o.o.',
        address_1: 'Magazynowa 7', postcode: '00-004', city: 'Łódź', phone: '500000002',
      },
      nip: NIP, chce_fakture: 1, metoda_wysylki: 'dpd', koszt_dostawy_brutto: '19.99',
      metoda_platnosci: 'Przelew', b2b: 0, termin_platnosci: '7', rabat_procent: 0, pozycje: [],
    },
  });
  if (metoda !== 'dpd') db.prepare('UPDATE zamowienia SET metoda_wysylki = ? WHERE id = ?').run(metoda, id);
  return id;
};

describe('„Zapamiętaj klienta” — nowy klient z nierozpoznaną dostawą', () => {
  for (const metoda of ['nieznana', 'allegro_one_box']) {
    it(`dostawa „${metoda}”: klient zapisany bez dostawy, z danymi nabywcy z zamówienia`, async () => {
      expect(klientPoNip(db, NIP)).toBeNull();
      const id = zalozZamowienie(metoda);

      const odp = await post(`/zamowienia/${id}/klient/zapamietaj`);
      expect(odp.body).not.toContain('Nie znam sposobu dostawy');
      expect(odp.statusCode).toBe(302);

      const k = klientPoNip(db, NIP);
      expect(wszyscyKlienci(db)).toHaveLength(1);
      // Dostawa NIEUSTALONA — ani nierozpoznana z zamówienia, ani podstawione „dpd”,
      // ani koszt zapłacony w tym jednym zamówieniu.
      expect(k.metoda_wysylki).toBe('');
      expect(k.koszt_dostawy_brutto).toBe('');
      // Reszta danych nabywcy — z zamówienia.
      expect(k.nazwa).toBe('Lampy Przykładowe sp. z o.o.');
      expect(k.nip).toBe(NIP);
      expect(k.chce_fakture).toBe(1);
      expect(k.termin_platnosci).toBe('7');
      expect(k.faktura).toMatchObject({
        firma: 'Lampy Przykładowe sp. z o.o.', nip: NIP, ulica: 'Świetlna 3', kod: '00-003', miasto: 'Łódź',
      });
      expect(k.wysylka).toMatchObject({ ulica: 'Magazynowa 7', kod: '00-004', miasto: 'Łódź' });
    });
  }

  // ⚠️ KOSZT Z ZAMÓWIENIA NIE JEST USTALENIEM Z KLIENTEM (PRZ-102.24, po recenzji). Kupon
  // darmowej wysyłki dawał klientowi „wysyłka gratis” na stałe, koszt null zamieniał się
  // w 0,00, dwie paczki po 19,00 w stałe 38,00. Z zamówienia przechodzi tylko rozpoznana metoda.
  it('dostawa rozpoznana (dpd): metoda z zamówienia, koszt nieustalony, „Wstaw dane” daje kwotę domyślną', async () => {
    const id = zalozZamowienie('dpd');
    expect((await post(`/zamowienia/${id}/klient/zapamietaj`)).statusCode).toBe(302);
    const k = klientPoNip(db, NIP);
    expect(k.metoda_wysylki).toBe('dpd');
    expect(k.koszt_dostawy_brutto).toBe('');

    const odp = await post('/zamowienia/nowe/klient', { klient_klucz: k.klucz, koszt_dostawy_brutto: '' });
    expect(odp.statusCode).toBe(200);
    const koszt = odp.body.match(/name="koszt_dostawy_brutto" value="([^"]*)"/)?.[1];
    const domyslny = (await get('/zamowienia/nowe')).body.match(/name="koszt_dostawy_brutto" value="([^"]*)"/)?.[1];
    expect(domyslny).toBeTruthy();
    expect(koszt).toBe(domyslny);
    expect(odp.body).toMatch(/<option value="dpd" selected/);
  });

  for (const [opis, koszt] of [['kupon darmowej wysyłki (0.00)', '0.00'], ['dwie paczki (38.00)', '38.00']]) {
    it(`dostawa rozpoznana, ${opis}: koszt zamówienia nie trafia na kartę klienta`, async () => {
      const id = zalozZamowienie('dpd');
      db.prepare('UPDATE zamowienia SET koszt_dostawy_brutto = ? WHERE id = ?').run(koszt, id);
      await post(`/zamowienia/${id}/klient/zapamietaj`);
      const k = klientPoNip(db, NIP);
      expect([k.metoda_wysylki, k.koszt_dostawy_brutto]).toEqual(['dpd', '']);
      expect((await get(`/klienci/${k.id}`)).body).not.toContain('wysyłka gratis');
    });
  }

  it('karta klienta, lista i formularz Stałych klientów działają przy pustej dostawie', async () => {
    const id = zalozZamowienie('nieznana');
    await post(`/zamowienia/${id}/klient/zapamietaj`);
    const k = klientPoNip(db, NIP);
    expect(k.metoda_wysylki).toBe('');

    const karta = await get(`/klienci/${k.id}`);
    expect(karta.statusCode).toBe(200);
    expect(karta.body).toContain('Dostawa');
    expect(karta.body).toContain('nie ustalono');
    // Pusty koszt to „nie ustalono”, a nie „wysyłka gratis” (to znaczy 0,00).
    expect(karta.body).not.toContain('wysyłka gratis');

    const formularz = await get(`/klienci/${k.id}/edytuj`);
    expect(formularz.statusCode).toBe(200);
    expect(formularz.body).toContain('name="metoda_wysylki"');
    expect(formularz.body).toContain('value="dpd"');

    expect((await get('/klienci')).statusCode).toBe(200);
  });

  // ⚠️ PUSTY KOSZT KLIENTA NIE MA PRAWA WEJŚĆ DO FORMULARZA ZAMÓWIENIA JAKO PUSTE POLE: puste
  // pole zapisuje się jako 0,00, czyli wysyłka gratis, której nikt nie ustalił. Ekran ma
  // pokazać kwotę domyślną dla wybranej dostawy, tak jak przy zamówieniu bez klienta.
  it('„Wstaw dane klienta” bez ustalonej dostawy zostawia koszt domyślny, nie puste pole', async () => {
    const id = zalozZamowienie('nieznana');
    await post(`/zamowienia/${id}/klient/zapamietaj`);
    const k = klientPoNip(db, NIP);

    const odp = await post('/zamowienia/nowe/klient', { klient_klucz: k.klucz, koszt_dostawy_brutto: '' });
    expect(odp.statusCode).toBe(200);
    const koszt = odp.body.match(/name="koszt_dostawy_brutto" value="([^"]*)"/)?.[1];
    const domyslny = (await get('/zamowienia/nowe')).body.match(/name="koszt_dostawy_brutto" value="([^"]*)"/)?.[1];
    expect(domyslny).toBeTruthy();
    expect(koszt).toBe(domyslny);
    expect(odp.body).toMatch(/<option value="dpd" selected/);
  });

  it('karta klienta z ustaloną dostawą pokazuje ją i koszt', async () => {
    const id = zalozZamowienie('dpd');
    await post(`/zamowienia/${id}/klient/zapamietaj`);
    // Koszt z zamówienia na kartę nie przechodzi — ustalamy go tak, jak zrobiłby to operator.
    db.prepare("UPDATE klienci SET koszt_dostawy_brutto = '19.99' WHERE nip = ?").run(NIP);
    const karta = await get(`/klienci/${klientPoNip(db, NIP).id}`);
    expect(karta.statusCode).toBe(200);
    expect(karta.body).toContain('DPD — kurier');
    expect(karta.body).toContain('19.99');
  });
});

// Formularz z ekranu odczytany tak, jak wyśle go przeglądarka: pola tekstowe i ukryte z ich
// wartością, zaznaczone pola wyboru, a z listy wyboru opcja `selected` — albo PIERWSZA, gdy
// żadna nie jest zaznaczona (dokładnie to robi przeglądarka i dokładnie tak pusta dostawa
// zamieniała się po cichu w DPD).
function formularzZEkranu(html) {
  const forma = html.match(/<form method="post" action="\/klienci">([\s\S]*?)<\/form>/)?.[1] ?? '';
  const dekoduj = (s) => s.replace(/&#34;|&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const atrybut = (tag, nazwa) => tag.match(new RegExp(`\\s${nazwa}="([^"]*)"`))?.[1];
  const pola = {};
  for (const [tag] of forma.matchAll(/<input\b[^>]*>/g)) {
    const nazwa = atrybut(tag, 'name');
    if (!nazwa) continue;
    if (atrybut(tag, 'type') === 'checkbox') {
      if (/\schecked\b/.test(tag)) pola[nazwa] = atrybut(tag, 'value') ?? 'on';
    } else {
      pola[nazwa] = dekoduj(atrybut(tag, 'value') ?? '');
    }
  }
  for (const [, nazwa, opcje] of forma.matchAll(/<select name="([^"]+)">([\s\S]*?)<\/select>/g)) {
    const wartosci = [...opcje.matchAll(/<option value="([^"]*)"([^>]*)>/g)];
    const wybrana = wartosci.find(([, , reszta]) => /selected/.test(reszta)) ?? wartosci[0];
    pola[nazwa] = wybrana ? dekoduj(wybrana[1]) : '';
  }
  return pola;
}

// FORMULARZ STAŁYCH KLIENTÓW PRZY PUSTEJ DOSTAWIE (PRZ-102.24, druga część). Lista wyboru
// nie miała opcji „nie ustalono”, więc przeglądarka wysyłała pierwszą (DPD), a pusty koszt
// zapisywał się jako 0,00 — czyli poprawka samego adresu robiła z klienta „wysyłka gratis”.
// Koszt z karty klienta wchodzi potem do nowych zamówień: to są pieniądze.
describe('Formularz Stałych klientów — dostawa nieustalona', () => {
  const zapiszFormularzemZNowymAdresem = async (klientId) => {
    const ekran = await get(`/klienci/${klientId}/edytuj`);
    expect(ekran.statusCode).toBe(200);
    const pola = formularzZEkranu(ekran.body);
    expect(pola.id).toBe(String(klientId));
    const odp = await post('/klienci', { ...pola, f_ulica: 'Nowa 11', w_ulica: 'Nowa 11' });
    expect(odp.statusCode).toBe(302);
    return { pola };
  };

  it('pusta dostawa: wybrana opcja „nie ustalono”, zapis poprawki adresu zostawia dostawę i koszt puste', async () => {
    const id = zalozZamowienie('nieznana');
    await post(`/zamowienia/${id}/klient/zapamietaj`);
    const k = klientPoNip(db, NIP);
    expect(k.metoda_wysylki).toBe('');

    const ekran = await get(`/klienci/${k.id}/edytuj`);
    expect(ekran.body).toMatch(/<option value="" selected>nie ustalono<\/option>/);

    const { pola } = await zapiszFormularzemZNowymAdresem(k.id);
    expect(pola.metoda_wysylki).toBe('');

    const po = klientPoNip(db, NIP);
    expect(po.faktura.ulica).toBe('Nowa 11');
    expect(po.metoda_wysylki).toBe('');
    expect(po.koszt_dostawy_brutto).toBe('');
    expect((await get(`/klienci/${k.id}`)).body).not.toContain('wysyłka gratis');
  });

  it('pusta dostawa wymusza pusty koszt, nawet gdy w polu kosztu coś wpisano', async () => {
    const id = zalozZamowienie('nieznana');
    await post(`/zamowienia/${id}/klient/zapamietaj`);
    const k = klientPoNip(db, NIP);
    const pola = formularzZEkranu((await get(`/klienci/${k.id}/edytuj`)).body);
    expect((await post('/klienci', { ...pola, koszt_dostawy_brutto: '0' })).statusCode).toBe(302);
    expect(klientPoNip(db, NIP).koszt_dostawy_brutto).toBe('');
  });

  it('klient z dpd i 19.00: zapis formularza bez zmian dostawy zostawia dpd / 19.00', async () => {
    const id = zalozZamowienie('dpd');
    await post(`/zamowienia/${id}/klient/zapamietaj`);
    db.prepare("UPDATE klienci SET koszt_dostawy_brutto = '19.00' WHERE nip = ?").run(NIP);
    const k = klientPoNip(db, NIP);
    expect([k.metoda_wysylki, k.koszt_dostawy_brutto]).toEqual(['dpd', '19.00']);

    const { pola } = await zapiszFormularzemZNowymAdresem(k.id);
    expect(pola.metoda_wysylki).toBe('dpd');

    const po = klientPoNip(db, NIP);
    expect(po.faktura.ulica).toBe('Nowa 11');
    expect([po.metoda_wysylki, po.koszt_dostawy_brutto]).toEqual(['dpd', '19.00']);
  });

  // Dzisiejsza reguła zostaje: WYBRANA dostawa z pustym polem kosztu to 0,00.
  // ⚠️ PUSTE POLE KOSZTU TO „NIE USTALONO” TAKŻE PRZY WYBRANEJ DOSTAWIE (decyzja kierownika
  // pętli, PRZ-102.24). Do tej poprawki puste pole zapisywało 0,00, więc poprawka samego adresu
  // u klienta z DPD i pustym kosztem dawała „wysyłka gratis” na stałe. Pusty koszt jest
  // bezpieczny: „Wstaw dane” podstawia kwotę domyślną z Ustawień.
  it('wybrana dostawa z pustym kosztem zapisuje pusty koszt, nie 0.00', async () => {
    const id = zalozZamowienie('nieznana');
    await post(`/zamowienia/${id}/klient/zapamietaj`);
    const k = klientPoNip(db, NIP);
    const pola = formularzZEkranu((await get(`/klienci/${k.id}/edytuj`)).body);
    await post('/klienci', { ...pola, metoda_wysylki: 'inpost_paczkomat', koszt_dostawy_brutto: '' });
    const po = klientPoNip(db, NIP);
    expect([po.metoda_wysylki, po.koszt_dostawy_brutto]).toEqual(['inpost_paczkomat', '']);
    expect((await get(`/klienci/${k.id}`)).body).not.toContain('wysyłka gratis');
  });

  it('klient z dpd i pustym kosztem z zamówienia: poprawka adresu formularzem zostawia koszt pusty', async () => {
    const id = zalozZamowienie('dpd');
    await post(`/zamowienia/${id}/klient/zapamietaj`);
    const k = klientPoNip(db, NIP);
    expect([k.metoda_wysylki, k.koszt_dostawy_brutto]).toEqual(['dpd', '']);
    await zapiszFormularzemZNowymAdresem(k.id);
    const po = klientPoNip(db, NIP);
    expect(po.faktura.ulica).toBe('Nowa 11');
    expect([po.metoda_wysylki, po.koszt_dostawy_brutto]).toEqual(['dpd', '']);
    expect((await get(`/klienci/${k.id}`)).body).not.toContain('wysyłka gratis');
  });

  for (const wpisane of ['0', '0,00']) {
    it(`wpisane wprost „${wpisane}” daje 0.00 i „wysyłka gratis”`, async () => {
      const id = zalozZamowienie('dpd');
      await post(`/zamowienia/${id}/klient/zapamietaj`);
      const k = klientPoNip(db, NIP);
      const pola = formularzZEkranu((await get(`/klienci/${k.id}/edytuj`)).body);
      await post('/klienci', { ...pola, koszt_dostawy_brutto: wpisane });
      expect(klientPoNip(db, NIP).koszt_dostawy_brutto).toBe('0.00');
      expect((await get(`/klienci/${k.id}`)).body).toContain('wysyłka gratis');
    });
  }
});
