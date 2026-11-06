import { randomBytes } from 'node:crypto';
import { ZAKRESY_API, czyZakresyPoprawne } from '../../../domena/klucze-api.js';
import { listaKluczyApi, zalozKluczApi, odwolajKluczApi, usunKluczApi } from '../../../core/bezpieczenstwo/klucze-api.js';
import { dopiszLogowanie } from '../../../core/bezpieczenstwo/konta.js';
import { nawigacjaUstawien } from '../nawigacja.js';

const ADRES = '/ustawienia/klucze-api';
const NAZWY_ZAKRESOW = {
  'zamowienia:odczyt': { grupa: 'Zamówienia', rodzaj: 'Odczyt' },
  'zamowienia:zapis': { grupa: 'Zamówienia', rodzaj: 'Zapis' },
  'produkty:odczyt': { grupa: 'Produkty', rodzaj: 'Odczyt' },
  'produkty:zapis': { grupa: 'Produkty', rodzaj: 'Zapis' },
  'stany:odczyt': { grupa: 'Stany', rodzaj: 'Odczyt' },
  'stany:zapis': { grupa: 'Stany', rodzaj: 'Zapis' },
  'proformy:zapis': { grupa: 'Proformy', rodzaj: 'Zapis' },
  'zdjecia:zapis': { grupa: 'Zdjęcia', rodzaj: 'Zapis' },
  'sprzedaz:odczyt': { grupa: 'Sprzedaż', rodzaj: 'Odczyt' },
  druk: { grupa: 'Druk', rodzaj: 'Kolejka druku' },
};
const opisZakresu = zakres => Object.hasOwn(NAZWY_ZAKRESOW, zakres) ? NAZWY_ZAKRESOW[zakres] : { grupa: zakres, rodzaj: zakres };
const etykieta = zakres => Object.hasOwn(NAZWY_ZAKRESOW, zakres) ? `${opisZakresu(zakres).grupa} — ${opisZakresu(zakres).rodzaj}` : zakres;
const grupy = [...new Set([...Object.keys(NAZWY_ZAKRESOW).filter(z => ZAKRESY_API.includes(z)), ...ZAKRESY_API].map(z => opisZakresu(z).grupa))];
const grupyZakresow = grupy.map(nazwa => ({ nazwa,
  zakresy: ZAKRESY_API.filter(z => opisZakresu(z).grupa === nazwa) }));

function tylkoAdmin(req, reply) {
  if (req.konto?.admin) return null;
  return reply.code(403).view('brak-dostepu.ejs', { title: 'Brak dostępu', wlasnyUklad: true });
}

export function registerKluczeApiRoutes(app, { db, teraz = () => new Date() }) {
  const terazIso = () => teraz().toISOString();
  // Każdy serwer ma własne formularze. Nie przechowujemy tu pełnych kluczy API.
  const formularze = new Map();
  function widok(req, reply, { blad = '', dane = {}, klucz = null, potwierdzenie = null } = {}) {
    const czas = Date.now();
    for (const [token, wpis] of formularze) if (wpis.doKiedy <= czas) formularze.delete(token);
    const jednorazowy = randomBytes(32).toString('base64url');
    formularze.set(jednorazowy, { doKiedy: czas + 15 * 60_000, login: req.konto.login });
    return reply.header('Cache-Control', 'no-store').view('klucze-api.ejs', {
      title: 'Klucze API', nawigacja: nawigacjaUstawien(req, reply),
      blad, dane, klucz, jednorazowy, etykieta, opisZakresu, grupyZakresow, potwierdzenie,
      zakresy: ZAKRESY_API, klucze: listaKluczyApi(db).map(k => ({ ...k,
        stan: k.odwolany_at ? 'odwołany' : k.wygasa_at && k.wygasa_at <= terazIso() ? 'wygasły' : 'czynny',
      })),
    });
  }
  app.get(ADRES, async (req, reply) => tylkoAdmin(req, reply) ?? widok(req, reply));
  app.post(ADRES, async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    const body = req.body ?? {};
    const wpis = formularze.get(body.jednorazowy);
    formularze.delete(body.jednorazowy);
    if (!wpis || wpis.doKiedy <= Date.now() || wpis.login !== req.konto.login) return reply.redirect(ADRES, 303);
    const dane = { nazwa: typeof body.nazwa === 'string' ? body.nazwa.trim() : '',
      zakresy: typeof body.zakresy === 'string' ? [body.zakresy] : body.zakresy ?? [],
      wygasa: typeof body.wygasa === 'string' ? body.wygasa : '' };
    let blad = !dane.nazwa ? 'Podaj nazwę klucza.' : !czyZakresyPoprawne(dane.zakresy) ? 'Wybierz poprawne zakresy dostępu.' : '';
    let wygasaAt = null;
    if (dane.wygasa) {
      // Wybrany dzień jest ostatnim dniem działania klucza, do 23:59:59.999 UTC.
      const data = new Date(`${dane.wygasa}T23:59:59.999Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dane.wygasa) || !Number.isFinite(data.getTime())
        || data.toISOString().slice(0, 10) !== dane.wygasa || data.toISOString() <= terazIso()) blad = 'Wybierz datę wygaśnięcia, która nie minęła.';
      else wygasaAt = data.toISOString();
    }
    if (blad) return widok(req, reply.code(400), { blad, dane });
    const wynik = zalozKluczApi(db, { nazwa: dane.nazwa, zakresy: dane.zakresy, kontoId: req.konto.id, wygasaAt, teraz: terazIso() });
    dopiszLogowanie(db, { login: req.konto.login, usluga: 'klucze-api', wynik: `zalozony:${wynik.prefiks}` });
    return widok(req, reply, { klucz: wynik.klucz });
  });
  app.post(`${ADRES}/:id/usun`, async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    const klucz = listaKluczyApi(db).find(k => String(k.id) === req.params.id);
    if (!klucz) return widok(req, reply.code(404), { blad: 'Nie ma takiego klucza.' });
    if (req.body?.potwierdzam !== 'tak') return widok(req, reply, { potwierdzenie: { klucz, akcja: 'usun', pytanie: 'usunąć', przycisk: 'usuń' } });
    if (usunKluczApi(db, klucz.id, terazIso())) {
      dopiszLogowanie(db, { login: req.konto.login, usluga: 'klucze-api', wynik: `usuniety:${klucz.prefiks}` });
    }
    return reply.redirect(ADRES, 303);
  });
  app.post(`${ADRES}/:id/odwolaj`, async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    const klucz = listaKluczyApi(db).find(k => String(k.id) === req.params.id);
    if (!klucz) return widok(req, reply.code(404), { blad: 'Nie ma takiego klucza.' });
    if (req.body?.potwierdzam !== 'tak') return widok(req, reply, { potwierdzenie: { klucz, akcja: 'odwolaj', pytanie: 'odwołać', przycisk: 'odwołaj' } });
    if (odwolajKluczApi(db, klucz.id, terazIso())) {
      dopiszLogowanie(db, { login: req.konto.login, usluga: 'klucze-api', wynik: `odwolany:${klucz.prefiks}` });
    }
    return reply.redirect(ADRES, 303);
  });
}
