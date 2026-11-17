import { createAtrapaInfaktu } from '../deploy/proba/atrapy/infakt.mjs';
import { createAtrapaErli } from '../deploy/proba/atrapy/erli.mjs';
import { ofertaPoIdZewnetrznym, wstawOferte, zmienOferte, ustawieniaOfertKonta,
  zapiszUstawieniaOfertKonta } from '../src/oms/db/oferty-kanalow.ts';
import { idProduktuErli } from '../src/moduly/magazyn/services/petla-ofert.js';
import { zapiszKarte } from '../src/oms/db/magazyn.js';
import { PRODUKTY } from './demo-dane-firma.mjs';

async function uzupelnijOfertyDemo({ db, kanal, env, teraz, log }) {
  const karty = db.prepare("SELECT * FROM karty_produktow WHERE sku IN ('LMP-STO-001', 'LMP-STO-002', 'LMP-STO-003', 'LMP-STO-004', 'LMP-STO-005', 'LMP-STO-006') ORDER BY sku").all();
  // Starsze bazy demo mogą jeszcze nie mieć katalogu; nie tworzymy zastępczych kart.
  if (karty.length !== 6) return;
  const opcje = { teraz: new Date(teraz()).toISOString() };
  if (!ustawieniaOfertKonta(db, kanal).zapisane) {
    zapiszUstawieniaOfertKonta(db, kanal, { czynne: false, stalaIlosc: 5,
      czasWysylkiDni: 2, cennikDostaw: '*', stawkaVat: '23' }, opcje);
  }
  const erli = createAtrapaErli({ db, kanal, env, teraz, log });
  const produkty = await erli.szukajProduktow();
  const stany = ['aktywna', 'do_wyslania', 'problem', 'blad', 'aktywna', 'aktywna'];
  for (const [i, karta] of karty.entries()) {
    const przejeta = i === 5;
    const idZewnetrzne = przejeta ? 'PC-RECZNA-LMP-STO-006' : idProduktuErli(db, karta.id);
    if (!db.prepare('SELECT 1 FROM zdjecia_kart WHERE karta_id=?').get(karta.id)) {
      db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at)
        VALUES (?, 0, 'woo', ?, ?)`).run(karta.id, `https://zdjecia.example/${karta.sku}.jpg`, opcje.teraz);
    }
    if (ofertaPoIdZewnetrznym(db, kanal, idZewnetrzne)) continue;
    // Starszy generator tworzy cenę w lustrze, ale nie na karcie. Scenariusz ceny
    // potrzebuje ceny karty; uzupełniamy wyłącznie brak z tego samego katalogu demo.
    if (karta.cena_gr === null) {
      karta.cena_gr = PRODUKTY.find(p => p.sku === karta.sku).cena_gr;
      zapiszKarte(db, karta.id, { cena_gr: karta.cena_gr }, { at: opcje.teraz });
    }
    const oferta = wstawOferte(db, { kartaId: karta.id, kanal, idZewnetrzne,
      stan: stany[i], pochodzenie: przejeta ? 'przejeta' : 'oms' }, opcje);
    if (i === 1) continue; // Jeszcze nic nie wysłano.
    if (i === 3) {
      zmienOferte(db, oferta.id, { blad: 'ERLI odrzuciło zapis produktu — sprawdź dane i ponów wysyłkę.', liczbaProb: 1 }, opcje);
      continue;
    }
    const cena = i === 4 ? Math.round(karta.cena_gr / 1.3) : karta.cena_gr;
    const produkt = { name: karta.nazwa, sku: karta.sku, price: cena, stock: 5, status: 'active',
      description: '<p>Lampa z katalogu Pracownia Półcień.</p>', images: [],
      externalCategories: [{ source: 'shop', breadcrumb: [{ id: i === 2 ? '999-lampy-demo' : karta.kategoria_glowna, name: karta.kategoria_glowna }] }],
      categories: i === 2 ? [] : [{ id: 'lampy-demo', name: 'Lampy' }],
      buyableProblems: i === 2 ? ['category'] : [], frozen: {}, currency: 'PLN' };
    if (!produkty.some(p => p.externalId === idZewnetrzne)) await erli.utworzProdukt(idZewnetrzne, produkt);
    zmienOferte(db, oferta.id, {
      wyslanoAt: przejeta ? null : opcje.teraz, wyslanaCenaGr: przejeta ? null : cena,
      wyslanaIlosc: przejeta ? null : 5, odczytCenaGr: cena, odczytIlosc: 5, odczytStatus: 'active', odczytanoAt: opcje.teraz,
      problemy: i === 2 ? [{ kod: 'category', tekst: 'ERLI nie rozpoznało kategorii — przypisz ją w panelu ERLI.' }]
        : i === 4 ? [{ kod: 'cena', tekst: 'Zmiana ceny przekracza próg — czeka na potwierdzenie, do ERLI nic nie poszło.' }] : [],
      cenaDoPotwierdzeniaGr: i === 4 ? karta.cena_gr : null,
    }, opcje);
  }
}

// ERLI trafia do OMS dopiero przez poller. Po jego zapisie uzupełniamy demo,
// korzystając z API atrapy inFaktu (również gdy jej konto jest już zasiane).
export async function uzupelnijDemoErli({ db, kanal, env, teraz, log }) {
  const maKanaly = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kanaly_sprzedazy'").get();
  if (kanal !== 'erli_polcien' || !maKanaly || !db.prepare("SELECT 1 FROM kanaly_sprzedazy WHERE klucz=? AND typ='erli'").get(kanal)) return;
  await uzupelnijOfertyDemo({ db, kanal, env, teraz, log });
  const infakt = createAtrapaInfaktu({ db, env, teraz, log });
  const zamowienia = db.prepare('SELECT * FROM zamowienia WHERE sklep=?').all(kanal);
  const terazMs = new Date(teraz()).getTime();
  const dzienPl = (ms) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
  const paczka = db.prepare(`INSERT INTO przesylki (zamowienie_id,kurier,status,numer_listu,etykieta_reczna,nadana_recznie,
    utworzona_at,kolejnosc,zrodlo_numeru,status_kuriera,status_kuriera_at,status_kuriera_pobrany_at)
    VALUES (?,?,'nadana',?,1,1,?,1,'demo',?,?,?)`);
  const kurierDostawy = (surowe) => surowe.delivery.typeId === 'dpd' ? 'dpd' : 'inpost';
  // Numery listów z prefiksem 0000 w formacie przewoźnika (DPD 13 cyfr + U, InPost 24 cyfry); 7… nie spotyka się z generatorem.
  const numerPaczki = (id, surowe) => kurierDostawy(surowe) === 'dpd'
    ? `0000${String(700000000 + id)}U` : `00007${String(id).padStart(19, '0')}`;
  for (const z of zamowienia) {
    const surowe = JSON.parse(z.surowe_json);
    const poZakupie = godziny => new Date(Date.parse(z.utworzone_at) + godziny * 3600000).toISOString();
    if (surowe.sellerStatus === 'inProgress') {
      db.prepare('UPDATE zamowienia SET w_realizacji_at=COALESCE(w_realizacji_at,?) WHERE id=?').run(poZakupie(3), z.id);
    }
    // „nowe” tylko z dziś. Opłacone zamówienie ERLI sprzed dzisiejszego dnia, którego
    // sprzedawca nie ruszył (`created`), idzie w realizację, a starsze niż 3 dni jest już wysłane — jak w pętli generatora.
    // Nieopłacone (`pending`) zostaje nowe: bez wpłaty pracownia go nie rusza.
    const wiekH = (terazMs - Date.parse(z.utworzone_at)) / 3600000;
    const doRuszenia = surowe.sellerStatus === 'created' && surowe.status === 'purchased' && !z.anulowane
      && !z.w_realizacji_at && !z.wyslane_at && dzienPl(Date.parse(z.utworzone_at)) < dzienPl(terazMs);
    if (doRuszenia && wiekH < 72) {
      db.prepare('UPDATE zamowienia SET w_realizacji_at=? WHERE id=?').run(poZakupie(Math.min(2, wiekH - 0.1)), z.id);
      // Najstarsze z nich ma już etykietę — kurier jeszcze nie odebrał (zakładka Przesyłki → Utworzone).
      if (wiekH >= 24 && surowe.delivery.typeId !== 'odbiorOsobisty' && !db.prepare('SELECT 1 FROM przesylki WHERE zamowienie_id=?').get(z.id)) {
        paczka.run(z.id, kurierDostawy(surowe), numerPaczki(z.id, surowe), poZakupie(Math.min(4, wiekH / 2)), null, null, null);
      }
    } else if (doRuszenia) {
      db.prepare('UPDATE zamowienia SET w_realizacji_at=?, wyslane_at=? WHERE id=?').run(poZakupie(3), poZakupie(8), z.id);
      if (surowe.delivery.typeId !== 'odbiorOsobisty' && !db.prepare('SELECT 1 FROM przesylki WHERE zamowienie_id=?').get(z.id)) {
        // Do tygodnia — paczka jeszcze w drodze (ostatni skan wczoraj, bez alarmu „stoi bez ruchu”); starsze doręczone.
        const wDrodze = wiekH < 7 * 24;
        paczka.run(z.id, kurierDostawy(surowe), numerPaczki(z.id, surowe), poZakupie(8),
          wDrodze ? 'Przesyłka w drodze' : 'Przesyłka doręczona do odbiorcy',
          wDrodze ? new Date(terazMs - 20 * 3600000).toISOString() : poZakupie(40), new Date(terazMs).toISOString());
      }
    }
    if (surowe.sellerStatus === 'sent') {
      db.prepare('UPDATE zamowienia SET w_realizacji_at=COALESCE(w_realizacji_at,?), wyslane_at=COALESCE(wyslane_at,?) WHERE id=?')
        .run(poZakupie(3), poZakupie(8), z.id);
      const numer = surowe.deliveryTracking?.trackingNumber;
      if (numer && !db.prepare('SELECT 1 FROM przesylki WHERE zamowienie_id=?').get(z.id)) {
        const kurier = surowe.delivery.typeId === 'dpd' ? 'dpd' : 'inpost';
        db.prepare(`INSERT INTO przesylki (zamowienie_id,kurier,status,numer_listu,etykieta_reczna,nadana_recznie,
          utworzona_at,kolejnosc,zrodlo_numeru,status_kuriera,status_kuriera_at,status_kuriera_pobrany_at)
          VALUES (?,?,'nadana',?,1,1,?,1,'demo','Przesyłka doręczona do odbiorcy',?,?)`)
          .run(z.id, kurier, numer, z.wyslane_at ?? poZakupie(8), poZakupie(32), new Date(teraz()).toISOString());
      }
    }
    // Więcej faktur ERLI — także osoba prywatna (0003) i paczka wysłana (0014); również starsze
    // zamówienia 0018–0029 (ok. 30% ERLI z fakturą, jak w innych kanałach demo).
    if (!['PC-ERLI-0002', 'PC-ERLI-0003', 'PC-ERLI-0005', 'PC-ERLI-0013', 'PC-ERLI-0014',
      'PC-ERLI-0018', 'PC-ERLI-0021', 'PC-ERLI-0025', 'PC-ERLI-0029'].includes(z.numer)) continue;
    if (db.prepare('SELECT 1 FROM faktury WHERE zamowienie_id=?').get(z.id)) continue;
    const firma = surowe.user.invoiceAddress;
    const adres = firma ?? surowe.user.deliveryAddress;
    const client_id = await infakt.zalozKlienta({ company_name: firma?.companyName ?? `${adres.firstName} ${adres.lastName}`,
      nip: firma?.nip, street: adres.address, city: adres.city, postal_code: adres.zip, country: 'PL' });
    const services = db.prepare('SELECT nazwa,ilosc,brutto_linii,vat FROM pozycje WHERE zamowienie_id=? ORDER BY id').all(z.id)
      .map(p => ({ name: p.nazwa, quantity: Number(p.ilosc), gross_price: Math.round(Number(p.brutto_linii) * 100), tax_symbol: String(p.vat) }));
    services.push({ name: 'Wysyłka', quantity: 1, gross_price: surowe.delivery.price, tax_symbol: '23' });
    const dokument = await infakt.wystaw({ client_id, services,
      invoice_date: z.utworzone_at.slice(0, 10), payment_method: z.pobranie ? 'delivery' : 'transfer',
      paid_price: z.oplacone_at ? surowe.totalPrice : 0 });
    db.prepare('INSERT INTO faktury (zamowienie_id,infakt_uuid,numer,utworzona_at) VALUES (?,?,?,?)')
      .run(z.id, dokument.uuid, dokument.numer, z.utworzone_at);
  }
}
