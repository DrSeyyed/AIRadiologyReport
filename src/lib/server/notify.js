export async function sendTelegramMessage(text, opts = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;       // group ID (can be negative)

  if (!token || !chatId) {
    console.warn('Telegram not configured (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID). Skipping message.');
    return { ok: false, skipped: true };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // HTML is easiest to avoid Markdown escaping headaches
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('Telegram send failed:', errText);
      return { ok: false, error: errText };
    }
    return { ok: true };
  } catch (e) {
    console.error('Telegram send error:', e);
    return { ok: false, error: e?.message };
  }
}
