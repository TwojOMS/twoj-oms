// Operacja jednorazowa: używaj wyłącznie po niezależnym potwierdzeniu GET
// /pickups/create-commands/{commandId} oraz GET /pickups/{pickupId} w Allegro.
// Nigdy nie wywołuje POST zlecającego drugi podjazd.
import { openOmsDb } from '../src/oms/db/db.ts';
import { importujPotwierdzonyPodjazd } from '../src/moduly/wysylka/db/podjazdy.js';

const [idTekst, kanal, shipmentId, numerListu, commandId, pickupId,
  carrierPickupId, date, minTime, maxTime] = process.argv.slice(2);
const przesylkaId = Number(idTekst);
if (!Number.isSafeInteger(przesylkaId) || przesylkaId <= 0 || !kanal?.startsWith('allegro_')
  || !shipmentId || !numerListu || !commandId || !pickupId || !carrierPickupId
  || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')
  || !/^\d{2}:\d{2}$/.test(minTime ?? '') || !/^\d{2}:\d{2}$/.test(maxTime ?? '')
  || !process.env.OMS_DB_PATH) {
  throw new Error('Wymagane: ID, kanał, shipmentId, numer listu, commandId, pickupId, carrierPickupId, data, minTime, maxTime i OMS_DB_PATH.');
}

const adres = {
  name: process.env.DPD_NADAWCA_NAZWA,
  street: process.env.DPD_NADAWCA_ULICA,
  postalCode: process.env.DPD_NADAWCA_KOD,
  city: process.env.DPD_NADAWCA_MIASTO,
  countryCode: 'PL',
  phone: process.env.DPD_NADAWCA_TELEFON,
  email: process.env.DPD_NADAWCA_EMAIL,
};
if (Object.values(adres).some((v) => !v)) throw new Error('Brak pełnego adresu nadawcy w konfiguracji OMS.');

const db = openOmsDb(process.env.OMS_DB_PATH);
try {
  const zamowienie = db.prepare(`SELECT z.metoda_wysylki FROM przesylki p
    JOIN zamowienia z ON z.id=p.zamowienie_id WHERE p.id=?`).get(przesylkaId);
  if (zamowienie?.metoda_wysylki !== 'allegro_dpd') {
    throw new Error('Lokalna metoda wysyłki nie jest Allegro Kurier DPD.');
  }
  const wynik = importujPotwierdzonyPodjazd(db, {
    przesylkaId, kanal, shipmentId, numerListu, commandId, pickupId, carrierPickupId,
    pickupCarrier: 'DPD', metoda: '03f26351-f683-4db2-8895-f2c599280e3c',
    termin: { date, minTime, maxTime }, adres, kto: 'potwierdzony podjazd Allegro poza OMS',
  });
  process.stdout.write(JSON.stringify({ id: wynik.id, stan: wynik.stan,
    pickupId: wynik.pickup_id, pickupCarrier: wynik.pickup_carrier }) + '\n');
} finally {
  db.close();
}
