// PRZ-068: ekran „Role i uprawnienia” — tylko administrator (flaga admin, nie ptaszek Ustawień).
import { EKRANY } from '../../../domena/ekrany.js';
import { nawigacjaUstawien } from '../nawigacja.js';
import { listaRol, zapiszMacierz, dodajRole, zmienNazweRoli, usunRole, BladRoli, KLUCZE_DODATKOWE, odciskMacierzy } from '../role.js';

const KOMUNIKATY = { macierz: 'Zapisano uprawnienia ról.', nowa: 'Dodano rolę.', nazwa: 'Zmieniono nazwę roli.', usunieto: 'Usunięto rolę.' };
const lista = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const WIERSZE = [...EKRANY.map((e) => ({ klucz: e.klucz, etykieta: e.etykieta })),
  ...KLUCZE_DODATKOWE.map((k) => ({ klucz: k, etykieta: 'Dostęp przez API (zewnętrzna aplikacja)' }))];

export function registerRoleRoutes(app, { db, teraz }) {
  // `wlasnyUklad: true` — brak-dostepu.ejs to samodzielny dokument (patrz tylkoAdmin w trasy/konta.js).
  // PRZ-083: gość demo (podglad-demo.js) ogląda Role — tylko GET; zapis blokuje już hak.
  const tylkoAdmin = (req, reply) => (req.konto?.admin || (req.konto?.podgladDemo && req.method === 'GET') ? null
    : reply.code(403).view('brak-dostepu.ejs', { title: 'Brak dostępu', wlasnyUklad: true }));
  const widok = (req, reply, { blad = null, pola = {} } = {}) => reply.view('role.ejs', {
    title: 'Role i uprawnienia', nawigacja: nawigacjaUstawien(req, reply), role: listaRol(db), wiersze: WIERSZE,
    odcisk: odciskMacierzy(db), zapisano: KOMUNIKATY[req.query?.zapisano] ?? null, blad, pola,
  });
  const obsluz = (req, reply, fn, cel) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    try { fn(); return reply.redirect(`/ustawienia/role?zapisano=${cel}`); }
    catch (e) {
      if (!(e instanceof BladRoli)) throw e;
      if (e.kod === 'nieznana') return reply.code(404).send('Nie ma takiej roli');
      // 409: macierz zmieniła się po otwarciu formularza — ekran z aktualnym stanem i nowym odciskiem, nic nie zapisane.
      return widok(req, reply.code(e.kod === 'nieaktualna' ? 409 : 400), { blad: e.message, pola: req.body ?? {} });
    }
  };
  app.get('/ustawienia/role', async (req, reply) => tylkoAdmin(req, reply) ?? widok(req, reply));
  app.post('/ustawienia/role', async (req, reply) => obsluz(req, reply,
    () => zapiszMacierz(db, { role: lista(req.body?.rola), pary: lista(req.body?.uprawnienie), odcisk: req.body?.odcisk }), 'macierz'));
  app.post('/ustawienia/role/nowa', async (req, reply) => obsluz(req, reply,
    () => dodajRole(db, { nazwa: req.body?.nazwa, kopiujZ: req.body?.kopiujZ || null, teraz }), 'nowa'));
  app.post('/ustawienia/role/:klucz/nazwa', async (req, reply) => obsluz(req, reply,
    () => zmienNazweRoli(db, req.params.klucz, req.body?.nazwa), 'nazwa'));
  app.post('/ustawienia/role/:klucz/usun', async (req, reply) => obsluz(req, reply,
    () => usunRole(db, req.params.klucz), 'usunieto'));
}
