import { json } from '@sveltejs/kit';
import { buildFavorableContactsVcf, getFavorableContactsFromSheet } from '$lib/server/whatsapp-monitor';

export async function GET({ url }) {
  try {
    const contacts = await getFavorableContactsFromSheet();

    if (url.searchParams.get('format') === 'json') {
      return json({
        ok: true,
        count: contacts.length,
        contacts
      });
    }

    const vcf = buildFavorableContactsVcf(contacts);
    const todayBrt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());

    const inline = url.searchParams.get('inline') === '1';

    return new Response(vcf, {
      status: 200,
      headers: {
        'Content-Type': 'text/vcard; charset=utf-8',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="triade-contatos-favoraveis-${todayBrt}.vcf"`,
        'Cache-Control': 'no-store'
      }
    });
  } catch (error: any) {
    return json(
      { ok: false, error: error?.message || 'Erro ao gerar arquivo .vcf de Contatos_Favoraveis.' },
      { status: 500 }
    );
  }
}
