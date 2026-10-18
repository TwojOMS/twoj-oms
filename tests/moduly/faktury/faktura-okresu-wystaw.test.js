import { describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapewnijOkres, pobierzOkres } from '../../../src/oms/db/okresy.js';
import { createFakturaOkresu } from '../../../src/moduly/faktury/services/faktura-okresu.js';
import { STAN } from '../../../src/domena/okres-rozliczeniowy.js';

function dodajZamowienie(db, okresId, { numer, kwota, pozycje, anulowane = 0, utworzone = '2026-07-10T10:00:00.000Z' }) {
  const zrodloId = Number(String(numer).replace(/\D/g, ''));
  db.prepare(
    'INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, anulowane,'
    + ' okres_rozliczeniowy_id, utworzone_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('reczne', zrodloId, numer, kwota, anulowane, okresId, utworzone);
  const id = db.prepare('SELECT id FROM zamowienia WHERE numer = ?').get(numer).id;
  for (const p of pozycje) {
    db.prepare(
      'INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto, brutto_linii, zrodlo)'
      + " VALUES (?, ?, ?, ?, ?, 'reczna')",
    ).run(id, p.nazwa, p.ilosc, p.brutto, p.brutto);
  }
  return id;
}

function bazaZOkresem() {
  const db = openOmsDb();
  const okres = zapewnijOkres(db, { klientKlucz: 'przykladowa', rok: 2026, miesiac: 7 });
  db.prepare(
    'INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, okres_rozliczeniowy_id, utworzone_at)'
    + " VALUES ('reczne', 202600001, 'R/2026/001', '104.00', ?, '2026-07-10T10:00:00.000Z')",
  ).run(okres.id);
  const zamId = db.prepare('SELECT id FROM zamowienia WHERE numer = ?').get('R/2026/001').id;
  db.prepare(
    'INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto, brutto_linii, zrodlo)'
    + " VALUES (?, 'STOP 70x100', 1, '100.00', '100.00', 'reczna'),"
    + " (?, 'Obsługa zamówienia', 1, '4.00', '4.00', 'reczna')",
  ).run(zamId, zamId);
  return { db, okres, zamId };
}

describe('createFakturaOkresu', () => {
  // ⚠️ Nazwy metod sprawdzone w src/oms/infakt/client.js: `wystaw`, `znajdzKlientaPoNip`,
  // `zalozKlienta`. NIE „wystawFakture" — takiej metody klient nie ma.
  //
  // ⚠️ Ksztalt ODPOWIEDZI w tej atrapie to SUROWA odpowiedz API inFaktu (`number`, `ksef_data`).
  // Prawdziwy `createInfaktClient().wystaw` oddaje ja PRZEPISANA na `{ uuid, numer, ksefStatus }`
  // — obie postacie sa w tym pliku przetestowane osobno, bo kod czytajacy tylko jedna z nich
  // zapisywalby do bazy NULL zamiast numeru faktury, i to po cichu.
  const infaktUdany = () => ({
    znajdzKlientaPoNip: vi.fn().mockResolvedValue(77),
    zalozKlienta: vi.fn(),
    wystaw: vi.fn().mockResolvedValue({ uuid: 'u-1', number: 'FV/1/2026', ksef_data: null }),
  });

  it('wystawia fakture i oznacza okres jako zafakturowany', async () => {
    const { db, okres } = bazaZOkresem();
    const infakt = infaktUdany();
    const wynik = await createFakturaOkresu({ db, infakt }).wystaw(okres.id, { nip: '1234500011' });
    expect(wynik.stan).toBe(STAN.ZAFAKTUROWANY);
    expect(wynik.numer).toBe('FV/1/2026');
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
    // Klient musi trafic do payloadu — faktura bez client_id nie ma nabywcy.
    expect(infakt.wystaw.mock.calls[0][0].client_id).toBe(77);
  });

  // Ta sama sciezka, ale przez ODPOWIEDZ PRAWDZIWEGO KLIENTA (`numer`/`ksefStatus`, patrz
  // infakt/client.js). Kod czytajacy wylacznie surowe `number` zapisalby tu NULL — okres
  // bylby zafakturowany dokumentem, ktorego numeru panel nie zna.
  it('zapisuje numer takze z odpowiedzi przepisanej przez klienta inFaktu', async () => {
    const { db, okres } = bazaZOkresem();
    const infakt = infaktUdany();
    infakt.wystaw = vi.fn().mockResolvedValue({ uuid: 'u-9', numer: 'FV/9/2026', ksefStatus: 'sent' });
    const wynik = await createFakturaOkresu({ db, infakt }).wystaw(okres.id, { nip: '1234500011' });
    expect(wynik.numer).toBe('FV/9/2026');
    expect(wynik.infakt_uuid).toBe('u-9');
    expect(wynik.ksef_status).toBe('sent');
  });

  it('nie wystawia drugi raz — okres zafakturowany odmawia', async () => {
    const { db, okres } = bazaZOkresem();
    const infakt = infaktUdany();
    const usluga = createFakturaOkresu({ db, infakt });
    await usluga.wystaw(okres.id, { nip: '1234500011' });
    await expect(usluga.wystaw(okres.id, { nip: '1234500011' })).rejects.toThrow(/wystawiona|stanie/i);
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
  });

  it('awaria 4xx zwalnia rezerwacje i otwiera okres z powrotem', async () => {
    const { db, okres } = bazaZOkresem();
    const infakt = infaktUdany();
    infakt.wystaw = vi.fn().mockRejectedValue(Object.assign(new Error('400'), { status: 400 }));
    await expect(createFakturaOkresu({ db, infakt }).wystaw(okres.id, { nip: '1234500011' })).rejects.toThrow();
    expect(pobierzOkres(db, okres.id).stan).toBe(STAN.OTWARTY);
  });

  // Okres po nieudanej probie ma wygladac DOKLADNIE tak, jak przed nia. Zostawiona data
  // zamkniecia przy stanie „otwarty" to slad, ktory czlowiek czyta jako „ktos ten miesiac
  // zamknal" — a nikt go nie zamykal.
  it('po awarii 4xx nie zostaje ani rezerwacja, ani data zamkniecia', async () => {
    const { db, okres } = bazaZOkresem();
    const infakt = infaktUdany();
    infakt.wystaw = vi.fn().mockRejectedValue(Object.assign(new Error('400'), { status: 400 }));
    await expect(createFakturaOkresu({ db, infakt }).wystaw(okres.id, { nip: '1234500011' })).rejects.toThrow();
    const po = pobierzOkres(db, okres.id);
    expect(po.ksef_status).toBeNull();
    expect(po.utworzona_at).toBeNull();
    expect(po.zamkniety_at).toBeNull();
  });

  it('po awarii 4xx wolno ponowic wystawienie', async () => {
    const { db, okres } = bazaZOkresem();
    const infakt = infaktUdany();
    const wystawUdany = infakt.wystaw;
    infakt.wystaw = vi.fn().mockRejectedValue(Object.assign(new Error('400'), { status: 400 }));
    const usluga = createFakturaOkresu({ db, infakt });
    await expect(usluga.wystaw(okres.id, { nip: '1234500011' })).rejects.toThrow();
    infakt.wystaw = wystawUdany;
    const wynik = await usluga.wystaw(okres.id, { nip: '1234500011' });
    expect(wynik.stan).toBe(STAN.ZAFAKTUROWANY);
  });

  it('awaria niejednoznaczna zostawia okres do wyjasnienia', async () => {
    const { db, okres } = bazaZOkresem();
    const infakt = infaktUdany();
    infakt.wystaw = vi.fn().mockRejectedValue(Object.assign(new Error('socket hang up'), { status: 500 }));
    await expect(createFakturaOkresu({ db, infakt }).wystaw(okres.id, { nip: '1234500011' })).rejects.toThrow();
    expect(pobierzOkres(db, okres.id).ksef_status).toBe('do_wyjasnienia');
  });

  // Zerwane polaczenie NIE niesie statusu (patrz infakt/client.js) — a to najczestsza
  // awaria niejednoznaczna. Brak statusu musi trafiac do tej samej blokady co 5xx.
  it('zerwane polaczenie (bez statusu) tez blokuje okres do decyzji czlowieka', async () => {
    const { db, okres } = bazaZOkresem();
    const infakt = infaktUdany();
    infakt.wystaw = vi.fn().mockRejectedValue(new Error('inFakt nieosiągalny: fetch failed'));
    await expect(createFakturaOkresu({ db, infakt }).wystaw(okres.id, { nip: '1234500011' })).rejects.toThrow();
    const po = pobierzOkres(db, okres.id);
    expect(po.ksef_status).toBe('do_wyjasnienia');
    expect(po.blad_opis).toMatch(/nieosiągalny/);
    // Okres ZOSTAJE zamkniety: dokument mogl powstac, wiec nie wolno dopuszczac tu nowych
    // zamowien, dopoki czlowiek nie rozstrzygnie, co jest w inFakcie.
    expect(po.stan).toBe(STAN.ZAMKNIETY);
  });

  it('okres do wyjasnienia odmawia ponowienia, nie wolajac inFaktu', async () => {
    const { db, okres } = bazaZOkresem();
    const infakt = infaktUdany();
    infakt.wystaw = vi.fn().mockRejectedValue(Object.assign(new Error('bum'), { status: 500 }));
    const usluga = createFakturaOkresu({ db, infakt });
    await expect(usluga.wystaw(okres.id, { nip: '1234500011' })).rejects.toThrow();
    infakt.wystaw = vi.fn();
    await expect(usluga.wystaw(okres.id, { nip: '1234500011' })).rejects.toThrow(/inFakcie|wyjaśnienia/i);
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });

  // ⚠️ NAJGROZNIEJSZA DZIURA TEGO ZADANIA (recenzja 2026-08-01). `zapytaj` z infakt/client.js
  // oddaje `null` dla KAZDEJ odpowiedzi 2xx, ktorej ciala nie da sie sparsowac jako JSON
  // (puste albo HTML-owe cialo z proxy), a `wystaw` degraduje to do `{uuid: null, ...}`.
  // Zadanie do inFaktu wtedy DOSZLO — dokument moze istniec. Zapisane jako „zafakturowany
  // z pustymi polami" zdejmowalo blokade: zmierzone, `infakt.wystaw` szedl DWA razy.
  it('odpowiedz bez uuid-a i bez numeru nie udaje sukcesu — okres idzie do wyjasnienia', async () => {
    const { db, okres } = bazaZOkresem();
    const infakt = infaktUdany();
    infakt.wystaw = vi.fn().mockResolvedValue({ uuid: null, numer: null, ksefStatus: null });
    const usluga = createFakturaOkresu({ db, infakt });
    await expect(usluga.wystaw(okres.id, { nip: '1234500011' })).rejects.toThrow(/bez numeru/i);
    const po = pobierzOkres(db, okres.id);
    expect(po.ksef_status).toBe('do_wyjasnienia');
    expect(po.stan).not.toBe(STAN.ZAFAKTUROWANY);
  });

  it('po odpowiedzi bez uuid-a DRUGIE wystawienie odmawia, a inFakt idzie dokladnie raz', async () => {
    const { db, okres } = bazaZOkresem();
    const infakt = infaktUdany();
    infakt.wystaw = vi.fn().mockResolvedValue({ uuid: null, numer: null, ksefStatus: null });
    const usluga = createFakturaOkresu({ db, infakt });
    await expect(usluga.wystaw(okres.id, { nip: '1234500011' })).rejects.toThrow();
    await expect(usluga.wystaw(okres.id, { nip: '1234500011' })).rejects.toThrow(/inFakcie|wyjaśnienia/i);
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
  });

  // Ta sama sytuacja w skrajnej postaci: cale cialo odpowiedzi nieczytelne, wiec klient
  // oddaje `null` zamiast obiektu.
  it('pusta odpowiedz (null) tez blokuje, zamiast udawac zafakturowany okres', async () => {
    const { db, okres } = bazaZOkresem();
    const infakt = infaktUdany();
    infakt.wystaw = vi.fn().mockResolvedValue(null);
    const usluga = createFakturaOkresu({ db, infakt });
    await expect(usluga.wystaw(okres.id, { nip: '1234500011' })).rejects.toThrow();
    await expect(usluga.wystaw(okres.id, { nip: '1234500011' })).rejects.toThrow();
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
  });

  // Komunikat nie ma prawa obiecywac ponowienia — ze stanow 'do_wyjasnienia'/'zawieszona'
  // panel sam nie wychodzi, a trasy odblokowania (Zadanie 9) jeszcze nie ma.
  it('komunikat blokady nie obiecuje ponowienia', async () => {
    const { db, okres } = bazaZOkresem();
    const infakt = infaktUdany();
    infakt.wystaw = vi.fn().mockRejectedValue(Object.assign(new Error('bum'), { status: 500 }));
    const usluga = createFakturaOkresu({ db, infakt });
    await expect(usluga.wystaw(okres.id, { nip: '1234500011' })).rejects.toThrow();
    await expect(usluga.wystaw(okres.id, { nip: '1234500011' })).rejects.toThrow(/nie ponowi|nie wyjdzie/i);
  });

  // ⚠️ WYSCIG, NIE „DWUKLIK". Straz uslugi czyta stan, potem czeka na `znajdzKlientaPoNip` —
  // wiec DWA przeplecione zadania zdazaja ja przejsc, zanim ktorekolwiek cokolwiek zarezerwuje.
  // To zwykle przeplecenie w jednowatkowym Node, a konczy sie DWOMA fakturami za miesiac.
  it('dwa przeplecione wystawienia — do inFaktu idzie dokladnie jedno', async () => {
    const { db, okres } = bazaZOkresem();
    const infakt = infaktUdany();
    let otworzBrame;
    const brama = new Promise((res) => { otworzBrame = res; });
    infakt.znajdzKlientaPoNip = vi.fn(async () => { await brama; return 77; });
    const usluga = createFakturaOkresu({ db, infakt });
    const pierwsze = usluga.wystaw(okres.id, { nip: '1234500011' });
    const drugie = usluga.wystaw(okres.id, { nip: '1234500011' });
    otworzBrame();
    const wyniki = await Promise.allSettled([pierwsze, drugie]);
    expect(wyniki.filter((w) => w.status === 'fulfilled')).toHaveLength(1);
    expect(wyniki.filter((w) => w.status === 'rejected')).toHaveLength(1);
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
    expect(pobierzOkres(db, okres.id).stan).toBe(STAN.ZAFAKTUROWANY);
  });

  it('nie ma takiego okresu — odmowa', async () => {
    const { db } = bazaZOkresem();
    const infakt = infaktUdany();
    await expect(createFakturaOkresu({ db, infakt }).wystaw(9999, { nip: '1234500011' })).rejects.toThrow(/okresu/i);
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });
});

describe('createFakturaOkresu — bariera arytmetyczna', () => {
  const infaktUdany = () => ({
    znajdzKlientaPoNip: vi.fn().mockResolvedValue(77),
    zalozKlienta: vi.fn(),
    wystaw: vi.fn().mockResolvedValue({ uuid: 'u-1', numer: 'FV/1/2026', ksefStatus: null }),
  });

  // Bariera idzie PRZED rezerwacja i przed zamknieciem okresu: nieudana arytmetyka nie ma
  // prawa zostawic po sobie ani jednego, ani drugiego.
  it('rozjazd sumy nie zostawia ani rezerwacji, ani zamknietego okresu', async () => {
    const db = openOmsDb();
    const okres = zapewnijOkres(db, { klientKlucz: 'przykladowa', rok: 2026, miesiac: 7 });
    dodajZamowienie(db, okres.id, {
      numer: 'R/2026/001', kwota: '104.00', pozycje: [{ nazwa: 'STOP', ilosc: 1, brutto: '90.00' }],
    });
    const infakt = infaktUdany();
    await expect(createFakturaOkresu({ db, infakt }).wystaw(okres.id, { nip: '1234500011' }))
      .rejects.toThrow(/R\/2026\/001/);
    const po = pobierzOkres(db, okres.id);
    expect(po.stan).toBe(STAN.OTWARTY);
    expect(po.ksef_status).toBeNull();
    expect(po.zamkniety_at).toBeNull();
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });

  // Rozjazdy znoszace sie nawzajem (Zadanie 6) — tu przez cala usluge, zeby nikt tej
  // wlasciwosci nie zgubil, przenoszac bariere w inne miejsce.
  it('dwa rozjazdy znoszace sie nawzajem dalej sa odmowa', async () => {
    const db = openOmsDb();
    const okres = zapewnijOkres(db, { klientKlucz: 'przykladowa', rok: 2026, miesiac: 7 });
    dodajZamowienie(db, okres.id, {
      numer: 'R/2026/001', kwota: '100.00', pozycje: [{ nazwa: 'A', ilosc: 1, brutto: '110.00' }],
    });
    dodajZamowienie(db, okres.id, {
      numer: 'R/2026/002', kwota: '100.00', pozycje: [{ nazwa: 'B', ilosc: 1, brutto: '90.00' }],
    });
    const infakt = infaktUdany();
    await expect(createFakturaOkresu({ db, infakt }).wystaw(okres.id, { nip: '1234500011' }))
      .rejects.toThrow(/nie zgadza/);
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });

  it('okres bez zamowien nie idzie do inFaktu', async () => {
    const db = openOmsDb();
    const okres = zapewnijOkres(db, { klientKlucz: 'przykladowa', rok: 2026, miesiac: 7 });
    const infakt = infaktUdany();
    await expect(createFakturaOkresu({ db, infakt }).wystaw(okres.id, { nip: '1234500011' }))
      .rejects.toThrow(/pozycji/);
    expect(pobierzOkres(db, okres.id).stan).toBe(STAN.OTWARTY);
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });
});

describe('createFakturaOkresu — nabywca', () => {
  // Nabywca rozstrzygany PRZED rezerwacja: brak `client_id` to faktura bez nabywcy,
  // a szukanie klienta po rezerwacji zostawialoby wiszace „w_toku" dla bledu, ktory
  // z wystawianiem nie ma nic wspolnego.
  it('brak klienta w kartotece — odmowa bez rezerwacji i bez zamykania okresu', async () => {
    const { db, okres } = bazaZOkresem();
    const infakt = {
      znajdzKlientaPoNip: vi.fn().mockResolvedValue(null),
      zalozKlienta: vi.fn(),
      wystaw: vi.fn(),
    };
    await expect(createFakturaOkresu({ db, infakt }).wystaw(okres.id, { nip: '1234500011' }))
      .rejects.toThrow(/1234500011/);
    const po = pobierzOkres(db, okres.id);
    expect(po.stan).toBe(STAN.OTWARTY);
    expect(po.ksef_status).toBeNull();
    expect(infakt.wystaw).not.toHaveBeenCalled();
    // Panel NIE zaklada klienta zbiorczego sam — to jeden staly kontrahent, zakladany raz,
    // recznie. Automat zalozylby duplikat przy pierwszej literowce w NIP-ie.
    expect(infakt.zalozKlienta).not.toHaveBeenCalled();
  });

  it('awaria wyszukiwania klienta nie zostawia rezerwacji', async () => {
    const { db, okres } = bazaZOkresem();
    const infakt = {
      znajdzKlientaPoNip: vi.fn().mockRejectedValue(new Error('kartoteka ma 2 wpisy')),
      zalozKlienta: vi.fn(),
      wystaw: vi.fn(),
    };
    await expect(createFakturaOkresu({ db, infakt }).wystaw(okres.id, { nip: '1234500011' })).rejects.toThrow();
    const po = pobierzOkres(db, okres.id);
    expect(po.stan).toBe(STAN.OTWARTY);
    expect(po.ksef_status).toBeNull();
  });
});

describe('createFakturaOkresu — daty i termin platnosci', () => {
  const infaktUdany = () => ({
    znajdzKlientaPoNip: vi.fn().mockResolvedValue(77),
    zalozKlienta: vi.fn(),
    wystaw: vi.fn().mockResolvedValue({ uuid: 'u-1', numer: 'FV/1/2026', ksefStatus: null }),
  });

  // Bez wyboru operatora payload NIE dostaje ani jednej daty — dokument bierze wtedy termin
  // z ustawien konta inFakt, dokladnie tak jak przy fakturze pojedynczej (services/faktura.js).
  it('bez podanego terminu payload nie niesie zadnej daty', async () => {
    const { db, okres } = bazaZOkresem();
    const infakt = infaktUdany();
    await createFakturaOkresu({ db, infakt }).wystaw(okres.id, { nip: '1234500011' });
    const payload = infakt.wystaw.mock.calls[0][0];
    expect(payload).not.toHaveProperty('invoice_date');
    expect(payload).not.toHaveProperty('payment_date');
  });

  it('wybor terminu jedzie do payloadu jako daty', async () => {
    const { db, okres } = bazaZOkresem();
    const infakt = infaktUdany();
    await createFakturaOkresu({ db, infakt })
      .wystaw(okres.id, { nip: '1234500011' }, { dataWystawienia: '2026-07-31', termin: 14 });
    expect(infakt.wystaw.mock.calls[0][0]).toMatchObject({
      invoice_date: '2026-07-31', payment_date: '2026-08-14',
    });
  });

  // Literowka w terminie ma odbic sie od formularza, a NIE zostawic zamknietego okresu
  // z wiszaca rezerwacja — czyli daty licza sie przed rezerwacja, tak jak w faktura.js.
  it('bledny termin nie zostawia rezerwacji ani zamknietego okresu', async () => {
    const { db, okres } = bazaZOkresem();
    const infakt = infaktUdany();
    await expect(createFakturaOkresu({ db, infakt })
      .wystaw(okres.id, { nip: '1234500011' }, { termin: 'kiedyś' })).rejects.toThrow(/termin/i);
    const po = pobierzOkres(db, okres.id);
    expect(po.stan).toBe(STAN.OTWARTY);
    expect(po.ksef_status).toBeNull();
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });
});

describe('createFakturaOkresu — zamowienia anulowane', () => {
  const infaktUdany = () => ({
    znajdzKlientaPoNip: vi.fn().mockResolvedValue(77),
    zalozKlienta: vi.fn(),
    wystaw: vi.fn().mockResolvedValue({ uuid: 'u-1', numer: 'FV/1/2026', ksefStatus: null }),
  });

  function okresZAnulowanym(db, { anulowaneRecznie = false } = {}) {
    const okres = zapewnijOkres(db, { klientKlucz: 'przykladowa', rok: 2026, miesiac: 7 });
    dodajZamowienie(db, okres.id, {
      numer: 'R/2026/001', kwota: '100.00', pozycje: [{ nazwa: 'ZYWE', ilosc: 1, brutto: '100.00' }],
    });
    const anulowanyId = dodajZamowienie(db, okres.id, {
      numer: 'R/2026/002',
      kwota: '200.00',
      pozycje: [{ nazwa: 'ANULOWANE', ilosc: 1, brutto: '200.00' }],
      anulowane: anulowaneRecznie ? 0 : 1,
      utworzone: '2026-07-11T10:00:00.000Z',
    });
    if (anulowaneRecznie) {
      db.prepare('UPDATE zamowienia SET anulowane_recznie = 1 WHERE id = ?').run(anulowanyId);
    }
    return { okres, anulowanyId };
  }

  it('pozycje anulowanego zamowienia nie ida na fakture okresu', async () => {
    const db = openOmsDb();
    const { okres } = okresZAnulowanym(db);
    const infakt = infaktUdany();
    await createFakturaOkresu({ db, infakt }).wystaw(okres.id, { nip: '1234500011' });
    const payload = infakt.wystaw.mock.calls[0][0];
    expect(payload.services.map((s) => s.name)).toEqual(['ZYWE']);
    expect(payload.services.reduce((a, s) => a + s.gross_price, 0)).toBe(10000);
  });

  // Anulowanie RECZNE (kolumna `anulowane_recznie`) liczy sie tak samo jak anulowanie
  // w sklepie — wartosc efektywna to suma logiczna obu (domain/status-reczny.js). Czytanie
  // samej kolumny sklepowej wystawialoby fakture za zamowienie, ktore operator anulowal
  // w panelu, bo sklep o tym anulowaniu nie wie.
  it('anulowanie reczne liczy sie tak samo jak sklepowe', async () => {
    const db = openOmsDb();
    const { okres } = okresZAnulowanym(db, { anulowaneRecznie: true });
    const infakt = infaktUdany();
    await createFakturaOkresu({ db, infakt }).wystaw(okres.id, { nip: '1234500011' });
    expect(infakt.wystaw.mock.calls[0][0].services.map((s) => s.name)).toEqual(['ZYWE']);
  });

  // Anulowane zamowienie jest POZA faktura, wiec jest tez poza bariera: rozjazd w jego
  // kwotach nie ma prawa zablokowac faktury za caly miesiac.
  it('rozjazd w anulowanym zamowieniu nie blokuje faktury okresu', async () => {
    const db = openOmsDb();
    const okres = zapewnijOkres(db, { klientKlucz: 'przykladowa', rok: 2026, miesiac: 7 });
    dodajZamowienie(db, okres.id, {
      numer: 'R/2026/001', kwota: '100.00', pozycje: [{ nazwa: 'ZYWE', ilosc: 1, brutto: '100.00' }],
    });
    dodajZamowienie(db, okres.id, {
      numer: 'R/2026/002', kwota: '200.00', anulowane: 1,
      pozycje: [{ nazwa: 'ANULOWANE', ilosc: 1, brutto: '5.00' }],
      utworzone: '2026-07-11T10:00:00.000Z',
    });
    const infakt = infaktUdany();
    const wynik = await createFakturaOkresu({ db, infakt }).wystaw(okres.id, { nip: '1234500011' });
    expect(wynik.stan).toBe(STAN.ZAFAKTUROWANY);
  });

  // Skoro anulowane zamowienia wypadaja po cichu z dokumentu, musi po nich zostac slad
  // w miejscu, w ktorym czlowiek go szuka — w logu tego zamowienia.
  it('pominiecie zostaje odnotowane w logu anulowanego zamowienia', async () => {
    const db = openOmsDb();
    const { okres, anulowanyId } = okresZAnulowanym(db);
    await createFakturaOkresu({ db, infakt: infaktUdany() }).wystaw(okres.id, { nip: '1234500011' });
    const wpisy = db.prepare('SELECT akcja, wynik FROM log WHERE zamowienie_id = ?').all(anulowanyId);
    expect(wpisy.some((w) => /anulowane/i.test(String(w.wynik)))).toBe(true);
  });

  // Numer faktury musi zostac w logu KAZDEGO zafakturowanego zamowienia — „na ktorej fakturze
  // to poszlo" jest pytaniem o zamowienie. Wpis idzie PRZED zapisem wiersza okresu, wiec
  // przetrwa nawet awarie tego zapisu (ten sam wzorzec co services/faktura.js).
  it('zafakturowane zamowienie dostaje w logu numer faktury', async () => {
    const db = openOmsDb();
    const { okres } = okresZAnulowanym(db);
    await createFakturaOkresu({ db, infakt: infaktUdany() }).wystaw(okres.id, { nip: '1234500011' });
    const zywyId = db.prepare('SELECT id FROM zamowienia WHERE numer = ?').get('R/2026/001').id;
    const wpisy = db.prepare('SELECT akcja, wynik FROM log WHERE zamowienie_id = ?').all(zywyId);
    expect(wpisy.some((w) => w.akcja === 'faktura-okresu' && w.wynik === 'FV/1/2026')).toBe(true);
  });

  it('okres z samymi anulowanymi zamowieniami nie idzie do inFaktu', async () => {
    const db = openOmsDb();
    const okres = zapewnijOkres(db, { klientKlucz: 'przykladowa', rok: 2026, miesiac: 7 });
    dodajZamowienie(db, okres.id, {
      numer: 'R/2026/001', kwota: '100.00', anulowane: 1,
      pozycje: [{ nazwa: 'ANULOWANE', ilosc: 1, brutto: '100.00' }],
    });
    const infakt = infaktUdany();
    await expect(createFakturaOkresu({ db, infakt }).wystaw(okres.id, { nip: '1234500011' }))
      .rejects.toThrow(/pozycji/);
    expect(pobierzOkres(db, okres.id).stan).toBe(STAN.OTWARTY);
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });
});
