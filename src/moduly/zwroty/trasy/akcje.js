import { pobierzZamowienie, dopiszLog } from '../../../oms/db/zamowienia.js';
import {
  dodajZwrot, usunZwrot, oznaczPieniadzeOddane, zwrot, odblokujKorekte, zapiszRecznyNumerKorekty,
} from '../../../oms/db/zwroty.js';
import {
  parsujZwrot, powodOdmowyUsunieciaZwrotu, korektaPrzepadla, powodOdmowyOdblokowaniaKorekty,
  parsujNumerKorekty, korektaNieSprawdzona, powodOdmowyKorektyDlaFaktury,
  powodOdmowyRejestracjiZwrotu, wierszeFormularzaZwrotu,
} from '../../../domena/zwrot.js';
import { formularzZwrotu, przygotujKrok2, razemZwrotuZl } from '../../../domena/zwrot-formularz.js';
import { dzienWarszawa } from '../../../domena/format-daty.js';
import { komunikatDlaOperatora } from '../../../domena/bledy.js';
import { adresKartyZamowienia } from '../../../domena/adres-karty-zamowienia.js';
import { bezpiecznyPowrotNaListe } from '../../../domena/filtry-listy.js';
import { ktoKlikal } from '../../zamowienia/wspolne.js';

import { createWspolne } from './wspolne.js';
export function registerAkcjeRoutes(app, { db, korekta = null, definicje, infakt = null }) {
  const { powrotKarty, adresKarty, zamowienieAlbo404, slad, decyzja, pokazKrok1 } = createWspolne({ db, korekta, definicje, infakt });
  app.post('/zamowienia/:id/zwroty/:zwrotId/pieniadze', async (req, reply) => {
    const z = zamowienieAlbo404(req, reply);
    if (!z) return reply;
    const zwrotId = Number(req.params.zwrotId);
    // Odczyt PRZED zapisem: po `oznaczPieniadzeOddane` kwota jest ta sama, ale slad ma
    // powstac z tego samego wiersza, ktory dostal fakt — takze wtedy, gdy zapis odmowi.
    const w = zwrot(db, z.id, zwrotId);
    try {
      oznaczPieniadzeOddane(db, z.id, zwrotId);
    } catch (e) {
      slad(z.id, 'zwrot.pieniadze', `BŁĄD: ${e.message}`);
      return reply.code(400).send(komunikatDlaOperatora(e));
    }
    slad(z.id, 'zwrot.pieniadze', decyzja(
      req,
      `pieniądze za zwrot z ${w.data} (${w.kwota} zł) oznaczone jako oddane kupującemu.`,
    ));
    return reply.redirect(adresKarty(req, z.id));
  });

  app.post('/zamowienia/:id/zwroty/:zwrotId/usun', async (req, reply) => {
    const z = zamowienieAlbo404(req, reply);
    if (!z) return reply;
    const w = zwrot(db, z.id, Number(req.params.zwrotId));
    if (!w) return reply.code(404).send('Nie ma takiego zwrotu przy tym zamówieniu.');
    const powod = powodOdmowyUsunieciaZwrotu(w);
    if (powod) {
      slad(z.id, 'zwrot.usuniecie', `BŁĄD: ${powod}`);
      return reply.code(400).send(powod);
    }
    // ⚠️ `powodOdmowyUsunieciaZwrotu` wyzej liczy sie POZA transakcja, wiec `usunZwrot` ma
    // WLASNY warunek w SQL-u (db/zwroty.js) i potrafi odmowic mimo zielonego sprawdzenia:
    // przy dwoch otwartych kartach „pieniądze oddane" mieszcza sie miedzy jednym a drugim.
    // Bez tego `try` taka odmowa wychodzila jako 500 i BEZ WPISU W LOGU.
    try {
      usunZwrot(db, z.id, w.id);
    } catch (e) {
      slad(z.id, 'zwrot.usuniecie', `BŁĄD: ${e.message}`);
      return reply.code(400).send(komunikatDlaOperatora(e));
    }
    // ⚠️ SKASOWANY ZWROT ZNIKA Z BAZY BEZ RESZTY (razem z pozycjami — kaskada). Log jest
    // wtedy JEDYNYM miejscem, z ktorego da sie odtworzyc, ze w ogole istnial i za ile byl.
    slad(z.id, 'zwrot.usuniecie', decyzja(
      req,
      `skasowany zwrot z ${w.data} na ${w.kwota} zł`
      + `${w.kwota_dostawy ? ` + dostawa ${w.kwota_dostawy} zł` : ''}`
      + `, pozycji: ${w.pozycje.length}${w.powod ? `; powód: ${w.powod}` : ''}.`,
    ));
    return reply.redirect(adresKarty(req, z.id));
  });

}
