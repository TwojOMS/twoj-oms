import { createAtrapaInfaktu } from '../deploy/proba/atrapy/infakt.mjs';

// ERLI trafia do OMS dopiero przez poller. Po jego zapisie uzupełniamy demo,
// korzystając z API atrapy inFaktu (również gdy jej konto jest już zasiane).
export async function uzupelnijDemoErli({ db, kanal, env, teraz, log }) {
  const maKanaly = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kanaly_sprzedazy'").get();
  if (kanal !== 'erli_polcien' || !maKanaly || !db.prepare("SELECT 1 FROM kanaly_sprzedazy WHERE klucz=? AND typ='erli'").get(kanal)) return;
  const infakt = createAtrapaInfaktu({ db, env, teraz, log });
  const zamowienia = db.prepare('SELECT * FROM zamowienia WHERE sklep=?').all(kanal);
  for (const z of zamowienia) {
    const surowe = JSON.parse(z.surowe_json);
    const poZakupie = godziny => new Date(Date.parse(z.utworzone_at) + godziny * 3600000).toISOString();
    if (surowe.sellerStatus === 'inProgress') {
      db.prepare('UPDATE zamowienia SET w_realizacji_at=COALESCE(w_realizacji_at,?) WHERE id=?').run(poZakupie(3), z.id);
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
    if (!['PC-ERLI-0002', 'PC-ERLI-0005', 'PC-ERLI-0013'].includes(z.numer)) continue;
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
