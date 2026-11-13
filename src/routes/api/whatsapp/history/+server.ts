import { json } from '@sveltejs/kit';
import { resolveGatewayConfig } from '$lib/server/whatsapp-gateway';

export async function GET({ url }) {
  try {
    const { provider, apiUrl, apiToken } = resolveGatewayConfig();
    if (provider !== 'whapi' || !apiToken) {
      return json(
        { ok: false, error: `Provider atual (${provider}) não suporta listagem de histórico via Whapi.` },
        { status: 400 }
      );
    }

    const count = Math.min(100, Math.max(10, parseInt(url.searchParams.get('count') || '60', 10)));
    const res = await fetch(`${apiUrl}/messages/list?count=${count}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiToken}`
      }
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return json(
        { ok: false, error: data?.error?.message || data?.message || `Whapi HTTP ${res.status}` },
        { status: res.status }
      );
    }

    const rawMessages: any[] = Array.isArray(data?.messages) ? data.messages : [];
    const grouped: Record<string, any[]> = {};

    for (const m of rawMessages) {
      const chatId = m.chat_id || m.from || 'unknown';
      if (chatId.includes('@g.us') || chatId.includes('@broadcast') || chatId.includes('status@')) continue;

      const text =
        m.text?.body ||
        m.voice?.caption ||
        m.image?.caption ||
        m.document?.caption ||
        `[${m.type || 'mídia'}]`;

      if (!grouped[chatId]) grouped[chatId] = [];
      grouped[chatId].push({
        id: m.id,
        fromMe: !!m.from_me,
        fromName: m.from_name || null,
        timestamp: m.timestamp ? new Date(m.timestamp * 1000).toISOString() : null,
        text
      });
    }

    // Sort each chat chronologically (oldest -> newest)
    const conversations = Object.entries(grouped).map(([chatId, msgs]) => {
      const sorted = [...msgs].sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
      const hasReply = sorted.some((m) => !m.fromMe);
      return {
        chatId,
        phone: chatId.split('@')[0],
        hasIncomingReply: hasReply,
        messageCount: sorted.length,
        messages: sorted
      };
    });

    return json({
      ok: true,
      totalMessagesFetched: rawMessages.length,
      totalChats: conversations.length,
      chatsWithReplies: conversations.filter((c) => c.hasIncomingReply)
    });
  } catch (error: any) {
    return json({ ok: false, error: error?.message || 'Erro ao buscar histórico Whapi.' }, { status: 500 });
  }
}
