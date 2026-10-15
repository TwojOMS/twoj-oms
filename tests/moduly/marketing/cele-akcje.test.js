import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zalozCel, celPoId, sumaZdarzen, zdarzeniaCelu } from '../../../src/oms/db/cele.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';

const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64') };
const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });
afterEach(() => { vi.useRealTimers(); });

// ⚠️ `origin` JEST OBOWIAZKOWY NA KAZDYM POST-cie. Panel odrzuca zapisy bez zgodnego
// Origin (ochrona CSRF) — bez tego naglowka kazda z tych asercji dostaje 403 i wyglada to
// jak zepsuta trasa, a nie jak dzialajaca ochrona. Ten sam uklad, co w web-konta.test.js.
const ORIGIN = { origin: 'http://localhost' };

const wyslij = async (url, payload) => {
  const app = buildOmsServer({ db, config });
  const odp = await app.inject({
    method: 'POST', url, payload, headers: { ...naglowek, ...ORIGIN },
  });
  await app.close();
  return odp;
};
const pobierz = async (url) => {
  const app = buildOmsServer({ db, config });
  const odp = await app.inject({ method: 'GET', url, headers: naglowek });
  await app.close();
  return odp;
};

const OTWARTY = { od: null, do: null };
const nowy = (n = {}) => zalozCel(db, {
  nazwa: 'Nowe wzory', kontoId: null, rytm: 'tydzien', celIle: 5,
  miernik: 'reczny', odDnia: null, doDnia: null, ...n,
});

describe('POST /cele — zakladanie', () => {
  it('zaklada licznik', async () => {
    const odp = await wyslij('/cele', {
      nazwa: 'Posty FB', rytm: 'miesiac', cel_ile: '12', miernik: 'reczny', konto_id: '',
    });
    expect(odp.statusCode).toBe(302);
    const c = db.prepare('SELECT * FROM cele').get();
    expect(c.nazwa).toBe('Posty FB');
    expect(c.cel_ile).toBe(12);
    expect(c.konto_id).toBe(null);
  });

  it('puste cel_ile zaklada ZADANIE tak/nie, nie licznik z zerem', async () => {
    await wyslij('/cele', {
      nazwa: 'Kampania Google', rytm: 'jednorazowy', cel_ile: '', miernik: 'reczny',
      konto_id: '', do_dnia: '2026-09-30',
    });
    const c = db.prepare('SELECT * FROM cele').get();
    expect(c.cel_ile).toBe(null);
    expect(c.do_dnia).toBe('2026-09-30');
  });

  it('odrzuca nieznany rytm zamiast zapisywac smiec', async () => {
    const odp = await wyslij('/cele', {
      nazwa: 'X', rytm: 'kwartal', cel_ile: '3', miernik: 'reczny', konto_id: '',
    });
    expect(odp.statusCode).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cele').get().n).toBe(0);
  });

  it('odrzuca nieznany miernik — inaczej cel od PIERWSZEJ sekundy bylby „nieznany"', async () => {
    const odp = await wyslij('/cele', {
      nazwa: 'X', rytm: 'tydzien', cel_ile: '3', miernik: 'wzory-sklep', konto_id: '',
    });
    expect(odp.statusCode).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cele').get().n).toBe(0);
  });

  it('odrzuca pusta nazwe', async () => {
    const odp = await wyslij('/cele', {
      nazwa: '   ', rytm: 'tydzien', cel_ile: '3', miernik: 'reczny', konto_id: '',
    });
    expect(odp.statusCode).toBe(400);
  });

  it('odrzuca cel_ile = 0 i ulamkowe JUZ W TRASIE, nie dopiero w CHECK bazy', async () => {
    // Baza i tak by je odrzucila, ale wtedy czlowiek dostalby 500 zamiast komunikatu.
    expect((await wyslij('/cele', {
      nazwa: 'X', rytm: 'tydzien', cel_ile: '0', miernik: 'reczny', konto_id: '',
    })).statusCode).toBe(400);
    expect((await wyslij('/cele', {
      nazwa: 'X', rytm: 'tydzien', cel_ile: '2.5', miernik: 'reczny', konto_id: '',
    })).statusCode).toBe(400);
  });
});

describe('POST /cele/:id/zdarzenie', () => {
  it('+1 dopisuje jedno zdarzenie z dniem warszawskim', async () => {
    const id = nowy();
    await wyslij(`/cele/${id}/zdarzenie`, { ile: '1' });
    const [z] = zdarzeniaCelu(db, id);
    expect(z.ile).toBe(1);
    expect(z.dzien).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('wpis liczby dopisuje JEDNO zdarzenie o tej wartosci', async () => {
    const id = nowy();
    await wyslij(`/cele/${id}/zdarzenie`, { ile: '4', notatka: 'seria FLORA' });
    expect(sumaZdarzen(db, id, OTWARTY).ile).toBe(4);
    expect(zdarzeniaCelu(db, id)).toHaveLength(1);
    expect(zdarzeniaCelu(db, id)[0].notatka).toBe('seria FLORA');
  });

  it('odrzuca ile <= 0 — zdarzenie „zero" niczego nie odnotowuje', async () => {
    const id = nowy();
    expect((await wyslij(`/cele/${id}/zdarzenie`, { ile: '0' })).statusCode).toBe(400);
    // Ujemne cicho odejmowaloby postep bez sladu w historii — wygladaloby jak zwykly wpis.
    expect((await wyslij(`/cele/${id}/zdarzenie`, { ile: '-3' })).statusCode).toBe(400);
    expect(zdarzeniaCelu(db, id)).toHaveLength(0);
  });

  it('odrzuca ile nieliczbowe', async () => {
    const id = nowy();
    expect((await wyslij(`/cele/${id}/zdarzenie`, { ile: 'duzo' })).statusCode).toBe(400);
  });

  it('404 na nieistniejacym celu', async () => {
    expect((await wyslij('/cele/999/zdarzenie', { ile: '1' })).statusCode).toBe(404);
  });

  it('KONTO IMIENNE trafia do historii — bez tego historia nie mowi nic', async () => {
    // ⚠️⚠️ TO JEST ASERCJA Z ZEBAMI, w odroznieniu od tej ponizej. Kazdy moze klikac „+1"
    // na cudzym celu (decyzja właściciela 13.09), wiec `konto_id` jest JEDYNYM sladem, kto
    // faktycznie to zrobil. `kontoId: null` wpisane na sztywno zapalá sie WLASNIE tutaj.
    const ewa = zalozKonto(db, {
      login: 'ewa', imie: 'Ewa', haslo: 'tajne', rola: 'sprzedaz',
    });
    const id = nowy();
    const app = buildOmsServer({ db, config });
    await app.inject({
      method: 'POST',
      url: `/cele/${id}/zdarzenie`,
      payload: { ile: '1' },
      headers: {
        ...ORIGIN,
        cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('ewa', wczytajSekret(db))}`,
      },
    });
    await app.close();
    expect(zdarzeniaCelu(db, id)[0].konto_id).toBe(ewa);
    expect(zdarzeniaCelu(db, id)[0].imie_konta).toBe('Ewa');
  });

  it('KONTO SERWISOWE nie jest zapisywane jako osoba', async () => {
    // Ten przebieg loguje sie haslem z `.env` (patrz `naglowek` wyzej), czyli kontem
    // SERWISOWYM: bootstrap, integracje panelu indywidualnego i skrypty — NIE czlowiek.
    //
    // ⚠️ UCZCIWA UWAGA O SILE TEGO TESTU (zmierzona mutacja, 13.09): dzis strażnik nie
    // nadaje kontu serwisowemu pola `id` w ogole (straznik.js:202), wiec `req.konto?.id`
    // i tak dalby `null` — mutacja zdejmujaca warunek `!req.konto.serwisowe` NIE zapala
    // tego testu. Warunek w trasie zostaje mimo to, bo jest JAWNY: gdy ktos kiedys doda
    // kontu serwisowemu `id` (a jest po co — dziennik logowan), bez niego zaczeloby ono
    // stawac w kolumnie „Kto" obok właściciela i Agi, po cichu. Asercja z zebami stoi WYZEJ.
    const id = nowy();
    await wyslij(`/cele/${id}/zdarzenie`, { ile: '1' });
    expect(zdarzeniaCelu(db, id)[0].konto_id).toBe(null);
  });

  it('klik o 01:30 CET nalezy do dnia WARSZAWSKIEGO, nie do UTC', async () => {
    // 2026-10-13T23:30:00Z = 01:30 dnia 14.10 w Warszawie (CET). `toISOString().slice(0,10)`
    // dalby 2026-10-13 — czyli wpis wpadlby do POPRZEDNIEGO tygodnia, a przy pierwszym
    // dniu miesiaca do poprzedniego miesiaca.
    // ⚠️ `toFake: ['Date']` — sam zegar, NIE setTimeout. Pelne `useFakeTimers()` zamraza
    // takze timery, na ktorych stoi Fastify, i `app.inject` nigdy nie wraca: test nie tyle
    // pada, co wisi do timeoutu, co wyglada jak zawieszony panel, a nie jak zly test.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T23:30:00Z'));
    const id = nowy();
    await wyslij(`/cele/${id}/zdarzenie`, { ile: '1' });
    expect(zdarzeniaCelu(db, id)[0].dzien).toBe('2026-10-14');
  });
});

describe('POST /cele/:id/cofnij', () => {
  it('zdejmuje ostatnie zdarzenie biezacego okresu', async () => {
    const id = nowy();
    await wyslij(`/cele/${id}/zdarzenie`, { ile: '1' });
    await wyslij(`/cele/${id}/zdarzenie`, { ile: '1' });
    await wyslij(`/cele/${id}/cofnij`, {});
    expect(sumaZdarzen(db, id, OTWARTY).ile).toBe(1);
  });

  it('cofniecie bez zdarzen nie wywala sie — przycisk bywa klikniety dwa razy', async () => {
    expect((await wyslij(`/cele/${nowy()}/cofnij`, {})).statusCode).toBe(302);
  });

  it('404 na nieistniejacym celu', async () => {
    expect((await wyslij('/cele/999/cofnij', {})).statusCode).toBe(404);
  });
});

describe('POST /cele/:id/czynny — wygaszanie zamiast kasowania', () => {
  it('wygasza cel, ale ZOSTAWIA zdarzenia', async () => {
    const id = nowy();
    await wyslij(`/cele/${id}/zdarzenie`, { ile: '2' });
    await wyslij(`/cele/${id}/czynny`, { czynny: '0' });
    expect(celPoId(db, id).czynny).toBe(0);
    // ⚠️ Historia ma PRZEZYC wygaszenie — to jedyny powod, dla ktorego wybralismy tabele
    // zdarzen zamiast kolumny z liczba.
    expect(zdarzeniaCelu(db, id)).toHaveLength(1);
  });

  it('przywraca wygaszony', async () => {
    const id = nowy();
    await wyslij(`/cele/${id}/czynny`, { czynny: '0' });
    await wyslij(`/cele/${id}/czynny`, { czynny: '1' });
    expect(celPoId(db, id).czynny).toBe(1);
  });
});

describe('POST /cele/:id — edycja', () => {
  it('zapisuje zmiany', async () => {
    const id = nowy();
    const odp = await wyslij(`/cele/${id}`, {
      nazwa: 'Posty FB', rytm: 'miesiac', cel_ile: '12', miernik: 'reczny', konto_id: '',
    });
    expect(odp.statusCode).toBe(302);
    expect(celPoId(db, id).nazwa).toBe('Posty FB');
    expect(celPoId(db, id).rytm).toBe('miesiac');
  });

  it('odrzuca smiec TAK SAMO jak zakladanie — jedna walidacja, nie dwie', async () => {
    const id = nowy();
    expect((await wyslij(`/cele/${id}`, {
      nazwa: 'X', rytm: 'kwartal', cel_ile: '3', miernik: 'reczny', konto_id: '',
    })).statusCode).toBe(400);
    expect(celPoId(db, id).nazwa).toBe('Nowe wzory');
  });
});

describe('GET /cele/nowy i GET /cele/:id', () => {
  it('formularz nowego celu sie renderuje', async () => {
    const odp = await pobierz('/cele/nowy');
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toContain('Nowy cel');
    // Miernik z rejestru, nie wpisany w widok recznie.
    expect(odp.body).toContain('Ręcznie');
  });

  it('karta celu pokazuje historie zdarzen', async () => {
    const id = nowy();
    await wyslij(`/cele/${id}/zdarzenie`, { ile: '2', notatka: 'seria FLORA' });
    const odp = await pobierz(`/cele/${id}`);
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toContain('seria FLORA');
  });

  it('404 na nieistniejacym', async () => {
    expect((await pobierz('/cele/999')).statusCode).toBe(404);
  });

  it('„nowy" NIE jest brany za identyfikator celu', async () => {
    // Fastify dopasowuje trasy statyczne przed parametrycznymi, ale kolejnosc rejestracji
    // bywa pulapka — a `/cele/nowy` zlapane przez `/cele/:id` dawaloby 404 na formularzu.
    expect((await pobierz('/cele/nowy')).statusCode).toBe(200);
  });
});
