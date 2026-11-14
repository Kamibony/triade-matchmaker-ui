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

    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${apiToken}`
    };

    const count = Math.min(200, Math.max(10, parseInt(url.searchParams.get('count') || '100', 10)));

    // 1. Check channel health/status
    let health: any = null;
    try {
      const hRes = await fetch(`${apiUrl}/health?wakeup=false`, { headers });
      health = await hRes.json().catch(() => ({ httpStatus: hRes.status }));
    } catch {}

    // 2. Try global /messages/list first
    const res = await fetch(`${apiUrl}/messages/list?count=${count}`, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return json(
        { ok: false, health, error: data?.error?.message || data?.message || `Whapi HTTP ${res.status}` },
        { status: res.status }
      );
    }

    let rawMessages: any[] = Array.isArray(data?.messages) ? data.messages : [];
    let chatsSummary: any[] = [];

    // 3. Fallback: query /chats (which persists chat list & last message even when /messages/list is empty)
    if (rawMessages.length === 0) {
      try {
        const cRes = await fetch(`${apiUrl}/chats?count=100`, { headers });
        if (cRes.ok) {
          const cData = await cRes.json().catch(() => ({}));
          const chatsList: any[] = Array.isArray(cData?.chats) ? cData.chats : [];
          chatsSummary = chatsList
            .filter((c) => c?.id && !String(c.id).includes('@g.us') && !String(c.id).includes('@broadcast') && !String(c.id).includes('status@'))
            .map((c) => ({
              chatId: c.id,
              name: c.name || null,
              unread: c.unread || 0,
              timestamp: c.timestamp ? new Date(c.timestamp * 1000).toISOString() : null,
              lastMessage: c.last_message?.text?.body || c.last_message?.type || null,
              lastFromMe: c.last_message?.from_me ?? null
            }));

          // Fetch individual chat messages for up to 30 direct chats
          for (const chat of chatsSummary.slice(0, 30)) {
            try {
              const mRes = await fetch(`${apiUrl}/messages/list/${encodeURIComponent(chat.chatId)}?count=30`, { headers });
              if (mRes.ok) {
                const mData = await mRes.json().catch(() => ({}));
                if (Array.isArray(mData?.messages)) {
                  rawMessages.push(...mData.messages);
                }
              }
            } catch {}
          }
        }
      } catch {}
    }

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
      channelStatus: health?.status?.text || health?.status || null,
      health,
      totalMessagesFetched: rawMessages.length,
      totalChats: conversations.length,
      chatsFromChatsEndpoint: chatsSummary.length,
      chatsSummary,
      chatsWithReplies: conversations.filter((c) => c.hasIncomingReply)
    });
  } catch (error: any) {
    return json({ ok: false, error: error?.message || 'Erro ao buscar histórico Whapi.' }, { status: 500 });
  }
}
