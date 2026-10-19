import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijPrzesylke, zakonczPrzesylke, zapiszStatusDpd } from '../../../src/moduly/wysylka/db/przesylki.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// ZAKLADKA /przesylki (pomysl właściciela 23.08): jedna lista paczek zamiast otwierania kart
// po kolei — kurier, numer, ETAP z dniami w drodze, ostatni ruch, filtr „bez ruchu".
// Etap liczy TA SAMA regula, co pastylka na karcie i czuwacz (domain/etap-przesylki.js).

const AUTH = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}` };
const CONFIG = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };

const zmapowane = (nr) => ({
  zrodlo_id: nr, numer: `Z-${nr}`, klient: { first_name: 'Jan', last_name: 'Testowy', email: 'j@k.pl' }, dostawa: {},
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '50.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-08-20T10:00:00Z', pozycje: [],
});

function nadana(db, zamowienieId, kurier, numer, { status = null, statusAt = null, utworzona = '2026-08-21T10:00:00.000Z' } = {}) {
  const p = rozpocznijPrzesylke(db, zamowienieId, kurier);
  zakonczPrzesylke(db, p.id, { numerListu: numer, etykietaSciezka: '/tmp/e.pdf', surowa: '<x/>' });
  db.prepare('UPDATE przesylki SET utworzona_at = ? WHERE id = ?').run(utworzona, p.id);
  if (status) zapiszStatusDpd(db, p.id, { opis: status, at: statusAt });
  return p.id;
}

let db; let app;
beforeEach(() => {
  // ⚠️ FEJKUJEMY WYLACZNIE `Date`, nie caly zegar. Pelne `useFakeTimers()` zatrzymuje tez
  // `setTimeout`/`setImmediate`, na ktorych stoi czytanie CIALA zadania w Fastify — GET-y
  // przechodzily, a KAZDY POST wisial do timeoutu testu. Ta sama forma stoi w
  // karta-wyglad.test.js i web-zamowienie.test.js, gdzie POST-y dzialaja.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-27T10:00:00Z')); // czwartek
  db = openOmsDb(':memory:');
  const id1 = zapiszZamowienie(db, 'pro', zmapowane(1), {});
  nadana(db, id1, 'dpd', 'WDRODZE1', { status: 'Przesyłka odebrana przez Kuriera', statusAt: '2026-08-26T09:00:00.000', utworzona: '2026-08-21T10:00:00.000Z' });
  const id2 = zapiszZamowienie(db, 'pro', zmapowane(2), {});
  nadana(db, id2, 'dpd', 'DORECZONA1', { status: 'Przesyłka doręczona', statusAt: '2026-08-22T12:00:00.000', utworzona: '2026-08-22T08:00:00.000Z' });
  const id3 = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane(3), {});
  nadana(db, id3, 'allegro_wza', 'BEZRUCHU1', { status: 'Przesyłka odebrana przez Kuriera', statusAt: '2026-08-21T11:00:00.000', utworzona: '2026-08-25T12:00:00.000Z' });
  app = buildOmsServer({ db, config: CONFIG });
});

describe('GET /przesylki', () => {
  it('w kolumnie Kurier pokazuje dla WzA pelna nazwe metody z karty zamowienia', async () => {
    for (const nazwa of ['Allegro Kurier DPD pobranie', 'Allegro Kurier DHL']) {
      db.prepare("UPDATE zamowienia SET metoda_wysylki_nazwa = ? WHERE numer = 'Z-3'")
        .run(nazwa);

      const r = await app.inject({ method: 'GET', url: '/przesylki?pokaz=wszystkie', headers: AUTH });
      const wiersz = r.body.split('<tr>').find((fragment) => fragment.includes('BEZRUCHU1'))
        ?.split('</tr>')[0];
      expect(wiersz).toContain(`<span class="prz067-usluga drobne">${nazwa}</span>`);
      expect(wiersz).not.toContain('allegro_wza');
    }
  });

  it('gdy WzA nie ma nazwy z Allegro, pokazuje ten sam slownikowy opis co karta', async () => {
    db.prepare("UPDATE zamowienia SET metoda_wysylki = 'allegro_dpd' WHERE numer = 'Z-3'").run();
    const r = await app.inject({ method: 'GET', url: '/przesylki?pokaz=wszystkie', headers: AUTH });
    const wiersz = r.body.split('<tr>').find((fragment) => fragment.includes('BEZRUCHU1'))
      ?.split('</tr>')[0];
    expect(wiersz).toContain('<span class="prz067-usluga drobne">Allegro Kurier DPD</span>');
  });

  it('reczna zmiana metody lub pobrania uniewaznia stara nazwe Allegro tak jak na karcie', async () => {
    const zmiana = db.prepare("UPDATE zamowienia SET metoda_wysylki = 'allegro_dpd', metoda_wysylki_nazwa = 'Allegro Kurier DPD', wysylka_reczna_json = ? WHERE numer = 'Z-3'");
    for (const [nadpisanie, oczekiwana] of [
      [{ metoda: 'inpost_paczkomat', pobranie: 0 }, 'InPost Paczkomat'],
      [{ metoda: 'allegro_dpd', pobranie: 1 }, 'Allegro Kurier DPD (pobranie)'],
    ]) {
      zmiana.run(JSON.stringify(nadpisanie));
      const r = await app.inject({ method: 'GET', url: '/przesylki?pokaz=wszystkie', headers: AUTH });
      const wiersz = r.body.split('<tr>').find((fragment) => fragment.includes('BEZRUCHU1'))
        ?.split('</tr>')[0];
      expect(wiersz).toContain(`<span class="prz067-usluga drobne">${oczekiwana}</span>`);
      expect(wiersz).not.toContain('<span class="prz067-usluga drobne">Allegro Kurier DPD</span>');
    }
  });

  it('nazwa metody zamowienia nie podmienia kuriera przesylki spoza WzA', async () => {
    db.prepare("UPDATE zamowienia SET metoda_wysylki_nazwa = ? WHERE numer = 'Z-1'")
      .run('Allegro Kurier DHL');

    const r = await app.inject({ method: 'GET', url: '/przesylki?pokaz=wszystkie', headers: AUTH });
    const wiersz = r.body.split('<tr>').find((fragment) => fragment.includes('WDRODZE1'))
      ?.split('</tr>')[0];
    expect(wiersz).toMatch(/<img class="prz067-logo" src="\/public\/przewoznicy\/dpd\.svg" alt="DPD"/);
    expect(wiersz).not.toContain('Allegro Kurier DHL');
  });

  it('domyslnie pokazuje paczki W DRODZE z etapem i dniami, bez doreczonych', async () => {
    const r = await app.inject({ method: 'GET', url: '/przesylki?pokaz=w_drodze', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('WDRODZE1');
    expect(r.body).toContain('BEZRUCHU1');
    expect(r.body).not.toContain('DORECZONA1');
    expect(r.body).toContain('W drodze (6 dni)');
    expect(r.body).toContain('Z-1');
  });

  it('filtr bez_ruchu zaweza do paczek stojacych ponad 3 dni robocze', async () => {
    const r = await app.inject({ method: 'GET', url: '/przesylki?pokaz=bez_ruchu', headers: AUTH });
    expect(r.body).toContain('BEZRUCHU1');
    expect(r.body).not.toContain('WDRODZE1');
  });

  it('filtr doreczone pokazuje zakonczone, wiersz linkuje do karty zamowienia', async () => {
    const r = await app.inject({ method: 'GET', url: '/przesylki?pokaz=doreczone', headers: AUTH });
    expect(r.body).toContain('DORECZONA1');
    expect(r.body).toContain('Doręczona');
    expect(r.body).toMatch(/href="\/zamowienia\/\d+"/);
  });

  it('chipy filtrow niosa liczniki: w drodze 2, bez ruchu 1, doreczone 1', async () => {
    const r = await app.inject({ method: 'GET', url: '/przesylki', headers: AUTH });
    expect(r.body).toMatch(/W drodze[\s\S]{0,40}\(2\)/);
    expect(r.body).toMatch(/Bez ruchu[\s\S]{0,40}\(1\)/);
    expect(r.body).toMatch(/Doręczone[\s\S]{0,40}\(1\)/);
  });

  it('bez logowania odsyla na /login (trasa NIE jest otwarta jak /health)', async () => {
    const r = await app.inject({ method: 'GET', url: '/przesylki', headers: { accept: 'text/html' } });
    expect([302, 401]).toContain(r.statusCode);
  });
});

// ——— UKRYWANIE (25.08.2026) ——————————————————————————————————————————————————————
// Dla paczek, ktorych zaden status nie uratuje: zamowienie testowe, etykieta zrobiona
// i nigdy przez kuriera niepodjeta. Sprzatanie przez ukrycie ma sens WYLACZNIE dla nich —
// szesc paczek, ktore 25.08 wisialy jako „bez ruchu", bylo w rzeczywistosci DORECZONYCH
// i zeszlo z listy samo, gdy panel zaczal pytac Allegro o statusy.
describe('ukrywanie paczek z zakladki', () => {
  const POST = { ...AUTH, origin: 'http://localhost' };
  const ukryj = (id, pokaz = 'bez_ruchu') => app.inject({
    method: 'POST', url: `/przesylki/${id}/ukryj`, headers: POST, payload: { pokaz },
  });

  const idBezRuchu = () => db.prepare("SELECT id FROM przesylki WHERE numer_listu = 'BEZRUCHU1'").get().id;

  it('ukryta paczka znika z „Bez ruchu" i z „W drodze"', async () => {
    const r = await ukryj(idBezRuchu());
    expect(r.statusCode).toBe(302);

    const bezRuchu = await app.inject({ method: 'GET', url: '/przesylki?pokaz=bez_ruchu', headers: AUTH });
    expect(bezRuchu.body).not.toContain('BEZRUCHU1');
    const wDrodze = await app.inject({ method: 'GET', url: '/przesylki?pokaz=w_drodze', headers: AUTH });
    expect(wDrodze.body).not.toContain('BEZRUCHU1');
    expect(wDrodze.body).toContain('WDRODZE1');
  });

  it('ukryta paczka jest widoczna pod chipem „Ukryte" i da sie ja przywrocic', async () => {
    const id = idBezRuchu();
    await ukryj(id);

    const ukryte = await app.inject({ method: 'GET', url: '/przesylki?pokaz=ukryte', headers: AUTH });
    expect(ukryte.body).toContain('BEZRUCHU1');
    expect(ukryte.body).toContain('Przywróć');

    await app.inject({
      method: 'POST', url: `/przesylki/${id}/przywroc`, headers: POST, payload: { pokaz: 'ukryte' },
    });
    const wrocila = await app.inject({ method: 'GET', url: '/przesylki?pokaz=bez_ruchu', headers: AUTH });
    expect(wrocila.body).toContain('BEZRUCHU1');
  });

  // ⚠️ LICZNIK MUSI ZEJSC RAZEM Z WIERSZEM. Chip „Bez ruchu (1)" swiecacy dalej jedynka nad
  // pusta lista klamalby o tym, co jest do zrobienia — i to jest dokladnie ten rodzaj
  // polsrodka, przed ktorym cale to sprzatanie ma bronic.
  it('liczniki chipow schodza razem z ukryciem, a „Ukryte" rosnie', async () => {
    await ukryj(idBezRuchu());
    const r = await app.inject({ method: 'GET', url: '/przesylki', headers: AUTH });
    expect(r.body).toMatch(/Bez ruchu[\s\S]{0,40}\(0\)/);
    expect(r.body).toMatch(/W drodze[\s\S]{0,40}\(1\)/);
    expect(r.body).toMatch(/Ukryte[\s\S]{0,40}\(1\)/);
  });

  // ⚠️⚠️ NOWE ZDARZENIE KURIERA PRZYWRACA PACZKE SAMO. Bez tego „Ukryj" bylby cichym
  // „nie chce wiedziec": paczka, ktora po tygodniu jednak ruszyla albo wrocila jako zwrot,
  // zniknelaby z panelu na zawsze — a wlasnie wtedy wymaga czlowieka najbardziej.
  it('zdarzenie kuriera PO ukryciu przywraca paczke na liste', async () => {
    const id = idBezRuchu();
    await ukryj(id);
    let r = await app.inject({ method: 'GET', url: '/przesylki', headers: AUTH });
    expect(r.body).not.toContain('BEZRUCHU1');

    zapiszStatusDpd(db, id, { opis: 'Zwrócona do nadawcy', at: '2026-08-28T09:00:00.000Z' });

    r = await app.inject({ method: 'GET', url: '/przesylki?pokaz=wszystkie', headers: AUTH });
    expect(r.body).toContain('BEZRUCHU1');
    const ukryte = await app.inject({ method: 'GET', url: '/przesylki?pokaz=ukryte', headers: AUTH });
    expect(ukryte.body).not.toContain('BEZRUCHU1');
  });

  it('zapisuje KTO ukryl i zostawia slad w logu zamowienia', async () => {
    const id = idBezRuchu();
    await ukryj(id);
    const w = db.prepare('SELECT ukryta_at, ukryta_przez FROM przesylki WHERE id = ?').get(id);
    expect(w.ukryta_przez).toBe('adam');
    expect(w.ukryta_at).toBeTruthy();

    const log = db.prepare("SELECT * FROM log WHERE akcja = 'przesylka.ukryj'").all();
    expect(log).toHaveLength(1);
    expect(log[0].wynik).toContain('Ręcznie (adam)');
    expect(log[0].wynik).toContain('BEZRUCHU1');
  });

  it('wraca na ten filtr, z ktorego przyszlo klikniecie', async () => {
    const r = await ukryj(idBezRuchu(), 'wszystkie');
    expect(r.headers.location).toBe('/przesylki?pokaz=wszystkie');
  });

  it('nieistniejaca przesylka to 404, nie cichy sukces', async () => {
    const r = await ukryj(999999);
    expect(r.statusCode).toBe(404);
  });
});
