// npm run telegram:setup — находит твой chat_id по сообщению, которое ты написал боту, и записывает в .env.
// Перед запуском: TELEGRAM_BOT_TOKEN уже в .env, и ты отправил боту любое сообщение.
import { readFile, appendFile } from 'node:fs/promises';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Нет TELEGRAM_BOT_TOKEN в .env. Добавь строку TELEGRAM_BOT_TOKEN=<токен от @BotFather> и запусти снова.');
  process.exit(1);
}
const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, { signal: AbortSignal.timeout(10_000) });
const body = await res.json() as { ok: boolean; result?: { message?: { chat: { id: number; first_name?: string; username?: string } } }[]; description?: string };
if (!body.ok) {
  console.error(`Telegram ответил ошибкой: ${body.description ?? res.status}. Проверь токен.`);
  process.exit(1);
}
const chats = new Map<number, string>();
for (const u of body.result ?? []) if (u.message) chats.set(u.message.chat.id, u.message.chat.username ?? u.message.chat.first_name ?? '');
if (!chats.size) {
  console.error('Бот пока не получил ни одного сообщения. Напиши ему в Telegram что-нибудь (например «привет») и запусти снова.');
  process.exit(1);
}
const [id, name] = [...chats.entries()].at(-1)!;
const env = await readFile('.env', 'utf8').catch(() => '');
if (/^TELEGRAM_CHAT_ID=/m.test(env)) {
  console.log(`В .env уже есть TELEGRAM_CHAT_ID. Найденный чат: ${id} (${name}).`);
} else {
  await appendFile('.env', `${env.endsWith('\n') || !env ? '' : '\n'}TELEGRAM_CHAT_ID=${id}\n`);
  console.log(`Готово: TELEGRAM_CHAT_ID=${id} (${name}) записан в .env. Перезапусти сервер: npm run up`);
}
await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ chat_id: id, text: '✅ ftech подключён. Сюда будут приходить уведомления о проблемах с платежами.' }),
}).catch(() => {});
