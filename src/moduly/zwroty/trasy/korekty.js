import { stronaOdmowy } from '../../../core/web/odmowa.js';
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
import { GDZIE_KLUCZ_INFAKTU } from '../../../domena/konfiguracja-infakt.js';
import { odmianaNazwyProgramu, gdzieDokument } from '../../../domena/nazwa-programu.js';
import { zdanieBrakuProgramu } from '../../../domena/wybor-programu.js';
import { adresKartyZamowienia } from '../../../domena/adres-karty-zamowienia.js';
import { bezpiecznyPowrotNaListe } from '../../../domena/filtry-listy.js';
import { ktoKlikal } from '../../zamowienia/wspolne.js';

import { createWspolne } from './wspolne.js';
export function registerKorektyRoutes(app, { db, korekta = null, definicje, infakt: programFaktur = null, wyborProgramu = null }) {
  const { powrotKarty, adresKarty, adresZwrotu, zamowienieAlbo404, slad, decyzja, pokazKrok1 } = createWspolne({ db, korekta, definicje, infakt: programFaktur });
  // PRZ-118.09: nazwa programu w odmowach korekty (bez programu — inFakt, jak dotąd).
  const nazwaProgramu = odmianaNazwyProgramu(programFaktur), gdzieProgramu = gdzieDokument(programFaktur);
  app.post('/zamowienia/:id/zwroty/:zwrotId/korekta', async (req, reply) => {
    const z = zamowienieAlbo404(req, reply);
    if (!z) return reply;
    // `null` (panel bez inFaktu) to tryb POPRAWNY — odmawiamy czytelnie, jak nadanie
    // bez skonfigurowanego kuriera.
    if (!korekta) return stronaOdmowy(reply, 503, zdanieBrakuProgramu(wyborProgramu) ?? `Wystawianie korekt nie jest skonfigurowane (brak inFaktu). ${GDZIE_KLUCZ_INFAKTU}`, { tytul: 'Nie udało się obsłużyć zwrotu', wroc: `/zamowienia/${z.id}/zwrot`, napisWroc: 'Wróć do ekranu zwrotu' });
    const zwrotId = Number(req.params.zwrotId);
    try {
      await korekta.wystaw(z.id, zwrotId);
    } catch (e) {
      // ⚠️ NIEUDANA PROBA MUSI ZOSTAWIC SLAD. Zerwane polaczenie ZOSTAWIA rezerwacje
      // (services/korekta.js), wiec bez wpisu w logu nie da sie potem odroznic „zlecenie
      // przepadlo" od „nikt nigdy nie kliknal".
      slad(z.id, 'zwrot.korekta', `BŁĄD: ${e.message}`);
      return stronaOdmowy(reply, 400, komunikatDlaOperatora(e), { tytul: 'Nie udało się obsłużyć zwrotu', wroc: `/zamowienia/${z.id}/zwrot`, napisWroc: 'Wróć do ekranu zwrotu' });
    }
    const po = zwrot(db, z.id, zwrotId);
    slad(z.id, 'zwrot.korekta', decyzja(
      req,
      `zlecona korekta do zwrotu z ${po?.data ?? '?'} (${po?.kwota ?? '?'} zł)`
      + `${po?.korekta_referencja ? `, referencja ${po.korekta_referencja}` : ''}`
      + `${po?.korekta_numer ? `, numer ${po.korekta_numer}` : ' — numer pojawi się po przetworzeniu'}.`,
    ));
    // ⚠️ Rozbieznosc z briefem: `reply.redirect(302, url)` NIE ISTNIEJE od Fastify 5
    // (w v4 bylo FSTDEP021; sygnatura to `redirect(url, code)`), a caly ten plik
    // uzywa jednoargumentowego wywolania (302 jest domyslnym kodem). Ta sama forma tutaj.
    // PRZ-147.03 (decyzja 9): ekran zwrotu, nie karta — tylko on pokazuje stan zlecenia,
    // a jego przeladowanie odczytuje status.
    return reply.redirect(adresZwrotu(req, z.id));
  });

  // ---------------------------------------------------------------------------------
  // ⚠️⚠️ DWA WYJSCIA ZE ZLECENIA KOREKTY, KTORE PRZEPADLO (recenzja 2026-08-15, C2).
  //
  // Zmierzone na zywym koncie: inFakt oddaje `201` NAWET NA PUSTE CIALO i odrzuca tresc
  // dopiero w przetwarzaniu w tle. Po progu ekran pisal „zlecenie zostało odrzucone" — i na
  // tym sie konczylo: przycisku „Wystaw korektę" juz nie bylo, skasowania zwrotu odmawial
  // `powodOdmowyUsunieciaZwrotu`, a zwrot zostawal NIEROZLICZONY NA ZAWSZE, trzymajac
  // zamowienie na liscie roboczej. Jedynym wyjsciem byl `UPDATE` na produkcyjnej bazie.
  //
  // Obie trasy CELOWO nie wymagaja skonfigurowanego inFaktu i CELOWO niczego tam nie wolaja —
  // dokladnie jak `/zamowienia/:id/faktura/odblokuj` i `/zamowienia/:id/faktura/skasowana`
  // (routes/zamowienia.js), ta sama konwencja i ten sam ksztalt wpisu w logu. Decyzje
  // podejmuje CZLOWIEK, ktory sprawdzil w inFakcie; log ma zapamietac, ze to byla decyzja,
  // a nie automat.
  // ---------------------------------------------------------------------------------

  // (1) „Sprawdziłem w inFakcie — korekty nie ma, odblokuj". Kasuje SAMA rezerwacje
  // (`korekta_zlecona_at`, `korekta_referencja`, `korekta_blad`) i otwiera droge do ponownego
  // zlecenia. ⚠️ Prog NIE ZWALNIA REZERWACJI AUTOMATYCZNIE — to ta sama regula, co przy
  // zerwanym polaczeniu: zaden uplyw czasu nie jest dowodem, ze dokument nie powstal.
  app.post('/zamowienia/:id/zwroty/:zwrotId/korekta/odblokuj', async (req, reply) => {
    const z = zamowienieAlbo404(req, reply);
    if (!z) return reply;
    const w = zwrot(db, z.id, Number(req.params.zwrotId));
    if (!w) return stronaOdmowy(reply, 404, 'Nie ma takiego zwrotu przy tym zamówieniu.', { tytul: 'Nie udało się obsłużyć zwrotu', wroc: `/zamowienia/${z.id}/zwrot`, napisWroc: 'Wróć do ekranu zwrotu' });
    // Regula (prog, numer, brak rezerwacji) mieszka w domenie — trasa jej nie liczy.
    const powod = powodOdmowyOdblokowaniaKorekty(w, { nazwa: nazwaProgramu });
    if (powod) {
      slad(z.id, 'zwrot.korekta.odblokowanie', `BŁĄD: ${powod}`);
      return stronaOdmowy(reply, 400, powod, { tytul: 'Nie udało się obsłużyć zwrotu', wroc: `/zamowienia/${z.id}/zwrot`, napisWroc: 'Wróć do ekranu zwrotu' });
    }
    let przed;
    try {
      przed = odblokujKorekte(db, z.id, w.id);
    } catch (e) {
      slad(z.id, 'zwrot.korekta.odblokowanie', `BŁĄD: ${e.message}`);
      return stronaOdmowy(reply, 400, `Nie udało się odblokować korekty: ${komunikatDlaOperatora(e)}`, { tytul: 'Nie udało się obsłużyć zwrotu', wroc: `/zamowienia/${z.id}/zwrot`, napisWroc: 'Wróć do ekranu zwrotu' });
    }
    slad(z.id, 'zwrot.korekta.odblokowanie', decyzja(
      req,
      'sprawdzone w inFakcie, korekty nie ma — rezerwacja zwrotu '
      + `z ${przed.data} (${przed.kwota} zł), zlecona ${przed.korekta_zlecona_at}`
      + `${przed.korekta_referencja ? `, referencja ${przed.korekta_referencja}` : ''}`
      + `${przed.korekta_blad ? `, błąd „${przed.korekta_blad}"` : ''} skasowana. `
      + 'Panel niczego w inFakcie nie kasował.',
    ));
    return reply.redirect(adresKarty(req, z.id));
  });

  // (2) „Korektę wystawiłem ręcznie" — zapis numeru dokumentu, ktory powstal POZA panelem.
  // ⚠️ BEZ TEJ DROGI zwrot do faktury skorygowanej recznie nigdy sie nie rozliczy
  // (`zwrotRozliczony` wymaga `korekta_numer`), a przy DRUGIEJ korekcie do tej samej faktury
  // jest to droga ZALECANA: panel odmawia jej swiadomie, bo nie umie odtworzyc stanu „przed"
  // po pierwszej korekcie (services/korekta.js).
  app.post('/zamowienia/:id/zwroty/:zwrotId/korekta/reczna', async (req, reply) => {
    const z = zamowienieAlbo404(req, reply);
    if (!z) return reply;
    const w = zwrot(db, z.id, Number(req.params.zwrotId));
    if (!w) return stronaOdmowy(reply, 404, 'Nie ma takiego zwrotu przy tym zamówieniu.', { tytul: 'Nie udało się obsłużyć zwrotu', wroc: `/zamowienia/${z.id}/zwrot`, napisWroc: 'Wróć do ekranu zwrotu' });
    const { numer, blad } = parsujNumerKorekty(w, req.body?.numer, { nazwa: nazwaProgramu, gdzie: gdzieProgramu });
    if (blad) {
      slad(z.id, 'zwrot.korekta.reczna', `BŁĄD: ${blad}`);
      return stronaOdmowy(reply, 400, blad, { tytul: 'Nie udało się obsłużyć zwrotu', wroc: `/zamowienia/${z.id}/zwrot`, napisWroc: 'Wróć do ekranu zwrotu' });
    }
    try {
      zapiszRecznyNumerKorekty(db, z.id, w.id, numer);
    } catch (e) {
      slad(z.id, 'zwrot.korekta.reczna', `BŁĄD: ${e.message}`);
      return stronaOdmowy(reply, 400, `Nie udało się zapisać numeru korekty: ${komunikatDlaOperatora(e)}`, { tytul: 'Nie udało się obsłużyć zwrotu', wroc: `/zamowienia/${z.id}/zwrot`, napisWroc: 'Wróć do ekranu zwrotu' });
    }
    slad(z.id, 'zwrot.korekta.reczna', decyzja(
      req,
      `korekta ${numer} do zwrotu z ${w.data} (${w.kwota} zł) została wystawiona RĘCZNIE `
      + 'w inFakcie — panel jej nie wystawiał, tylko odnotował numer podany przez człowieka.',
    ));
    return reply.redirect(adresKarty(req, z.id));
  });
}
