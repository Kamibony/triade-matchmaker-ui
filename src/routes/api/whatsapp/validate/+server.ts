import { json } from '@sveltejs/kit';
import { checkWhapiNumbers } from '$lib/server/whatsapp-gateway';

export async function POST({ request }) {
  try {
    const body = await request.json().catch(() => ({}));
    const rawPhones: string[] = Array.isArray(body?.phones)
      ? body.phones.map((p: any) => String(p || '').trim()).filter(Boolean)
      : [];

    if (rawPhones.length === 0) {
      return json({ ok: false, error: 'Informe um array "phones" com pelo menos 1 número.' }, { status: 400 });
    }

    if (rawPhones.length > 25) {
      return json(
        { ok: false, error: 'Limite de segurança: máximo de 25 números por requisição.' },
        { status: 400 }
      );
    }

    const result = await checkWhapiNumbers(rawPhones);
    return json(result, { status: result.ok ? 200 : 502 });
  } catch (err: any) {
    return json({ ok: false, error: err?.message || 'Erro ao validar números.' }, { status: 500 });
  }
}
