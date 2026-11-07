import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { wczytajUstawienia } from '../../../src/oms/db/ustawienia.js';
import { odczytajSzablony } from '../../../src/domena/szablony-paczek.js';
import { propozycjaAutomatu, USLUGI_AUTOMATOW } from '../../../src/domena/gabaryty-automatow.js';

// PRZ-152.G11a: ekran „Szablony paczek” — tabela z edycją w wierszu i sekcja „Paczkomaty i automaty”.
const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64') };
const naglowekPost = { ...naglowek, origin: 'http://localhost' };
const ADRES = '/ustawienia/zamowienia-i-wysylka';
const ORLEN = '09164667-daa5-42dc-8087-33d7485790ac';
const KURIER_DPD = '03f26351-f683-4db2-8895-f2c599280e3c';

let db;
let app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config });
  await app.ready();
});
afterEach(async () => { await app.close(); db.close(); });

const get = (zapytanie = '') => app.inject({ method: 'GET', url: ADRES + zapytanie, headers: naglowek });
const post = (url, payload) => app.inject({ method: 'POST', url, headers: naglowekPost, payload });
// Tylko główna kolumna — arkusz stylów w <style> układu zawiera nazwy wszystkich klas.
const tresc = (body) => body.slice(body.indexOf('<main'));
const wiersz = (body, id) => {
  const i = body.indexOf(`data-szablon="${id}"`);
  return i < 0 ? null : body.slice(i, body.indexOf('</tr>', i));
};
const formularz = (body, id) => {
  const i = body.indexOf(`id="${id}"`);
  return i < 0 ? null : body.slice(i, body.indexOf('</form>', i));
};
const MALA = { nazwa: 'Mała płaska', waga: '0,5', dlugosc: '30', szerokosc: '20', wysokosc: '2' };
const dodajMala = async () => {
  expect((await post('/ustawienia/paczka/szablon', MALA)).statusCode).toBe(302);
  return odczytajSzablony(wczytajUstawienia(db)).szablony.find((s) => s.nazwa === MALA.nazwa).id;
};

describe('tabela szablonów paczek', () => {
  it('jeden tytuł, wiersz z wagą i wymiarami, plakietka domyślnego bez kosza, bez stałego formularza', async () => {
    const t = tresc((await get()).body);

    // PRZ-154 E2.1: h1 działu, zakładka i h2 opisują formularz.
    expect(t.match(/<h1\b/g)).toHaveLength(1);
    expect(t).toContain('<h1>Wysyłka i druk</h1>');
    expect(t).not.toContain('<h2 class="naglowek-formularza">Szablony paczek</h2>');
    const w = wiersz(t, 'domyslna');
    expect(w).toContain('Paczka domyślna');
    expect(w).toContain('1 kg');
    expect(w).toContain('110 × 75 × 1 cm');
    expect(w).toContain('domyślny');
    expect(w).toContain('?edytuj=domyslna');
    expect(w).not.toContain('/usun');
    expect(t).not.toContain('id="ust-szablon-nowy"');
    expect(t).toContain('href="/ustawienia/zamowienia-i-wysylka?dodaj=1');
  });

  it('„+ Dodaj szablon” bez JS dokłada pusty wiersz, a zapis dodaje szablon', async () => {
    const f = formularz((await get('?dodaj=1')).body, 'ust-szablon-nowy');
    expect(f).not.toBeNull();
    expect(f).not.toContain('name="id"');

    const id = await dodajMala();
    const t = tresc((await get('?zapisano=szablon')).body);
    const w = wiersz(t, id);
    expect(w).toContain('0,5 kg');
    expect(w).toContain('30 × 20 × 2 cm');
    expect(w).toContain(`/ustawienia/paczka/szablon/${id}/domyslny`);
    expect(w).toContain('Ustaw domyślny');
    expect(w).toContain(`/ustawienia/paczka/szablon/${id}/usun`);
    expect(t).toContain('Zapisano szablony paczek.');
  });

  it('„Edytuj” bez JS (?edytuj=<id>) daje pola w tym samym wierszu z Zapisz i Anuluj, zapis zmienia szablon', async () => {
    const id = await dodajMala();
    const b = (await get(`?edytuj=${id}`)).body;
    const w = wiersz(b, id);
    expect(w).toContain(`name="id" value="${id}"`);
    expect(w).toContain('name="nazwa" value="Mała płaska"');
    expect(w).toContain('name="waga" value="0.5"');
    expect(w).toContain('name="wysokosc" value="2"');
    expect(w).toContain('>Zapisz<');
    expect(w).toContain(`href="${ADRES}"`);
    expect(wiersz(b, 'domyslna')).not.toContain('name="nazwa"');

    const r = await post('/ustawienia/paczka/szablon', { ...MALA, id, waga: '0,8' });
    expect(r.statusCode).toBe(302);
    expect(odczytajSzablony(wczytajUstawienia(db)).szablony.find((s) => s.id === id).waga).toBe(0.8);
  });

  it('odmowa edycji zostawia wiersz w trybie edycji z wpisanymi wartościami', async () => {
    const id = await dodajMala();
    const r = await post('/ustawienia/paczka/szablon', { ...MALA, id, waga: '0' });

    expect(r.statusCode).toBe(400);
    expect(wiersz(r.body, id)).toContain('name="waga" value="0"');
    expect(odczytajSzablony(wczytajUstawienia(db)).szablony.find((s) => s.id === id).waga).toBe(0.5);
  });

  it('odmowa dodania pokazuje pusty wiersz z wpisanymi wartościami', async () => {
    const r = await post('/ustawienia/paczka/szablon', { ...MALA, dlugosc: 'abc' });

    expect(r.statusCode).toBe(400);
    expect(formularz(r.body, 'ust-szablon-nowy')).toContain('name="dlugosc" value="abc"');
  });

  it('„Ustaw domyślny” przenosi plakietkę, a „usuń” kasuje szablon', async () => {
    const id = await dodajMala();
    expect((await post(`/ustawienia/paczka/szablon/${id}/domyslny`, {})).statusCode).toBe(302);
    let t = tresc((await get()).body);
    expect(wiersz(t, id)).not.toContain('/usun');
    expect(wiersz(t, 'domyslna')).toContain('/ustawienia/paczka/szablon/domyslna/usun');

    expect((await post('/ustawienia/paczka/szablon/domyslna/usun', {})).statusCode).toBe(302);
    t = tresc((await get()).body);
    expect(wiersz(t, 'domyslna')).toBeNull();
    expect(odczytajSzablony(wczytajUstawienia(db)).szablony.map((s) => s.id)).toEqual([id]);
  });

  it('nie ostrzega o małej wysokości', async () => {
    await dodajMala();
    expect(tresc((await get()).body)).not.toMatch(/wysoko\S* (jest )?(mał|zbyt|za mał)/i);
  });
});

describe('paczkomaty i automaty', () => {
  it('bez ustawienia pokazuje dzisiejsze wartości: InPost A + waga szablonu, Allegro S + 1 kg, 7 usług w wyjątkach', async () => {
    await post('/ustawienia/paczka/szablon', { id: 'domyslna', nazwa: 'Paczka domyślna', waga: '3', dlugosc: '110', szerokosc: '75', wysokosc: '1' });
    const t = tresc((await get()).body);

    expect(t).toContain('Paczkomaty i automaty');
    const inpost = formularz(t, 'automat-paczkomat');
    expect(inpost).toContain('Paczkomat InPost');
    expect(inpost).toMatch(/value="A" checked/);
    expect(inpost).toContain('name="waga" value="3"');
    expect(inpost).toContain('8 × 38 × 64 cm');
    const allegro = formularz(t, 'automat-allegro');
    expect(allegro).toMatch(/value="S" checked/);
    expect(allegro).toContain('name="waga" value="1"');
    expect(t).toContain('<details');
    for (const u of USLUGI_AUTOMATOW) expect(formularz(t, `automat-${u.id}`)).toContain(u.nazwa);
    expect(t).not.toContain(`automat-${KURIER_DPD}`);
  });

  it('zapis InPost i Allegro trafia do ustawień i do propozycji', async () => {
    let r = await post('/ustawienia/paczka/automat', { cel: 'paczkomat', gabaryt: 'B', waga: '2,5' });
    expect(r.statusCode, r.body).toBe(302);
    expect(r.headers.location).toBe(`${ADRES}?zapisano=automat`);
    r = await post('/ustawienia/paczka/automat', { cel: 'allegro', gabaryt: 'M', waga: '4' });
    expect(r.statusCode).toBe(302);

    const zapis = wczytajUstawienia(db);
    expect(propozycjaAutomatu(zapis, { rodzaj: 'paczkomat' })).toEqual({ gabaryt: 'B', waga: 2.5 });
    expect(propozycjaAutomatu(zapis, { rodzaj: 'wza', deliveryMethodId: ORLEN })).toEqual({ gabaryt: 'M', waga: 4 });
    const t = tresc((await get('?zapisano=automat')).body);
    expect(formularz(t, 'automat-paczkomat')).toMatch(/value="B" checked/);
    expect(formularz(t, 'automat-allegro')).toMatch(/value="M" checked/);
    expect(t).toContain('Zapisano gabaryty paczkomatów i automatów.');
  });

  it('waga automatu ponad 20 kg — odmowa, nic nie zapisane, wpisana wartość zostaje', async () => {
    const r = await post('/ustawienia/paczka/automat', { cel: 'allegro', gabaryt: 'L', waga: '25' });

    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('20 kg');
    expect(formularz(r.body, 'automat-allegro')).toContain('name="waga" value="25"');
    expect(formularz(r.body, 'automat-allegro')).toMatch(/value="L" checked/);
    expect(wczytajUstawienia(db)['paczka.automaty']).toBeUndefined();
  });

  it('wpisana waga wraca na ekran zabezpieczona (wiersz paczkomatu)', async () => {
    const r = await post('/ustawienia/paczka/automat', { cel: 'paczkomat', gabaryt: 'A', waga: '"><b>x' });

    expect(r.statusCode).toBe(400);
    expect(formularz(r.body, 'automat-paczkomat')).toContain('value="&#34;&gt;&lt;b&gt;x"');
    expect(formularz(r.body, 'automat-paczkomat')).not.toContain('<b>x');
  });

  it('wyjątek usługi wygrywa, „jak wszystkie” go usuwa', async () => {
    await post('/ustawienia/paczka/automat', { cel: 'allegro', gabaryt: 'M', waga: '4' });
    expect((await post('/ustawienia/paczka/automat', { cel: ORLEN, gabaryt: 'L', waga: '12' })).statusCode).toBe(302);
    expect(propozycjaAutomatu(wczytajUstawienia(db), { rodzaj: 'wza', deliveryMethodId: ORLEN })).toEqual({ gabaryt: 'L', waga: 12 });

    const t = tresc((await get()).body);
    const akcja = `/ustawienia/paczka/automat/${ORLEN}/jak-wszystkie`;
    expect(t).toContain(`action="${akcja}"`);
    expect(t).toMatch(/<details[^>]* open/);

    const r = await post(akcja, {});
    expect(r.statusCode).toBe(302);
    expect(propozycjaAutomatu(wczytajUstawienia(db), { rodzaj: 'wza', deliveryMethodId: ORLEN })).toEqual({ gabaryt: 'M', waga: 4 });
    expect(tresc((await get()).body)).not.toContain(`action="${akcja}"`);
  });

  it('usługa bez profilu gabarytu nie dostaje wyjątku', async () => {
    const r = await post('/ustawienia/paczka/automat', { cel: KURIER_DPD, gabaryt: 'S', waga: '1' });
    expect(r.statusCode).toBe(400);
    expect(wczytajUstawienia(db)['paczka.automaty']).toBeUndefined();
    expect((await post(`/ustawienia/paczka/automat/${KURIER_DPD}/jak-wszystkie`, {})).statusCode).toBe(400);
  });
});
