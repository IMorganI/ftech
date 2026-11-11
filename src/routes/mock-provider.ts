import type { FastifyInstance } from 'fastify';
import type { MockProvider } from '../providers/mock.js';

/** Страница оплаты мок-провайдера (только для разработки, MOCK_PROVIDER_ENABLED=true). */
export async function mockProviderRoutes(app: FastifyInstance, opts: { mock: MockProvider }) {
  const { mock } = opts;
  // Формы страницы оплаты шлют пустое тело в urlencoded — содержимое не нужно.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_r, _b, done) => done(null, {}));
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  app.get<{ Params: { ref: string } }>('/mock-provider/pay/:ref', async (req, reply) => {
    const p = mock.payments.get(req.params.ref);
    if (!p) return reply.code(404).type('text/html').send('<p>Платёж не найден</p>');
    const amount = (Number(p.amount) / 100).toFixed(2);
    return reply.type('text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Мок-оплата</title>
<style>body{font:16px system-ui;max-width:420px;margin:40px auto;padding:0 16px}b{font-size:28px}
form{display:inline}button{font:inherit;padding:10px 18px;margin:16px 8px 0 0;cursor:pointer}</style>
<p>Тестовый провайдер · статус: ${esc(p.status)}</p><b>${esc(amount)} ${esc(p.currency)}</b>
<p style="color:#666">Это симуляция страницы оплаты. Настоящие карты здесь не вводятся.</p>
${p.status === 'pending' ? `
<form method="post" action="/mock-provider/pay/${esc(p.ref)}/success"><button>Оплатить</button></form>
<form method="post" action="/mock-provider/pay/${esc(p.ref)}/declined"><button>Отклонить</button></form>` : ''}`);
  });

  app.post<{ Params: { ref: string; outcome: string } }>('/mock-provider/pay/:ref/:outcome', async (req, reply) => {
    const outcome = req.params.outcome === 'success' ? 'success' : 'declined';
    const p = mock.payments.get(req.params.ref);
    if (!p) return reply.code(404).send();
    await mock.complete(p.ref, outcome);
    return reply.redirect(p.returnUrl ?? `/mock-provider/pay/${p.ref}`, 303);
  });
}
