import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
type Wiazanie = { rozpocznij: (kanal: string) => Promise<{ ok: boolean; powod?: string }> };
export function registerWiazanieRoute(app: FastifyInstance, {
  wiazanieKanalow, widokIntegracji,
}: { wiazanieKanalow: Wiazanie | null; widokIntegracji: (req: FastifyRequest, reply: FastifyReply, dane: { blad: string | undefined }) => unknown }) {
  app.post<{ Params: { kanal: string } }>('/ustawienia/kanaly/:kanal/wiazanie', async (req, reply) => {
    if (!wiazanieKanalow) {
      reply.code(503);
      return widokIntegracji(req, reply, { blad: 'Panel nie ma podpiętych kanałów Allegro.' });
    }
    const wynik = await wiazanieKanalow.rozpocznij(String(req.params?.kanal ?? ''));
    if (!wynik.ok) {
      reply.code(400);
      return widokIntegracji(req, reply, { blad: wynik.powod });
    }
    return reply.redirect('/ustawienia/integracje?zapisano=kanal');
  });
}
