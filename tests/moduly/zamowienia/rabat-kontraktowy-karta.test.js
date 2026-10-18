import { describe, it, expect, beforeEach } from 'vitest';

import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import {
  dodajPozycjeReczna, pobierzZamowienie, zapiszPozycjeReczna,
} from '../../../src/oms/db/zamowienia.js';
import { dopiszKlienta } from '../../../src/oms/db/klienci.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { zalozZamowienieReczne } from '../../../src/moduly/zamowienia/services/zamowienie-reczne.js';
import { NAZWA_CIASTECZKA_OMS, podpisz } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';

const NIP = '1234500011';
const znacznik = '2026-08-24T09:00:00.000Z';
const naglowek = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};

const config = { auth: { user: 'adam', pass: 'x' } };

let db;

beforeEach(() => {
  db = openOmsDb(':memory:');
  dopiszKlienta(db, {
    klucz: 'przykladowa', nazwa: 'Pracownia Przykładowa', nip: NIP, b2b: 1, rabat_procent: 40,
    chce_fakture: 1, metoda_wysylki: 'dpd', aktywny: 1,
    koszt_dostawy_brutto: '0.00', platnosc: 'Przelew', termin_platnosci: null, komentarz: null,
    // ⚠️ WARUNKI UMOWY MIESZKAJA OD 24.08.2026 NA KARCIE KLIENTA — do tego dnia szly
    // z `OMS_KLIENCI_ZBIORCZY`, wiec ten sam test budowal je w `config`.
    rozliczenie_zbiorcze: 1, prog_darmowej_dostawy_gr: 50000,
    oplata_obslugi_gr: 400, oplata_kurierska_gr: 1900,
  });
});

/** Zamówienie ręczne BEZ NIP-u i bez rabatu, z pozycją po cenie katalogowej. */
const zamowienieBezNipu = () => zalozZamowienieReczne({
  db,
  znacznik,
  dane: {
    klient: { first_name: 'Anna', last_name: 'Przykładowa', email: 'biuro@przykladowa.example' },
    dostawa: { first_name: 'Anna', last_name: 'Przykładowa', address_1: 'Długa 1' },
    nip: null,
    chce_fakture: 1,
    metoda_wysylki: 'dpd',
    pobranie: 0,
    metoda_platnosci: 'Przelew',
    koszt_dostawy_brutto: '0.00',
    b2b: 0,
    termin_platnosci: null,
    rabat_procent: 0,
    pozycje: [{
      nazwa: 'Szablon PIESI', sku: null, ilosc: 1, cena_brutto: '100.00',
      brutto_linii: '100.00', cena_katalogowa: '100.00',
    }],
  },
}).id;

const zapiszFakture = async (id, pola, headers = naglowek) => {
  const app = buildOmsServer({ db, config });
  const odp = await app.inject({
    method: 'POST',
    url: `/zamowienia/${id}/dane/faktura`,
    headers,
    payload: { firma: 'Pracownia Przykładowa sp. z o.o.', ulica: 'Długa 1', kod: '43-300', miasto: 'Pęki', ...pola },
  });
  await app.close();
  return odp;
};

const karta = async (id) => {
  const app = buildOmsServer({ db, config });
  const odp = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
  await app.close();
  return odp;
};

const towar = (z) => z.pozycje.find((p) => p.nazwa === 'Szablon PIESI');

describe('rabat kontraktowy przy zapisie danych faktury', () => {
  it('wpisanie NIP-u klienta z umową przecenia pozycje dodane wcześniej', async () => {
    const id = zamowienieBezNipu();
    expect(towar(pobierzZamowienie(db, id)).cena_brutto).toBe('100.00');

    const odp = await zapiszFakture(id, { nip: NIP });
    expect(odp.statusCode).toBe(302);

    const z = pobierzZamowienie(db, id);
    expect(z.rabat_procent).toBe(40);
    expect(towar(z).cena_brutto).toBe('60.00');
  });

  // ⚠️ OPLATA NIE JEST TOWAREM. „Obsługa zamówienia" nie ma ceny katalogowej, więc
  // przeliczenie nie ma jej z czego policzyć — i ma tak zostać. 4 zł przecenione o 40%
  // to pieniądze zabrane sobie samemu, bez śladu na karcie.
  it('opłata za obsługę przeżywa przeliczenie bez zmiany', async () => {
    const id = zamowienieBezNipu();
    const app = buildOmsServer({ db, config });
    await app.inject({
      method: 'POST',
      url: `/zamowienia/${id}/pozycje`,
      headers: naglowek,
      payload: { nazwa: 'Obsługa zamówienia', ilosc: '1', cena_brutto: '4.00' },
    });
    await app.close();

    await zapiszFakture(id, { nip: NIP });

    const z = pobierzZamowienie(db, id);
    expect(z.pozycje.find((p) => p.nazwa === 'Obsługa zamówienia').cena_brutto).toBe('4.00');
    expect(towar(z).cena_brutto).toBe('60.00');
  });

  it('zapis danych faktury BEZ NIP-u niczego nie przecenia', async () => {
    const id = zamowienieBezNipu();
    await zapiszFakture(id, { nip: '' });
    const z = pobierzZamowienie(db, id);
    expect(z.rabat_procent).toBe(0);
    expect(towar(z).cena_brutto).toBe('100.00');
  });

  it('Sprzedaz i Produkcja po tym samym NIP-ie dostaja identyczny rabat bez ruszania ceny recznej', async () => {
    // Ten przypadek mierzy pojedyncza FV; pozostale testy pliku zachowuja klienta zbiorczego.
    db.prepare('UPDATE klienci SET rozliczenie_zbiorcze = 0 WHERE nip = ?').run(NIP);
    const idSprzedaz = zamowienieBezNipu();
    const idProdukcja = zamowienieBezNipu();

    // Pozycja przyszla z magazynu po cenie katalogowej, a potem operator uzgodnil 4 zl.
    // To trudniejszy przypadek niz pozycja bez katalogu: automat ma od czego policzyc rabat,
    // lecz rozpoznanie recznej zmiany ceny musi go zatrzymac.
    for (const id of [idSprzedaz, idProdukcja]) {
      dodajPozycjeReczna(db, id, {
        nazwa: 'Ustalenie reczne', ilosc: 1, cena_brutto: '10.00', brutto_linii: '10.00',
        produkt_id: 991, wariant_id: 992, cena_katalogowa: '10.00',
      });
      const pozycja = pobierzZamowienie(db, id).pozycje.find((p) => p.nazwa === 'Ustalenie reczne');
      zapiszPozycjeReczna(db, id, pozycja.id, {
        nazwa: pozycja.nazwa, ilosc: 1, cena_brutto: '4.00', brutto_linii: '4.00',
      });
    }

    zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'h', rola: 'administrator', admin: true });
    zalozKonto(db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz', admin: false });
    zalozKonto(db, { login: 'pako', imie: 'Produkcja', haslo: 'h', rola: 'produkcja', admin: false });
    const jako = (login) => ({
      origin: 'http://localhost', accept: 'text/html',
      cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz(login, wczytajSekret(db))}`,
    });

    expect((await zapiszFakture(idSprzedaz, { nip: NIP, chce_fakture: 'on' }, jako('ewa'))).statusCode).toBe(302);
    expect((await zapiszFakture(idProdukcja, { nip: NIP, chce_fakture: 'on' }, jako('pako'))).statusCode).toBe(302);

    const wyniki = [idSprzedaz, idProdukcja].map((id) => pobierzZamowienie(db, id));
    for (const z of wyniki) {
      expect(z.rabat_procent).toBe(40);
      expect(towar(z).cena_brutto).toBe('60.00');
      expect(z.pozycje.find((p) => p.nazwa === 'Ustalenie reczne').cena_brutto).toBe('4.00');
      expect(z.chce_fakture).toBeTruthy();
    }
    expect(wyniki[0].kwota_brutto).toBe(wyniki[1].kwota_brutto);

    const app = buildOmsServer({ db, config, faktura: { wystaw: async () => {} } });
    for (const [id, login] of [[idSprzedaz, 'ewa'], [idProdukcja, 'pako']]) {
      const kartaRoli = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: jako(login) });
      expect(kartaRoli.statusCode).toBe(200);
      expect(kartaRoli.body).toContain(`action="/zamowienia/${id}/faktura"`);
    }
    await app.close();
  });
});

describe('pas rozjazdu rabatu na karcie', () => {
  it('pokazuje się, gdy zamówienie ma inną stawkę niż umowa', async () => {
    const id = zamowienieBezNipu();
    await zapiszFakture(id, { nip: NIP });
    // Operator zmienia stawkę na uzgodnione jednorazowo 25%.
    const app = buildOmsServer({ db, config });
    await app.inject({
      method: 'POST',
      url: `/zamowienia/${id}/ustalenia`,
      headers: naglowek,
      payload: { rabat_procent: '25' },
    });
    await app.close();

    const odp = await karta(id);
    expect(odp.body).toContain('40%');
    // ⚠️ CELUJEMY W `class="…"`, nie w gola nazwe klasy: ta trafia takze w blok <style>
    // layoutu, wiec asercja nieobecnosci nizej bylaby ZAWSZE czerwona, a obecnosci ZAWSZE
    // zielona — czyli oba testy nie sprawdzalyby niczego.
    expect(odp.body).toContain('class="rabat-kontraktowy"');
  });

  it('NIE pokazuje się, gdy stawki są zgodne', async () => {
    const id = zamowienieBezNipu();
    await zapiszFakture(id, { nip: NIP });
    const odp = await karta(id);
    expect(odp.body).not.toContain('class="rabat-kontraktowy"');
  });
});
