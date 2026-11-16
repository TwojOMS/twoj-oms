// Menu użytkownika mówi nazwą roli z bazy. Hak preHandler modułu ustawienia biegnie PO haku
// modułu web (kolejność rejestracji), więc nadpisuje gotowe reply.locals.menuKonta; menuKontaDla
// (domena/menu-konta.js) zostaje nietknięte; hak dopisuje też mojeKontoHref.
import { opisRoliKonta } from './role.js';

export function zarejestrujMenuKontaRol(app, { db }) {
  app.addHook('preHandler', async (req, reply) => {
    const menu = reply.locals?.menuKonta;
    if (!menu || !req.konto || req.konto.serwisowe || typeof req.konto.id !== 'number') return;
    const opis = opisRoliKonta(db, req.konto.id);
    // „Moje konto” wyłącznie dla konta z tabeli (warunek wyżej odcina konto serwisowe .env).
    reply.locals.menuKonta = { ...menu, ...(opis ? { opisRoli: opis } : {}), mojeKontoHref: '/konto' };
  });
}
