import { afterEach, describe, expect, it } from 'vitest';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { zmienSzablonyWiadomosci, wczytajSzablonyWiadomosci } from '../../../src/oms/db/szablony-wiadomosci.js';
import { zapiszSzablon } from '../../../src/domena/szablony-wiadomosci.js';
import { utworzRegule, wlaczRegule, usunRegule, regulyUzywajaceSzablonu } from '../../../src/moduly/automatyzacje/db/reguly.js';
import { migracjaRegul } from '../../../src/moduly/automatyzacje/migracje/0001-reguly.ts';
import { MODULY } from '../../../src/moduly/lista.ts';

const ADRES = '/ustawienia/szablony-wiadomosci';
const ID = 'wlasny-1';
const otwarte = [];
afterEach(async () => {
  for (const p of otwarte.splice(0)) { await p.app.close(); p.db.close(); }
});

async function panel({ bezAutomatyzacji = false } = {}) {
  const p = nowyPanel(bezAutomatyzacji ? { moduly: MODULY.filter(m => m.nazwa !== 'automatyzacje') } : {});
  otwarte.push(p);
  await p.app.ready();
  zalozKonto(p.db, { login: 'admin', imie: 'Admin', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'operator', imie: 'Operator', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'operator').id, ['ustawienia']);
  zmienSzablonyWiadomosci(p.db, s => zapiszSzablon(s, 'nowy', {
    nazwa: 'Informacja o lampie', temat: 'Lampa', tresc: 'Dzień dobry {imie}.',
  }, '2026-10-23T10:00:00Z'));
  return { ...p, admin: jako(p.db, 'admin'), operator: jako(p.db, 'operator') };
}

function regula(db, nazwa, { wlaczona = false, usunieta = false, szablon = ID } = {}) {
  const id = utworzRegule(db, { nazwa, zdarzenie: 'paczka_nadana', akcja: 'mail_kupujacy',
    akcja_json: { szablon }, warunki: { kanaly: ['reczne'] }, opoznienie_min: 0, limit_na_godzine: 20 });
  if (wlaczona) wlaczRegule(db, id);
  if (usunieta) usunRegule(db, id);
  return id;
}
const istnieje = db => wczytajSzablonyWiadomosci(db).wlasne.some(s => s.id === ID);

describe('usunięcie szablonu używanego przez automatyzacje', () => {
  it('pokazuje włączoną i wyłączoną regułę z odnośnikami oraz wymagane potwierdzenie', async () => {
    const p = await panel();
    const a = regula(p.db, 'Lampy wysłane', { wlaczona: true });
    const b = regula(p.db, 'Lampy w kolejce');
    regula(p.db, 'Usunięta reguła', { usunieta: true });
    regula(p.db, 'Inny szablon', { szablon: 'wlasny-2' });
    const r = await get(p.app, `${ADRES}/${ID}`, p.admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Ten szablon wysyłają reguły automatyzacji:');
    expect(r.body).toContain(`href="/ustawienia/automatyzacje/${a}">Lampy wysłane</a> (włączona)`);
    expect(r.body).toContain(`href="/ustawienia/automatyzacje/${b}">Lampy w kolejce</a> (wyłączona)`);
    expect(r.body).toContain('Po usunięciu ich maile przestaną wychodzić — najpierw zmień szablon w regule albo ją wyłącz.');
    expect(r.body).toMatch(/<input[^>]*type="checkbox"[^>]*name="potwierdzUsuniecie"[^>]*value="1"[^>]*required/u);
    expect(r.body).toContain('Rozumiem, reguły przestaną wysyłać ten mail');
    expect(r.body).not.toContain('Usunięta reguła');
    expect(r.body).not.toContain('Inny szablon');
    expect(r.body.indexOf('Ten szablon wysyłają')).toBeLessThan(r.body.indexOf('>Usuń szablon<'));
  });

  it('POST bez potwierdzenia → 400 z edytorem i szablon NIE usunięty, także gdy regułę dodano po otwarciu ekranu', async () => {
    const p = await panel();
    await get(p.app, `${ADRES}/${ID}`, p.admin);
    regula(p.db, 'Lampy wysłane', { wlaczona: true });
    const r = await post(p.app, `${ADRES}/${ID}/usun`, p.admin);
    expect(r.statusCode).toBe(400);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('Potwierdź, że reguły przestaną wysyłać ten mail.');
    expect(r.body).toContain('id="szw-formularz"');
    expect(r.body).toContain('Lampy wysłane');
    expect(r.body).toContain('name="potwierdzUsuniecie"');
    expect(istnieje(p.db)).toBe(true);
  });

  it('inna wartość potwierdzenia nie pozwala usunąć, także przy samej wyłączonej regule', async () => {
    const p = await panel();
    regula(p.db, 'Lampy w kolejce');
    const r = await post(p.app, `${ADRES}/${ID}/usun`, p.admin, { potwierdzUsuniecie: '0' });
    expect(r.statusCode).toBe(400);
    expect(istnieje(p.db)).toBe(true);
  });

  it('POST z potwierdzeniem usuwa; przekierowana lista zachowuje dotychczasowy komunikat i podaje obie nazwy', async () => {
    const p = await panel();
    const a = regula(p.db, 'Lampy wysłane', { wlaczona: true });
    regula(p.db, 'Lampy w kolejce');
    regula(p.db, 'Usunięta reguła', { usunieta: true });
    const r = await post(p.app, `${ADRES}/${ID}/usun`, p.admin, { potwierdzUsuniecie: '1' });
    expect(r.statusCode).toBe(303);
    expect(istnieje(p.db)).toBe(false);
    const lista = await get(p.app, r.headers.location, p.admin);
    expect(lista.statusCode).toBe(200);
    expect(lista.body).toContain('Szablon usunięty. Wysłane nim wiadomości zostają w historii zamówień.');
    expect(lista.body).toContain('Reguły Lampy wysłane, Lampy w kolejce mają teraz usunięty szablon.');
    expect(lista.body).not.toContain('Usunięta reguła');
    expect(p.db.prepare('SELECT wlaczona FROM automatyzacje_reguly WHERE id = ?').get(a).wlaczona).toBe(1);
  });

  it('operator z Ustawieniami bez dostępu do reguły widzi same nazwy, ze znakami HTML bezpiecznie zapisanymi', async () => {
    const p = await panel();
    const id = regula(p.db, 'Lampy <b>pilne</b>');
    expect((await get(p.app, `/ustawienia/automatyzacje/${id}`, p.operator)).statusCode).toBe(403);
    const r = await get(p.app, `${ADRES}/${ID}`, p.operator);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Lampy &lt;b&gt;pilne&lt;/b&gt;');
    expect(r.body).not.toContain(`href="/ustawienia/automatyzacje/${id}"`);
    expect(r.body).toContain('name="potwierdzUsuniecie"');
  });

  it('nieużywany szablon (tylko reguła usunięta i inny szablon) usuwa się jak dotychczas', async () => {
    const p = await panel();
    regula(p.db, 'Usunięta reguła', { usunieta: true });
    regula(p.db, 'Inny szablon', { szablon: 'wlasny-2' });
    const r = await get(p.app, `${ADRES}/${ID}`, p.admin);
    expect(r.body).not.toContain('Ten szablon wysyłają');
    expect(r.body).not.toContain('name="potwierdzUsuniecie"');
    const usun = await post(p.app, `${ADRES}/${ID}/usun`, p.admin);
    expect(usun.statusCode).toBe(303);
    expect(usun.headers.location).toBe(`${ADRES}?zapisano=usunieto`);
    expect(istnieje(p.db)).toBe(false);
  });

  it('brak tabeli automatyzacji → ekran i usunięcie bez błędu i bez potwierdzenia', async () => {
    const p = await panel({ bezAutomatyzacji: true });
    expect(p.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'automatyzacje_reguly'").get()).toBeUndefined();
    expect(regulyUzywajaceSzablonu(p.db, ID)).toEqual([]);
    const r = await get(p.app, `${ADRES}/${ID}`, p.admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('name="potwierdzUsuniecie"');
    expect((await post(p.app, `${ADRES}/${ID}/usun`, p.admin)).statusCode).toBe(303);
    expect(istnieje(p.db)).toBe(false);
  });

  it('moduł automatyzacji wyłączony, ale tabela z regułą zachowana → bez ostrzeżenia i potwierdzenia', async () => {
    const p = await panel({ bezAutomatyzacji: true });
    migracjaRegul.wykonaj(p.db);
    regula(p.db, 'Lampy w kolejce');
    expect(regulyUzywajaceSzablonu(p.db, ID)).toHaveLength(1);
    const r = await get(p.app, `${ADRES}/${ID}`, p.admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('name="potwierdzUsuniecie"');
    expect((await post(p.app, `${ADRES}/${ID}/usun`, p.admin)).statusCode).toBe(303);
    expect(istnieje(p.db)).toBe(false);
  });

  it('przywracanie szablonu wbudowanego nadal nie wymaga potwierdzenia', async () => {
    const p = await panel();
    regula(p.db, 'Lampy wysłane', { szablon: 'wyslane', wlaczona: true });
    const r = await get(p.app, `${ADRES}/wyslane`, p.admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('name="potwierdzUsuniecie"');
    const przywroc = await post(p.app, `${ADRES}/wyslane/usun`, p.admin);
    expect(przywroc.statusCode).toBe(303);
    expect(przywroc.headers.location).toBe(`${ADRES}?zapisano=przywrocono`);
  });
});
