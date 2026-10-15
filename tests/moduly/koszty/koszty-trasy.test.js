import { describe, it, expect } from 'vitest';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszKoszt, zapiszKursor, zapiszOdrzuconyKoszt } from '../../../src/oms/db/koszty.js';
import { przypnijKategorie } from '../../../src/oms/db/kategorie-kosztow.js';

// ⚠️ Ta sama para naglowkow, co w pozostalych testach tras (faktury-trasy.test.js): Basic Auth
// panelu, a przy POST takze `origin`, bez ktorego ochrona CSRF slusznie odbija zadanie.
const AUTH = { authorization: `Basic ${Buffer.from('t:h').toString('base64')}` };
const AUTH_POST = { ...AUTH, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' };

// Reszta pol z `opcje` jedzie do `buildOmsServer` bez zmian — dzieki temu test moze
// podstawic usluge, ktorej ekran kosztow uzywa tylko po to, zeby POKAZAC przycisk
// (np. `paczkaDlaBiura`), nie budujac wlasnego serwera obok.
function serwer({ czuwaczKosztow = { przebieg: async () => ({ nowych: 0 }) }, ...dodatkowe } = {}) {
  const db = openOmsDb(':memory:');
  const app = buildOmsServer({
    db, config: { auth: { user: 't', pass: 'h' } }, czuwaczKosztow, ...dodatkowe,
  });
  return { app, db };
}

// ⚠️ KWOTY JAKO NAPISY Z DWOMA MIEJSCAMI PO PRZECINKU — DOKLADNIE TAKI KSZTALT ODDAJE
// `naWiersz` (domain/koszt-metadane.js), czyli JEDYNA droga, ktora zapisuje koszty na
// produkcji. Zasiew liczbowy (`netto: 100`) utrwalal ksztalt, ktorego panel nigdy nie
// wytwarza: kolumny sa TEXT-em, bo pieniadze liczy sie przez `grosze()` na liczbach
// calkowitych (niezmiennik 4.5). Cala droga „KSeF → ekran" ma wlasny test
// (tests/oms/koszty-droga-ksef-na-ekran.test.js).
const wiersz = (n = {}) => ({
  ksefNumber: 'K-1', numerDokumentu: 'FV/2026/06/12', sprzedawcaNip: '5252674798',
  sprzedawcaNazwa: 'Allegro', dataWystawienia: '2026-06-05',
  dataTrwalegoZapisu: '2026-06-05T14:00:00Z', netto: '100.00', vat: '23.00', brutto: '123.00',
  waluta: 'PLN', rodzaj: 'Vat', maZalacznik: 0, ...n,
});

describe('GET /koszty', () => {
  it('bez hasla oddaje 401', async () => {
    const { app } = serwer();
    expect((await app.inject({ method: 'GET', url: '/koszty' })).statusCode).toBe(401);
  });

  it('pokazuje dokumenty miesiaca, sume i kategorie', async () => {
    const { app, db } = serwer();
    przypnijKategorie(db, '5252674798', 'Prowizje sprzedażowe', 'zmienny');
    zapiszKoszt(db, wiersz());
    const r = await app.inject({ method: 'GET', url: '/koszty?miesiac=2026-06', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('FV/2026/06/12');
    expect(r.body).toContain('Allegro');
    expect(r.body).toContain('Prowizje sprzedażowe');
    expect(r.body).toContain('123,00');
  });

  it('⚠️ pas nieprzypisanych podaje LICZBE dokumentow i KWOTE, nie sama etykiete', async () => {
    const { app, db } = serwer();
    zapiszKoszt(db, wiersz({ ksefNumber: 'K-9', sprzedawcaNip: '9999999999', sprzedawcaNazwa: 'Nowy Dostawca', netto: '40.00', vat: '9.20', brutto: '49.20' }));
    const r = await app.inject({ method: 'GET', url: '/koszty?miesiac=2026-06', headers: AUTH });
    expect(r.body).toContain('Bez kategorii');
    expect(r.body).toContain('40,00');
    expect(r.body).toContain('9999999999');
  });

  it('⚠️ dokument w obcej walucie stoi osobno i NIE wchodzi do sumy PLN', async () => {
    const { app, db } = serwer();
    zapiszKoszt(db, wiersz());
    zapiszKoszt(db, wiersz({ ksefNumber: 'K-EUR', numerDokumentu: 'INV-9', waluta: 'EUR', netto: '900.00', vat: '0.00', brutto: '900.00' }));
    const r = await app.inject({ method: 'GET', url: '/koszty?miesiac=2026-06', headers: AUTH });
    expect(r.body).toContain('INV-9');
    expect(r.body).toContain('EUR');
    expect(r.body).not.toContain('1 000,00');
  });

  it('pokazuje date ostatniego udanego pobrania', async () => {
    const { app, db } = serwer();
    zapiszKursor(db, '2026-06-05T14:00:00Z');
    const r = await app.inject({ method: 'GET', url: '/koszty?miesiac=2026-06', headers: AUTH });
    expect(r.body).toContain('Ostatnie pobranie');
  });

  it('miesiac bez dokumentow oddaje 200 i zdanie o pustce, nie bledu', async () => {
    const { app } = serwer();
    const r = await app.inject({ method: 'GET', url: '/koszty?miesiac=2026-02', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Brak faktur kosztowych');
  });

  // ⚠️ `kosztyMiesiaca` RZUCA na miesiacu w zlym formacie (db/koszty.js, recenzja W2) — i ma
  // rzucac, bo pusta lista znaczylaby „w tym miesiacu nie bylo kosztow". Trasa musi ten wyjatek
  // ZLAPAC: literowka w adresie ma dac zdanie, ktore operator rozumie, a nie piecsetke.
  it('⚠️ zly miesiac w adresie odmawia CZYTELNIE, a nie piecsetka', async () => {
    const { app } = serwer();
    const r = await app.inject({ method: 'GET', url: '/koszty?miesiac=2026-6', headers: AUTH });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('RRRR-MM');
  });
});

// ⚠️⚠️ KWARANTANNA (`koszty_odrzucone`) — dokumenty, ktorych panel nie umial zapisac, a wiec
// NIE WCHODZACE do sumy miesiaca. Do tej zakladki nie mialy zadnego konsumenta na ekranie:
// trwaly slad, ktorego nikt nie widzi, jest tyle wart, co brak sladu — a suma miesiaca po
// cichu nie zgadza sie wtedy z zestawieniem z KSeF.
describe('GET /koszty — kwarantanna', () => {
  it('⚠️ pokazuje LICZBE odrzuconych, ich numery i zdanie, ze NIE wchodza do sumy', async () => {
    const { app, db } = serwer();
    zapiszKoszt(db, wiersz());
    zapiszOdrzuconyKoszt(db, {
      ksefNumber: 'K-BRAK-KWOTY', invoiceNumber: 'FV/2026/06/77',
      permanentStorageDate: '2026-06-07T10:00:00Z',
    }, 'Brak kwoty: netto (K-BRAK-KWOTY).');
    const r = await app.inject({ method: 'GET', url: '/koszty?miesiac=2026-06', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('K-BRAK-KWOTY');
    expect(r.body).toContain('FV/2026/06/77');
    expect(r.body).toContain('Brak kwoty');
    expect(r.body).toMatch(/nie wchodz\w*\s+do sumy/i);
  });

  // Pusta kwarantanna to stan POPRAWNY i CICHY. Ostrzezenie palace sie zawsze przestaje
  // cokolwiek znaczyc i przykrywa nastepna, prawdziwa dziure (ta sama lekcja, co przy
  // `zapiszBladPobrania` w db/koszty.js).
  it('pusta kwarantanna nie zapala zadnego ostrzezenia', async () => {
    const { app, db } = serwer();
    zapiszKoszt(db, wiersz());
    const r = await app.inject({ method: 'GET', url: '/koszty?miesiac=2026-06', headers: AUTH });
    expect(r.body).not.toMatch(/nie wchodz\w*\s+do sumy/i);
  });
});

// ⚠️⚠️ KATEGORIA BEZ ANI JEDNEGO DOSTAWCY MUSI BYC WIDOCZNA NA LISCIE WYBORU. Lista brala sie
// wczesniej z `DISTINCT` po tabeli PRZYPISAN, wiec „Sprzet" i „Reklama" (wlasciciel nie zna
// z gory ich NIP-ow) nie mialy jak sie na niej pojawic — a bez pojawienia sie nie mialy jak
// zostac wybrane, czyli nie mogly powstac NIGDY. To jest ten test, ktory pilnuje, zeby slownik
// kategorii nie zrosl sie z powrotem z przypisaniami.
describe('GET /koszty — lista wyboru kategorii', () => {
  it('⚠️ zawiera kategorie, ktore nie maja jeszcze zadnego dostawcy', async () => {
    const { app } = serwer();
    const r = await app.inject({ method: 'GET', url: '/koszty?miesiac=2026-06', headers: AUTH });
    expect(r.body).toContain('value="Sprzęt"');
    expect(r.body).toContain('value="Reklama"');
    expect(r.body).toContain('value="Materiały do produkcji"');
  });
});

describe('POST /koszty/kategoria', () => {
  it('przypina kategorie i wraca na TEN SAM miesiac', async () => {
    const { app, db } = serwer();
    zapiszKoszt(db, wiersz({ ksefNumber: 'K-9', sprzedawcaNip: '9999999999' }));
    const r = await app.inject({
      method: 'POST', url: '/koszty/kategoria', headers: AUTH_POST,
      payload: 'nip=9999999999&kategoria=Materia%C5%82y&typ=zmienny&miesiac=2026-06',
    });
    expect([200, 303]).toContain(r.statusCode);
    expect(db.prepare('SELECT kategoria FROM kategorie_kosztow WHERE nip = ?').get('9999999999').kategoria).toBe('Materiały');
  });

  it('⚠️ nieznany typ jest ODRZUCANY — CHECK w bazie nie moze byc jedyna obrona', async () => {
    const { app } = serwer();
    const r = await app.inject({
      method: 'POST', url: '/koszty/kategoria', headers: AUTH_POST,
      payload: 'nip=9999999999&kategoria=X&typ=wymyslony&miesiac=2026-06',
    });
    expect(r.statusCode).toBe(400);
  });

  // Miesiac w formularzu to ADRES POWROTU, a nie pytanie o pieniadze: popsuty nie ma prawa
  // przewrocic akcji, ktora juz sie wykonala (kategoria zostala przypieta).
  it('⚠️ popsuty miesiac w formularzu nie gubi przypiecia', async () => {
    const { app, db } = serwer();
    const r = await app.inject({
      method: 'POST', url: '/koszty/kategoria', headers: AUTH_POST,
      payload: 'nip=9999999999&kategoria=Opakowania&typ=zmienny&miesiac=czerwiec',
    });
    expect(r.statusCode).toBe(200);
    expect(db.prepare('SELECT kategoria FROM kategorie_kosztow WHERE nip = ?').get('9999999999').kategoria).toBe('Opakowania');
  });
});

describe('POST /koszty/odswiez', () => {
  it('wola przebieg WYMUSZONY, nie zwykly', async () => {
    let wywolanie = null;
    const { app } = serwer({ czuwaczKosztow: { przebieg: async (o) => { wywolanie = o; return { nowych: 3 }; } } });
    await app.inject({ method: 'POST', url: '/koszty/odswiez', headers: AUTH_POST, payload: 'miesiac=2026-06' });
    expect(wywolanie).toEqual({ wymuszony: true });
  });

  it('⚠️ blad KSeF oddaje ekran z komunikatem, NIGDY 500', async () => {
    const { app } = serwer({ czuwaczKosztow: { przebieg: async () => { throw new Error('KSeF odmowil przy pobieraniu: HTTP 401'); } } });
    const r = await app.inject({ method: 'POST', url: '/koszty/odswiez', headers: AUTH_POST, payload: 'miesiac=2026-06' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('KSeF odmowil');
  });

  // Panel bez sekcji KSEF_* to tryb POPRAWNY (jak brak inFaktu przy /faktury): zakladka ma
  // dzialac na lustrze w bazie, ale przycisk nie ma czego uruchomic — i musi to POWIEDZIEC.
  it('panel bez KSeF odmawia czytelnie, zamiast wywalic sie na braku czuwacza', async () => {
    const { app } = serwer({ czuwaczKosztow: null });
    const r = await app.inject({ method: 'POST', url: '/koszty/odswiez', headers: AUTH_POST, payload: 'miesiac=2026-06' });
    expect(r.statusCode).toBe(503);
    expect(r.body).toContain('KSeF');
  });
});

// ⚠️ WIZUALIZACJA KOSZTU (Zadanie 12). KSeF oddaje wylacznie XML, wiec PDF rysuje panel —
// a XML pobiera NA ZADANIE, bo archiwum na NAS-ie jest dzis wylaczone (`KSEF_ARCHIWUM`
// nieustawione na produkcji). Trasa nie ma prawa polegac na `sciezka_pdf` w bazie.
describe('GET /koszty/:ksefNumber/pdf', () => {
  const zWizualizacja = (wizualizacjaKosztu) => {
    const db = openOmsDb(':memory:');
    const app = buildOmsServer({
      db, config: { auth: { user: 't', pass: 'h' } }, czuwaczKosztow: null, wizualizacjaKosztu,
    });
    return { app, db };
  };

  it('oddaje PDF z naglowkami pobrania i nazwa z numeru dokumentu', async () => {
    let widziany = null;
    const { app, db } = zWizualizacja({
      pdf: async (ksefNumber) => {
        widziany = ksefNumber;
        return { wiersz: { numer_dokumentu: 'FV/2026/06/12' }, bajty: Buffer.from('%PDF-1.3 udalo sie') };
      },
    });
    zapiszKoszt(db, wiersz());

    const r = await app.inject({ method: 'GET', url: '/koszty/K-1/pdf', headers: AUTH });

    expect(widziany).toBe('K-1');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toContain('koszt-FV_2026_06_12.pdf');
    expect(r.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  // Panel bez sekcji KSEF_* to tryb POPRAWNY — ale wizualizacji nie ma z czego zrobic
  // i trasa musi to POWIEDZIEC, a nie wywalic sie na braku uslugi.
  it('panel bez KSeF odmawia czytelnie', async () => {
    const { app } = zWizualizacja(null);
    const r = await app.inject({ method: 'GET', url: '/koszty/K-1/pdf', headers: AUTH });
    expect(r.statusCode).toBe(503);
    expect(r.body).toContain('KSeF');
  });

  // ⚠️ ODMOWA OPISANA DLA CZLOWIEKA WRACA ZDANIEM, nie piecsetka: nieznany numer KSeF
  // i awaria po stronie KSeF sa tu tym samym rodzajem zdarzenia.
  it('⚠️ blad przy pobieraniu XML-a oddaje zdanie, NIGDY 500', async () => {
    const { app } = zWizualizacja({
      pdf: async () => {
        const e = new Error('KSeF nieosiągalny przy pobieraniu dokumentu K-1');
        e.dlaOperatora = true;
        throw e;
      },
    });
    const r = await app.inject({ method: 'GET', url: '/koszty/K-1/pdf', headers: AUTH });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('KSeF nieosiągalny');
  });

  it('link do PDF-u stoi na ekranie, gdy KSeF jest podpiety — i znika, gdy go nie ma', async () => {
    const { app, db } = zWizualizacja({ pdf: async () => ({ wiersz: {}, bajty: Buffer.from('%PDF-') }) });
    zapiszKoszt(db, wiersz());
    const r = await app.inject({ method: 'GET', url: '/koszty?miesiac=2026-06', headers: AUTH });
    expect(r.body).toContain('/koszty/K-1/pdf');

    const bezKsef = zWizualizacja(null);
    zapiszKoszt(bezKsef.db, wiersz());
    const r2 = await bezKsef.app.inject({ method: 'GET', url: '/koszty?miesiac=2026-06', headers: AUTH });
    expect(r2.body).not.toContain('/koszty/K-1/pdf');
  });
});

// ⚠️⚠️ RĘCZNE FAKTURY KOSZTOWE (2026-08-13). Koszty, których w KSeF NIE MA I NIE BĘDZIE:
// Facebook, Google, Anthropic, zakupy zagraniczne, paragony. Leżą w TEJ SAMEJ tabeli, co
// lustro KSeF-u — bo suma miesiąca i rozbicie na kategorie mają mieć jedną prawdę o kosztach.
//
// ⚠️⚠️ FORMULARZ MA TRZY POLA: `firma` (wybór z listy), `dataWystawienia`, `kwota`. Poprzednia
// wersja miała osiem — właściciel obejrzał ją i powiedział wprost, że tyle wystarczy.
describe('POST /koszty/reczne', () => {
  const FORMULARZ = 'firma=Google&dataWystawienia=2026-06-07&kwota=200&miesiac=2026-06';

  it('dopisuje koszt spoza KSeF i pokazuje go w miesiącu', async () => {
    const { app, db } = serwer();
    db.prepare('INSERT INTO firmy_reczne (nazwa,sprzedawca,kategoria,typ,dodana_at) VALUES (?,?,?,?,?)')
      .run('Google','Google Ireland Limited','Reklama','zmienny','2026-10-01T00:00:00Z');
    const r = await app.inject({
      method: 'POST', url: '/koszty/reczne', headers: AUTH_POST, payload: FORMULARZ,
    });
    expect(r.statusCode).toBe(200);
    // ⚠️ NAZWA SPRZEDAWCY, KATEGORIA I TYP BIORĄ SIĘ ZE SŁOWNIKA FIRM — operator wpisał
    // wyłącznie datę i kwotę, a na ekranie stoi pełna nazwa wystawcy.
    expect(r.body).toContain('Google Ireland Limited');
    const w = db.prepare('SELECT * FROM koszty').get();
    expect(w.zrodlo).toBe('reczne');
    expect(w.netto).toBe('200.00');
    expect(w.brutto).toBe('200.00');
    expect(w.vat).toBe('0.00');
    expect(w.waluta).toBe('PLN');
    expect(w.kategoria_dokumentu).toBe('Reklama');
    // ⚠️ NUMER DOKUMENTU SKŁADANY Z FIRMY I DATY — czytelny na liście i NIE udający numeru
    // faktury sprzedawcy (takiego numeru nikt nigdy nie wystawił).
    expect(w.numer_dokumentu).toBe('Google 2026-06-07');
  });

  // ⚠️ WCHODZI DO SUMY MIESIĄCA NA RÓWNI Z DOKUMENTEM Z KSeF — to jest cały powód, dla
  // którego oba rodzaje leżą w jednej tabeli.
  it('⚠️ wchodzi do sumy miesiąca razem z dokumentami z KSeF', async () => {
    const { app, db } = serwer();
    db.prepare('INSERT INTO firmy_reczne (nazwa,sprzedawca,kategoria,typ,dodana_at) VALUES (?,?,?,?,?)')
      .run('Google','Google Ireland Limited','Reklama','zmienny','2026-10-01T00:00:00Z');
    zapiszKoszt(db, wiersz());
    await app.inject({ method: 'POST', url: '/koszty/reczne', headers: AUTH_POST, payload: FORMULARZ });
    const r = await app.inject({ method: 'GET', url: '/koszty?miesiac=2026-06', headers: AUTH });
    expect(r.body).toContain('300,00');
  });

  // ⚠️⚠️ TO JEST POPRAWKA USTERKI, KTÓRĄ MIAŁA PIERWSZA WERSJA: formularz miał pole waluty,
  // więc faktura Anthropica w USD lądowała w pasie „obca waluta", czyli POZA sumą miesiąca.
  // Koszt, dla którego cała ta funkcja powstała, nie wchodził do liczby, którą miał zasilić.
  it('⚠️ kwota jest w PLN i wiersz NIE ląduje poza sumą miesiąca', async () => {
    const { app, db } = serwer();
    db.prepare('INSERT INTO firmy_reczne (nazwa,sprzedawca,kategoria,typ,dodana_at) VALUES (?,?,?,?,?)')
      .run('Anthropic','Anthropic PBC','Oprogramowanie','staly','2026-10-01T00:00:00Z');
    await app.inject({
      method: 'POST', url: '/koszty/reczne', headers: AUTH_POST,
      payload: 'firma=Anthropic&dataWystawienia=2026-06-07&kwota=90&waluta=USD&miesiac=2026-06',
    });
    const r = await app.inject({ method: 'GET', url: '/koszty?miesiac=2026-06', headers: AUTH });
    expect(r.body).not.toContain('Poza sumą');
    expect(r.body).toContain('90,00');
  });

  // ⚠️ RÓŻNICY „skąd to jest" NIE WIDAĆ PO TREŚCI DOKUMENTU — a widzieć ją trzeba, bo tylko
  // wiersz ręczny wolno poprawić i tylko za jego kwotę odpowiada człowiek przy panelu.
  it('⚠️ wiersz ręczny jest na liście ROZPOZNAWALNY i ma odnośnik do poprawki', async () => {
    const { app, db } = serwer();
    db.prepare('INSERT INTO firmy_reczne (nazwa,sprzedawca,kategoria,typ,dodana_at) VALUES (?,?,?,?,?)')
      .run('Google','Google Ireland Limited','Reklama','zmienny','2026-10-01T00:00:00Z');
    await app.inject({ method: 'POST', url: '/koszty/reczne', headers: AUTH_POST, payload: FORMULARZ });
    const klucz = db.prepare('SELECT ksef_number k FROM koszty').get().k;
    const r = await app.inject({ method: 'GET', url: '/koszty?miesiac=2026-06', headers: AUTH });
    expect(r.body).toContain('wpisana ręcznie');
    expect(r.body).toContain('/koszty/reczne/' + encodeURIComponent(klucz));
  });

  it('⚠️ popsuta kwota odmawia zdaniem dla człowieka, a nie piećsetką', async () => {
    const { app, db } = serwer();
    db.prepare('INSERT INTO firmy_reczne (nazwa,sprzedawca,kategoria,typ,dodana_at) VALUES (?,?,?,?,?)')
      .run('Google','Google Ireland Limited','Reklama','zmienny','2026-10-01T00:00:00Z');
    const r = await app.inject({
      method: 'POST', url: '/koszty/reczne', headers: AUTH_POST,
      payload: 'firma=Google&dataWystawienia=2026-06-07&kwota=osiemdziesi%C4%85t&miesiac=2026-06',
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('kwota');
    expect(db.prepare('SELECT COUNT(*) c FROM koszty').get().c).toBe(0);
  });

  // ⚠️ FIRMA SPOZA LISTY ODMAWIA, mimo `<select>` na ekranie: żądanie da się złożyć z ręki,
  // a firma bez definicji nie niesie ani nazwy sprzedawcy, ani kategorii.
  it('⚠️ firma spoza słownika odmawia — wiersz byłby kosztem niczyim', async () => {
    const { app, db } = serwer();
    const r = await app.inject({
      method: 'POST', url: '/koszty/reczne', headers: AUTH_POST,
      payload: 'firma=Wymy%C5%9Blona&dataWystawienia=2026-06-07&kwota=100&miesiac=2026-06',
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Wymyślona');
    expect(db.prepare('SELECT COUNT(*) c FROM koszty').get().c).toBe(0);
  });

  it('⚠️ zła data odmawia — po niej liczy się miesiąc kosztów', async () => {
    const { app, db } = serwer();
    db.prepare('INSERT INTO firmy_reczne (nazwa,sprzedawca,kategoria,typ,dodana_at) VALUES (?,?,?,?,?)')
      .run('Google','Google Ireland Limited','Reklama','zmienny','2026-10-01T00:00:00Z');
    const r = await app.inject({
      method: 'POST', url: '/koszty/reczne', headers: AUTH_POST,
      payload: 'firma=Google&dataWystawienia=7.06.2026&kwota=100&miesiac=2026-06',
    });
    expect(r.statusCode).toBe(400);
    expect(db.prepare('SELECT COUNT(*) c FROM koszty').get().c).toBe(0);
  });

  // Dokument z innego miesiąca ma być WIDOCZNY po zapisaniu — inaczej operator nie ma
  // potwierdzenia, że cokolwiek się stało, i wpisuje go po raz drugi.
  it('po zapisaniu ekran pokazuje MIESIĄC DOKUMENTU, a nie ten, z którego przyszedł formularz', async () => {
    const { app, db } = serwer();
    db.prepare('INSERT INTO firmy_reczne (nazwa,sprzedawca,kategoria,typ,dodana_at) VALUES (?,?,?,?,?)')
      .run('Facebook (Meta)','Meta Platforms Ireland Limited','Reklama','zmienny','2026-10-01T00:00:00Z');
    const r = await app.inject({
      method: 'POST', url: '/koszty/reczne', headers: AUTH_POST,
      payload: 'firma=Facebook+%28Meta%29&dataWystawienia=2026-05-02&kwota=100&miesiac=2026-06',
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Meta Platforms Ireland Limited');
    expect(r.body).toContain('2026-05');
  });
});

// ⚠️⚠️ SŁOWNIK FIRM SPOZA KSeF — bez niego pole wyboru „Firma" byłoby zamknięte na trzech
// pozycjach wgranych startowo, a lista z definicji będzie rosła.
describe('POST /koszty/firmy — dopisanie firmy do listy', () => {
  it('formularz kosztu zaczyna z pustą listą firm i bez pola sprzedawcy', async () => {
    const { app, db } = serwer();
    const r = await app.inject({ method: 'GET', url: '/koszty?miesiac=2026-06', headers: AUTH });
    expect(r.body).not.toContain('value="Facebook (Meta)"');
    expect(r.body).not.toContain('value="Google"');
    expect(r.body).not.toContain('value="Anthropic"');
    expect(db.prepare('SELECT COUNT(*) c FROM firmy_reczne').get().c).toBe(0);
    // ⚠️ Pól po uproszczeniu jest TRZY — nazwa sprzedawcy, NIP, numer dokumentu, VAT, brutto
    // i waluta zniknęły z formularza i mają nie wrócić.
    expect(r.body).not.toContain('name="sprzedawcaNazwa"');
    expect(r.body).not.toContain('name="sprzedawcaNip"');
    expect(r.body).not.toContain('name="numerDokumentu"');
    expect(r.body).not.toContain('name="waluta"');
  });

  // ⚠️ DWA POLA: nazwa i kategoria. Typ kosztu dobiera się z kategorii — ona już go zna, a
  // trzecie pole pozwoliłoby tej samej kategorii mieć tu inny typ niż w rozbiciu miesiąca.
  it('dopisana firma staje na liście z typem wziętym z kategorii', async () => {
    const { app, db } = serwer();
    const r = await app.inject({
      method: 'POST', url: '/koszty/firmy', headers: AUTH_POST,
      payload: 'nazwa=OpenAI&kategoria=Oprogramowanie&miesiac=2026-06',
    });
    expect(r.statusCode).toBe(200);
    expect(db.prepare('SELECT * FROM firmy_reczne WHERE nazwa = ?').get('OpenAI'))
      .toMatchObject({ sprzedawca: 'OpenAI', kategoria: 'Oprogramowanie', typ: 'staly' });
    expect(r.body).toContain('value="OpenAI"');
  });

  it('⚠️ dopisana firma od razu daje się wybrać przy koszcie', async () => {
    const { app, db } = serwer();
    await app.inject({
      method: 'POST', url: '/koszty/firmy', headers: AUTH_POST,
      payload: 'nazwa=OpenAI&kategoria=Oprogramowanie&miesiac=2026-06',
    });
    const r = await app.inject({
      method: 'POST', url: '/koszty/reczne', headers: AUTH_POST,
      payload: 'firma=OpenAI&dataWystawienia=2026-06-07&kwota=120&miesiac=2026-06',
    });
    expect(r.statusCode).toBe(200);
    expect(db.prepare('SELECT * FROM koszty').get())
      .toMatchObject({ sprzedawca_nazwa: 'OpenAI', kategoria_dokumentu: 'Oprogramowanie', typ_dokumentu: 'staly' });
  });

  // ⚠️ KATEGORIA SPOZA LISTY ODMAWIA, bo to ona niesie TYP. Zgadnięty typ wchodziłby do progu
  // rentowności nie do odróżnienia od wybranego świadomie.
  it('⚠️ nieznana kategoria odmawia — bez niej firma nie miałaby typu kosztu', async () => {
    const { app, db } = serwer();
    const r = await app.inject({
      method: 'POST', url: '/koszty/firmy', headers: AUTH_POST,
      payload: 'nazwa=OpenAI&kategoria=Wymy%C5%9Blona&miesiac=2026-06',
    });
    expect(r.statusCode).toBe(400);
    expect(db.prepare('SELECT COUNT(*) c FROM firmy_reczne').get().c).toBe(0);
  });

  it('⚠️ pusta nazwa odmawia, zamiast założyć firmę bez nazwy', async () => {
    const { app, db } = serwer();
    const r = await app.inject({
      method: 'POST', url: '/koszty/firmy', headers: AUTH_POST,
      payload: 'nazwa=+&kategoria=Reklama&miesiac=2026-06',
    });
    expect(r.statusCode).toBe(400);
    expect(db.prepare('SELECT COUNT(*) c FROM firmy_reczne').get().c).toBe(0);
  });
});

describe('edycja i usuniecie kosztu recznego', () => {
  const PODSTAWA = 'firma=Google&dataWystawienia=2026-06-07&kwota=200&miesiac=2026-06';
  const dopisz = async (app) => app.inject({
    method: 'POST', url: '/koszty/reczne', headers: AUTH_POST, payload: PODSTAWA,
  });

  it('ekran poprawki pokazuje wpisane wartości i wybraną firmę', async () => {
    const { app, db } = serwer();
    db.prepare('INSERT INTO firmy_reczne (nazwa,sprzedawca,kategoria,typ,dodana_at) VALUES (?,?,?,?,?)')
      .run('Google','Google Ireland Limited','Reklama','zmienny','2026-10-01T00:00:00Z');
    await dopisz(app);
    const klucz = db.prepare('SELECT ksef_number k FROM koszty').get().k;
    const r = await app.inject({ method: 'GET', url: '/koszty/reczne/' + encodeURIComponent(klucz), headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Google Ireland Limited');
    // Kwota wraca w postaci kanonicznej — to jest pole do POPRAWIENIA, a nie liczba
    // do przeczytania.
    expect(r.body).toContain('value="200.00"');
    // ...a firma stoi wybrana, bo inaczej poprawka kwoty przestawiałaby sprzedawcę.
    expect(r.body).toMatch(/value="Google"\s+selected/);
  });

  it('poprawka zmienia kwotę i NIE zakłada drugiego wiersza', async () => {
    const { app, db } = serwer();
    db.prepare('INSERT INTO firmy_reczne (nazwa,sprzedawca,kategoria,typ,dodana_at) VALUES (?,?,?,?,?)')
      .run('Google','Google Ireland Limited','Reklama','zmienny','2026-10-01T00:00:00Z');
    await dopisz(app);
    const klucz = db.prepare('SELECT ksef_number k FROM koszty').get().k;
    const r = await app.inject({
      method: 'POST',
      url: '/koszty/reczne/' + encodeURIComponent(klucz),
      headers: AUTH_POST,
      payload: 'firma=Google&dataWystawienia=2026-06-07&kwota=100&miesiac=2026-06',
    });
    expect(r.statusCode).toBe(200);
    expect(db.prepare('SELECT COUNT(*) c FROM koszty').get().c).toBe(1);
    expect(db.prepare('SELECT netto FROM koszty').get().netto).toBe('100.00');
  });

  it('usunięcie kasuje wiersz ręczny', async () => {
    const { app, db } = serwer();
    db.prepare('INSERT INTO firmy_reczne (nazwa,sprzedawca,kategoria,typ,dodana_at) VALUES (?,?,?,?,?)')
      .run('Google','Google Ireland Limited','Reklama','zmienny','2026-10-01T00:00:00Z');
    await dopisz(app);
    const klucz = db.prepare('SELECT ksef_number k FROM koszty').get().k;
    const r = await app.inject({
      method: 'POST', url: '/koszty/reczne/' + encodeURIComponent(klucz) + '/usun',
      headers: AUTH_POST, payload: 'miesiac=2026-06',
    });
    expect(r.statusCode).toBe(200);
    expect(db.prepare('SELECT COUNT(*) c FROM koszty').get().c).toBe(0);
  });

  // ⚠️⚠️ DOKUMENTU Z KSeF NIE WOLNO SKASOWAĆ ANI POPRAWIĆ Z PANELU — panel jest lustrem KSeF-u.
  it('⚠️ dokument z KSeF odbija się od obu tras, a wiersz zostaje nietknięty', async () => {
    const { app, db } = serwer();
    db.prepare('INSERT INTO firmy_reczne (nazwa,sprzedawca,kategoria,typ,dodana_at) VALUES (?,?,?,?,?)')
      .run('Google','Google Ireland Limited','Reklama','zmienny','2026-10-01T00:00:00Z');
    zapiszKoszt(db, wiersz());
    const usun = await app.inject({
      method: 'POST', url: '/koszty/reczne/K-1/usun', headers: AUTH_POST, payload: 'miesiac=2026-06',
    });
    expect(usun.statusCode).toBe(400);
    expect(usun.body).toContain('KSeF');
    const popraw = await app.inject({
      method: 'POST',
      url: '/koszty/reczne/K-1',
      headers: AUTH_POST,
      payload: 'firma=Google&dataWystawienia=2026-06-07&kwota=1&miesiac=2026-06',
    });
    expect(popraw.statusCode).toBe(400);
    expect(db.prepare('SELECT netto FROM koszty WHERE ksef_number = ?').get('K-1').netto).toBe('100.00');
  });
});

// ⚠️⚠️ SPRZEDAWCA BEZ POLSKIEGO NIP-U (Google, Meta, Anthropic) nie ma jak trafić do mapy
// kategorii — jej kluczem głównym jest NIP. Kategoria musi więc dać się przypiąć WPROST
// do dokumentu, tym samym formularzem, którym przypina się ją po NIP-ie.
describe('POST /koszty/kategoria — dokument bez NIP-u', () => {
  // Kategoria ze słownika firm jest wartością POCZĄTKOWĄ, a nie kajdanami: jedna faktura
  // Google potrafi dotyczyć czego innego niż wszystkie poprzednie i musi dać się przepiąć.
  it('przypina kategorię do samego dokumentu i wchodzi ona do rozbicia', async () => {
    const { app, db } = serwer();
    db.prepare('INSERT INTO firmy_reczne (nazwa,sprzedawca,kategoria,typ,dodana_at) VALUES (?,?,?,?,?)')
      .run('Facebook (Meta)','Meta Platforms Ireland Limited','Reklama','zmienny','2026-10-01T00:00:00Z');
    await app.inject({
      method: 'POST', url: '/koszty/reczne', headers: AUTH_POST,
      payload: 'firma=Facebook+%28Meta%29&dataWystawienia=2026-06-07&kwota=100&miesiac=2026-06',
    });
    const klucz = db.prepare('SELECT ksef_number k FROM koszty').get().k;

    const r = await app.inject({
      method: 'POST',
      url: '/koszty/kategoria',
      headers: AUTH_POST,
      payload: 'ksefNumber=' + encodeURIComponent(klucz) + '&nip=&kategoria=Sprz%C4%99t&typ=staly&miesiac=2026-06',
    });

    expect(r.statusCode).toBe(200);
    expect(db.prepare('SELECT kategoria_dokumentu k FROM koszty').get().k).toBe('Sprzęt');
    // ...i nie powstał przy tym żaden wiersz w mapie po NIP-ie.
    expect(db.prepare("SELECT COUNT(*) c FROM kategorie_kosztow WHERE kategoria = 'Sprzęt'").get().c).toBe(0);
  });

  it('⚠️ bez NIP-u i bez dokumentu nie ma do czego przypiąć — odmowa, nie cisza', async () => {
    const { app } = serwer();
    const r = await app.inject({
      method: 'POST', url: '/koszty/kategoria', headers: AUTH_POST,
      payload: 'nip=&ksefNumber=&kategoria=Reklama&typ=zmienny&miesiac=2026-06',
    });
    expect(r.statusCode).toBe(400);
  });

  // Sprzedawca Z NIP-em dalej idzie starą drogą: przypięcie obejmuje WSZYSTKIE jego faktury,
  // także te sprzed miesięcy. To jest reguła modułu i ta zmiana jej nie rusza.
  it('sprzedawca z NIP-em dalej trafia do mapy po NIP-ie, a nie na pojedynczy dokument', async () => {
    const { app, db } = serwer();
    zapiszKoszt(db, wiersz({ ksefNumber: 'K-5', sprzedawcaNip: '9999999999' }));
    await app.inject({
      method: 'POST', url: '/koszty/kategoria', headers: AUTH_POST,
      payload: 'ksefNumber=K-5&nip=9999999999&kategoria=Sprz%C4%99t&typ=staly&miesiac=2026-06',
    });
    expect(db.prepare('SELECT kategoria FROM kategorie_kosztow WHERE nip = ?').get('9999999999').kategoria).toBe('Sprzęt');
    expect(db.prepare('SELECT kategoria_dokumentu k FROM koszty WHERE ksef_number = ?').get('K-5').k).toBeNull();
  });
});

// ——— JEDNO WEJSCIE DO PDF DLA BIURA ————————————————————————————————————————————————
//
// Trasy paczek zostaja pod `/faktury/paczka` dla zgodnosci, ale ekran KOSZTOW nie daje do
// nich drugiego wejscia. Kontrakt UX ma jeden przycisk zestawienia na `/faktury`; pozostawienie
// tutaj paczek z dokumentami znowu daloby operatorowi trzy podobne akcje PDF.
describe('GET /koszty — bez starych przyciskow paczek dla biura', () => {
  it('nie pokazuje zadnej paczki nawet przy dostepnej usludze', async () => {
    const { app } = serwer({ paczkaDlaBiura: { zbuduj: async () => ({}) } });
    const r = await app.inject({ method: 'GET', url: '/koszty?miesiac=2026-08', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('/faktury/paczka');
    expect(r.body).not.toContain('Paczka dla biura');
  });

  it('nie pokazuje paczek takze na ekranie po odswiezeniu', async () => {
    const { app } = serwer({ paczkaDlaBiura: { zbuduj: async () => ({}) } });
    const r = await app.inject({
      method: 'POST', url: '/koszty/odswiez', headers: AUTH_POST, payload: 'miesiac=2026-08',
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('/faktury/paczka');
  });
});
