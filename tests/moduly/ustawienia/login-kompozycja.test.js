import { describe, it, expect, vi, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { kontoPoLoginie } from '../../../src/core/bezpieczenstwo/konta.js';
import { sprawdz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';

const env={ OMS_SPRZEDAWCA_NIP:'1234563218', OMS_RACHUNEK:'34109010140000000000000000',
  OMS_USER:'operator', OMS_PASS:'test', OMS_PROFORMY_KATALOG:tmpdir(), OMS_ETYKIETY_KATALOG:tmpdir() };
const origin={ origin:'http://localhost' };
function cookie(r) {
  const wartosci=[r.headers['set-cookie']].flat();
  const sesja=wartosci.find(v=>v?.startsWith(NAZWA_CIASTECZKA_OMS+'='));
  expect(sesja,'Trasa login musi wystawić cookie sesji').toBeTruthy();
  return sesja.split(';')[0];
}
async function login(a,uzytkownik,haslo) {
  const r=await a.app.inject({ method:'POST', url:'/login', headers:origin,
    payload:{uzytkownik,haslo,powrot:'/ustawienia/konta'} });
  expect(r.statusCode,r.body).toBe(302);
  return cookie(r);
}
function sesja(a,c) { return sprawdz(c.slice(c.indexOf('=')+1),wczytajSekret(a.db)); }
afterEach(()=>vi.unstubAllGlobals());
describe('PRZ-030 rzeczywisty bootstrap i trasy kont',()=>{
  it('login → założenie dwóch kont → zmiana hasła → relogin zachowuje wersję i drugą sesję',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('Sieć zabroniona');}));
    const a=await zbudujOms({env});
    try {
      const strona=await a.app.inject('/login');
      expect(strona.statusCode,strona.body).toBe(200);
      expect(strona.body).toContain('Logowanie');
      const serwisowe=await login(a,'operator','test');
      // Obecność jawnej wersji 0 sprawdza osobny przypadek; ten ma dotrzeć do reloginu.
      expect(sesja(a,serwisowe)?.uzytkownik).toBe('operator');
      const zaloz=async(c,login,haslo)=>{
        const r=await a.app.inject({method:'POST',url:'/ustawienia/konta/nowe',
          headers:{...origin,cookie:c},payload:{login,imie:login,haslo,rola:'administrator'}});
        expect(r.statusCode,r.body).toBe(302);
      };
      await zaloz(serwisowe,'alfa','stare');
      const stare=await login(a,'alfa','stare');
      await zaloz(stare,'beta','drugie');
      const drugie=await login(a,'beta','drugie');
      const cel=kontoPoLoginie(a.db,'alfa');
      expect(cel.wersja_hasla).toBe(0);
      const zmiana=await a.app.inject({method:'POST',url:`/ustawienia/konta/${cel.id}/haslo`,
        headers:{...origin,cookie:drugie},payload:{haslo:'nowe'}});
      expect(zmiana.statusCode,zmiana.body).toBe(302);
      expect(kontoPoLoginie(a.db,'alfa').wersja_hasla).toBe(1);
      const nowe=await login(a,'alfa','nowe');
      const chronione=await a.app.inject({url:'/ustawienia/konta',headers:{cookie:nowe}});
      expect(chronione.statusCode,chronione.body).toBe(200);
      expect(sesja(a,nowe).wersja_hasla).toBe(1);
      const odrzucone=await a.app.inject({url:'/ustawienia/konta',headers:{cookie:stare}});
      expect([302,401]).toContain(odrzucone.statusCode);
      if(odrzucone.statusCode===302)expect(odrzucone.headers.location).toMatch(/^\/login/);
      const nadal=await a.app.inject({url:'/ustawienia/konta',headers:{cookie:drugie}});
      expect(nadal.statusCode,nadal.body).toBe(200);
      expect(sesja(a,drugie).wersja_hasla).toBe(0);
      expect(fetch).not.toHaveBeenCalled();
    } finally {await a.app.close();a.db.close();}
  });
  it('konto serwisowe z env dostaje jawną wersję 0',async()=>{
    const a=await zbudujOms({env});
    try {expect(sesja(a,await login(a,'operator','test')).wersja_hasla).toBe(0);}
    finally {await a.app.close();a.db.close();}
  });
});
