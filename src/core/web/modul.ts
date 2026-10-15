import type { DefinicjaKanalu } from '../../moduly/kanaly/konfiguracja.ts';
import type { ModulOms } from '../kontrakty.ts';
import { registerWeb } from './pipeline.js';
import { efektywnyTryb } from '../tryb.ts';
import { kontoDemo } from '../demo.ts';
export function createModulWeb(definicje: readonly DefinicjaKanalu[]): ModulOms<{auth:{user:string;pass:string};odlozoneEkrany:readonly string[];definicje:readonly DefinicjaKanalu[];marka:{logoPlik:string|null;logoAlt:string};proba:boolean;demo:ReturnType<typeof kontoDemo>}> { return {
  nazwa:'web', wersja:'1.0.0', wymaga:['rdzen'], migracje:[],uprawnienia:[],menu:[],
  konfiguracja:env=>{
    if(!env.OMS_USER||!env.OMS_PASS)throw new Error('Brak OMS_USER/OMS_PASS dla wspólnego HTTP');
    // PRZ-060: znak instalacji w belce — PNG z wolumenu danych zamiast neutralnego z paczki.
    const marka={logoPlik:env.OMS_LOGO_PLIK?.trim()||null,logoAlt:env.OMS_LOGO_ALT?.trim()??''};
    // PRZ-075: tryb próby i konto gościa demo trafiają do każdego widoku (pipeline.js, reply.locals).
    return {definicje,auth:{user:env.OMS_USER,pass:env.OMS_PASS},odlozoneEkrany:[],marka,
      proba:efektywnyTryb(env)==='proba',demo:kontoDemo(env)};
  },
  zbuduj:ctx=>({uslugi:{config:ctx.konfiguracja},trasy:app=>{
    registerWeb(app,{db:ctx.db,config:ctx.usluga('web','config')});
  }}),
};
}
export const modulWeb = createModulWeb([]);
