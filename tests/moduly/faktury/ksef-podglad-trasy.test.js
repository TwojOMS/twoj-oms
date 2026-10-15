// tests/oms/ksef-podglad-trasy.test.js
//
// ⚠️⚠️ EKRAN, KTORY STOI PRZED OPERACJA NIEODWRACALNA. Ta trasa NICZEGO NIE WYSYLA —
// pokazuje, co POLECIALOBY, gdyby operator zatwierdzil. Zatwierdzenie to osobna trasa
// (/faktury/ksef/wyslij), ktora liczy zbior JESZCZE RAZ, od nowa.
import { describe, it, expect } from 'vitest';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';

const AUTH = { authorization: `Basic ${Buffer.from('t:h').toString('base64')}`, origin: 'http://localhost' };
// ⚠️ KSZTALT JAK U PRAWDZIWEJ USLUGI: inFakt oddaje kwote W GROSZACH (`gross_price`),
// a `services/faktury-widok.js` doklada do niej gotowy napis w zlotowkach (`kwotaZl`).
// Widok pyta o ZRODLO, zeby brak kwoty nie wydrukowal sie jako „0.00 zl" (recenzja calosci,
// M3), wiec fikstura bez `gross_price` testowalaby co innego niz produkcja.
//
// ⚠️ `client_tax_code` JEST CZESCIA KSZTALTU, a nie ozdoba: od 28.08.2026 dokument bez NIP-u
// nabywcy jest konsumencki i bariera go nie przepuszcza (domain/wysylka-ksef.js). Fikstura
// bez tego pola odbijalaby sie od reguly przy KAZDYM tescie tego pliku.
const dok = (u, n, ksef = null) => ({
  uuid: u, number: n, rodzaj: 'vat', ksef_number: ksef, gross_price: 12300, kwotaZl: '123.00',
  client_company_name: 'Firma X', client_tax_code: '1234563218', invoice_date: '2026-08-06',
});

function serwer(dokumenty) {
  const widok = { dokumenty: async () => dokumenty, nieoplacone: async () => [], proformy: () => [] };
  return buildOmsServer({
    db: openOmsDb(':memory:'), config: { auth: { user: 't', pass: 'h' } },
    fakturyWidok: widok,
    // ⚠️ ATRAPA ODDAJE TO SAMO, CO PRAWDZIWA USLUGA: wynik reguly PLUS liste dokumentow,
    // z ktorej ten wynik policzono (services/wysylka-ksef.js, `przelicz`). Bez `dokumenty`
    // ekran nie ma skad wziac nabywcy ani kwoty — `coWolnoWyslac` oddaje wylacznie
    // `{ uuid, numer }`, bo jest regula, a nie zrodlem danych.
    wysylkaKsef: { podglad: async ({ uuids }) => {
      const { coWolnoWyslac } = await import('../../../src/domena/wysylka-ksef.js');
      return { ...coWolnoWyslac(uuids, dokumenty), dokumenty };
    }, wyslij: async () => ({ wyslane: [], pominiete: [] }) },
  });
}

describe('POST /faktury/ksef/podglad', () => {
  it('pokazuje, co poleci: numery, nabywców, kwoty i liczbę dokumentów', async () => {
    const app = serwer([dok('u1', '1/08/2026'), dok('u2', '2/08/2026')]);
    const r = await app.inject({ method: 'POST', url: '/faktury/ksef/podglad', headers: AUTH,
      payload: { uuid: ['u1', 'u2'], miesiac: '2026-08', pole: 'invoice_date' } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('1/08/2026');
    expect(r.body).toContain('2/08/2026');
    expect(r.body).toContain('Firma X');
    expect(r.body).toContain('123.00');
    expect(r.body).toContain('2');
  });

  // ⚠️⚠️ „0,00 zł" TO ZDANIE O PIENIADZACH, a przy dokumencie bez kwoty prawda brzmi
  // „nie wiadomo" (recenzja calosci, M3). Warunek stal na `d.kwotaZl`, a `zl(0)` daje NAPIS
  // „0.00" — prawdziwy, wiec komorka drukowala zero przy dokumencie, ktory kwoty nie ma.
  it('dokument bez kwoty zostawia pustą komórkę, a nie „0.00 zł"', async () => {
    const bezKwoty = { ...dok('u1', '1/08/2026'), gross_price: null, kwotaZl: '0.00' };
    const app = serwer([bezKwoty]);
    const r = await app.inject({ method: 'POST', url: '/faktury/ksef/podglad', headers: AUTH,
      payload: { uuid: 'u1', miesiac: '2026-08', pole: 'invoice_date' } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('1/08/2026');
    expect(r.body).not.toContain('0.00 zł');
  });

  // ⚠️ NIEODWRACALNOŚĆ MA BYĆ NAPISANA, a nie domyślna. Dokumentu w KSeF nie da się skasować.
  it('mówi wprost, że operacji nie da się cofnąć', async () => {
    const app = serwer([dok('u1', '1/08/2026')]);
    const r = await app.inject({ method: 'POST', url: '/faktury/ksef/podglad', headers: AUTH,
      payload: { uuid: 'u1', miesiac: '2026-08', pole: 'invoice_date' } });
    expect(r.body).toMatch(/nie da się cofnąć|nieodwracaln/i);
  });

  it('wypisuje pominięte RAZEM Z POWODEM, zamiast je wyrzucić po cichu', async () => {
    const app = serwer([dok('u1', '1/08/2026'), dok('u3', '3/08/2026', 'JUZ-W-KSEF')]);
    const r = await app.inject({ method: 'POST', url: '/faktury/ksef/podglad', headers: AUTH,
      payload: { uuid: ['u1', 'u3'], miesiac: '2026-08', pole: 'invoice_date' } });
    expect(r.body).toContain('3/08/2026');
    expect(r.body).toMatch(/jest już w KSeF/i);
  });

  // ⚠️⚠️ LICZBA NA CZERWONYM PRZYCISKU MA BYC PRAWDZIWA (recenzja calosci, Finding 1). Dokument,
  // ktorego wysylke panel juz zlecil, nie ma jeszcze numeru KSeF (~70 sekund), wiec przed
  // poprawka wchodzil do „Poleci do KSeF" i zwiekszal liczbe na przycisku o dokument, ktory
  // i tak odbilby sie od rezerwacji w bazie.
  it('dokument, którego wysyłkę panel już zlecił, jest POMINIĘTY, a nie liczony do wysyłki', async () => {
    const zlecony = { ...dok('u2', '2/08/2026'), ksefZleconaAt: '2026-08-06T14:00:00.000Z' };
    const app = serwer([dok('u1', '1/08/2026'), zlecony]);
    const r = await app.inject({ method: 'POST', url: '/faktury/ksef/podglad', headers: AUTH,
      payload: { uuid: ['u1', 'u2'], miesiac: '2026-08', pole: 'invoice_date' } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Poleci do KSeF — 1');
    expect(r.body).toContain('Pominięte — 1');
    expect(r.body).toMatch(/już zlecił|juz zlecil/i);
    // Przycisk obiecuje DOKLADNIE tyle, ile poleci.
    expect(r.body).toMatch(/Wyślij 1 fakturę do KSeF/);
  });

  it('puste zaznaczenie nie prowadzi do ekranu wysyłki', async () => {
    const app = serwer([dok('u1', '1/08/2026')]);
    const r = await app.inject({ method: 'POST', url: '/faktury/ksef/podglad', headers: AUTH,
      payload: { miesiac: '2026-08', pole: 'invoice_date' } });
    expect(r.body).toMatch(/nie zaznaczono/i);
    expect(r.body).not.toContain('name="potwierdzam"');
  });

  // ⚠️ SAMO POMINIECIE TEZ NIE DAJE PRZYCISKU. Zaznaczenie bylo, ale nic z niego nie
  // przechodzi — przycisk „Wyślij" obiecywalby wtedy operacje, ktora i tak nic by nie
  // zrobila, a to jest ten sam falsz, co „wysłano" bez wysylki (przewodnik 4.13a).
  it('gdy z zaznaczenia nic nie przechodzi, przycisku wysyłki NIE MA', async () => {
    const app = serwer([dok('u3', '3/08/2026', 'JUZ-W-KSEF')]);
    const r = await app.inject({ method: 'POST', url: '/faktury/ksef/podglad', headers: AUTH,
      payload: { uuid: 'u3', miesiac: '2026-08', pole: 'invoice_date' } });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('name="potwierdzam"');
    expect(r.body).toMatch(/jest już w KSeF/i);
  });

  // ⚠️ MIESIAC I POLE MUSZA POJECHAC DALEJ. Trasa zatwierdzenia liczy zbior JESZCZE RAZ,
  // z listy pobranej na nowo — bez tych dwoch pol nie ma jak odtworzyc, na ktora liste
  // operator patrzyl, i zatwierdzenie odpytaloby zupelnie inny miesiac.
  it('formularz zatwierdzenia niesie uuidy, miesiąc i pole daty', async () => {
    const app = serwer([dok('u1', '1/08/2026'), dok('u2', '2/08/2026')]);
    const r = await app.inject({ method: 'POST', url: '/faktury/ksef/podglad', headers: AUTH,
      payload: { uuid: ['u1', 'u2'], miesiac: '2026-08', pole: 'sale_date' } });
    expect(r.body).toContain('action="/faktury/ksef/wyslij"');
    expect(r.body).toContain('name="uuid" value="u1"');
    expect(r.body).toContain('name="uuid" value="u2"');
    expect(r.body).toContain('name="miesiac" value="2026-08"');
    expect(r.body).toContain('name="pole" value="sale_date"');
    expect(r.body).toContain('name="potwierdzam"');
  });

  // ⚠️ TA TRASA NICZEGO NIE WYSYLA. Gdyby kiedys ktos „dla wygody" wpial tu `wyslij`,
  // samo obejrzenie podgladu byloby juz nieodwracalne — a caly ten ekran po to jest,
  // zeby czlowiek zdazyl sie rozmyslic.
  it('podgląd NIE wysyła niczego do inFaktu', async () => {
    let wolane = 0;
    const dokumenty = [dok('u1', '1/08/2026')];
    const app = buildOmsServer({
      db: openOmsDb(':memory:'), config: { auth: { user: 't', pass: 'h' } },
      fakturyWidok: { dokumenty: async () => dokumenty, nieoplacone: async () => [], proformy: () => [] },
      wysylkaKsef: {
        podglad: async ({ uuids }) => {
          const { coWolnoWyslac } = await import('../../../src/domena/wysylka-ksef.js');
          return { ...coWolnoWyslac(uuids, dokumenty), dokumenty };
        },
        wyslij: async () => { wolane += 1; return { wyslane: [], pominiete: [] }; },
      },
    });
    const r = await app.inject({ method: 'POST', url: '/faktury/ksef/podglad', headers: AUTH,
      payload: { uuid: 'u1', miesiac: '2026-08', pole: 'invoice_date' } });
    expect(r.statusCode).toBe(200);
    expect(wolane).toBe(0);
  });

  it('POST bez nagłówka Origin odbija się od ochrony CSRF', async () => {
    const app = serwer([dok('u1', '1/08/2026')]);
    const r = await app.inject({ method: 'POST', url: '/faktury/ksef/podglad',
      headers: { authorization: AUTH.authorization }, payload: { uuid: 'u1' } });
    expect(r.statusCode).toBe(403);
  });

  // Panel bez sekcji INFAKT_* nie ma czego wysylac — ma to POWIEDZIEC, a nie oddac 500
  // ani udawac pustego zaznaczenia (ta sama zasada, co przy GET /faktury).
  it('panel bez usługi wysyłki odmawia czytelnie', async () => {
    const app = buildOmsServer({
      db: openOmsDb(':memory:'), config: { auth: { user: 't', pass: 'h' } },
    });
    const r = await app.inject({ method: 'POST', url: '/faktury/ksef/podglad', headers: AUTH,
      payload: { uuid: 'u1', miesiac: '2026-08', pole: 'invoice_date' } });
    expect(r.statusCode).toBe(503);
    expect(r.body).toMatch(/inFakt/i);
  });
});
