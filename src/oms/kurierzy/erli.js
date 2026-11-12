import { bladOperatora } from '../../domena/bledy.js';
import { GABARYTY_PACZKOMATU } from '../../domena/paczka.js';
import { groszeZKwoty } from '../../domena/kwota.js';

// PRZ-157.08: kurier „Przesyłki Erli” — przewóz kupiony przez ERLI (`POST /shipping/parcels/`).
//
// Ten sam kontrakt co kurierzy/allegro-wza.js: `nadaj` zakłada paczkę, a ERLI tworzy ją
// ASYNCHRONICZNIE — etykieta i numer śledzenia są dopiero wtedy, gdy `_search` odda
// `shipping.waybills[]`. Do tego czasu wynik to „w trakcie tworzenia” i karta pokazuje
// sprawę „przesyłka tworzona u kuriera” z przyciskiem „Sprawdź ponownie”
// (services/nadanie.js → `sprawdzPrzesylke`).
//
// Pobranie: ERLI NIE przyjmuje kwoty w żądaniu — inkasuje kwotę z zamówienia (`delivery.cod`,
// `totalPrice`). Dlatego inna kwota niż w zamówieniu to odmowa przed POST, a nie cicha zmiana.
//
// Klient ERLI (src/oms/erli/client.js albo atrapa) podaje `erliDla(zamowienie)` — kanał ERLI
// to osobne konto, a paczka założona na jednym nie istnieje dla drugiego.

/** Pola `receiver` przyjmowane przez `POST /shipping/parcels/` (specyfikacja ERLI). */
const POLA_ODBIORCY = ['street', 'buildingNumber', 'flatNumber', 'city', 'country', 'zip', 'firstName', 'lastName',
  'companyName', 'pickupType', 'phoneNumber', 'pointCode', 'postnummer', 'email'];

const PRZED_ODBIOREM = new Set(['preparing', 'readyToSend', 'waitingForCourier']);
// Opisy korzystają ze wspólnej klasyfikacji etapów i spraw przesyłki w OMS.
const STATUSY = {
  preparing: 'Zarejestrowana — przygotowanie', readyToSend: 'Zarejestrowana — gotowa do nadania',
  waitingForCourier: 'Zarejestrowana — oczekuje na kuriera', sent: 'W drodze — odebrana przez kuriera',
  onTheWay: 'W drodze', readyToDeliver: 'W drodze — u kuriera do dostarczenia',
  delivered: 'Doręczona', readyToPickup: 'W drodze — oczekuje w punkcie',
  pickupTimeExpired: 'W drodze — minął termin odbioru', returned: 'Zwrot przesyłki',
  canceled: 'Zarejestrowana — anulowana w ERLI', claimed: 'W drodze — reklamacja',
  error: 'Zarejestrowana — błąd przygotowania', deliveryUnsuccessful: 'Zwrot przesyłki — dostarczenie nieudane',
  redirected: 'W drodze — przekierowana',
};

function surowe(z) {
  const s = z?.surowe_json;
  if (s && typeof s === 'object') return s;
  try { return JSON.parse(String(s ?? 'null')) ?? {}; } catch { return {}; }
}

const mm = cm => Math.round(Number(cm) * 10);

/** Wymiary w mm i waga w g: z karty (cm, kg) albo z gabarytu paczkomatu (A/B/C). */
function wymiary(paczka) {
  const waga = Math.round(Number(paczka?.waga) * 1000);
  const gabaryt = String(paczka?.gabaryt ?? '').toUpperCase();
  if (Object.hasOwn(GABARYTY_PACZKOMATU, gabaryt)) {
    const [wysokosc, szerokosc, dlugosc] = GABARYTY_PACZKOMATU[gabaryt].split('×').map(w => Number.parseFloat(w)); // '8 × 38 × 64 cm'
    return { length: mm(dlugosc), width: mm(szerokosc), height: mm(wysokosc), weight: waga };
  }
  return { length: mm(paczka?.dlugosc), width: mm(paczka?.szerokosc), height: mm(paczka?.wysokosc), weight: waga };
}

function odbiorca(receiver) {
  return Object.fromEntries(POLA_ODBIORCY.filter(p => receiver?.[p] !== undefined).map(p => [p, receiver[p]]));
}

/** `errors[]` paczki → wyjątek z kodem; `shipmentId` mówi nadaniu, że paczka w ERLI istnieje. */
function bladPaczki(parcel) {
  const opis = parcel.errors.map(e => `${e.errorCode} — ${e.errorMessage}`).join('; ');
  return bladOperatora(`ERLI zgłosiło błąd paczki: ${opis}`, {
    shipmentId: String(parcel.id), surowa: JSON.stringify(parcel),
  });
}

/** @param {{ erliDla: (zamowienie: any) => any, punktNadaniaDla?: (zamowienie: any) => any }} opcje */
export function createErliPrzesylkiClient({ erliDla, punktNadaniaDla = () => null }) {
  async function wynikPaczki(erli, parcel) {
    if (Array.isArray(parcel?.errors) && parcel.errors.length) throw bladPaczki(parcel);
    const shipmentId = String(parcel.id);
    const waybill = parcel?.shipping?.waybills?.[0];
    if (!waybill || !parcel.trackingNumber) {
      return { shipmentId, numerListu: null, wTrakcieTworzenia: true, etykietaPdf: null, etykietaZpl: null, surowa: JSON.stringify(parcel) };
    }
    const etykietaPdf = Buffer.from(await erli.pobierzEtykiete(waybill));
    if (etykietaPdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw bladOperatora('ERLI oddało etykietę, która nie jest plikiem PDF.', {
        shipmentId, numerListu: parcel.trackingNumber, surowa: JSON.stringify(parcel),
      });
    }
    return { shipmentId, numerListu: parcel.trackingNumber, wTrakcieTworzenia: false, etykietaPdf, etykietaZpl: null, surowa: JSON.stringify(parcel) };
  }

  /** @param {import('../../core/kontrakty.ts').ZlecenieKuriera} zlecenie */
  async function nadaj({ zamowienie: z, paczka, kolejnosc = 1, kwotaPobrania = null, pobranieNaTejPaczce = false }) {
    const sur = surowe(z);
    const typeId = sur?.delivery?.typeId;
    if (!typeId) throw bladOperatora('Zamówienie nie ma metody dostawy ERLI (delivery.typeId) — Przesyłki Erli nie wiedzą, czym nadać. Panel niczego nie nadał.');

    // D3: zamówienie spoza PLN obsługuje się ręcznie — całe nadanie, nie tylko pobranie.
    const waluta = String(sur.currency ?? 'PLN').trim().toUpperCase() || 'PLN';
    if (waluta !== 'PLN') {
      throw bladOperatora(`Zamówienie ERLI jest w walucie ${waluta} — panel nadaje Przesyłkami Erli tylko zamówienia w PLN. Nadaj je ręcznie w panelu ERLI. Panel niczego nie nadał.`);
    }

    // Pobranie sprawdzane w OBIE strony (wzór: domena/allegro-wysylka.js). ERLI inkasuje kwotę
    // z zamówienia na pierwszej paczce bez względu na to, co powie OMS — paczka nr 1 zamówienia
    // za pobraniem bez pobrania w OMS to pieniądze pobrane przez ERLI, a w OMS zapisane jako opłacone.
    const pobranie = kwotaPobrania != null && String(kwotaPobrania).trim() !== '' && pobranieNaTejPaczce;
    if (!pobranie && sur.delivery.cod && kolejnosc === 1) {
      throw bladOperatora('Zamówienie jest za pobraniem w ERLI, a nadanie jest bez pobrania — ERLI i tak pobrałoby kwotę z zamówienia. Włącz pobranie na tej paczce. Panel niczego nie nadał.');
    }
    if (pobranie) {
      if (!sur.delivery.cod) throw bladOperatora('Pobranie przez Przesyłki Erli jest możliwe tylko wtedy, gdy klient wybrał je w ERLI — zamówienie w ERLI nie jest za pobraniem. Panel niczego nie nadał.');
      if (kolejnosc > 1) throw bladOperatora('ERLI pobiera kwotę tylko na pierwszej paczce zamówienia. Panel niczego nie nadał.');
      const zZamowienia = Number(sur.totalPrice);
      if (groszeZKwoty(String(kwotaPobrania).replace(',', '.'), 'kwota pobrania ERLI') !== zZamowienia) {
        throw bladOperatora(`ERLI pobiera kwotę z zamówienia (${(zZamowienia / 100).toFixed(2)} zł) — innej kwoty nie da się ustawić. Panel niczego nie nadał.`);
      }
    }

    const erli = erliDla(z);
    const orderId = String(z.zrodlo_id);
    // Przed POST: paczki tego zamówienia już w ERLI. Chroni przed duplikatem (np. po przekroczonym
    // czasie odpowiedzi, gdy paczka powstała) i daje adres odbiorcy pierwszej paczki dla kolejnej.
    const zywe = (await erli.szukajPaczek({ filter: { field: 'orderId', operator: '=', value: orderId } }) ?? [])
      .filter(p => p?.status !== 'canceled');
    if (zywe.length >= kolejnosc) {
      throw bladOperatora(`Zamówienie już ma paczkę nr ${kolejnosc} w ERLI (id ${zywe[kolejnosc - 1].id}) — sprawdź ją w panelu ERLI, zanim nadasz kolejną. Panel niczego nie nadał.`);
    }
    const shipping = { typeId };
    const punkt = punktNadaniaDla(z);
    if (punkt != null && punkt !== '') shipping.postingPointId = Number(punkt);
    if (paczka?.niestandardowa === true) shipping.nonStandard = true;
    if (kolejnosc > 1) {
      if (!zywe[0]?.shipping?.receiver) throw bladOperatora('Nadaj najpierw pierwszą paczkę zamówienia — kolejna paczka ERLI dostaje jej adres odbiorcy. Panel niczego nie nadał.');
      shipping.receiver = odbiorca(zywe[0].shipping.receiver);
    }

    const [parcel] = await erli.utworzPaczki([{ orderId, dimensions: wymiary(paczka), shipping }]);
    return wynikPaczki(erli, parcel);
  }

  async function sprawdzPrzesylke(id, z) {
    const erli = erliDla(z);
    const [parcel] = await erli.szukajPaczek({ filter: { field: 'id', operator: '=', value: Number(id) } }) ?? [];
    if (!parcel) throw bladOperatora(`ERLI nie zna paczki ${id}.`, { shipmentId: String(id) });
    return wynikPaczki(erli, parcel);
  }

  async function paczkaPoId(erli, id) {
    const paczki = await erli.szukajPaczek({ filter: { field: 'id', operator: '=', value: Number(id) } });
    return paczki?.find(p => String(p.id) === String(id)) ?? null;
  }

  async function anulujPrzesylke(id, z) {
    let erli;
    let parcel;
    try {
      erli = erliDla(z);
      parcel = await paczkaPoId(erli, id);
    } catch {
      throw bladOperatora('ERLI: nie udało się sprawdzić paczki przed anulowaniem. Spróbuj ponownie.');
    }
    // Nieznany stan nie uprawnia do DELETE. Historia chroni również po cofnięciu statusu.
    if (!PRZED_ODBIOREM.has(parcel?.status)
      || parcel?.statusHistory?.some(w => !PRZED_ODBIOREM.has(w.status))) {
      throw bladOperatora('Tej paczki ERLI nie można anulować — brak potwierdzenia, że jest przed odbiorem przez kuriera. Sprawdź ją w panelu ERLI.');
    }
    try { return await erli.anulujPaczke(id); } catch {
      throw bladOperatora('ERLI: nie udało się anulować paczki. Sprawdź jej stan w panelu ERLI przed ponowieniem.');
    }
  }

  async function statusPrzesylki(id, { kanal } = {}) {
    let parcel;
    try { parcel = await paczkaPoId(erliDla({ sklep: kanal }), id); } catch {
      throw bladOperatora('ERLI: status paczki jest chwilowo niedostępny.');
    }
    if (!parcel || !Object.hasOwn(STATUSY, parcel.status)) return null;
    const zdarzenie = parcel.statusHistory?.findLast(w => w.status === parcel.status);
    return { opis: STATUSY[parcel.status], kod: null, at: zdarzenie?.changed ?? parcel.updatedAt ?? null };
  }

  async function protokolOdbioru(id, z) {
    try {
      const dokument = await erliDla(z).protokolyOdbioru([id]);
      const url = new URL(dokument.url);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Nieprawidłowy adres');
      return { url: url.href };
    } catch {
      throw bladOperatora('ERLI: nie udało się pobrać protokołu odbioru. Spróbuj ponownie.');
    }
  }

  return { nadaj, sprawdzPrzesylke, anulujPrzesylke, statusPrzesylki, protokolOdbioru, sledzeniePoId: true };
}
