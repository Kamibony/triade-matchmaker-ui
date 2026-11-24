import { json } from '@sveltejs/kit';
import {
  getBrasiliaTimeInfo,
  getActiveWhatsAppProvider,
  sendWhatsAppText,
  buildTwoStepOpenerMessage,
  buildDiagnosticoOpenerMessage
} from '$lib/server/whatsapp-gateway';
import { registerRuntimeDiagnosticoLead } from '$lib/server/diagnostico-whatsapp';

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
      mode = 'edital',
      diagnosticoLead,
      useTwoStepOpener = false,
      enforceBusinessHours = true,
      forceSendOutsideHours = false,
      validateBeforeSend,
      overrideConfig
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
      diagnosticoLead?.phone ||
      lead?.contatos_encontrados?.whatsapp ||
      lead?.osc?.official_contacts?.ddd_telefone_1 ||
      lead?.osc?.official_contacts?.ddd_telefone_2;

    const isDiagnosticoMode = mode === 'diagnostico';
    const finalMessage = isDiagnosticoMode
      ? message ||
        buildDiagnosticoOpenerMessage({
          nome: diagnosticoLead?.nome || lead?.osc?.nome || 'sua organização',
          tema: diagnosticoLead?.tema,
          municipio: diagnosticoLead?.municipio || lead?.osc?.municipio,
          uf: diagnosticoLead?.uf || lead?.osc?.uf,
          variant: diagnosticoLead?.variant
        })
      : useTwoStepOpener && lead
        ? buildTwoStepOpenerMessage(lead)
        : message || lead?.whatsapp_message;

    if (!rawPhone || !finalMessage) {
      return json({ ok: false, error: 'Telefone ou texto da mensagem ausente.' }, { status: 400 });
    }

    const result = await sendWhatsAppText(rawPhone, finalMessage, {
      simulateTypingMs: 3500,
      validateBeforeSend: typeof validateBeforeSend === 'boolean' ? validateBeforeSend : isDiagnosticoMode,
      overrideConfig
    });

    if (isDiagnosticoMode && result.ok && (diagnosticoLead?.cnpj || lead?.osc?.cnpj)) {
      registerRuntimeDiagnosticoLead({
        cnpj: String(diagnosticoLead?.cnpj || lead?.osc?.cnpj || '').replace(/\D/g, ''),
        nome: diagnosticoLead?.nome || lead?.osc?.nome || 'Organização',
        phone: result.phone || rawPhone,
        uf: diagnosticoLead?.uf || lead?.osc?.uf,
        municipio: diagnosticoLead?.municipio || lead?.osc?.municipio,
        tema: diagnosticoLead?.tema,
        ref: diagnosticoLead?.ref,
        campanha_tag: diagnosticoLead?.campanha_tag,
        origem: diagnosticoLead?.origem || 'Lista',
        variant: diagnosticoLead?.variant
      });
    }

    return json({
      ...result,
      mode: isDiagnosticoMode ? 'diagnostico' : 'edital',
      sentText: finalMessage,
      businessHours: timeInfo
    });
  } catch (error: any) {
    return json({ ok: false, error: error.message || 'Erro ao processar envio WhatsApp.' }, { status: 500 });
  }
}
