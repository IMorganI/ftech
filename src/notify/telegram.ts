/** Отправка сообщения в Telegram через Bot API. Токен бота — только из переменных окружения. */
export type TgFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface Sender {
  send(text: string): Promise<void>;
}

export class TelegramSender implements Sender {
  constructor(private token: string, private chatId: string, private fetch: TgFetch = globalThis.fetch as unknown as TgFetch) {}

  async send(text: string): Promise<void> {
    const res = await this.fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    // В тексте ошибки нет токена: он только в адресе запроса.
    if (!res.ok) throw new Error(`Telegram: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}
