import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { zalozKonto, kontoPoLoginie, listaKont } from '../../../src/core/bezpieczenstwo/konta.js';
import { pozostanieCzynnyAdmin } from '../../../src/moduly/ustawienia/trasy/konta.js';
import { nowyPanel, jako, get, post, BASIC } from '../../pomoc/konta-prz068.js';

// ⛔ Żadnego prawdziwego SMTP: mailer to wyłącznie atrapa podana nadpisaniem usługi `wiadomosci.mailer`.
const ADRES = 'https://panel.example.test';
const tokenZ = (t) => /\/haslo\/([A-Za-z0-9_-]{43})/.exec(t)?.[1];
const atrapa = () => ({ sendMail: vi.fn(async () => ({ messageId: 'atrapa' })) });
function panel({ env = {}, mailer = null } = {}) {
  const p = nowyPanel({ env, ...(mailer ? { nadpisania: { 'wiadomosci.mailer': mailer } } : {}) });
  const idAdam = zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  return { ...p, idAdam, admin: jako(p.db, 'adam') };
}
const NOWA = { imie: 'Nowa Osoba', login: 'nowa', email: 'nowa@example.test', rola: 'produkcja' };

describe('PRZ-069 zaproszenia i reset hasła', () => {
  it('„Pokaż link”: konto bez hasła, link widoczny raz, w bazie tylko skrót, nagłówki no-store/strict-origin', async () => {
    const { db, app, admin } = panel();
    const r = await post(app, '/ustawienia/konta/nowe', admin, { ...NOWA, sposob: 'pokaz' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['referrer-policy']).toBe('strict-origin');
    expect(r.body).toMatch(/http:\/\/localhost(:80)?\/haslo\/[A-Za-z0-9_-]{43}/);
    const token = tokenZ(r.body);
    const konto = kontoPoLoginie(db, 'nowa');
    expect(konto).toMatchObject({ czynne: true, admin: false });
    expect(konto.uprawnienia).toEqual(new Set(['zamowienia', 'przesylki', 'faktury-zamowienia', 'zwroty-zamowienia']));
    expect(listaKont(db).find((k) => k.login === 'nowa').zaproszone).toBe(true);
    const link = db.prepare('SELECT * FROM linki_hasla').get();
    expect(link).toMatchObject({ cel: 'zaproszenie', hash_tokenu: createHash('sha256').update(token).digest('hex') });
    const login = await app.inject({ method: 'POST', url: '/login', headers: { origin: 'http://localhost', accept: 'text/html' }, payload: { uzytkownik: 'nowa', haslo: '' } });
    expect(login.statusCode).toBe(401);
  });

  // PRZ-094.10 (decyzja właściciela 18.10): bez OMS_ADRES_PANELU i zapisu mail nie jest już blokowany — link prowadzi pod
  // adres, z którego korzysta admin. Odmowa zostaje tylko przy adresie żądania, który nie przechodzi walidacji
  // (adres-panelu-domyslny-prz094-10.test.js, „(e)”).
  it('mail bez OMS_ADRES_PANELU i zapisu: link pod adresem żądania admina, komunikat mówi, dokąd prowadzi', async () => {
    const mailer = atrapa();
    const { db, app, admin } = panel({ mailer });
    const r = await post(app, '/ustawienia/konta/nowe', admin, { ...NOWA, sposob: 'mail' });
    expect(r.statusCode, r.body).toBe(302);
    const id = kontoPoLoginie(db, 'nowa').id;
    expect(r.headers.location).toBe(`/ustawienia/konta/${id}?zapisano=wyslano-domyslny`);
    expect(mailer.sendMail.mock.calls[0][0].text).toMatch(/http:\/\/localhost\/haslo\/[A-Za-z0-9_-]{43}/);
  });

  it('mail: adres z OMS_ADRES_PANELU, nigdy z nagłówka Host; treść, temat, ważność', async () => {
    const mailer = atrapa();
    const { db, app } = panel({ env: { OMS_ADRES_PANELU: ADRES }, mailer });
    const naglowki = { ...jako(db, 'adam'), host: 'zly.example', origin: 'http://zly.example' };
    const r = await app.inject({ method: 'POST', url: '/ustawienia/konta/nowe', headers: { accept: 'text/html', ...naglowki }, payload: { ...NOWA, sposob: 'mail' } });
    expect(r.statusCode).toBe(302);
    const id = kontoPoLoginie(db, 'nowa').id;
    expect(r.headers.location).toBe(`/ustawienia/konta/${id}?zapisano=wyslano`);
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    const m = mailer.sendMail.mock.calls[0][0];
    expect(m).toMatchObject({ to: 'nowa@example.test', subject: 'Zaproszenie do panelu' });
    expect(m.text).toContain(`${ADRES}/haslo/`);
    expect(m.text).toContain('48 h');
    expect(m.text).toMatch(/jeśli to nie Ty/i);
    expect(m.text + m.html).not.toContain('zly.example');
    expect(m.html).toContain(`${ADRES}/haslo/`);
  });

  it('mail bez skonfigurowanego SMTP (mailer null) odmawia i proponuje „Pokaż link”', async () => {
    const { db, app, admin } = panel({ env: { OMS_ADRES_PANELU: ADRES } });
    const r = await post(app, '/ustawienia/konta/nowe', admin, { ...NOWA, sposob: 'mail' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Pokaż link');
    expect(kontoPoLoginie(db, 'nowa')).toBeNull();
  });

  it('błąd SMTP: konto zostaje, komunikat i propozycja „Pokaż link”', async () => {
    const mailer = { sendMail: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) };
    const { db, app, admin } = panel({ env: { OMS_ADRES_PANELU: ADRES }, mailer });
    const r = await post(app, '/ustawienia/konta/nowe', admin, { ...NOWA, sposob: 'mail' });
    expect(r.statusCode).toBe(502);
    expect(r.body).toContain('Nie udało się wysłać maila');
    expect(r.body).toContain('Pokaż link');
    expect(kontoPoLoginie(db, 'nowa')).not.toBeNull();
  });

  it('reset istniejącego konta: cel reset, wcześniejszy nieużyty link unieważniony; wyłączenie unieważnia linki', async () => {
    const { db, app, admin } = panel();
    const id = zalozKonto(db, { login: 'ewa', imie: 'Ewa', haslo: 'stare-haslo-123', rola: 'sprzedaz' });
    await post(app, `/ustawienia/konta/${id}/link`, admin, { sposob: 'pokaz' });
    const r = await post(app, `/ustawienia/konta/${id}/link`, admin, { sposob: 'pokaz' });
    expect(r.statusCode).toBe(200);
    const linki = db.prepare('SELECT cel, uniewaznione_at FROM linki_hasla WHERE konto_id = ? ORDER BY id').all(id);
    expect(linki.map((l) => l.cel)).toEqual(['reset', 'reset']);
    expect(linki[0].uniewaznione_at).not.toBeNull();
    expect(linki[1].uniewaznione_at).toBeNull();
    await post(app, `/ustawienia/konta/${id}/czynne`, admin, { czynne: '0' });
    expect(db.prepare('SELECT count(*) AS n FROM linki_hasla WHERE konto_id = ? AND uniewaznione_at IS NULL').get(id).n).toBe(0);
  });

  it('strona konta dla admina, e-mail z walidacją i unikalnością; 404 i 403', async () => {
    const { db, app, admin } = panel();
    const a = zalozKonto(db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
    const b = zalozKonto(db, { login: 'ola', imie: 'Ola', haslo: 'h', rola: 'sprzedaz' });
    const strona = await get(app, `/ustawienia/konta/${a}`, admin);
    expect(strona.statusCode).toBe(200);
    expect(strona.body).toContain('ewa');
    expect(strona.body).toContain(`action="/ustawienia/konta/${a}/email"`);
    expect(strona.body).toContain(`action="/ustawienia/konta/${a}/link"`);
    expect((await post(app, `/ustawienia/konta/${a}/email`, admin, { email: ' Ewa@Example.TEST ' })).statusCode).toBe(302);
    const dup = await post(app, `/ustawienia/konta/${b}/email`, admin, { email: 'ewa@example.test' });
    expect(dup.statusCode).toBe(400);
    expect(dup.body).toContain('pas-uprzedzenie');
    expect((await post(app, `/ustawienia/konta/${b}/email`, admin, { email: 'bez-malpy' })).statusCode).toBe(400);
    expect((await get(app, '/ustawienia/konta/9999', admin)).statusCode).toBe(404);
    expect((await get(app, `/ustawienia/konta/${a}`, jako(db, 'ewa'))).statusCode).toBe(403);
    expect((await post(app, `/ustawienia/konta/${a}/link`, jako(db, 'ewa'), { sposob: 'pokaz' })).statusCode).toBe(403);
  });

  it('ekran kont nie ma już żadnego pola hasła; stara trasa /nowe z hasłem dalej działa (O6)', async () => {
    const { db, app, admin } = panel();
    const lista = await get(app, '/ustawienia/konta', admin);
    expect(lista.body).not.toMatch(/name="haslo"/);
    expect(lista.body).toContain('Nowe konto');
    expect(lista.body).toContain('name="sposob"');
    expect((await post(app, '/ustawienia/konta/nowe', admin, { login: 'pako', imie: 'Pako', haslo: 'haslo-ok', rola: 'produkcja' })).statusCode).toBe(302);
    expect(listaKont(db).find((k) => k.login === 'pako').zaproszone).toBe(false);
  });

  it('zaproszony administrator nie zamyka bramy degradacji, dopóki nie ustawi hasła (Review Focus 1)', async () => {
    const { db, app } = nowyPanel();
    const r = await post(app, '/ustawienia/konta/nowe', BASIC, { imie: 'Szef', login: 'szef', email: '', rola: 'administrator', sposob: 'pokaz' });
    expect(r.statusCode).toBe(200);
    expect((await get(app, '/ustawienia/konta', BASIC)).statusCode).toBe(200);
    const token = tokenZ(r.body);
    const ustaw = await post(app, `/haslo/${token}`, {}, { nowe: 'haslo-szefa-123', nowe2: 'haslo-szefa-123' });
    expect(ustaw.statusCode).toBe(302);
    expect((await get(app, '/ustawienia/konta', BASIC)).statusCode).toBe(403);
    expect(kontoPoLoginie(db, 'szef').admin).toBe(true);
  });

  it('bezpiecznik „ostatni administrator” nie liczy zaproszonego admina', async () => {
    const { db, app, idAdam, admin } = panel();
    await post(app, '/ustawienia/konta/nowe', admin, { imie: 'Szef', login: 'szef', email: '', rola: 'administrator', sposob: 'pokaz' });
    // Funkcja czysta względem req (jak w web-konta.test.js D3) — bez bezpiecznika „nie wyłączysz siebie”, który zasłoniłby wynik.
    expect(pozostanieCzynnyAdmin(db, idAdam, { czynne: false, admin: true })).toBe(false);
    expect(pozostanieCzynnyAdmin(db, idAdam, { czynne: true, admin: false })).toBe(false);
  });
});
