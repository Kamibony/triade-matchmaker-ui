import { json } from '@sveltejs/kit';
import {
  getBrasiliaTimeInfo,
  getActiveWhatsAppProvider,
  sendWhatsAppText,
  buildTwoStepOpenerMessage
} from '$lib/server/whatsapp-gateway';

export async function GET() {
  const timeInfo = getBrasiliaTimeInfo();
  const provider = getActiveWhatsAppProvider();

  return json({
    provider,
    configured: provider !== 'simulation',
    businessHours: timeInfo
  });
}

export async function POST({ request }) {
  try {
    const body = await request.json();
    const {
      phone,
      message,
      lead,
      useTwoStepOpener = false,
      enforceBusinessHours = true,
      forceSendOutsideHours = false
    } = body;

    const timeInfo = getBrasiliaTimeInfo();
    if (enforceBusinessHours && !forceSendOutsideHours && !timeInfo.isBusinessHours) {
      return json(
        {
          ok: false,
          queuedForBusinessHours: true,
          businessHours: timeInfo,
          error: `Fora do horário comercial (${timeInfo.formattedTime}). O disparo automático aguarda a janela de Seg–Sex, 09:00 às 17:30 BRT.`
        },
        { status: 425 }
      );
    }

    const rawPhone =
      phone ||
      lead?.contatos_encontrados?.whatsapp ||
      lead?.osc?.official_contacts?.ddd_telefone_1 ||
      lead?.osc?.official_contacts?.ddd_telefone_2;

    const finalMessage = useTwoStepOpener && lead ? buildTwoStepOpenerMessage(lead) : message || lead?.whatsapp_message;

    if (!rawPhone || !finalMessage) {
      return json({ ok: false, error: 'Telefone ou texto da mensagem ausente.' }, { status: 400 });
    }

    const result = await sendWhatsAppText(rawPhone, finalMessage, { simulateTypingMs: 3500 });

    return json({
      ...result,
      sentText: finalMessage,
      businessHours: timeInfo
    });
  } catch (error: any) {
    return json({ ok: false, error: error.message || 'Erro ao processar envio WhatsApp.' }, { status: 500 });
  }
}
