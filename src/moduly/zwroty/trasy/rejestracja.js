import { pobierzZamowienie, dopiszLog } from '../../../oms/db/zamowienia.js';
import { dodajZwrot } from '../../../oms/db/zwroty.js';
import { parsujZwrot } from '../../../domena/zwrot.js';
import { dzienWarszawa } from '../../../domena/format-daty.js';
import { komunikatDlaOperatora } from '../../../domena/bledy.js';
import { adresKartyZamowienia } from '../../../domena/adres-karty-zamowienia.js';
import { bezpiecznyPowrotNaListe } from '../../../domena/filtry-listy.js';
import { ktoKlikal } from '../../zamowienia/wspolne.js';

// Wyodrębnienie frozen routes/zwroty.js:34–47,227–256 (5b9cd765).
// Guard uwierzytelniania, ptaszków i CSRF zapewnia wymagany moduł web.
export function registerZwrotyRoutes(app, { db, definicje }) {
  const powrotKarty = (req) => bezpiecznyPowrotNaListe(req.query?.powrot ?? req.body?.powrot, definicje);
  const adresKarty = (req, id) => adresKartyZamowienia(id, { powrot: powrotKarty(req) }, definicje);

  const zamowienieAlbo404 = (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) { reply.code(404).send('Nie ma takiego zamówienia'); return null; }
    return z;
  };

  // Skrot na dwie formy tego samego wpisu. Slad zapisujemy ZAWSZE tym samym ksztaltem, co
  // reszta panelu: udana akcja to „DECYZJA CZŁOWIEKA (kto): …", nieudana to „BŁĄD: …".
  const slad = (id, akcja, wynik) => dopiszLog(db, id, { akcja, wynik });
  const decyzja = (req, tresc) => `DECYZJA CZŁOWIEKA (${ktoKlikal(req)}): ${tresc}`;

  app.post('/zamowienia/:id/zwrot', async (req, reply) => {
    const z = zamowienieAlbo404(req, reply);
    if (!z) return reply;
    const dzis = dzienWarszawa(new Date().toISOString());
    const { zwrot: nowy, blad } = parsujZwrot(z, req.body, { dzis });
    // Odmowa PRZED jakimkolwiek zapisem — inaczej polowicznie zapisany zwrot zostawialby
    // stan, ktorego nikt nie chcial (ta sama zasada, co przy faktach statusu).
    if (blad) {
      slad(z.id, 'zwrot.rejestracja', `BŁĄD: ${blad}`);
      return reply.code(400).send(blad);
    }
    let zapisany;
    try {
      zapisany = dodajZwrot(db, z.id, nowy);
    } catch (e) {
      slad(z.id, 'zwrot.rejestracja', `BŁĄD: ${e.message}`);
      return reply.code(400).send(komunikatDlaOperatora(e));
    }
    // ⚠️ Slad niesie KWOTE i DATE, a nie samo „zarejestrowano zwrot". Ta kwota schodzi
    // z przychodu w raporcie zarzadczym, wiec po miesiacu ma sie dac odpowiedziec, ile
    // i kiedy zdjeto — bez otwierania karty zamowienia.
    slad(z.id, 'zwrot.rejestracja', decyzja(
      req,
      `zarejestrowany zwrot z ${zapisany.data} na ${zapisany.kwota} zł`
      + `${zapisany.kwota_dostawy ? ` + dostawa ${zapisany.kwota_dostawy} zł` : ''}`
      + `, pozycji: ${zapisany.pozycje.length}`
      + `${zapisany.powod ? `; powód: ${zapisany.powod}` : ''}.`,
    ));
    return reply.redirect(adresKarty(req, z.id));
  });
}
