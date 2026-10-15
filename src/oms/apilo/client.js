import { transport } from '../../integracje/transport.js';
// Klient Apilo — JEDYNY, jaki został w repo, i celowo stoi po stronie OMS-u.
//
// Integracja panelu indywidualnego z Apilo została usunięta 2026-08-18 (Etap 6 planu
// „Nowy układ karty + koniec Apilo") razem z całym `src/apilo/`. Przeżył jeden konsument:
// JEDNORAZOWY import historii sprzedaży (`scripts/import-apilo.mjs` → `services/import-apilo.js`),
// który plan zostawia świadomie — historia jest niezmienna i nie ma jej skąd odtworzyć.
// Plan zakładał, że import „ma własnego klienta"; nie miał — pożyczał panelowego. Ten plik
// robi to założenie prawdziwym, żeby usunięcie integracji nie zabrało importu historii.
//
// ⚠️ POŚWIADCZENIA NADAL SĄ WSPÓLNE Z PANELEM (ten sam `credentialsPath`). Refresh token
// Apilo jest JEDNORAZOWY: druga kopia tokenów odświeżona za plecami tej pierwszej unieważnia
// parę i wywala drugą stronę na 401 — cicho, nawet 21 dni później. Skoro panel do Apilo już
// nie chodzi, ryzyko jest mniejsze, ale ZNIKA dopiero razem z ostatnim konsumentem.
//
// ⚠️ NIE ROBIĆ Z TEGO CZUWACZA. To narzędzie do uruchomienia ręcznego, nie integracja.
import { readFileSync, writeFileSync } from 'node:fs';

export function createApiloClient({
  host, credentialsPath, fetchImpl, http = transport({ fetchImpl }), now = () => Date.now(),
  readFile = (p) => readFileSync(p, 'utf8'),
  writeFile = (p, data) => writeFileSync(p, data),
}) {
  function loadCreds() { return JSON.parse(readFile(credentialsPath)); }
  function saveCreds(c) { writeFile(credentialsPath, JSON.stringify(c, null, 2)); }

  async function refresh(creds) {
    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    const res = await http(`${host}/rest/auth/token/`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ grantType: 'refresh_token', token: creds.refreshToken }),
    });
    if (res.status >= 400) {
      const err = new Error(`Apilo token refresh failed (${res.status})`);
      err.status = res.status; throw err;
    }
    const tok = await res.json();
    const updated = { ...creds, ...tok };
    saveCreds(updated);
    return updated;
  }

  async function currentToken() {
    let creds = loadCreds();
    const expMs = Date.parse(creds.accessTokenExpireAt);
    if (Number.isFinite(expMs) && expMs - now() < 60_000) creds = await refresh(creds);
    return creds.accessToken;
  }

  async function request(method, path, body) {
    const token = await currentToken();
    const headers = { Authorization: `bearer ${token}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await http(`${host}${path}`, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    let parseError = false;
    if (!text) {
      data = {};
    } else {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
        parseError = true;
      }
    }
    if (res.status >= 400) {
      const err = new Error(`Apilo ${method} ${path} -> ${res.status}: ${text}`);
      err.status = res.status; err.body = data; throw err;
    }
    if (parseError) {
      throw new Error(`Apilo ${method} ${path}: invalid JSON response`);
    }
    return data;
  }

  return { request };
}
