// Wynik trafia do panelu i stanu połączenia. Nigdy nie przenosimy do niego
// wyjątku klienta API: odpowiedź zewnętrzna może powtórzyć token lub klucz.
const KROKI = Object.freeze({
  BRAK_KONFIGURACJI: 'Zapisz poświadczenie źródła w sekretach instancji i ponów test.',
  BRAK_ADAPTERA: 'Skonfiguruj adapter odczytu tego źródła i ponów test.',
  BRAK_UPRAWNIEN: 'Sprawdź uprawnienia tylko do odczytu dla wybranego konta i ponów test.',
  BRAK_WALUTY: 'Sprawdź walutę konta lub właściwości i ponów test.',
  BLAD_ODCZYTU: 'Sprawdź połączenie ze źródłem i ponów test.',
  ADS_API_NIEDOSTEPNE: 'Raport Google przez GA4 działa bez Ads API; to opcjonalne połączenie wymaga produkcyjnego dostępu.',
});

function wynikBledu(stan, kodBledu) {
  return { stan, waluta: null, strefa: null, pobranoAt: null,
    kodBledu, nastepnyKrok: KROKI[kodBledu] };
}

function kodWaluty(value) {
  const waluta = String(value ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(waluta) ? waluta : null;
}

function strefaCzasowa(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function zakresProby(data) {
  const doDnia = new Date(Date.UTC(data.getUTCFullYear(), data.getUTCMonth(), data.getUTCDate()));
  const odDnia = new Date(doDnia);
  odDnia.setUTCDate(odDnia.getUTCDate() - 6);
  return { od: odDnia.toISOString().slice(0, 10), do: doDnia.toISOString().slice(0, 10) };
}

function brakUprawnien(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  return status === 401 || status === 403;
}

/** Test odczytu pojedynczego połączenia. `klienci` zawiera fabryki istniejących
 * adapterów GA4/Meta, a magazyn udostępnia sekret tylko wewnątrz serwera. */
export async function testPolaczenie({ typ, kontoId, sekretRef, magazyn, klienci,
  teraz = () => new Date(), od, do: doDnia }) {
  if (typ === 'google_ads') return wynikBledu('niedostepne', 'ADS_API_NIEDOSTEPNE');
  if (typ !== 'ga4' && typ !== 'meta') return wynikBledu('brak_konfiguracji', 'BRAK_KONFIGURACJI');
  if (!kontoId || !sekretRef || !magazyn?.odczytaj) {
    return wynikBledu('niepodlaczone', 'BRAK_KONFIGURACJI');
  }
  if (typeof klienci?.[typ] !== 'function') return wynikBledu('brak_konfiguracji', 'BRAK_ADAPTERA');

  try {
    const sekret = await magazyn.odczytaj(sekretRef);
    if (!sekret) return wynikBledu('niepodlaczone', 'BRAK_KONFIGURACJI');
    const klient = await klienci[typ]({ sekret, sekretRef, kontoId });
    if (typeof klient?.raportReklam !== 'function') return wynikBledu('brak_konfiguracji', 'BRAK_ADAPTERA');
    const chwila = teraz();
    const zakres = { ...zakresProby(chwila), ...(od ? { od } : {}), ...(doDnia ? { do: doDnia } : {}) };
    const raport = await klient.raportReklam(typ === 'ga4'
      ? { wlasciwosc: kontoId, ...zakres }
      : { konto: kontoId, ...zakres });
    const waluta = kodWaluty(raport?.waluta);
    if (!waluta) return wynikBledu('brak_konfiguracji', 'BRAK_WALUTY');
    return { stan: 'dziala', waluta,
      strefa: typ === 'meta' ? strefaCzasowa(raport?.strefa) : null,
      pobranoAt: chwila.toISOString(), kodBledu: null, nastepnyKrok: null };
  } catch (error) {
    return brakUprawnien(error)
      ? wynikBledu('brak_uprawnien', 'BRAK_UPRAWNIEN')
      : wynikBledu('blad', 'BLAD_ODCZYTU');
  }
}
