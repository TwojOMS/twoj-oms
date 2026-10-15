import { randomUUID } from 'node:crypto';
import { dzienWarszawa } from '../../../domena/format-daty.js';
import { dopiszLog } from '../../../oms/db/zamowienia.js';
import { ocenKandydata, ofertyPodjazdu, diagnozaTerminow, normalizujTelefon } from '../../../domena/podjazdy.js';
import {
  pobierzPodjazd, powiazanePrzesylkiPodjazdu, zapiszPodgladPodjazdu,
  zarezerwujPodjazd, zapiszWynikPodjazdu, rozpocznijWysylkePodjazdu,
  zajmijSprawdzeniePodjazdu,
} from '../db/podjazdy.js';

const TRZYDZIESCI_MINUT = 30 * 60 * 1000;
// Dwa sekwencyjne GET-y Allegro mają po 30 s limitu. Lease musi przetrwać oba
// oraz narzut sieci/SQLite; spóźniony właściciel i tak nie zapisze bez tokenu.
const LEASE_SPRAWDZENIA_MS = 120 * 1000;
const dzien = /^\d{4}-\d{2}-\d{2}$/;
const kluczTerminu = (t) => `${t?.date}|${t?.minTime}|${t?.maxTime}`;
// Potwierdzone rzeczywistym podjazdem 23.09.2026: zasób WzA tej usługi
// podaje transport DPD, a szczegóły przyjętego podjazdu pickupCarrier=DPD.
// Pozostałe metody wymagają osobnego pomiaru przed odblokowaniem POST.
// ⚠️ Automaty Paczkowe DPD i Kurier DPD pobranie odblokowane 01.10.2026 BEZ takiego
// pomiaru (decyzja właściciela): zasób WzA obu podaje transport ['DPD'] i ten sam termin
// 13:00–17:00 co Kurier DPD (#1376, #1377), ale podjazdu zamówionego w panelu Allegro
// nie da się odczytać (GET /pickups = 405, brak pickupId). Pomiarem jest pierwszy
// podjazd z OMS-u: `sprawdz` nie potwierdzi go, gdy `pickupCarrier` będzie inny niż tu.
const KURIER_ODBIERAJACY = new Map([
  ['03f26351-f683-4db2-8895-f2c599280e3c', 'DPD'],
  ['09bcdcdb-c62a-41c4-ba42-f2c599280e3c', 'DPD'],
  ['13f26351-26fb-48d4-b5dd-f2c599280e3c', 'DPD'],
]);

function walidujAdres(adres) {
  const wymagane = ['name', 'street', 'postalCode', 'city', 'countryCode', 'email', 'phone'];
  if (!adres || wymagane.some((k) => !String(adres[k] ?? '').trim())) {
    throw new Error('Uzupełnij adres i kontakt odbioru podjazdu.');
  }
  const poprawny = Object.fromEntries(wymagane.map((k) => [k, String(adres[k]).trim()]));
  // Normalizujemy przed HTTP, porównaniem oferty i zapisem snapshotu.
  poprawny.phone = normalizujTelefon(poprawny.phone, poprawny.countryCode);
  return poprawny;
}

function walidujIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100
    || ids.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)
    || new Set(ids.map(Number)).size !== ids.length) {
    throw new Error('Zaznacz od 1 do 100 różnych przesyłek.');
  }
  return ids.map(Number);
}

function paczka(db, id) {
  return db.prepare(`SELECT p.*, z.sklep, z.metoda_wysylki_nazwa FROM przesylki p
    JOIN zamowienia z ON z.id = p.zamowienie_id WHERE p.id = ?`).get(id);
}

function aktywny(db, id) {
  return db.prepare(`SELECT 1 FROM podjazdy_przesylki
    WHERE przesylka_id = ? AND aktywna_rezerwacja = 1`).get(id);
}

export function createPodjazdy({ db, allegroDla, teraz = () => new Date(), uuid = randomUUID,
  moznaZlecac = null }) {
  // Fail closed during rollout: before enabling this setting we first record
  // the already ordered pickup so it cannot be requested a second time in OMS.
  const zlecanieAktywne = () => moznaZlecac === null
    ? db.prepare("SELECT wartosc FROM ustawienia WHERE klucz='podjazdy.allegro.dpd.aktywne'").get()?.wartosc === '1'
    : moznaZlecac;
  const nastepnaProba = (sekundy = 600) => new Date(teraz().getTime()
    + (Number.isFinite(Number(sekundy)) && Number(sekundy) > 0 ? Number(sekundy) : 600) * 1000).toISOString();
  async function sprawdzPaczki(ids) {
    const wynik = [];
    for (const id of walidujIds(ids)) {
      const p = paczka(db, id);
      if (!p) throw new Error(`Przesyłka ${id} nie istnieje.`);
      const klient = allegroDla(p.sklep);
      if (!klient) throw new Error(`Brak połączenia z kontem ${p.sklep}.`);
      if (p.kurier !== 'allegro_wza' || !p.id_przesylki_kuriera) {
        throw new Error(`Przesyłka ${id} nie jest gotową paczką WzA.`);
      }
      const meta = await klient.pobierzPrzesylkeWza(p.id_przesylki_kuriera);
      const ocena = ocenKandydata({ przesylka: p, metaWza: meta, aktywneZlecenie: aktywny(db, id) });
      if (!ocena.wolno) throw new Error(`Przesyłka ${id}: ${ocena.powod}`);
      // Zasób przesyłki musi zawierać ten konkretny numer listu. Samo ID w bazie
      // mogło kiedyś być ID komendy tworzenia lub zostać omyłkowo podmienione.
      if (!meta.packages?.some((pakiet) => pakiet.waybill === p.numer_listu)) {
        throw new Error(`Przesyłka ${id}: numer listu nie zgadza się z zasobem Allegro.`);
      }
      wynik.push({ przesylkaId: id, shipmentId: meta.id, numerListu: p.numer_listu,
        kanal: p.sklep, metoda: meta.deliveryMethodId, nazwa: p.metoda_wysylki_nazwa ?? null,
        kurierOdbierajacy: Array.isArray(meta.transport) && meta.transport.length === 1
          && KURIER_ODBIERAJACY.get(meta.deliveryMethodId) === meta.transport[0]
          ? meta.transport[0] : null });
    }
    return wynik;
  }

  async function przygotuj({ ids, data, adres, kto = null }) {
    const parsed = new Date(`${data}T00:00:00Z`);
    if (!dzien.test(data ?? '') || Number.isNaN(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== data || data < dzienWarszawa(teraz().toISOString())) {
      throw new Error('Niepoprawna data podjazdu.');
    }
    const poprawnyAdres = walidujAdres(adres);
    const przesylki = await sprawdzPaczki(ids);
    const grupyMap = new Map();
    for (const p of przesylki) {
      const klucz = `${p.kanal}|${p.metoda}`;
      if (!grupyMap.has(klucz)) grupyMap.set(klucz, []);
      grupyMap.get(klucz).push(p);
    }
    const grupy = [];
    for (const [id, paczki] of grupyMap) {
      const klient = allegroDla(paczki[0].kanal);
      const propozycje = await klient.pobierzPropozycjePodjazdu({
        shipmentIds: paczki.map((p) => p.shipmentId), readyDate: data, address: poprawnyAdres,
      });
      const terminy = ofertyPodjazdu(propozycje, paczki.map((p) => p.shipmentId), poprawnyAdres);
      const diagnoza = terminy.length ? null : diagnozaTerminow(propozycje, paczki.map((p) => p.shipmentId), poprawnyAdres);
      if (diagnoza) {
        diagnoza.paczki = diagnoza.paczki.map((d, i) => ({ shipmentId: d.shipmentId,
          numerListu: paczki[i].numerListu, grupaAllegro: d.grupaAllegro, terminy: d.terminy }));
      }
      grupy.push({ id, kanal: paczki[0].kanal, metoda: paczki[0].metoda,
        etykieta: paczki[0].nazwa || `Usługa ${paczki[0].metoda}`,
        kurierOdbierajacy: paczki.every((p) => p.kurierOdbierajacy === paczki[0].kurierOdbierajacy)
          ? paczki[0].kurierOdbierajacy : null,
        przesylki: paczki, terminy, diagnoza });
    }
    for (const grupa of grupy) grupa.moznaZlecac = zlecanieAktywne()
      && (moznaZlecac === null ? Boolean(grupa.kurierOdbierajacy) : true);
    const id = uuid();
    const wygasaAt = new Date(teraz().getTime() + TRZYDZIESCI_MINUT).toISOString();
    zapiszPodgladPodjazdu(db, { id, kto, snapshot: { data, adres: poprawnyAdres, grupy }, wygasaAt });
    return { id, data, adres: poprawnyAdres, grupy, wygasaAt };
  }

  function pobierzPodglad({ id }) {
    const zapis = db.prepare('SELECT * FROM podjazdy_podglady WHERE id=?').get(id);
    if (!zapis) throw new Error('Nieznany podgląd podjazdów.');
    const snapshot = JSON.parse(zapis.snapshot_json);
    const wygasl = Date.parse(zapis.wygasa_at) <= teraz().getTime();
    return { id: zapis.id, data: snapshot.data, adres: snapshot.adres,
      wygasaAt: zapis.wygasa_at, wygasl,
      grupy: snapshot.grupy.map((g) => {
        const wynik = db.prepare('SELECT * FROM podjazdy WHERE podglad_id=? AND grupa_id=?')
          .get(zapis.id, g.id) ?? null;
        return { ...g, wynik,
          moznaZlecac: !wynik && !wygasl && g.moznaZlecac && zlecanieAktywne() };
      }) };
  }

  async function zlec({ podgladId, grupaId, termin, kto = null }) {
    const istniejacy = db.prepare('SELECT * FROM podjazdy WHERE podglad_id=? AND grupa_id=?')
      .get(podgladId, grupaId);
    if (istniejacy) return istniejacy;
    const podglad = db.prepare('SELECT * FROM podjazdy_podglady WHERE id=?').get(podgladId);
    if (!podglad || Date.parse(podglad.wygasa_at) <= teraz().getTime()) {
      throw new Error('Podgląd wygasł. Pobierz aktualne terminy.');
    }
    const snapshot = JSON.parse(podglad.snapshot_json);
    const grupa = snapshot.grupy.find((g) => g.id === grupaId);
    if (!grupa) throw new Error('Nieznana grupa podjazdu.');
    if (!grupa.moznaZlecac || !zlecanieAktywne()) {
      throw new Error('Zlecanie podjazdów jest wstrzymane: nie potwierdzono przewoźnika odbierającego albo aktywacji usługi.');
    }
    const oferta = grupa.terminy.find((t) => kluczTerminu(t) === kluczTerminu(termin));
    if (!oferta) {
      throw new Error('Termin nie pochodzi z aktualnego podglądu.');
    }
    const wybranyTermin = { date: oferta.date, minTime: oferta.minTime, maxTime: oferta.maxTime };
    const odswiezone = await sprawdzPaczki(grupa.przesylki.map((p) => p.przesylkaId));
    if (odswiezone.some((p, i) => p.shipmentId !== grupa.przesylki[i].shipmentId
      || p.kanal !== grupa.kanal || p.metoda !== grupa.metoda
      || (moznaZlecac === null && p.kurierOdbierajacy !== grupa.kurierOdbierajacy))) {
      throw new Error('Zestaw paczek się zmienił. Pobierz nowy podgląd.');
    }
    const klient = allegroDla(grupa.kanal);
    const propozycje = await klient.pobierzPropozycjePodjazdu({
      shipmentIds: grupa.przesylki.map((p) => p.shipmentId),
      readyDate: snapshot.data, address: snapshot.adres,
    });
    if (!ofertyPodjazdu(propozycje, grupa.przesylki.map((p) => p.shipmentId), snapshot.adres)
      .some((t) => kluczTerminu(t) === kluczTerminu(wybranyTermin))) {
      throw new Error('Wybrany termin zniknął z aktualnych propozycji. Pobierz nowy podgląd.');
    }
    const rezerwacja = zarezerwujPodjazd(db, {
      podgladId, grupaId, commandId: uuid(), kanal: grupa.kanal,
      przewoznik: grupa.metoda, adres: snapshot.adres, termin: wybranyTermin,
      przesylki: grupa.przesylki, kto,
    });
    if (!rozpocznijWysylkePodjazdu(db, rezerwacja.id)) return pobierzPodjazd(db, rezerwacja.id);
    try {
      const zamowienia = new Set(grupa.przesylki.map((p) => paczka(db, p.przesylkaId)?.zamowienie_id));
      for (const zamowienieId of zamowienia) {
        if (zamowienieId) dopiszLog(db, zamowienieId, { akcja: 'podjazd.zlecenie',
          wynik: `DECYZJA CZŁOWIEKA (${kto ?? 'operator'}): konto ${grupa.kanal}, usługa ${grupa.metoda}, `
            + `${grupa.przesylki.length} paczek, termin ${wybranyTermin.date} ${wybranyTermin.minTime}–${wybranyTermin.maxTime}, `
            + `komenda ${rezerwacja.command_id}` });
      }
      await klient.zlecPodjazd({ commandId: rezerwacja.command_id,
        input: { shipmentIds: grupa.przesylki.map((p) => p.shipmentId), pickupTime: wybranyTermin, address: snapshot.adres } });
      return zapiszWynikPodjazdu(db, rezerwacja.id, { stan: 'oczekuje' });
    } catch (error) {
      // Po wysłaniu nie wiadomo, czy Allegro przyjęło komendę. Nie zwalniamy paczek
      // ani nie ponawiamy POST; odtwarzanie odbywa się wyłącznie GET-em po UUID.
      return zapiszWynikPodjazdu(db, rezerwacja.id, {
        stan: 'nieznany', bladOpis: `Nieustalony wynik wysłania: ${error?.message ?? error}`,
        nastepneSprawdzenieAt: nastepnaProba(error?.retryAfterS),
      });
    }
  }

  async function sprawdz({ id }) {
    const zlecenie = pobierzPodjazd(db, id);
    if (!zlecenie) throw new Error('Nieznane zlecenie podjazdu.');
    if (['potwierdzony', 'odrzucony'].includes(zlecenie.stan)) return zlecenie;
    const klient = allegroDla(zlecenie.kanal);
    if (!klient) throw new Error('Konto Allegro jest niedostępne.');
    const sprawdzenieToken = uuid();
    const czas = teraz();
    if (!zajmijSprawdzeniePodjazdu(db, id, { token: sprawdzenieToken,
      teraz: czas.toISOString(), do: new Date(czas.getTime() + LEASE_SPRAWDZENIA_MS).toISOString() })) {
      return pobierzPodjazd(db, id);
    }
    const zapisz = (wynik) => zapiszWynikPodjazdu(db, id, { ...wynik, sprawdzenieToken });
    let stan;
    try { stan = await klient.stanZleceniaPodjazdu(zlecenie.command_id); }
    catch (error) {
      return zapisz({ stan: 'nieznany',
        bladOpis: `Nie udało się sprawdzić komendy: ${error?.message ?? error}`,
        nastepneSprawdzenieAt: nastepnaProba(error?.retryAfterS) });
    }
    if ((stan?.id ?? stan?.commandId) !== zlecenie.command_id) {
      return zapisz({ stan: 'nieznany',
        bladOpis: 'Allegro zwróciło inny identyfikator komendy.' });
    }
    if (stan?.status === 'ERROR') return zapisz({ stan: 'odrzucony', bladOpis: 'Allegro odrzuciło zlecenie.' });
    if (stan?.status !== 'SUCCESS') return zapisz({
      stan: 'oczekuje', nastepneSprawdzenieAt: nastepnaProba(stan?.retryAfterS),
    });
    if (!stan.pickupId) return zapisz({ stan: 'nieznany', bladOpis: 'Sukces bez pickupId.' });
    let szczegoly;
    try { szczegoly = await klient.pobierzPodjazd(stan.pickupId); }
    catch (error) { return zapisz({ stan: 'nieznany', pickupId: stan.pickupId,
      bladOpis: 'Nie udało się sprawdzić szczegółów odbioru.',
      nastepneSprawdzenieAt: nastepnaProba(error?.retryAfterS) }); }
    const lokalne = powiazanePrzesylkiPodjazdu(db, id).map((p) => p.shipment_id).sort();
    const zdalne = [...(szczegoly?.shipmentIds ?? [])].sort();
    if (szczegoly?.id !== stan.pickupId || JSON.stringify(lokalne) !== JSON.stringify(zdalne)
      || !szczegoly.pickupCarrier) {
      return zapisz({ stan: 'nieznany', pickupId: stan.pickupId,
        bladOpis: 'Szczegóły odbioru nie potwierdzają kompletu paczek i przewoźnika.' });
    }
    // `przewoznik` trzyma identyfikator usługi WzA. Usługa z mapy ma oczekiwanego
    // przewoźnika — inny w szczegółach to nie „potwierdzony", tylko sprzeczność do wyjaśnienia.
    const oczekiwany = KURIER_ODBIERAJACY.get(zlecenie.przewoznik);
    if (oczekiwany && szczegoly.pickupCarrier !== oczekiwany) {
      return zapisz({ stan: 'nieznany', pickupId: stan.pickupId,
        bladOpis: `Allegro przydzieliło przewoźnika ${szczegoly.pickupCarrier}, a OMS oczekiwał ${oczekiwany}.` });
    }
    return zapisz({ stan: 'potwierdzony', pickupId: stan.pickupId,
      carrierPickupId: stan.carrierPickupId ?? szczegoly.carrierPickupId ?? null,
      pickupCarrier: szczegoly.pickupCarrier });
  }

  return { przygotuj, pobierzPodglad, zlec, sprawdz };
}
