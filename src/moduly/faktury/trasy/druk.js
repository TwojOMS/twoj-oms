import { pobierzZamowienie, dopiszLog } from '../../../oms/db/zamowienia.js';

import { dodajFaktureDoKolejki, fakturyDoWziecia, zamowienieDlaPozycji, oznaczFaktureWydrukowana, oznaczBladDrukuFaktury, porzucFakture, ostatniaPozycjaDlaFaktury } from '../db/kolejka-druku-faktur.js';

import { bezpiecznyPowrotNaListe } from '../../../domena/filtry-listy.js';

import { adresKartyZamowienia } from '../../../domena/adres-karty-zamowienia.js';

import { komunikatDlaOperatora } from '../../../domena/bledy.js';

import { bezpiecznaNazwa } from '../../../domena/pliki.js';

import { ktoKlikal } from '../../zamowienia/lista.js';

export function registerDrukFakturRoutes(app, { db, config = {}, faktura, fakturaHurtem, proforma, infakt, fakturaAllegro, ksefDoczytanie, wczytajListe, miniaturyEkranu }) {

const adresPowrotuNaKarte = (req, id, opcje = {}) => adresKartyZamowienia(id, {
    powrot: powrotKarty(req),
    ...opcje,
  }, config.definicje);

const powrotKarty = (req) => bezpiecznyPowrotNaListe(req.query?.powrot ?? req.body?.powrot, config.definicje);

app.get('/zamowienia/:id/faktura/pdf', async (req, reply) => {
    const id = Number(req.params.id);
    if (!pobierzZamowienie(db, id)) return reply.code(404).send('Nie ma takiego zamówienia');
    if (!faktura) return reply.code(503).send('Panel nie ma podpiętego inFaktu.');

    let wynik;
    try {
      wynik = await faktura.pdf(id);
    } catch (e) {
      dopiszLog(db, id, { akcja: 'faktura.pdf', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się pobrać faktury: ${komunikatDlaOperatora(e)}`);
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
    if (!z) return reply.code(404).send('Nie ma takiego zamówienia');
    // ⚠️ `infakt_uuid`, nie sam wiersz faktury: bez niego nie ma czego pobrac z inFaktu
    // (wiersz istnieje takze jako REZERWACJA, przed powstaniem dokumentu — patrz
    // domain/faktura-stan.js). Kolejka z zadaniem bez tresci wracalaby w petli.
    if (!z.faktura?.infakt_uuid) {
      return reply.code(400).send('Ta faktura nie ma jeszcze dokumentu w inFakcie — nie ma czego drukować.');
    }
    dodajFaktureDoKolejki(db, z.faktura.id);
    dopiszLog(db, id, {
      akcja: 'faktura.druk',
      wynik: `DECYZJA CZŁOWIEKA (${ktoKlikal(req)}): faktura ${z.faktura.numer ?? ''} dodana do kolejki druku.`,
    });
    return reply.redirect(adresPowrotuNaKarte(req, id, { kotwica: 'faktura' }));
  });

app.post('/zamowienia/:id/faktura/druk-porzuc', async (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z?.faktura) return reply.code(404).send('Nie ma takiej faktury');
    const poz = ostatniaPozycjaDlaFaktury(db, z.faktura.id);
    if (!poz) return reply.code(404).send('Ta faktura nie czeka w kolejce druku.');
    porzucFakture(db, poz.id);
    dopiszLog(db, id, {
      akcja: 'faktura.druk',
      wynik: `DECYZJA CZŁOWIEKA (${ktoKlikal(req)}): porzucony wydruk faktury (${poz.ostatni_blad ?? 'bez podanego błędu'}).`,
    });
    return reply.redirect(adresPowrotuNaKarte(req, id, { kotwica: 'faktura' }));
  });

app.get('/kolejka-druku-faktur', async (req) => fakturyDoWziecia(db, {
    stanowisko: String(req.query?.stanowisko ?? '').trim() || 'nieznane',
  }));

app.get('/kolejka-druku-faktur/:id/pdf', async (req, reply) => {
    const id = Number(req.params.id);
    const cel = zamowienieDlaPozycji(db, id);
    if (!cel) return reply.code(404).send('Nie ma takiej pozycji w kolejce druku faktur.');
    if (!faktura) return reply.code(503).send('Panel nie ma podpiętego inFaktu.');
    let wynik;
    try {
      wynik = await faktura.pdf(cel.zamowienieId);
    } catch (e) {
      dopiszLog(db, cel.zamowienieId, { akcja: 'faktura.druk', wynik: `BŁĄD pobrania PDF: ${e.message}` });
      return reply.code(400).send(`Nie udało się pobrać faktury: ${komunikatDlaOperatora(e)}`);
    }
    const nazwaPliku = `faktura-${bezpiecznaNazwa(wynik.numer ?? String(cel.zamowienieId))}.pdf`;
    return reply.type('application/pdf')
      .header('Content-Disposition', `attachment; filename="${nazwaPliku}"`)
      .send(wynik.bajty);
  });

app.post('/kolejka-druku-faktur/:id/wydrukowano', async (req, reply) => {
    try {
      oznaczFaktureWydrukowana(db, Number(req.params.id));
    } catch (e) {
      return reply.code(404).send(komunikatDlaOperatora(e));
    }
    return { ok: true };
  });

app.post('/kolejka-druku-faktur/:id/blad', async (req, reply) => {
    const powod = String(req.body?.powod ?? '').trim() || 'nieznany błąd druku';
    try {
      oznaczBladDrukuFaktury(db, Number(req.params.id), powod);
    } catch (e) {
      return reply.code(404).send(komunikatDlaOperatora(e));
    }
    return { ok: true };
  });

}
