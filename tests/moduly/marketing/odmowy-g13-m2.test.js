import { afterEach, describe, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { odczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';

// PRZ-152.G13 paczka M2: odmowy marketingu (reklamy w Ustawieniach, kampania) w układzie OMS.
const CONFIG = { auth: { user: 'serwis', pass: 'haslo-env' }, klienciZbiorczy: [] };
const BASIC = { authorization: `Basic ${Buffer.from('serwis:haslo-env').toString('base64')}`, origin: 'http://localhost' };
const FORM = { ...BASIC, 'content-type': 'application/x-www-form-urlencoded' };
const REKL = '/ustawienia/integracje/reklamy';
let db, app;
afterEach(async () => { await app?.close(); db?.close(); app = db = null; });
const start = (nad = {}) => { db = openOmsDb(':memory:'); app = buildOmsServer({ db, config: CONFIG, ...nad }); return app; };

const sprawdz = (r, status, tekst, href, napis) => {
  expect(r.statusCode).toBe(status);
  expect(r.headers['content-type']).toMatch(/^text\/html/);
  expect(r.body).toMatch(/<html/);
  expect(r.body).toContain(`<p class="pasek-uwaga" role="alert">${tekst}</p>`);
  expect(r.body).toContain(`<a class="btn" href="${href}">${napis}</a>`);
};
const wyslij = (method, url, payload = '', headers = FORM) => app.inject({ method, url, headers, payload });

describe('reklamy w Ustawieniach', () => {
  const SEKRET = 'tajny-klucz-reklam-12345';
  const PELNE = `typ=meta&kontoId=act_1&kanal=sklep_a&tresc=${SEKRET}`;
  const wRekl = (r, status, tekst) => {
    sprawdz(r, status, tekst, REKL, 'Wróć do połączeń reklam');
    expect(r.body).not.toContain(SEKRET);
  };
  it('zapis bez admina (403)', async () => {
    start();
    const id = zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'h', rola: 'sprzedaz', admin: false });
    ustawUprawnienia(db, id, ['ustawienia']);
    const jakoAga = { ...FORM, cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('ewa', odczytajSekret(db))}` };
    wRekl(await wyslij('POST', `${REKL}/zapisz`, PELNE, jakoAga), 403, 'Tylko administrator może zmieniać połączenia reklam.');
    wRekl(await wyslij('POST', `${REKL}/test`, 'polaczenieId=1', jakoAga), 403, 'Tylko administrator może testować połączenia reklam.');
  });
  it('zapis bez HTTPS (403)', async () => {
    start();
    wRekl(await wyslij('POST', `${REKL}/zapisz`, PELNE), 403, 'Poświadczenie można przesłać wyłącznie przez HTTPS.');
  });
  it('zapis bez magazynu sekretów (503)', async () => {
    start({ reklamy: { zaufaneHttps: () => true } });
    wRekl(await wyslij('POST', `${REKL}/zapisz`, PELNE), 503, 'Magazyn sekretów reklam nie jest skonfigurowany.');
  });
  it('zapis z brakami w formularzu (400)', async () => {
    start({ reklamy: { magazyn: { zapisz: async () => 'meta:x' }, zaufaneHttps: () => true } });
    wRekl(await wyslij('POST', `${REKL}/zapisz`, `typ=meta&kontoId=act_1&kanal=&tresc=${SEKRET}`), 400, 'Uzupełnij źródło, konto, kanał i poświadczenie.');
  });
  it('zapis, gdy magazyn zawodzi (400)', async () => {
    start({ reklamy: { magazyn: { zapisz: async () => { throw new Error(`awaria ${SEKRET}`); } }, zaufaneHttps: () => true } });
    wRekl(await wyslij('POST', `${REKL}/zapisz`, PELNE), 400, 'Nie udało się zapisać połączenia reklam.');
  });
  it('test nieistniejącego połączenia (404)', async () => {
    start();
    wRekl(await wyslij('POST', `${REKL}/test`, 'polaczenieId=999'), 404, 'Nie znaleziono połączenia reklam.');
  });
});

describe('kampania', () => {
  it('odświeżenie reklam bez czuwacza (503)', async () => {
    start({ czuwaczReklam: null });
    sprawdz(await wyslij('POST', '/kampania/odswiez-reklamy'), 503, 'Odczyt reklam nie jest dostępny.', '/kampania', 'Wróć do reklam');
  });
  it('odświeżenie bez Mety i GA4 (503)', async () => {
    start({ czuwaczKampanii: null });
    sprawdz(await wyslij('POST', '/kampania/odswiez'), 503, 'Panel nie ma podpiętej ani Mety, ani GA4 — nie ma czego odświeżać.', '/kampania', 'Wróć do reklam');
  });
});
