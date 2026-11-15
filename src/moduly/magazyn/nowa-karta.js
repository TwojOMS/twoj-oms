import { utworzKarte } from '../../oms/db/magazyn.js';
import { STAWKI_VAT } from '../../domena/vat.js';

const POLA = ['nazwa', 'sku', 'ean', 'cena_zl', 'stawka_vat'];

export function registerNowaKartaMagazynu(app, { db, pomoc, magazyn }) {
  const formularz = (reply, wpisane = {}, blad = null) => reply.code(blad ? 400 : 200).view('magazyn-nowa-karta.ejs', {
    title: 'Nowy produkt', wpisane, blad, stawkiVat: STAWKI_VAT,
  });
  // Jak lista i karta: magazyn niegotowy (brak sklepów) → nic nie zapisujemy, wracamy na listę.
  const niegotowy = reply => (magazyn?.gotowy?.() === false ? reply.redirect('/magazyn') : null);
  app.get('/magazyn/nowa-karta', async (_req, reply) => niegotowy(reply) ?? formularz(reply));
  // Rola magazyn i CSRF (Origin/Referer) są sprawdzane przez globalne haki panelu.
  app.post('/magazyn/nowa-karta', async (req, reply) => {
    if (niegotowy(reply)) return reply;
    const wpisane = Object.fromEntries(POLA.map(pole => [pole, typeof req.body?.[pole] === 'string' ? req.body[pole] : '']));
    const { zmiany, blad } = pomoc.zmianyZFormularza(db, {}, wpisane);
    if (blad) return formularz(reply, wpisane, blad);
    // Tworzenie i oznaczenie wszystkich wpisanych pól są jedną operacją. Stan początkowy
    // wynika z braku ruchów magazynowych — formularz nigdy nie zapisuje stanu.
    db.exec('SAVEPOINT nowa_karta');
    let id;
    try {
      const wypelnione = Object.fromEntries(Object.entries(zmiany).filter(([, wartosc]) => wartosc !== null));
      id = utworzKarte(db, wypelnione, { zrodlo: 'reczne' });
      db.exec('RELEASE nowa_karta');
    } catch (error) {
      db.exec('ROLLBACK TO nowa_karta');
      db.exec('RELEASE nowa_karta');
      throw error;
    }
    return reply.code(303).redirect(`/magazyn/${id}`);
  });
}
