// SRODEK TOKENU ALLEGRO — jedno miejsce, w ktorym panel rozbiera JWT.
//
// ⚠️ MODUL ISTNIEJE, ZEBY REGULA „NIGDY NIE RZUCA" MIALA JEDNA KOPIE. Czytaja stad dwie
// rzeczy: zakresy (uprawnienia-kanalu.js) i konto Allegro (tozsamosc-kanalu.js), a obie
// wola ekran stanu kanalu. Wyjatek przy tokenie o nieznanym ksztalcie wywalilby cala
// strone z powodu jednego kanalu — i to jest cala tresc tego pliku.
//
// ⚠️ NIEZMIENNIK 4.10: token wchodzi, token NIE WYCHODZI. Na zewnatrz ida wylacznie
// wartosci wyjete z payloadu (nazwy zakresow, identyfikator konta) — nigdy sam napis.

/**
 * Payload tokenu albo `null`, gdy nie da sie go odczytac.
 *
 * `null` znaczy „NIE WIEM", a nie „puste". Wolajacy musi te dwie rzeczy rozroznic:
 * obie listy ponizej otwieraja barierę ponownego wiazania, a wiazanie NADPISUJE dzialajaca
 * pare tokenow i uniewaznia ja po stronie Allegro.
 */
export function payloadTokenu(accessToken) {
  try {
    const czesc = String(accessToken ?? '').split('.')[1];
    if (!czesc) return null;
    const payload = JSON.parse(Buffer.from(czesc, 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}
