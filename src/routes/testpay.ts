import type { FastifyInstance } from 'fastify';
import type { TestPaySimulator } from '../providers/testpay.js';

/**
 * «Кабинет» и страница оплаты учебного провайдера TestPay (только при MOCK_PROVIDER_ENABLED=true).
 * Простые HTML-формы без скриптов; всё, что выводится, экранируется.
 */
export async function testPayRoutes(app: FastifyInstance, opts: { sim: TestPaySimulator }) {
  const { sim } = opts;
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 8 * 1024 },
    (_r, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const page = (title: string, body: string) => `<!doctype html><html lang="ru"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
:root{--bg:#f6f4ef;--panel:#fff;--ink:#1d1b16;--muted:#6b665b;--line:#e2ddd1;--acc:#0f766e;--ok:#15803d;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#16150f;--panel:#201e17;--ink:#ede8dc;--muted:#a39d8f;--line:#38342a;--acc:#2dd4bf;--ok:#4ade80;--bad:#f87171}}
body{font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--ink);max-width:760px;margin:0 auto;padding:24px max(16px,env(safe-area-inset-left))}
h1{font-size:22px;margin:0 0 4px}.muted{color:var(--muted);font-size:13px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0;display:grid;gap:10px}
code{font:13px ui-monospace,monospace;background:var(--bg);padding:4px 6px;border-radius:5px;word-break:break-all;user-select:all}
input{font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:inherit;width:100%;box-sizing:border-box}
button{font:inherit;padding:7px 14px;border-radius:6px;border:1px solid var(--acc);background:var(--acc);color:var(--panel);cursor:pointer}
button.ghost{background:none;color:var(--acc)}form{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0}
form input{flex:1;min-width:220px}.ok{color:var(--ok)}.bad{color:var(--bad)}.logo{font-weight:800;color:var(--acc);letter-spacing:.02em}
</style><body>${body}</body></html>`;

  app.get('/testpay', async (_req, reply) => {
    const keys = [...sim.keys.values()].reverse();
    const disputed = new Set(sim.operations.filter((o) => o.type === 'chargeback').map((o) => o.paymentId));
    const paid = [...sim.payments.values()].filter((p) => p.status === 'success' && !disputed.has(p.id)).reverse().slice(0, 10);
    const cards = keys.map((k) => {
      const ep = k.endpoint;
      const last = ep?.lastDelivery
        ? `<div class="muted">Последняя отправка: ${esc(ep.lastDelivery.event)} · ${esc(new Date(ep.lastDelivery.at).toLocaleString('ru'))} · ответ
           <b class="${ep.lastDelivery.status >= 200 && ep.lastDelivery.status < 300 ? 'ok' : 'bad'}">${ep.lastDelivery.status || 'нет связи'}</b></div>` : '';
      return `<div class="card">
  <div class="muted">API-ключ · создан ${esc(new Date(k.createdAt).toLocaleString('ru'))}</div><code>${esc(k.key)}</code>
  <div class="muted">Адрес вебхука</div>
  <form method="post" action="/testpay/webhooks"><input type="hidden" name="key" value="${esc(k.key)}">
    <input name="url" type="url" required placeholder="вставь адрес вебхука из борды" value="${esc(ep?.url ?? '')}"><button>Сохранить адрес</button></form>
  ${ep ? `<div class="muted">Секрет подписи — вставь его в борде в шаге «Вебхук»</div><code>${esc(ep.secret)}</code>
  <form method="post" action="/testpay/webhooks/test"><input type="hidden" name="key" value="${esc(k.key)}"><button>Отправить тестовое событие</button></form>
  <form method="post" action="/testpay/webhooks/roll"><input type="hidden" name="key" value="${esc(k.key)}"><button class="ghost">Перевыпустить секрет</button></form>
  ${last}` : '<div class="muted">Секрет подписи появится после сохранения адреса.</div>'}
</div>`;
    }).join('');
    return reply.type('text/html; charset=utf-8').send(page('TestPay · кабинет', `
<div class="logo">TestPay</div><h1>Кабинет мерчанта (учебный)</h1>
<p class="muted">Так выглядит подключение у большинства провайдеров: API-ключ → адрес вебхука → секрет подписи → тестовое событие. Денег здесь нет.</p>
<form method="post" action="/testpay/keys"><button>Создать API-ключ</button></form>
${cards || '<p class="muted">Ключей пока нет.</p>'}
${paid.length ? `<div class="card"><b>Оплаты</b><div class="muted">«Оспорить» — как будто игрок пошёл в банк: в выписке появится чарджбэк.</div>
${paid.map((p) => `<form method="post" action="/testpay/payments/${esc(p.id)}/dispute"><code>${esc(p.id)}</code>
 <span>${esc(`${p.amount / 100n}.${(p.amount % 100n).toString().padStart(2, '0')} ${p.currency}`)}</span><button class="ghost">Оспорить</button></form>`).join('')}</div>` : ''}
<div class="card"><b>Выписка</b><div class="muted">Скачай и загрузи в борде: «Контроль → Сверка с провайдером».</div>
<a href="/testpay/report.csv" download="testpay-report.csv">Скачать выписку (CSV)</a></div>`));
  });

  app.post('/testpay/keys', async (_req, reply) => { sim.createKey(); return reply.redirect('/testpay', 303); });

  app.post<{ Body: Record<string, string> }>('/testpay/webhooks', async (req, reply) => {
    const { key, url } = req.body ?? {};
    let ok = false;
    try { ok = !!url && ['http:', 'https:'].includes(new URL(url).protocol); } catch { ok = false; }
    if (!ok || !key || !sim.keys.has(key)) return reply.code(400).type('text/html; charset=utf-8').send(page('Ошибка', '<p>Нужен адрес вида https://…</p><a href="/testpay">Назад</a>'));
    sim.setEndpoint(key, url!);
    return reply.redirect('/testpay', 303);
  });

  app.post<{ Body: Record<string, string> }>('/testpay/webhooks/test', async (req, reply) => {
    if (req.body?.key) await sim.sendEvent(req.body.key, 'test', { message: 'Тестовое событие из кабинета TestPay' });
    return reply.redirect('/testpay', 303);
  });

  app.post<{ Body: Record<string, string> }>('/testpay/webhooks/roll', async (req, reply) => {
    if (req.body?.key) sim.rollSecret(req.body.key);
    return reply.redirect('/testpay', 303);
  });

  app.post<{ Params: { id: string } }>('/testpay/payments/:id/dispute', async (req, reply) => {
    sim.dispute(req.params.id);
    return reply.redirect('/testpay', 303);
  });

  app.get('/testpay/report.csv', async (_req, reply) => reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', 'attachment; filename="testpay-report.csv"')
    .send(sim.reportCsv()));

  app.get<{ Params: { id: string } }>('/testpay/pay/:id', async (req, reply) => {
    const p = sim.payments.get(req.params.id);
    if (!p) return reply.code(404).type('text/html; charset=utf-8').send(page('TestPay', '<p>Платёж не найден (симулятор перезапускался?)</p>'));
    const amount = `${p.amount / 100n}.${(p.amount % 100n).toString().padStart(2, '0')}`;
    return reply.type('text/html; charset=utf-8').send(page('TestPay · оплата', `
<div class="logo">TestPay</div><div class="card"><div class="muted">Статус: ${esc(p.status)}</div>
<h1>${esc(amount)} ${esc(p.currency)}</h1><p class="muted">Учебная страница оплаты — настоящие карты здесь не вводятся.</p>
${p.status === 'pending' ? `<form method="post" action="/testpay/pay/${esc(p.id)}/success"><button>Оплатить</button></form>
<form method="post" action="/testpay/pay/${esc(p.id)}/declined"><button class="ghost">Отклонить</button></form>` : ''}</div>`));
  });

  app.post<{ Params: { id: string; outcome: string } }>('/testpay/pay/:id/:outcome', async (req, reply) => {
    const p = await sim.complete(req.params.id, req.params.outcome === 'success' ? 'success' : 'declined');
    if (!p) return reply.code(404).send();
    return reply.redirect(p.returnUrl ?? `/testpay/pay/${p.id}`, 303);
  });
}
