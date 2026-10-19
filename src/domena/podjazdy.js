import { czyKanalAllegro } from './wysylka.js';

// Podjazd dotyczy zasobu WzA, nie samego zamówienia Allegro ani numeru listu.
// Klucz grupy rozdziela konto i dokładną metodę dostawy. Nie zgadujemy fizycznego
// kuriera z `carrier: ALLEGRO` ani z pierwszego wpisu transportingInfo.
export function ocenKandydata({ przesylka: p, metaWza, aktywneZlecenie = null }) {
  const odmowa = (powod) => ({ wolno: false, powod, grupa: null });
  if (p?.kurier !== 'allegro_wza' || p?.status !== 'nadana') return odmowa('To nie jest gotowa przesyłka WzA.');
  if (!czyKanalAllegro(p)) return odmowa('Nieznane konto Allegro.');
  if (!p?.etykieta_sciezka && !p?.etykieta_zpl_sciezka) return odmowa('Brak zapisanej etykiety.');
  if (p?.przejeta_at) return odmowa('Przesyłka została już przejęta.');
  if (aktywneZlecenie) return odmowa('Dla przesyłki trwa już zlecenie podjazdu.');
  if (!p?.id_przesylki_kuriera || metaWza?.id !== p.id_przesylki_kuriera) {
    return odmowa('Nie potwierdzono identyfikatora przesyłki WzA.');
  }
  if (metaWza?.pickupAvailable !== true) return odmowa('Allegro nie udostępnia podjazdu dla tej przesyłki.');
  if (!metaWza?.deliveryMethodId) return odmowa('Brak identyfikatora metody dostawy.');
  return { wolno: true, powod: null, grupa: `${p.sklep}|${metaWza.deliveryMethodId}` };
}

const kluczTerminu = (t) => `${t?.date ?? ''}|${t?.minTime ?? ''}|${t?.maxTime ?? ''}`;

// Od 06.10.2026 Allegro odrzuca telefon podjazdu bez prefiksu (HTTP 400, address.phone).
// Polskie 9 cyfr i 0048 + 9 cyfr → +48; numer z `+` traci tylko białe znaki; reszta bez zmian.
// Ta sama funkcja normalizuje adres przed wysłaniem i OBIE strony porównania odpowiedzi.
export function normalizujTelefon(telefon, countryCode) {
  const tekst = String(telefon ?? '').trim();
  const cyfry = tekst.replace(/[\s()-]/g, '');
  if (tekst.startsWith('+')) return tekst.replace(/\s/g, '');
  if (countryCode === 'PL' && /^\d{9}$/.test(cyfry)) return '+48' + cyfry;
  if (countryCode === 'PL' && /^0048\d{9}$/.test(cyfry)) return '+' + cyfry.slice(2);
  return tekst;
}

const takieSamePole = (k, wyslany, odeslany) => (k === 'phone'
  ? normalizujTelefon(wyslany.phone, wyslany.countryCode) === normalizujTelefon(odeslany.phone, odeslany.countryCode)
  : (wyslany[k] ?? '') === (odeslany[k] ?? ''));

// Allegro podaje terminy per shipmentId. Zlecenie grupowe może użyć tylko
// IDENTYCZNEJ oferty obecnej dla każdej paczki; geometria okien nie jest ofertą.
export function wspolneTerminy(propozycje) {
  if (!Array.isArray(propozycje) || !propozycje.length || propozycje.length > 100) return [];
  const ids = propozycje.map((p) => p?.shipmentId);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return [];
  const first = propozycje[0].pickupTimes ?? [];
  const pozostale = propozycje.slice(1).map((p) => new Set((p.pickupTimes ?? []).map(kluczTerminu)));
  return first.filter((t) => t?.date && t?.minTime && t?.maxTime && pozostale.every((s) => s.has(kluczTerminu(t))))
    .filter((t, i, all) => all.findIndex((x) => kluczTerminu(x) === kluczTerminu(t)) === i);
}

function ocenOdpowiedz(odpowiedz, shipmentIds, adres) {
  if (!Array.isArray(shipmentIds) || !shipmentIds.length || shipmentIds.length > 100
    || shipmentIds.some((id) => !id) || new Set(shipmentIds).size !== shipmentIds.length) {
    return { przyczyna: 'niezgodny-zestaw', propozycje: [] };
  }
  if (!Array.isArray(odpowiedz) || !odpowiedz.length) {
    return { przyczyna: 'pusta-odpowiedz', propozycje: [] };
  }
  if (odpowiedz.some((g) => !Array.isArray(g?.proposals))) {
    return { przyczyna: 'niezgodny-zestaw', propozycje: [] };
  }
  // Element tablicy API nie jest identyfikatorem osobnego odbioru. Pomiar DPD
  // 30.09.2026: trzy osobne elementy, ten sam adres i termin dla trzech paczek.
  // Łączymy wyłącznie dokładny zestaw, bez pominięć, duplikatów i obcych paczek.
  const propozycje = odpowiedz.flatMap((g) => g.proposals);
  const ids = propozycje.map((p) => p?.shipmentId);
  if (ids.length !== shipmentIds.length || new Set(ids).size !== ids.length
    || ids.some((id) => !shipmentIds.includes(id))) {
    return { przyczyna: 'niezgodny-zestaw', propozycje: [] };
  }
  // API może dopisać null do opcjonalnych pól. Każda rzeczywista różnica,
  // także kontaktu czy punktu, blokuje użycie oferty pod adresem operatora.
  // Telefon to jedyny wyjątek od dosłownej równości: ten sam numer w zapisie 9 cyfr i +48.
  if (!adres || typeof adres !== 'object' || Array.isArray(adres)
    || !Object.keys(adres).length || odpowiedz.some((g) => !g.address
      || typeof g.address !== 'object' || Array.isArray(g.address)
      || Object.keys({ ...adres, ...g.address }).some((k) => !takieSamePole(k, adres, g.address)))) {
    return { przyczyna: 'niezgodny-adres', propozycje: [] };
  }
  return { przyczyna: null, propozycje };
}

export function ofertyPodjazdu(odpowiedz, shipmentIds, adres) {
  const ocena = ocenOdpowiedz(odpowiedz, shipmentIds, adres);
  return ocena.przyczyna ? [] : wspolneTerminy(ocena.propozycje);
}

// Gdy wspólnego terminu nie ma, operator musi zobaczyć, CO zwróciło Allegro:
// podział na osobne grupy, paczkę bez oferty albo różne okna. Sam komunikat
// „brak wspólnego terminu” nie odróżnia tych przypadków.
export function diagnozaTerminow(odpowiedz, shipmentIds, adres) {
  const grupy = Array.isArray(odpowiedz) ? odpowiedz.filter((g) => Array.isArray(g?.proposals)) : [];
  const paczki = shipmentIds.map((shipmentId) => {
    const nr = grupy.findIndex((g) => g.proposals.some((p) => p?.shipmentId === shipmentId));
    const oferta = nr < 0 ? null : grupy[nr].proposals.find((p) => p?.shipmentId === shipmentId);
    return { shipmentId, grupaAllegro: nr < 0 ? null : nr + 1,
      terminy: (oferta?.pickupTimes ?? []).map((t) => ({ date: t?.date, minTime: t?.minTime, maxTime: t?.maxTime })) };
  });
  const ocena = adres ? ocenOdpowiedz(odpowiedz, shipmentIds, adres) : null;
  const przyczyna = !grupy.length ? 'pusta-odpowiedz'
    : paczki.some((p) => !p.terminy.length) ? 'paczka-bez-terminu'
      : ocena?.przyczyna ?? 'rozne-okna';
  return { przyczyna, grupAllegro: grupy.length, paczki };
}

export function podjazdPoTerminie(termin, terazIso = new Date().toISOString()) {
  if (!termin?.date || !termin?.maxTime) return false;
  const d = new Date(terazIso);
  if (!Number.isFinite(d.getTime())) return false;
  const czesci = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const w = Object.fromEntries(czesci.map((p) => [p.type, p.value]));
  const lokalnie = `${w.year}-${w.month}-${w.day}T${w.hour}:${w.minute}`;
  return lokalnie > `${termin.date}T${termin.maxTime}`;
}
