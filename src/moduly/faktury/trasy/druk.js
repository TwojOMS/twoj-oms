import { pobierzZamowienie, dopiszLog } from '../../../oms/db/zamowienia.js';
import { idDokumentu } from '../../../domena/dokument-programu.js';

import { dodajFaktureDoKolejki, zamowienieDlaPozycji, oznaczFaktureWydrukowana, oznaczBladDrukuFaktury, porzucFakture, ostatniaPozycjaDlaFaktury } from '../db/kolejka-druku-faktur.js';
import {
  dodajProformeDoKolejki, pozycjeDrukuDoWziecia, proformaDlaPozycji, oznaczProformeWydrukowana, oznaczBladDrukuProformy,
  porzucProforme, ostatniaPozycjaDlaProformy, porzucUniewaznionaPozycje,
} from '../db/kolejka-druku-proform.js';
import { pobierzProforme } from '../db/proformy.js';
import { czyWolnoDrukowacProforme, rozpoznajPozycjeDruku } from '../../../domena/druk-proformy.js';
import { zapiszZgloszenie } from '../db/stanowiska-druku.js';

import { bezpiecznyPowrotNaListe } from '../../../domena/filtry-listy.js';

import { adresKartyZamowienia } from '../../../domena/adres-karty-zamowienia.js';

import { komunikatDlaOperatora } from '../../../domena/bledy.js';
import { stronaOdmowy } from '../../../core/web/odmowa.js';

import { bezpiecznaNazwa } from '../../../domena/pliki.js';

import { ktoKlikal } from '../../zamowienia/lista.js';

import { zdanieBrakuProgramu } from '../../../domena/wybor-programu.js';
import { odmianaNazwyProgramu } from '../../../domena/nazwa-programu.js';
import { zProgramu } from '../../../integracje/program-fakturowy.ts';

export function registerDrukFakturRoutes(app, { db, config = {}, faktura, fakturaHurtem, proforma, infakt, fakturaAllegro, ksefDoczytanie, wczytajListe, miniaturyEkranu, wyborProgramu = null, teraz = () => new Date() }) {

const nazwaProgramu = odmianaNazwyProgramu(zProgramu({ infakt }));
// PRZ-121.03a: przy jawnym „brak” zdanie o wyłączonych fakturach zamiast „Panel nie ma podpiętego inFaktu.”.
const bezProgramu = () => zdanieBrakuProgramu(wyborProgramu, 'PDF wcześniejszej faktury pobierzesz w programie, w którym ją wystawiono.') ?? 'Panel nie ma podpiętego inFaktu.';

const adresPowrotuNaKarte = (req, id, opcje = {}) => adresKartyZamowienia(id, {
    powrot: powrotKarty(req),
    ...opcje,
  }, config.definicje);

const powrotKarty = (req) => bezpiecznyPowrotNaListe(req.query?.powrot ?? req.body?.powrot, config.definicje);

// PRZ-152.G13f2: odmowa linku „PDF” (nowa karta) i formularzy „Drukuj” / „Porzuć wydruk” z karty zamówienia —
// strona w układzie OMS z powrotem na kartę (id z adresu, kodowany w adresKartyZamowienia). Status i tekst bez zmian.
// Proformy: `:id` to id proformy, więc karta liczy się z `p.zamowienie_id` (`idKarty`). Nieznane zamówienie
// albo proforma (`odmowaBezKarty`): karty nie ma — powrót na listę (bezpieczne `?powrot`).
const odmowaDruku = (req, reply, status, komunikat, tytul, idKarty = req.params.id) => stronaOdmowy(reply, status, komunikat, {
    tytul, wroc: adresPowrotuNaKarte(req, idKarty, { kotwica: 'faktura' }), napisWroc: 'Wróć do zamówienia',
  });
const odmowaBezKarty = (req, reply, status, komunikat, tytul) => stronaOdmowy(reply, status, komunikat, {
    tytul, wroc: powrotKarty(req), napisWroc: 'Wróć do listy zamówień',
  });
const PROFORMA_NIE_DO_DRUKU = 'Nie udało się wysłać proformy do druku';
const NIE_POBRANO = 'Nie udało się pobrać faktury';
const NIE_DO_DRUKU = 'Nie udało się wysłać faktury do druku';
const NIE_PORZUCONO = 'Nie udało się porzucić wydruku';

// PRZ-122.B10b: pobranie zamyka fakturę TwojeFaktury — bez HEAD (Fastify domyślnie = handler GET).
app.get('/zamowienia/:id/faktura/pdf', { exposeHeadRoute: false }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!pobierzZamowienie(db, id)) return odmowaBezKarty(req, reply, 404, 'Nie ma takiego zamówienia', NIE_POBRANO);
    if (!faktura) return odmowaDruku(req, reply, 503, bezProgramu(), NIE_POBRANO);

    let wynik;
    try {
      wynik = await faktura.pdf(id);
    } catch (e) {
      // B10a: faktura VAT (B2B i B2C — B2C-QR) bez numeru KSeF — „jeszcze nie”, nie błąd (bez wpisu BŁĄD); zdanie z adresem podglądu.
      if (e?.czekaNaKsef) return odmowaDruku(req, reply, 409, komunikatDlaOperatora(e), NIE_POBRANO);
      dopiszLog(db, id, { akcja: 'faktura.pdf', wynik: `BŁĄD: ${e.message}` });
      return odmowaDruku(req, reply, 400, `Nie udało się pobrać faktury: ${komunikatDlaOperatora(e)}`, NIE_POBRANO);
    }
    // Numer faktury ma ukosniki („65/07/2026") — w nazwie pliku sa nielegalne na Windowsie,
    // a to na Windows ten plik jedzie prosto do drukarki.
    const nazwaPliku = `faktura-${bezpiecznaNazwa(wynik.numer ?? String(id))}.pdf`;
    return reply.type('application/pdf')
      .header('Content-Disposition', `attachment; filename="${nazwaPliku}"`)
      .send(wynik.bajty);
  });

app.post('/zamowienia/:id/faktura/drukuj', async (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) return odmowaBezKarty(req, reply, 404, 'Nie ma takiego zamówienia', NIE_DO_DRUKU);
    // ⚠️ `infakt_uuid`, nie sam wiersz faktury: bez niego nie ma czego pobrac z inFaktu
    // (wiersz istnieje takze jako REZERWACJA, przed powstaniem dokumentu — patrz
    // domain/faktura-stan.js). Kolejka z zadaniem bez tresci wracalaby w petli.
    if (!idDokumentu(z.faktura)) {
      return odmowaDruku(req, reply, 400, `Ta faktura nie ma jeszcze dokumentu w ${nazwaProgramu.miejscownik} — nie ma czego drukować.`, NIE_DO_DRUKU);
    }
    dodajFaktureDoKolejki(db, z.faktura.id);
    dopiszLog(db, id, {
      akcja: 'faktura.druk',
      wynik: `Ręcznie (${ktoKlikal(req)}): faktura ${z.faktura.numer ?? ''} dodana do kolejki druku.`,
    });
    return reply.redirect(adresPowrotuNaKarte(req, id, { kotwica: 'faktura' }));
  });

app.post('/zamowienia/:id/faktura/druk-porzuc', async (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) return odmowaBezKarty(req, reply, 404, 'Nie ma takiej faktury', NIE_PORZUCONO);
    if (!z.faktura) return odmowaDruku(req, reply, 404, 'Nie ma takiej faktury', NIE_PORZUCONO);
    const poz = ostatniaPozycjaDlaFaktury(db, z.faktura.id);
    if (!poz) return odmowaDruku(req, reply, 404, 'Ta faktura nie czeka w kolejce druku.', NIE_PORZUCONO);
    porzucFakture(db, poz.id);
    dopiszLog(db, id, {
      akcja: 'faktura.druk',
      wynik: `Ręcznie (${ktoKlikal(req)}): porzucony wydruk faktury (${poz.ostatni_blad ?? 'bez podanego błędu'}).`,
    });
    return reply.redirect(adresPowrotuNaKarte(req, id, { kotwica: 'faktura' }));
  });

// PRZ-152.G10a (D4, D5): druk proformy. Wolno każdą nieunieważnioną (decyzja właściciela 05.11: „po prostu jest
// proforma”). Adresy mieszczą się w regule `/^\/proformy/` (ekrany.js) — uprawnienia bez zmian. Drukarki
// serwer nie sprawdza, tak jak przy fakturze.
app.post('/proformy/:id/drukuj', async (req, reply) => {
    const p = pobierzProforme(db, Number(req.params.id));
    if (!p) return odmowaBezKarty(req, reply, 404, 'Nie ma takiej proformy.', PROFORMA_NIE_DO_DRUKU);
    const zgoda = czyWolnoDrukowacProforme(p);
    if (!zgoda.wolno) return odmowaDruku(req, reply, 400, zgoda.powod, PROFORMA_NIE_DO_DRUKU, p.zamowienie_id);
    // Bez pliku czuwacz dostawałby w kółko błąd PDF — odmowa od razu, przy kliknięciu.
    if (!p.plik_sciezka) return odmowaDruku(req, reply, 400, `Proforma ${p.numer} nie ma zapisanego pliku PDF — nie ma czego drukować.`, PROFORMA_NIE_DO_DRUKU, p.zamowienie_id);
    dodajProformeDoKolejki(db, p.id);
    dopiszLog(db, p.zamowienie_id, {
      akcja: 'proforma.druk',
      wynik: `Ręcznie (${ktoKlikal(req)}): proforma ${p.numer} dodana do kolejki druku.`,
    });
    return reply.redirect(adresPowrotuNaKarte(req, p.zamowienie_id, { kotwica: 'faktura' }));
  });

app.post('/proformy/:id/druk-porzuc', async (req, reply) => {
    const p = pobierzProforme(db, Number(req.params.id));
    if (!p) return odmowaBezKarty(req, reply, 404, 'Nie ma takiej proformy.', NIE_PORZUCONO);
    const poz = ostatniaPozycjaDlaProformy(db, p.id);
    if (!poz) return odmowaDruku(req, reply, 404, 'Ta proforma nie czeka w kolejce druku.', NIE_PORZUCONO, p.zamowienie_id);
    porzucProforme(db, poz.id);
    dopiszLog(db, p.zamowienie_id, {
      akcja: 'proforma.druk',
      wynik: `Ręcznie (${ktoKlikal(req)}): porzucony wydruk proformy ${p.numer} (${poz.ostatni_blad ?? 'bez podanego błędu'}).`,
    });
    return reply.redirect(adresPowrotuNaKarte(req, p.zamowienie_id, { kotwica: 'faktura' }));
  });

// D3: czuwacz bez zmian — jedna lista dla faktur i proform; pozycja proformy ma id „p<n>”, a trasy niżej
// rozpoznają przedrostek. Id bez przedrostka liczy się jak dotąd (`Number`), zniekształcone „p…” → 404.
const pozycjaZAdresu = (req) => rozpoznajPozycjeDruku(req.params.id);
const BRAK_POZYCJI = 'Nie ma takiej pozycji w kolejce druku faktur.';

// Recenzja G10a: proformę można unieważnić już PO zajęciu pozycji przez czuwacza (drukuje po kolei, do
// 120 s na pozycję), więc PDF sprawdza ją jeszcze raz. Unieważniona → pozycja oczekująca porzucona
// z tym samym powodem co przy liście, odpowiedź 409 z tekstem odmowy; `null` = można dalej.
// Potwierdzenie (…/wydrukowano) NIE odmawia — PDF wyszedł, gdy proforma była ważna (recenzja 2).
const odmowaUniewaznionej = (idPozycji, cel, reply) => {
    const zgoda = czyWolnoDrukowacProforme({ numer: cel.numer, uniewazniona_at: cel.uniewaznionaAt });
    if (zgoda.wolno) return null;
    porzucUniewaznionaPozycje(db, idPozycji);
    return reply.code(409).send(zgoda.powod);
  };

app.get('/kolejka-druku-faktur', async (req) => {
    const stanowisko = String(req.query?.stanowisko ?? '').trim();
    // PRZ-126.C05a: odpytanie = zgłoszenie komputera z drukarką (karta wyszarza „Drukuj” bez zgłoszenia z 5 min).
    // Zapis z dławieniem (raz na 60 s na stanowisko); jego błąd nie psuje odpowiedzi dla czuwacza.
    try {
      zapiszZgloszenie(db, stanowisko, teraz());
    } catch (e) {
      req.log?.warn?.({ druk: 'zgłoszenie stanowiska', blad: e?.message }, 'Druk faktur: nie zapisano zgłoszenia stanowiska');
    }
    return pozycjeDrukuDoWziecia(db, { stanowisko: stanowisko || 'nieznane' });
  });

app.get('/kolejka-druku-faktur/:id/pdf', { exposeHeadRoute: false }, async (req, reply) => {
    const poz = pozycjaZAdresu(req);
    if (!poz) return reply.code(404).send(BRAK_POZYCJI);
    if (poz.rodzaj === 'proforma') return pdfProformy(poz.id, reply);
    const id = poz.id;
    const cel = zamowienieDlaPozycji(db, id);
    if (!cel) return reply.code(404).send(BRAK_POZYCJI);
    if (!faktura) return reply.code(503).send(bezProgramu());
    let wynik;
    try {
      wynik = await faktura.pdf(cel.zamowienieId);
    } catch (e) {
      if (e?.czekaNaKsef) return reply.code(409).send(komunikatDlaOperatora(e));
      dopiszLog(db, cel.zamowienieId, { akcja: 'faktura.druk', wynik: `BŁĄD pobrania PDF: ${e.message}` });
      return reply.code(400).send(`Nie udało się pobrać faktury: ${komunikatDlaOperatora(e)}`);
    }
    const nazwaPliku = `faktura-${bezpiecznaNazwa(wynik.numer ?? String(cel.zamowienieId))}.pdf`;
    return reply.type('application/pdf')
      .header('Content-Disposition', `attachment; filename="${nazwaPliku}"`)
      .send(wynik.bajty);
  });

// PDF pozycji proformy to ZAPISANY plik (`proforma.pdf`, ten sam co „PDF” na karcie) — migawka dokumentu,
// który klient dostał, a nie dokument generowany od nowa.
const pdfProformy = (idPozycji, reply) => {
    const cel = proformaDlaPozycji(db, idPozycji);
    if (!cel) return reply.code(404).send(BRAK_POZYCJI);
    const odmowa = odmowaUniewaznionej(idPozycji, cel, reply);
    if (odmowa) return odmowa;
    if (!proforma) return reply.code(503).send('Proformy nie są skonfigurowane.');
    let wynik;
    try {
      wynik = proforma.pdf(cel.proformaId);
    } catch (e) {
      dopiszLog(db, cel.zamowienieId, { akcja: 'proforma.druk', wynik: `BŁĄD pobrania PDF: ${e.message}` });
      return reply.code(400).send(`Nie udało się pobrać proformy: ${komunikatDlaOperatora(e)}`);
    }
    const nazwaPliku = `proforma-${bezpiecznaNazwa(wynik.numer ?? cel.numer ?? String(cel.proformaId))}.pdf`;
    return reply.type('application/pdf')
      .header('Content-Disposition', `attachment; filename="${nazwaPliku}"`)
      .send(wynik.bajty);
  };

app.post('/kolejka-druku-faktur/:id/wydrukowano', async (req, reply) => {
    const poz = pozycjaZAdresu(req);
    if (!poz) return reply.code(404).send(BRAK_POZYCJI);
    try {
      // Unieważniona w trakcie druku: kartka już wyszła — zapis prawdy z notatką (db), bez odmowy.
      if (poz.rodzaj === 'proforma') oznaczProformeWydrukowana(db, poz.id);
      else oznaczFaktureWydrukowana(db, poz.id);
    } catch (e) {
      return reply.code(404).send(komunikatDlaOperatora(e));
    }
    return { ok: true };
  });

app.post('/kolejka-druku-faktur/:id/blad', async (req, reply) => {
    const powod = String(req.body?.powod ?? '').trim() || 'nieznany błąd druku';
    const poz = pozycjaZAdresu(req);
    if (!poz) return reply.code(404).send(BRAK_POZYCJI);
    try {
      if (poz.rodzaj === 'proforma') oznaczBladDrukuProformy(db, poz.id, powod);
      else oznaczBladDrukuFaktury(db, poz.id, powod);
    } catch (e) {
      return reply.code(404).send(komunikatDlaOperatora(e));
    }
    return { ok: true };
  });

}
