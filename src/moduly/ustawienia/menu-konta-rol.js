// PRZ-068: menu użytkownika mówi nazwą roli z bazy. Hak preHandler modułu ustawienia biegnie PO haku
// modułu web (kolejność rejestracji), więc nadpisuje gotowe reply.locals.menuKonta; menuKontaDla i fixture
// HTML 065 zostają nietknięte (plan O10). PRZ-069 dopisuje tu mojeKontoHref.
import { opisRoliKonta } from './role.js';

export function zarejestrujMenuKontaRol(app, { db }) {
  app.addHook('preHandler', async (req, reply) => {
    const menu = reply.locals?.menuKonta;
    if (!menu || !req.konto || req.konto.serwisowe || typeof req.konto.id !== 'number') return;
    const opis = opisRoliKonta(db, req.konto.id);
    // PRZ-069: „Moje konto” wyłącznie dla konta z tabeli (warunek wyżej odcina konto serwisowe .env).
    reply.locals.menuKonta = { ...menu, ...(opis ? { opisRoli: opis } : {}), mojeKontoHref: '/konto' };
  });
}
