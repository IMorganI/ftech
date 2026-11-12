/* Борда ftech. Без сборки и зависимостей: DOM строится через h() и текстовые узлы, HTML-строки не вставляются никогда — данные из базы не могут внедрить разметку. */
'use strict';

// ---------- утилиты ----------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'style') el.style.cssText = v; // через CSSOM: строгий CSP запрещает style-атрибуты, но не CSSOM
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** Заменить содержимое элемента: вложенные массивы раскрываются, null/false пропускаются (иначе DOM напишет «null»). */
function put(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
}

async function api(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body ?? {}); }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* пустой ответ */ }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Ошибка ${res.status}`);
    err.status = res.status; err.code = data?.error?.code; err.details = data?.error?.details;
    throw err;
  }
  return data;
}

/** Центы (строка/число) → «1 234.56» */
function money(cents, currency) {
  if (cents === null || cents === undefined) return '—';
  const n = BigInt(cents);
  const neg = n < 0n; const a = neg ? -n : n;
  const whole = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const s = `${neg ? '−' : ''}${whole}.${(a % 100n).toString().padStart(2, '0')}`;
  return currency ? `${s} ${currency}` : s;
}
/** «12.50» → '1250' (центы строкой) */
function toCents(text) {
  const t = String(text).trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  const c = BigInt(w) * 100n + BigInt((f + '00').slice(0, 2));
  return c > 0n ? c.toString() : null;
}
const when = (iso) => iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const list = (s) => String(s).split(/[,\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);

const STATUS = {
  success: ['ok', 'Успех'], pending: ['n', 'Ожидает'], declined: ['bad', 'Отказ'], failed: ['bad', 'Ошибка'], created: ['m', 'Создан'],
};
const pill = (status) => { const [c, t] = STATUS[status] || ['m', status]; return h('span', { class: `pill ${c}` }, t); };
const DECLINE = {
  capacity_exhausted: 'лимиты аккаунтов заполнены',
  player_self_excluded: 'самоисключение', country_not_licensed: 'страна вне лицензии', kyc_rejected: 'KYC отклонён',
  kyc_required: 'нужен KYC', player_limit_exceeded: 'лимит игрока', no_route: 'нет маршрута', all_attempts_failed: 'отказ провайдеров',
  provider_unavailable: 'провайдер не ответил (без каскада)', amount_over_limit: 'больше лимита выплаты',
};

function errorBox(err) {
  const details = (err.details || []).map((d) => `${d.path}: ${d.message}`).join('; ');
  return h('div', { class: 'msg err', role: 'alert' }, err.message, details ? ` (${details})` : '');
}
function field(label, input, cls) { return h('label', { class: cls }, label, input); }
function formValues(form) {
  const out = {};
  for (const el of form.querySelectorAll('[name]')) out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  return out;
}

/** Форма с обработкой ошибок: onSubmit(values) → Promise; результат/ошибка показываются под формой. */
function actionForm(attrs, children, onSubmit) {
  const out = h('div');
  const form = h('form', { ...attrs, onsubmit: async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn && (btn.disabled = true);
    put(out, );
    try { const r = await onSubmit(formValues(form), form); if (r instanceof Node) out.append(r); }
    catch (err) { if (!handleAuthError(err)) out.append(errorBox(err)); }
    finally { btn && (btn.disabled = false); }
  } }, children);
  return h('div', { class: 'stack' }, form, out);
}

/** Блок «показывается один раз» — для ключей и паролей. */
function shownOnce(title, pairs) {
  return h('div', { class: 'once' },
    h('b', null, title),
    h('div', { class: 'note' }, 'Скопируй сейчас: после обновления страницы это больше не покажется.'),
    pairs.map(([label, value]) => [
      h('div', { class: 'note' }, label),
      h('code', null, value),
      h('button', { class: 'sm', type: 'button', onclick: async (e) => {
        try { await navigator.clipboard.writeText(value); e.target.textContent = 'Скопировано'; }
        catch { e.target.textContent = 'Выдели и скопируй вручную'; }
      } }, 'Копировать'),
    ]));
}

// ---------- состояние ----------

const state = { me: null, tab: 'overview', timer: null, cache: {} };
const root = document.getElementById('root');
const can = (role) => ({ viewer: 1, operator: 2, admin: 3 })[state.me?.role] >= ({ viewer: 1, operator: 2, admin: 3 })[role];

function handleAuthError(err) {
  if (err.status === 401) { state.me = null; showLogin('Сессия истекла, войдите снова'); return true; }
  if (err.code === 'password_change_required') { showChangePassword(); return true; }
  return false;
}

// ---------- вход ----------

function authScreen(title, ...body) {
  clearInterval(state.timer);
  document.body.classList.remove('app');
  put(root, h('div', { class: 'auth' }, h('div', { class: 'brand' }, 'ftech · борда'), h('h1', null, title), body));
}

function showLogin(notice) {
  authScreen('Вход',
    notice ? h('div', { class: 'msg err' }, notice) : null,
    actionForm({ class: 'panel' }, [
      field('Email', h('input', { name: 'email', type: 'email', autocomplete: 'username', required: true, id: 'login-email' })),
      field('Пароль', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true, id: 'login-password' })),
      h('button', { class: 'primary', type: 'submit' }, 'Продолжить'),
    ], async (v) => {
      const r = await api('POST', '/admin/v1/auth/login', v);
      if (r.next === 'totp_setup') showTotp(r); else showTotp(null);
    }));
  document.getElementById('login-email')?.focus();
}

function showTotp(setup) {
  authScreen(setup ? 'Настройка 2FA' : 'Код подтверждения',
    setup ? h('div', { class: 'panel' },
      h('p', { style: null }, 'Отсканируй QR-код в Google Authenticator, 1Password или Authy. Без этого войти будет нельзя.'),
      h('img', { class: 'qr', alt: 'QR-код для приложения-аутентификатора', src: 'data:image/svg+xml;utf8,' + encodeURIComponent(setup.qrSvg) }),
      h('div', { class: 'note' }, 'Или введи ключ вручную:'),
      h('div', { class: 'secret' }, setup.totpSecret)) : null,
    actionForm({ class: 'panel' }, [
      field('6 цифр из приложения', h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '\\d{6}', maxlength: 6, required: true, id: 'totp-code' })),
      h('button', { class: 'primary', type: 'submit' }, 'Подтвердить'),
    ], async (v) => {
      const r = await api('POST', '/admin/v1/auth/totp', { code: v.code.trim() });
      if (r.next === 'change_password') showChangePassword(); else boot();
    }),
    h('button', { class: 'link', type: 'button', onclick: () => showLogin() }, '← Назад'));
  document.getElementById('totp-code')?.focus();
}

function showChangePassword() {
  authScreen('Смена временного пароля',
    h('p', { class: 'note' }, 'Минимум 12 символов, буквы и цифры. Удобно — фраза из нескольких слов с числом.'),
    actionForm({ class: 'panel' }, [
      field('Текущий (временный) пароль', h('input', { name: 'currentPassword', type: 'password', autocomplete: 'current-password', required: true })),
      field('Новый пароль', h('input', { name: 'newPassword', type: 'password', autocomplete: 'new-password', minlength: 12, required: true })),
      h('button', { class: 'primary', type: 'submit' }, 'Сменить пароль'),
    ], async (v) => { await api('POST', '/admin/v1/me/password', v); boot(); }));
}

// ---------- каркас ----------

// Меню: группы → разделы. [id, название, минимальная роль, подзаголовок страницы]
const MENU = [
  ['Деньги', [
    ['overview', 'Обзор', 'viewer', 'Депозиты, оборот и заработок платформы за период'],
    ['analytics', 'Аналитика', 'viewer', 'Цифры по операторам, сайтам, аккаунтам и провайдерам; выгрузка в CSV'],
    ['payments', 'Платежи', 'viewer', 'Все депозиты и выплаты: поиск, статусы, попытки по аккаунтам'],
    ['manual', 'Ручные выплаты', 'viewer', 'Остатки выплат, которые не удалось вернуть на карту'],
  ]],
  ['Подключения', [
    ['connect', 'Операторы и аккаунты', 'viewer', 'Платёжные аккаунты, ключи провайдеров, вебхуки и сайты'],
    ['accounts', 'Лимиты и маршрутизация', 'viewer', 'Сколько осталось до лимита каждого аккаунта сегодня'],
    ['sandbox', 'Тест-платёж', 'viewer', 'Проверить маршрутизацию и оплату без сайта'],
  ]],
  ['Контроль', [
    ['stuck', 'Зависшие деньги', 'viewer', 'Где и сколько денег ждёт, как давно и что делать'],
    ['issues', 'Проблемы', 'viewer', 'Расхождения с провайдерами, которые разбирает человек'],
    ['chargebacks', 'Чарджбэки', 'viewer', 'Споры игроков через банк: сроки ответа, доказательства, итог'],
    ['reconciliation', 'Сверка с провайдером', 'viewer', 'Загрузи выписку из кабинета провайдера — увидишь, где деньги расходятся'],
    ['audit', 'Журнал действий', 'admin', 'Кто, что и когда менял в борде'],
  ]],
  ['Настройки', [
    ['users', 'Команда', 'admin', 'Доступы сотрудников и роли'],
  ]],
];
const TABS = MENU.flatMap(([, items]) => items);
const ROLE_RU = { viewer: 'наблюдатель', operator: 'оператор', admin: 'администратор' };

async function boot() {
  try {
    state.me = await api('GET', '/admin/v1/me');
    if (state.me.mustChangePassword) return showChangePassword();
    const fromHash = location.hash.slice(1);
    if (TABS.some(([id, , role]) => id === fromHash && can(role))) state.tab = fromHash;
    renderShell();
  } catch (err) {
    if (err.status === 401) showLogin(); else put(root, errorBox(err));
  }
}

function go(id) { state.tab = id; location.hash = id; document.body.classList.remove('menu-open'); renderShell(); }

/** Счётчики в меню: ручные выплаты и открытые проблемы. */
async function refreshBadges() {
  try {
    const [o, st] = await Promise.all([api('GET', '/admin/v1/overview'), api('GET', '/admin/v1/stuck').catch(() => null)]);
    // Зависшие: только то, что требует действия или внимания (без «ждут оплаты игроком»).
    const stuck = st ? st.categories.filter((c) => c.severity === 'bad').reduce((a, c) => a + c.count, 0) : 0;
    const catCount = (k) => st?.categories.find((c) => c.key === k)?.count ?? 0;
    state.badges = { manual: o.manual_payouts ?? 0, issues: o.open_issues ?? 0, stuck,
      chargebacks: catCount('chargeback_deadline') + catCount('chargebacks_open'), reconciliation: catCount('report_discrepancies') };
    for (const [id, n] of Object.entries(state.badges)) {
      const b = document.querySelector(`[data-badge="${id}"]`);
      if (b) { b.textContent = n > 99 ? '99+' : String(n); b.hidden = !n; }
    }
  } catch { /* не критично */ }
}

function renderShell() {
  const badges = state.badges || {};
  const nav = h('nav', { class: 'side-nav', 'aria-label': 'Разделы' },
    MENU.map(([group, items]) => {
      const visible = items.filter(([, , role]) => can(role));
      if (!visible.length) return null;
      return h('div', { class: 'nav-group' },
        h('div', { class: 'nav-title' }, group),
        visible.map(([id, label]) => h('button', {
          class: state.tab === id ? 'on' : '', 'aria-current': state.tab === id ? 'page' : null, onclick: () => go(id),
        }, h('span', null, label),
          ['manual', 'issues', 'stuck', 'chargebacks', 'reconciliation'].includes(id) ? h('span', { class: `badge ${id === 'manual' ? 'warn' : 'bad'}`, 'data-badge': id, hidden: !badges[id] }, String(badges[id] ?? 0)) : null)));
    }));
  const [, title, , subtitle] = TABS.find(([id]) => id === state.tab) || TABS[0];
  const group = MENU.find(([, items]) => items.some(([id]) => id === state.tab))?.[0] ?? '';
  const main = h('main', { id: 'main' });
  document.body.classList.add('app');
  put(root,
    h('div', { class: 'layout' },
      h('aside', { class: 'side' },
        h('div', { class: 'side-head' },
          h('div', { class: 'logo' }, h('span', { class: 'logo-mark' }, 'f'), h('span', null, 'ftech')),
          h('button', { class: 'menu-btn', 'aria-label': 'Меню', onclick: () => document.body.classList.toggle('menu-open') }, '☰')),
        nav,
        h('div', { class: 'side-foot' },
          h('div', { class: 'me' }, h('b', null, state.me.email), h('span', null, ROLE_RU[state.me.role] || state.me.role)),
          h('button', { class: 'sm', onclick: async () => { await api('POST', '/admin/v1/auth/logout').catch(() => {}); state.me = null; showLogin(); } }, 'Выйти'))),
      h('div', { class: 'content' },
        h('header', { class: 'page-head' },
          h('div', { class: 'crumb' }, group),
          h('h1', null, title),
          h('p', null, subtitle)),
        main)));
  refreshBadges();
  clearInterval(state.timer);
  const view = VIEWS[state.tab];
  const run = async () => {
    try { await view(main); }
    catch (err) { if (!handleAuthError(err)) put(main, errorBox(err)); }
  };
  run();
  // Живые разделы обновляются сами, пока пользователь ничего не редактирует.
  if (['overview', 'payments', 'manual', 'accounts', 'issues', 'stuck', 'chargebacks'].includes(state.tab)) {
    state.timer = setInterval(() => { if (!main.contains(document.activeElement) || document.activeElement === document.body) run(); }, 5000);
  }
}

// ---------- аналитика ----------

const GROUPS = [['operator', 'Операторы'], ['site', 'Сайты'], ['account', 'Аккаунты'], ['provider', 'Провайдеры']];
const A_PERIODS = [['today', 'Сегодня'], ['7d', '7 дней'], ['30d', '30 дней'], ['custom', 'Свой период']];
const isoDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const ruDay = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

function analyticsQuery(f) {
  const p = new URLSearchParams({ period: f.period, groupBy: f.groupBy, tz: TZ });
  if (f.period === 'custom') { p.set('from', f.from); p.set('to', f.to); }
  if (f.operatorId) p.set('operatorId', f.operatorId);
  return p.toString();
}

/** Скачивание через fetch: ошибки (слишком длинный период и т. п.) показываем в борде, а не открываем JSON. */
async function download(path, btn, box) {
  btn.disabled = true; put(box);
  try {
    const res = await fetch(path, { credentials: 'same-origin' });
    if (!res.ok) {
      let msg = `Ошибка ${res.status}`;
      try { msg = (await res.json()).error.message; } catch { /* не JSON */ }
      throw Object.assign(new Error(msg), { status: res.status });
    }
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'ftech.csv';
    const url = URL.createObjectURL(await res.blob());
    const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (err) {
    if (!handleAuthError(err)) put(box, errorBox(err));
  } finally { btn.disabled = false; }
}

async function viewAnalytics(main) {
  const today = isoDay(new Date());
  const f = state.cache.analytics ||= { period: '30d', groupBy: 'operator', operatorId: '', from: isoDay(new Date(Date.now() - 29 * 86400e3)), to: today };
  const operators = await api('GET', '/admin/v1/operators');
  let data, loadError = null;
  try { data = await api('GET', `/admin/v1/analytics?${analyticsQuery(f)}`); }
  catch (err) {
    if (err.status === 401 || err.status === 403) throw err;
    // Фильтры остаются на экране — ошибку можно исправить, не уходя со страницы.
    loadError = err; data = { rows: [], totals: [], fromDay: f.from, toDay: f.to, tz: TZ };
  }
  const set = (patch) => { Object.assign(f, patch); renderShell(); };
  const forAccounts = f.groupBy === 'account' || f.groupBy === 'provider';
  const [colName, colExtra] = { operator: ['Оператор', null], site: ['Сайт', 'Оператор'], account: ['Аккаунт', 'Провайдер'], provider: ['Провайдер', null] }[f.groupBy];

  const seg = (items, cur, onPick, label) => h('div', { class: 'seg', role: 'group', 'aria-label': label },
    items.map(([id, name]) => h('button', { class: id === cur ? 'on' : '', 'aria-pressed': id === cur, onclick: () => onPick(id) }, name)));

  const fromIn = h('input', { type: 'date', value: f.from, max: today, 'aria-label': 'С' });
  const toIn = h('input', { type: 'date', value: f.to, max: today, 'aria-label': 'По' });
  const custom = f.period === 'custom' ? h('div', { class: 'dates' },
    h('label', null, 'С', fromIn), h('label', null, 'По', toIn),
    h('button', { class: 'primary', onclick: () => {
      const a = fromIn.value, b = toIn.value;
      const days = (Date.parse(b) - Date.parse(a)) / 86400e3 + 1;
      if (!a || !b || days < 1) return put(dlBox, h('div', { class: 'msg err' }, 'Дата «по» должна быть не раньше даты «с»'));
      if (days > 366) return put(dlBox, h('div', { class: 'msg err' }, 'Период не больше 366 дней'));
      set({ from: a, to: b });
    } }, 'Показать')) : null;

  const opSel = h('select', { 'aria-label': 'Оператор', onchange: (e) => set({ operatorId: e.target.value }) },
    h('option', { value: '' }, 'Все операторы'),
    operators.map((o) => { const opt = h('option', { value: o.id }, o.name); if (o.id === f.operatorId) opt.selected = true; return opt; }));

  const dlBox = h('div');
  const dlSummary = h('button', { onclick: () => download(`/admin/v1/analytics.csv?${analyticsQuery(f)}`, dlSummary, dlBox) }, '⇩ Таблица в CSV');
  const dlTx = can('operator') ? h('button', { onclick: () => download(`/admin/v1/export/transactions.csv?${analyticsQuery(f)}`, dlTx, dlBox) }, '⇩ Все платежи в CSV') : null;

  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const share = (v, total) => (BigInt(total) > 0n ? Number((BigInt(v) * 1000n) / BigInt(total)) / 10 : 0);
  const totalBy = Object.fromEntries(data.totals.map((t) => [t.currency, t]));
  const meter = (value, cls) => value === null ? h('span', { class: 'dim' }, '—')
    : h('div', { class: 'cell-meter' }, h('span', null, `${value}%`),
        h('div', { class: `meter ${cls || ''}` }, h('i', { style: `width:${Math.min(100, value)}%` })));

  const line = (r, total) => {
    const conv = pct(r.succeeded, r.succeeded + r.declined);
    return h('tr', { class: total ? 'total' : '' },
      h('td', null, h('div', { class: 'name' }, r.label), colExtra && r.extra ? h('div', { class: 'note' }, r.extra) : null),
      h('td', { class: 'n' }, h('b', null, r.succeeded), h('span', { class: 'dim' }, ` / ${r.deposits}`)),
      h('td', null, meter(conv, conv !== null && conv < 50 ? 'low' : '')),
      h('td', null, meter(pct(r.attemptsOk, r.attempts), 'alt')),
      h('td', { class: 'n' }, money(r.volume, r.currency),
        total ? null : h('div', { class: 'meter share', title: `${share(r.volume, totalBy[r.currency]?.volume ?? 0)}% оборота` },
          h('i', { style: `width:${share(r.volume, totalBy[r.currency]?.volume ?? 0)}%` }))),
      h('td', { class: 'n' }, r.succeeded ? money(String(BigInt(r.volume) / BigInt(r.succeeded)), r.currency) : '—'),
      h('td', { class: 'n money' }, money(r.earned, r.currency)),
      h('td', { class: 'n dim' }, money(r.providerCost, r.currency)),
      h('td', { class: 'n' }, BigInt(r.paidOut) ? money(r.paidOut, r.currency) : h('span', { class: 'dim' }, '—'),
        r.payouts ? h('div', { class: 'note' }, `${r.payouts} ${forAccounts ? plural(r.payouts, 'возврат', 'возврата', 'возвратов') : plural(r.payouts, 'выплата', 'выплаты', 'выплат')}`) : null));
  };

  const t = data.totals;
  const kpi = (label, value, sub) => h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, label),
    h('b', { class: 'kpi-value' }, ...(value.length ? value.map((v) => h('span', null, v)) : ['0'])), sub ? h('span', { class: 'kpi-sub' }, sub) : null);
  const sumN = (k) => t.reduce((a, r) => a + r[k], 0);
  const totalConv = pct(sumN('succeeded'), sumN('succeeded') + sumN('declined'));

  put(main,
    h('section', { class: 'panel filters' },
      h('div', { class: 'filter-row' }, h('span', { class: 'flabel' }, 'Период'), seg(A_PERIODS, f.period, (id) => set({ period: id }), 'Период'), custom),
      h('div', { class: 'filter-row' }, h('span', { class: 'flabel' }, 'Разбить по'), seg(GROUPS, f.groupBy, (id) => set({ groupBy: id }), 'Группировка'),
        operators.length > 1 ? opSel : null),
      h('div', { class: 'row' },
        h('span', { class: 'note' }, `${ruDay(data.fromDay)} — ${ruDay(data.toDay)} · время ${data.tz}`),
        h('div', { class: 'row start' }, dlSummary, dlTx)),
      dlBox, loadError ? errorBox(loadError) : null),

    t.length ? h('div', { class: 'kpis' },
      kpi('Оборот', t.map((r) => money(r.volume, r.currency)), `${sumN('succeeded')} ${plural(sumN('succeeded'), 'успешный депозит', 'успешных депозита', 'успешных депозитов')}`),
      kpi('Конверсия', [totalConv === null ? '—' : `${totalConv}%`], `${sumN('declined')} ${plural(sumN('declined'), 'отказ', 'отказа', 'отказов')}`),
      kpi('Заработала платформа', t.map((r) => money(r.earned, r.currency)), 'комиссия с успешных депозитов'),
      kpi('Выплачено игрокам', t.map((r) => money(r.paidOut, r.currency)).filter((_, i) => BigInt(t[i].paidOut)), forAccounts ? 'возвраты на карты через аккаунты' : `${sumN('payouts')} ${plural(sumN('payouts'), 'выплата', 'выплаты', 'выплат')}`)) : null,

    h('section', { class: 'panel' },
      h('div', { class: 'row' }, h('h2', null, `По ${{ operator: 'операторам', site: 'сайтам', account: 'аккаунтам', provider: 'провайдерам' }[f.groupBy]}`)),
      data.rows.length === 0
        ? h('p', { class: 'note' }, 'За этот период платежей нет. Выбери период длиннее или проведи тест-платёж.')
        : h('div', { class: 'tbl' }, h('table', { class: 'analytics' },
            h('thead', null, h('tr', null,
              h('th', null, colName), h('th', null, 'Депозиты', h('div', { class: 'th-sub' }, 'успешно / всего')),
              h('th', null, 'Конверсия'), h('th', null, 'Одобрение', h('div', { class: 'th-sub' }, 'попыток')),
              h('th', null, 'Оборот', h('div', { class: 'th-sub' }, 'доля в валюте')), h('th', null, 'Средний чек'),
              h('th', null, 'Заработали'), h('th', null, 'Провайдеру'),
              h('th', null, forAccounts ? 'Возвраты на карты' : 'Выплачено'))),
            h('tbody', null, data.rows.map((r) => line(r, false))),
            h('tfoot', null, data.totals.map((r) => line(r, true))))),
      h('details', { class: 'explain' }, h('summary', null, 'Что значат колонки'),
        h('ul', { class: 'plain note' },
          h('li', null, 'Конверсия — доля успешных среди завершённых депозитов (без тех, что ещё ждут оплаты).'),
          h('li', null, 'Одобрение попыток — доля успешных попыток. Если платёж каскадом прошёл со второго аккаунта, у первого это отказ. ',
            forAccounts ? 'Здесь попытка засчитывается тому аккаунту, через который она шла.' : ''),
          h('li', null, 'Заработали — комиссия платформы с успешных депозитов. Провайдеру — его комиссия по ставке аккаунта.'),
          h('li', null, forAccounts ? 'Возвраты на карты — выплаты игрокам, проведённые возвратом через этот аккаунт.' : 'Выплачено — успешные выплаты игрокам (возвраты на карты и ручные).'),
          h('li', null, 'Разные валюты не складываются: итог — отдельно по каждой валюте.'),
          h('li', null, 'CSV открывается в Excel и Google Таблицах: разделитель «;», копейки через запятую. Выгрузка всех платежей содержит ID игроков, доступна с роли «оператор» и записывается в журнал.')))));
}

// ---------- обзор: деньги и депозиты ----------

const PERIODS = [['today', 'Сегодня'], ['7d', '7 дней'], ['30d', '30 дней']];
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const plural = (n, one, few, many) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many; };
const moneyList = (rows, key) => rows.filter((r) => BigInt(r[key]) !== 0n).map((r) => money(r[key], r.currency));

function svg(tag, attrs, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

/** Столбики: успешные депозиты по часам/дням, сверху — отказы. Подсказка при наведении — через <title>. */
function depositsChart(series, unit) {
  const W = 760, H = 200, L = 34, B = 24, T = 8;
  const max = Math.max(1, ...series.map((p) => p.succeeded + p.declined));
  const step = Math.max(1, Math.ceil(max / 4));
  const top = Math.ceil(max / step) * step;
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const bw = (W - L) / series.length;
  const label = (b) => unit === 'hour' ? b.slice(11, 13) : `${b.slice(8, 10)}.${b.slice(5, 7)}`;
  const every = Math.ceil(series.length / 12);
  const grid = [];
  for (let v = 0; v <= top; v += step) {
    grid.push(svg('line', { x1: L, x2: W, y1: y(v), y2: y(v), class: 'grid' }), svg('text', { x: L - 6, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' }, v));
  }
  const bars = series.map((p, i) => {
    const x = L + i * bw + bw * 0.15, w = bw * 0.7;
    const vol = Object.entries(p.volume || {}).map(([c, v]) => money(v, c)).join(', ') || '0';
    const when = unit === 'hour' ? `${label(p.bucket)}:00` : label(p.bucket);
    return svg('g', null,
      svg('title', null, `${when}: ${p.succeeded} ${plural(p.succeeded, 'успешный', 'успешных', 'успешных')} (${vol}), отказов ${p.declined}`),
      svg('rect', { x, width: w, y: y(p.succeeded), height: Math.max(0, y(0) - y(p.succeeded)), class: 'bar-ok', rx: 2 }),
      p.declined ? svg('rect', { x, width: w, y: y(p.succeeded + p.declined), height: y(p.succeeded) - y(p.succeeded + p.declined), class: 'bar-bad', rx: 2 }) : null,
      i % every === 0 ? svg('text', { x: x + w / 2, y: H - 6, class: 'axis', 'text-anchor': 'middle' }, label(p.bucket)) : null);
  });
  return svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Депозиты по времени' }, grid, bars);
}

async function viewOverview(main) {
  const period = state.cache.period || '7d';
  const s = await api('GET', `/admin/v1/stats?period=${period}&tz=${encodeURIComponent(TZ)}`);
  const o = await api('GET', '/admin/v1/overview');
  const t = s.totals;
  const sum = (k) => t.reduce((a, r) => a + r[k], 0);
  const succeeded = sum('succeeded'), declined = sum('declined'), pending = sum('pending'), attempts = sum('attempts');
  const conversion = succeeded + declined ? Math.round((succeeded / (succeeded + declined)) * 100) : null;
  const volume = moneyList(t, 'volume'), earned = moneyList(t, 'earned'), cost = moneyList(t, 'provider_cost');
  const feePct = s.platformFeeBps.max === null ? null : s.platformFeeBps.min === s.platformFeeBps.max
    ? `${s.platformFeeBps.max / 100}%` : `${s.platformFeeBps.min / 100}–${s.platformFeeBps.max / 100}%`;
  const periodName = PERIODS.find(([id]) => id === period)[1].toLowerCase();
  const attention = o.open_issues + o.failed_webhooks + o.manual_payouts;
  const paidOut = (s.payouts || []).filter((r) => BigInt(r.paid_out) !== 0n).map((r) => money(r.paid_out, r.currency));
  const payoutsDone = (s.payouts || []).reduce((a, r) => a + r.succeeded, 0);

  const kpi = (label, value, sub, cls) => h('div', { class: `kpi ${cls || ''}` },
    h('span', { class: 'kpi-label' }, label),
    h('b', { class: 'kpi-value' }, ...(Array.isArray(value) ? (value.length ? value.map((v) => h('span', null, v)) : ['0']) : [value])),
    sub ? h('span', { class: 'kpi-sub' }, sub) : null);

  const switcher = h('div', { class: 'seg', role: 'group', 'aria-label': 'Период' },
    PERIODS.map(([id, name]) => h('button', { class: id === period ? 'on' : '', 'aria-pressed': id === period, onclick: () => { state.cache.period = id; renderShell(); } }, name)));

  const goto = (tab) => () => go(tab);

  put(main, ...[
    attempts === 0 && o.tx_24h === 0 ? h('section', { class: 'panel hint' },
      h('h3', null, 'Здесь пока тихо'),
      h('p', null, 'Как только сайты начнут присылать депозиты, тут появятся цифры. Чтобы посмотреть, как всё работает, проведи тестовый платёж:'),
      h('ol', { class: 'steps' },
        h('li', null, 'Открой вкладку «Тест-платёж» и вставь API-ключ сайта (для демо — из файла DEMO-CREDENTIALS.md).'),
        h('li', null, 'Нажми «Создать депозит», затем «Открыть страницу оплаты» и «Оплатить».'),
        h('li', null, 'Вернись сюда — депозит и заработок появятся в цифрах.')),
      h('div', null, h('button', { class: 'primary', onclick: goto('sandbox') }, 'Провести тестовый платёж'))) : null,

    h('section', { class: 'panel' },
      h('div', { class: 'row' }, h('h2', null, `Итоги · ${periodName}`), switcher),
      h('div', { class: 'kpis' },
        kpi('Успешных депозитов', String(succeeded),
          attempts ? `из ${attempts} ${plural(attempts, 'попытки', 'попыток', 'попыток')}` + (pending ? ` · ${pending} ждут оплаты` : '') : 'попыток не было', 'main'),
        kpi('Конверсия', conversion === null ? '—' : `${conversion}%`, declined ? `${declined} ${plural(declined, 'отказ', 'отказа', 'отказов')}` : 'отказов нет'),
        kpi('Оборот', volume, 'сумма успешных депозитов'),
        kpi('Выплачено игрокам', paidOut, payoutsDone ? `${payoutsDone} ${plural(payoutsDone, 'выплата', 'выплаты', 'выплат')}` : 'выплат не было'),
        kpi('Заработали', earned, feePct === null ? null : `комиссия платформы ${feePct}` + (cost.length ? ` · провайдерам ушло ${cost.join(', ')}` : ''), 'money')),
      feePct === '0%' ? h('div', { class: 'msg warn' }, 'Комиссия платформы не задана — заработок считается как 0. Укажи процент во вкладке «Подключения» у оператора.') : null,
      h('div', { class: 'chart-wrap' }, depositsChart(s.series, s.unit)),
      h('div', { class: 'legend' }, h('span', { class: 'sw ok' }), 'успешные', h('span', { class: 'sw bad' }), 'отказы',
        h('span', { class: 'note' }, s.unit === 'hour' ? ' · по часам' : ' · по дням', ` · время ${s.tz}`))),

    h('div', { class: 'grid2' },
      h('section', { class: 'panel' },
        h('h2', null, 'По сайтам'),
        s.bySite.length ? h('div', { class: 'tbl' }, h('table', null,
          h('thead', null, h('tr', null, ['Сайт', 'Успешно', 'Оборот', 'Заработали'].map((x) => h('th', null, x)))),
          h('tbody', null, s.bySite.map((r) => h('tr', null,
            h('td', null, r.site), h('td', { class: 'n' }, `${r.succeeded} из ${r.attempts}`),
            h('td', { class: 'n' }, money(r.volume, r.currency)), h('td', { class: 'n money' }, money(r.earned, r.currency)))))))
          : h('p', { class: 'note' }, `За ${periodName === 'сегодня' ? 'сегодня' : 'этот период'} депозитов не было.`)),
      h('section', { class: 'panel' },
        h('div', { class: 'row' }, h('h2', null, 'Последние депозиты'), h('button', { class: 'link', onclick: goto('payments') }, 'Все платежи →')),
        s.recent.length ? h('div', { class: 'tbl' }, h('table', null, h('tbody', null, s.recent.map((r) => h('tr', { class: 'click', tabindex: 0,
          onclick: () => { state.cache.selTx = r.id; goto('payments')(); }, onkeydown: (e) => { if (e.key === 'Enter') e.currentTarget.click(); } },
          h('td', { class: 'n dim' }, when(r.created_at).slice(0, 12)), h('td', null, r.site, h('div', { class: 'note' }, r.player)),
          h('td', { class: 'n' }, money(r.amount, r.currency)),
          h('td', null, pill(r.status), r.decline_code ? h('div', { class: 'note' }, DECLINE[r.decline_code] || r.decline_code) : null))))))
          : h('p', { class: 'note' }, 'Пока ни одного.'))),

    h('section', { class: `panel ${attention ? 'attention' : ''}` },
      h('h2', null, 'Требует внимания'),
      attention ? h('ul', { class: 'plain' },
        o.open_issues ? h('li', null, h('button', { class: 'link', onclick: goto('issues') }, `${o.open_issues} ${plural(o.open_issues, 'расхождение', 'расхождения', 'расхождений')} с провайдерами`), ' — нужно проверить вручную') : null,
        o.manual_payouts ? h('li', null, h('button', { class: 'link', onclick: goto('manual') }, `${o.manual_payouts} ${plural(o.manual_payouts, 'ручная выплата ждёт', 'ручные выплаты ждут', 'ручных выплат ждут')}`), ' — переведи и отметь выполненной') : null,
        o.failed_webhooks ? h('li', null, `${o.failed_webhooks} ${plural(o.failed_webhooks, 'уведомление', 'уведомления', 'уведомлений')} сайтам не удалось доставить — проверь адреса вебхуков во вкладке «Сайты»`) : null)
        : h('p', { class: 'note' }, 'Всё в порядке: расхождений, ручных выплат и недоставленных уведомлений нет.')),
  ].filter(Boolean)); // replaceChildren превратил бы null в текст «null»
}

// ---------- платёжные аккаунты ----------

const durText = (min) => (min < 60 ? `${min} мин` : `${Math.floor(min / 60)} ч${min % 60 ? ` ${min % 60} мин` : ''}`);

function capacityCard(c) {
  const lim = Number(c.limit) || 1;
  const p = c.tiers.primary, r = c.tiers.reserve;
  const w = (v) => `width:${Math.min(100, (Number(v) / lim) * 100)}%`;
  const soon = c.exhaustInMin !== null && c.exhaustInMin < c.resetInMin;
  const at = soon ? new Date(Date.now() + c.exhaustInMin * 60000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : null;
  const tone = c.fillPct >= 90 || (soon && c.exhaustInMin < 120) ? 'bad' : c.fillPct >= 70 || soon ? 'warn' : 'ok';
  return h('section', { class: `panel cap ${tone}` },
    h('div', { class: 'row' }, h('h2', null, `Ёмкость на сегодня · ${c.currency}`),
      h('span', { class: `pill ${tone}` }, c.fillPct >= 90 ? 'почти исчерпана' : soon && c.exhaustInMin < 120 ? `при таком темпе — на ${durText(c.exhaustInMin)}`
        : c.fillPct >= 70 ? 'заканчивается' : soon ? 'до конца дня не хватит' : 'запас есть')),
    h('div', { class: 'cap-main' },
      h('div', null, h('div', { class: 'kpi-label' }, 'Можно принять ещё'), h('b', { class: 'cap-free' }, money(c.free, c.currency)),
        h('div', { class: 'note' }, `из ${money(c.limit, c.currency)} · занято ${c.fillPct}%`)),
      h('div', null, h('div', { class: 'kpi-label' }, 'Темп за последний час'), h('b', { class: 'cap-rate' }, `${money(c.ratePerHour, c.currency)}/ч`),
        h('div', { class: 'note' }, soon ? `при таком темпе лимиты закончатся через ${durText(c.exhaustInMin)} — около ${at}`
          : `лимиты обнулятся через ${durText(c.resetInMin)} — до этого хватит`))),
    h('div', { class: 'capbar', role: 'img', 'aria-label': `Занято ${c.fillPct}%` },
      h('i', { class: 'p-taken', style: w(p.taken) }), h('i', { class: 'p-free', style: w(p.free) }),
      h('i', { class: 'r-taken', style: w(r.taken) }), h('i', { class: 'r-free', style: w(r.free) })),
    h('div', { class: 'legend' },
      h('span', { class: 'sw p-taken' }), `основные: занято ${money(p.taken, c.currency)}`, h('span', { class: 'sw p-free' }), `свободно ${money(p.free, c.currency)}`,
      Number(r.limit) ? [h('span', { class: 'sw r-taken' }), `резерв: занято ${money(r.taken, c.currency)}`, h('span', { class: 'sw r-free' }), `свободно ${money(r.free, c.currency)}`] : ' · резервных аккаунтов нет'));
}

async function viewAccounts(main) {
  const [accounts, cap] = await Promise.all([api('GET', '/admin/v1/accounts'), api('GET', '/admin/v1/capacity')]);
  const capAcc = new Map(cap.currencies.flatMap((c) => c.accounts.map((a) => [a.id, a])));
  const modeOf = new Map(cap.operators.map((o) => [o.id, o.routing_mode]));
  const active = accounts.filter((a) => a.enabled).length;
  const group = (tier) => accounts.filter((a) => (a.tier || 'primary') === tier);
  const MODES = [['fill', 'По порядку'], ['weights', 'По весам']];
  put(main,
    cap.currencies.length ? cap.currencies.map(capacityCard) : h('section', { class: 'panel hint' }, h('p', null, 'Нет включённых аккаунтов — принимать платежи некуда.')),
    h('section', { class: 'panel' },
      h('h2', null, 'Как распределяются платежи'),
      h('ol', { class: 'steps' },
        h('li', null, h('b', null, 'Подходящие аккаунты: '), 'валюта, страна игрока, сумма в диапазоне аккаунта, и хватает лимита на этот платёж (дневного и месячного, с учётом порога переключения).'),
        h('li', null, h('b', null, 'Основные, резерв — только если основные не подходят. '), 'Резерв держи для пиков и сбоев.'),
        h('li', null, h('b', null, 'Прошлый аккаунт игрока (липкость), '), 'если он подходит: банки спокойнее относятся к платежам на того же мерчанта.'),
        h('li', null, h('b', null, 'Приоритет, затем режим оператора: '), '«по порядку» — дешевле комиссия, следующий аккаунт после заполнения; «по весам» — оборот дня делится по долям (60/30/10), поток ровный.'),
        h('li', null, h('b', null, 'Нигде не хватает лимита — '), 'сайт получает отказ capacity_exhausted и сумму, которую можно принять сейчас (может предложить игроку меньше).')),
      cap.operators.length ? h('div', { class: 'stack' }, cap.operators.map((o) => h('div', { class: 'row start' },
        h('span', null, h('b', null, o.name), ': '),
        can('admin') ? h('div', { class: 'seg', role: 'group', 'aria-label': 'Режим распределения' }, MODES.map(([id, label]) =>
          h('button', { class: o.routing_mode === id ? 'on' : '', 'aria-pressed': o.routing_mode === id, onclick: async () => {
            await api('PATCH', `/admin/v1/operators/${o.id}`, { routingMode: id }); renderShell(); } }, label)))
          : h('span', { class: 'pill n' }, MODES.find(([id]) => id === o.routing_mode)[1])))) : null),
    h('section', { class: 'panel' },
      h('div', { class: 'row' }, h('h2', null, 'Основные аккаунты'), h('span', { class: 'note' }, `${active} из ${accounts.length} включены`)),
      h('p', { class: 'note' }, 'Шкала — сколько дневного лимита использовано; черта — порог, после которого платежи уходят на следующий аккаунт.'),
      group('primary').length ? h('div', { class: 'accs' }, group('primary').map((a) => accountCard(a, capAcc.get(a.id), modeOf.get(a.operator_id))))
        : h('p', { class: 'note' }, 'Основных аккаунтов нет.')),
    h('section', { class: 'panel' },
      h('h2', null, 'Резерв'),
      h('p', { class: 'note' }, 'Получают платежи, только когда ни один основной не подходит. Перевести аккаунт в резерв — кнопка «Лимиты» у аккаунта.'),
      group('reserve').length ? h('div', { class: 'accs' }, group('reserve').map((a) => accountCard(a, capAcc.get(a.id), modeOf.get(a.operator_id))))
        : h('p', { class: 'note' }, 'Резервных аккаунтов нет.')),
    h('p', { class: 'note' }, 'Подключить новый аккаунт и ввести его ключи — в «Операторы и аккаунты».'));
}

function accountCard(a, ca, mode) {
  const cap = Number(a.daily_cap), used = Number(a.used_today), res = Number(a.reserved_today);
  const fill = (used + res) / cap, mark = a.switch_at_bps / 100;
  const lvl = fill * 100 >= mark ? 'full' : fill >= 0.75 ? 'warn' : 'ok';
  const status = !a.enabled ? h('span', { class: 'pill m' }, 'выключен')
    : lvl === 'full' ? h('span', { class: 'pill bad' }, 'лимит на сегодня исчерпан')
    : lvl === 'warn' ? h('span', { class: 'pill warn' }, 'близко к лимиту') : h('span', { class: 'pill ok' }, 'активен');

  const card = h('div', { class: `acc ${a.enabled ? '' : 'off'}`, 'data-lvl': lvl },
    h('div', { class: 'row' }, h('div', null, h('div', { class: 'name' }, a.name), h('div', { class: 'prov' }, a.provider_code)), status),
    h('div', { class: 'bar', role: 'img', 'aria-label': `Заполнено ${Math.round(fill * 100)}%` },
      h('i', { class: 'u', style: `width:${Math.min(100, (used / cap) * 100)}%` }),
      h('i', { class: 'r', style: `width:${Math.min(100, (res / cap) * 100)}%` }),
      h('span', { class: 'mark', style: `left:${mark}%` })),
    h('div', { class: 'nums' }, h('span', null, 'сегодня ', h('b', null, money(a.used_today)), ' из ', money(a.daily_cap)), h('span', null, `${(fill * 100).toFixed(1)}%`)),
    h('div', { class: 'meta' },
      h('span', null, 'Ждут оплаты'), h('span', null, money(a.reserved_today)),
      h('span', null, 'Сумма платежа'), h('span', null, `${money(a.min_amount)} – ${money(a.max_amount)}`),
      h('span', null, 'Лимит в месяц'), h('span', null, a.monthly_cap ? money(a.monthly_cap) : 'нет'),
      h('span', null, 'Комиссия провайдера'), h('span', null, `${(a.fee_bps / 100).toFixed(2)}%`),
      h('span', null, 'Приоритет'), h('span', null, a.priority),
      mode === 'weights' && a.enabled ? [h('span', null, 'Вес'), h('span', null, ca ? `${a.weight} → цель ${ca.targetPct}% · сегодня ${ca.sharePct}%` : String(a.weight))] : null,
      h('span', null, 'Переключать на'), h('span', null, `${mark}% лимита`),
      can('admin') ? [h('span', null, 'ID'), h('span', { class: 'id-cell', title: 'Нужен для адреса вебхука провайдера' }, a.id)] : null),
    h('div', { class: 'tags' }, a.currencies.map((c) => h('span', { class: 'tag' }, c)), a.countries.map((c) => h('span', { class: 'tag' }, c))));

  if (can('operator')) {
    const result = h('div');
    const toggle = h('button', { class: 'sm', onclick: async () => {
      try { await api('PATCH', `/admin/v1/accounts/${a.id}`, { enabled: !a.enabled }); renderShell(); }
      catch (err) { if (!handleAuthError(err)) put(result, errorBox(err)); }
    } }, a.enabled ? 'Выключить' : 'Включить');
    const editBtn = h('button', { class: 'sm', onclick: () => {
      state.cache.editing = a.id; clearInterval(state.timer);
      const ed = actionForm({ class: 'edit' }, [
        field('Дневной лимит', h('input', { name: 'dailyCap', value: (Number(a.daily_cap) / 100).toFixed(2), inputmode: 'decimal' })),
        field('Месячный (пусто — без)', h('input', { name: 'monthlyCap', value: a.monthly_cap ? (Number(a.monthly_cap) / 100).toFixed(2) : '', inputmode: 'decimal' })),
        field('Порог, %', h('input', { name: 'switchAt', value: a.switch_at_bps / 100, type: 'number', min: 1, max: 100, step: 0.01 })),
        field('Комиссия, %', h('input', { name: 'fee', value: a.fee_bps / 100, type: 'number', min: 0, max: 100, step: 0.01 })),
        field('Приоритет', h('input', { name: 'priority', value: a.priority, type: 'number', min: -1000, max: 1000 })),
        field('Уровень', h('select', { name: 'tier' }, [['primary', 'основной'], ['reserve', 'резерв']].map(([v, t]) => { const o = h('option', { value: v }, t); if ((a.tier || 'primary') === v) o.selected = true; return o; }))),
        field('Вес (режим «по весам»)', h('input', { name: 'weight', value: a.weight ?? 100, type: 'number', min: 1, max: 10000 })),
        h('div', { class: 'row start' }, h('button', { class: 'primary sm', type: 'submit' }, 'Сохранить'),
          h('button', { class: 'sm', type: 'button', onclick: () => { state.cache.editing = null; renderShell(); } }, 'Отмена')),
      ], async (v) => {
        const dailyCap = toCents(v.dailyCap);
        if (!dailyCap) throw new Error('Дневной лимит — сумма больше нуля, например 5000 или 5000.50');
        const monthlyCap = v.monthlyCap.trim() ? toCents(v.monthlyCap) : null;
        if (v.monthlyCap.trim() && !monthlyCap) throw new Error('Месячный лимит — сумма больше нуля или пусто');
        await api('PATCH', `/admin/v1/accounts/${a.id}`, {
          dailyCap, monthlyCap, switchAtBps: Math.round(Number(v.switchAt) * 100), feeBps: Math.round(Number(v.fee) * 100), priority: Number(v.priority),
          tier: v.tier, weight: Number(v.weight),
        });
        state.cache.editing = null; renderShell();
      });
      editBtn.replaceWith(ed);
    } }, 'Лимиты');
    card.append(h('div', { class: 'row start' }, toggle, editBtn), result);
  }
  return card;
}

// ---------- платежи ----------

async function viewPayments(main) {
  const f = state.cache.payFilter || (state.cache.payFilter = { status: '', player: '', type: '' });
  const qs = new URLSearchParams({ limit: '100', ...(f.status ? { status: f.status } : {}), ...(f.player ? { player: f.player } : {}), ...(f.type ? { type: f.type } : {}) });
  const rows = await api('GET', `/admin/v1/transactions?${qs}`);
  const detail = h('div', { id: 'tx-detail' });

  const filter = h('form', { class: 'row start', onsubmit: (e) => { e.preventDefault(); Object.assign(f, formValues(e.target)); renderShell(); } },
    h('select', { name: 'type', style: 'width:auto', 'aria-label': 'Тип' },
      [['', 'Все'], ['deposit', 'Депозиты'], ['payout', 'Выплаты']].map(([v, t]) => h('option', { value: v, selected: f.type === v }, t))),
    h('select', { name: 'status', style: 'width:auto', 'aria-label': 'Статус' },
      [['', 'Все статусы'], ['pending', 'Ожидают'], ['success', 'Успешные'], ['declined', 'Отказы']].map(([v, t]) => h('option', { value: v, selected: f.status === v }, t))),
    h('input', { name: 'player', placeholder: 'ID игрока', value: f.player, style: 'width:180px', 'aria-label': 'ID игрока' }),
    h('button', { type: 'submit' }, 'Показать'));

  const table = h('table', null,
    h('thead', null, h('tr', null, ['Время', 'Сайт', 'Игрок', 'Сумма', 'Статус', 'Аккаунт', 'Частей'].map((t) => h('th', null, t)))),
    h('tbody', null, rows.length ? rows.map((t) => h('tr', { class: `click ${state.cache.selTx === t.id ? 'sel' : ''}`, tabindex: 0,
      onclick: () => { state.cache.selTx = t.id; showTx(detail, t.id); main.querySelectorAll('tr.sel').forEach((r) => r.classList.remove('sel')); },
      onkeydown: (e) => { if (e.key === 'Enter') e.currentTarget.click(); } },
      h('td', { class: 'n' }, when(t.created_at)), h('td', null, t.site), h('td', { class: 'n' }, `${t.player} · ${t.country}`),
      h('td', { class: 'n' }, t.type === 'payout' ? h('span', { class: 'out' }, '−', money(t.amount, t.currency)) : money(t.amount, t.currency),
        h('div', { class: 'note' }, t.type === 'payout' ? 'выплата' : 'депозит')),
      h('td', null, pill(t.status), t.decline_code ? h('div', { class: 'note' }, DECLINE[t.decline_code] || t.decline_code) : null),
      h('td', { class: 'dim' }, t.account || '—'), h('td', { class: 'n' }, t.attempts)))
      : h('tr', null, h('td', { colspan: 7, class: 'dim' }, 'Платежей нет. Создай тестовый во вкладке «Песочница».'))));

  put(main, h('div', { class: 'grid2 pay' },
    h('section', { class: 'panel' }, h('div', { class: 'row' }, h('h2', null, 'Платежи'), filter),
      h('p', { class: 'note' }, 'Нажми на платёж — справа его история: аккаунты, ответы провайдера, вебхуки, проводки и что делать дальше.'), h('div', { class: 'tbl' }, table)),
    h('section', { class: 'panel' }, detail)));
  if (state.cache.selTx) await showTx(detail, state.cache.selTx);
  else detail.append(h('p', { class: 'note' }, 'Выбери платёж слева: здесь будет его полная история и что можно сделать сейчас.'));
}

const TONE_PILL = { ok: 'ok', bad: 'bad', warn: 'warn', info: 'n' };
const WHO = { system: 'система', staff: 'сотрудник', site: 'сайт' };

function openTx(id) { state.cache.selTx = id; go('payments'); }

async function showTx(box, id) {
  let t;
  try { t = await api('GET', `/admin/v1/transactions/${id}/timeline`); }
  catch (err) { if (!handleAuthError(err)) put(box, errorBox(err)); return; }
  const day = (iso) => new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  const time = (iso) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  let lastDay = '';
  put(box,
    h('div', { class: 'row' },
      h('div', null, h('div', { class: 'note' }, t.type === 'payout' ? 'Выплата' : 'Депозит'),
        h('h3', { class: 'tx-amount' }, t.type === 'payout' ? '−' : '', money(t.amount, t.currency))),
      pill(t.status)),
    h('div', { class: `tx-state ${t.state.tone}` }, h('b', null, t.state.title), t.state.detail ? h('div', null, t.state.detail) : null),
    t.next.length ? h('div', { class: 'tx-next' }, h('h2', null, 'Что дальше'),
      h('ul', { class: 'plain' }, t.next.map((n) => h('li', null,
        h('span', { class: `who ${n.who}` }, WHO[n.who]), ' ', n.text,
        n.tab ? [' ', h('button', { class: 'link', onclick: () => go(n.tab) }, 'Открыть →')] : null)))) : null,
    h('div', { class: 'meta' },
      h('span', null, 'ID'), h('span', { class: 'id-cell' }, t.id),
      h('span', null, 'Сайт'), h('span', null, `${t.site} · ${t.operator}`),
      h('span', null, 'Игрок'), h('span', null, `${t.player} · ${t.country}`),
      t.withdrawalId ? [h('span', null, 'Вывод казино'), h('span', null, t.withdrawalId)] : null,
      t.platformFee !== null && t.platformFee !== undefined ? [h('span', null, 'Заработок платформы'), h('span', null, money(t.platformFee, t.currency))] : null,
      t.type === 'deposit' && BigInt(t.refunded || 0) > 0n ? [h('span', null, 'Возвращено игроку'), h('span', null, money(t.refunded, t.currency))] : null),
    t.type === 'deposit' && t.status === 'success' && can('operator') ? chargebackForm(t) : null,
    h('h2', null, 'История'),
    h('ol', { class: 'timeline' }, t.events.map((e) => {
      const d = day(e.at); const showDay = d !== lastDay; lastDay = d;
      return h('li', { class: `tl ${e.tone}` },
        h('span', { class: 'tl-time' }, showDay ? h('span', { class: 'tl-day' }, d) : null, time(e.at)),
        h('span', { class: 'tl-dot', 'aria-hidden': 'true' }),
        h('div', { class: 'tl-body' }, h('div', { class: 'tl-title' }, e.title, e.actor ? h('span', { class: 'tl-actor' }, ` · ${e.actor}`) : null),
          e.detail ? h('div', { class: 'tl-detail' }, e.detail) : null));
    })));
}

// ---------- зависшие деньги ----------

const SEV = { bad: ['нужно действие', 'bad'], warn: ['внимание', 'warn'], info: ['для сведения', 'm'] };
const ageText = (iso) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 60 ? `${m} мин` : m < 2880 ? `${Math.round(m / 60)} ч` : `${Math.round(m / 1440)} дн`;
};

async function viewStuck(main) {
  const s = await api('GET', '/admin/v1/stuck');
  const active = s.categories.filter((c) => c.count > 0);
  const quiet = s.categories.filter((c) => c.count === 0);
  const sum = (sev) => active.filter((c) => c.severity === sev).reduce((a, c) => a + c.count, 0);
  const totals = (list) => list.map((t) => money(t.amount, t.currency)).join(' · ') || '—';

  put(main,
    h('div', { class: 'kpis' },
      h('div', { class: `kpi ${sum('bad') ? 'alarm' : ''}` }, h('span', { class: 'kpi-label' }, 'Нужно действие'), h('b', { class: 'kpi-value' }, String(sum('bad'))),
        h('span', { class: 'kpi-sub' }, sum('bad') ? 'платежей, где без человека не разобраться' : 'ничего не требует вмешательства')),
      h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, 'Внимание'), h('b', { class: 'kpi-value' }, String(sum('warn'))),
        h('span', { class: 'kpi-sub' }, 'ручные выплаты, повторы, доставка')),
      h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, 'Зарезервировано лимита'), h('b', { class: 'kpi-value' }, ...(s.reserved.length ? s.reserved.map((r) => h('span', null, money(r.amount, r.currency))) : ['0'])),
        h('span', { class: 'kpi-sub' }, 'под платежи, которые ещё не завершились'))),
    active.length ? active.map((c) => h('section', { class: `panel stuck ${c.severity}` },
      h('div', { class: 'row' },
        h('div', null, h('h3', null, c.title, ' ', h('span', { class: `pill ${SEV[c.severity][1]}` }, SEV[c.severity][0])),
          h('div', { class: 'note' }, `${c.count} · ${totals(c.totals)} · старейшему ${ageText(c.oldestAt)}`)),
        c.tab ? h('button', { class: 'sm', onclick: () => go(c.tab) }, 'Раздел →') : null),
      h('p', { class: 'note' }, c.hint),
      h('div', { class: 'tbl' }, h('table', null,
        h('thead', null, h('tr', null, ['Сколько ждёт', 'Сумма', 'Подробности', ''].map((x) => h('th', null, x)))),
        h('tbody', null, c.items.map((i) => h('tr', { class: 'click', tabindex: 0, onclick: () => (i.txId ? openTx(i.txId) : go(c.tab)), onkeydown: (e) => { if (e.key === 'Enter') e.currentTarget.click(); } },
          h('td', { class: 'n' }, ageText(i.at)), h('td', { class: 'n' }, money(i.amount, i.currency)),
          h('td', { class: 'dim' }, i.label), h('td', null, h('span', { class: 'link-like' }, i.txId ? 'История →' : 'Раздел →'))))))),
      c.count > c.items.length ? h('p', { class: 'note' }, `Показаны первые ${c.items.length} из ${c.count}.`) : null))
      : h('section', { class: 'panel hint' }, h('h3', null, 'Всё чисто'), h('p', null, 'Нет денег, которые зависли или ждут человека.')),
    quiet.length ? h('section', { class: 'panel' }, h('h2', null, 'Без замечаний'),
      h('ul', { class: 'plain note' }, quiet.map((c) => h('li', null, `✓ ${c.title}`)))) : null);
}

function chargebackForm(t) {
  const free = BigInt(t.amount) - BigInt(t.refunded || 0) - BigInt(t.chargedBack || 0);
  if (free <= 0n) return null;
  const inWeek = new Date(Date.now() + 7 * 86400e3).toISOString().slice(0, 10);
  return h('details', { class: 'cb-form' }, h('summary', null, 'Игрок оспорил оплату? Зарегистрировать чарджбэк'),
    h('p', { class: 'note' }, 'Обычно чарджбэки приходят в выписке провайдера и заводятся сами при сверке. Вручную — если провайдер сообщил письмом или в кабинете.'),
    actionForm({ class: 'form' }, [
      field('Сумма спора', h('input', { name: 'amount', required: true, inputmode: 'decimal', value: (Number(free) / 100).toFixed(2) })),
      field('Комиссия за чарджбэк', h('input', { name: 'fee', inputmode: 'decimal', placeholder: '0' })),
      field('ID спора у провайдера', h('input', { name: 'caseRef', placeholder: 'например CB-12345' })),
      field('Код причины', h('input', { name: 'reasonCode', placeholder: '10.4, 4837…' })),
      field('Ответить до', h('input', { name: 'respondBy', type: 'date', value: inWeek })),
      field('Комментарий', h('input', { name: 'note', placeholder: 'откуда узнали' }), 'wide'),
      h('div', null, h('button', { class: 'primary', type: 'submit' }, 'Зарегистрировать')),
    ], async (v) => {
      const amount = toCents(v.amount);
      if (!amount) throw new Error('Сумма — число больше нуля');
      await api('POST', '/admin/v1/chargebacks', { transactionId: t.id, amount, ...(v.fee.trim() ? { fee: toCents(v.fee) || 0 } : {}),
        ...(v.caseRef.trim() ? { caseRef: v.caseRef.trim() } : {}), ...(v.reasonCode.trim() ? { reasonCode: v.reasonCode.trim() } : {}),
        ...(v.respondBy ? { respondBy: v.respondBy } : {}), ...(v.note.trim() ? { note: v.note.trim() } : {}) });
      renderShell();
    }));
}

// ---------- чарджбэки ----------

const CB_STATUS = { open: ['ждёт ответа', 'warn'], evidence_submitted: ['доказательства отправлены', 'n'], won: ['выигран', 'ok'], lost: ['проигран', 'bad'], accepted: ['принят', 'm'] };

async function viewChargebacks(main) {
  const all = !!state.cache.cbAll;
  const rows = await api('GET', `/admin/v1/chargebacks${all ? '?all=true' : ''}`);
  const deadline = (r) => {
    if (!r.respond_by || !['open', 'evidence_submitted'].includes(r.status)) return r.respond_by ? h('span', { class: 'dim' }, new Date(r.respond_by).toLocaleDateString('ru-RU')) : '—';
    const d = r.days_left;
    const cls = d < 0 ? 'bad' : d <= 3 ? 'bad' : d <= 7 ? 'warn' : 'ok';
    return h('div', null, h('span', { class: `pill ${cls}` }, d < 0 ? `просрочен на ${-d} дн` : d === 0 ? 'сегодня' : `через ${d} дн`),
      h('div', { class: 'note' }, new Date(r.respond_by).toLocaleDateString('ru-RU')));
  };
  const act = (r, status, label, cls, needNote) => actionForm({ class: 'row start' }, [
    needNote ? h('input', { name: 'note', placeholder: 'что отправили', required: true, minlength: 3, style: 'width:170px' }) : null,
    h('button', { class: `sm ${cls || ''}`, type: 'submit' }, label),
  ], async (v) => { await api('POST', `/admin/v1/chargebacks/${r.id}/status`, { status, ...(v.note ? { note: v.note } : {}) }); renderShell(); });
  const actions = (r) => {
    if (!can('operator')) return null;
    if (r.status === 'open') return h('div', { class: 'stack' }, act(r, 'evidence_submitted', 'Доказательства отправлены', 'primary', true),
      h('div', { class: 'row start' }, act(r, 'won', 'Выиграли'), act(r, 'lost', 'Проиграли', 'danger'), act(r, 'accepted', 'Не спорим')));
    if (r.status === 'evidence_submitted') return h('div', { class: 'row start' }, act(r, 'won', 'Выиграли', 'primary'), act(r, 'lost', 'Проиграли', 'danger'));
    return null;
  };
  put(main,
    h('section', { class: 'panel hint' },
      h('h3', null, 'Как отвечать на чарджбэк'),
      h('p', null, 'Эквайер уже списал сумму. Чтобы вернуть её, до срока отправь провайдеру доказательства: подтверждение KYC, IP и устройство входов игрока, историю ставок после депозита, переписку с поддержкой, принятые условия. Без ответа спор проигрывается автоматически.')),
    h('section', { class: 'panel' },
      h('div', { class: 'row' }, h('h2', null, all ? 'Все чарджбэки' : 'Открытые чарджбэки'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: all, onchange: (e) => { state.cache.cbAll = e.target.checked; renderShell(); } }), 'Показать закрытые')),
      rows.length ? h('div', { class: 'tbl' }, h('table', null,
        h('thead', null, h('tr', null, ['Открыт', 'Игрок', 'Сумма', 'Причина', 'Ответить', 'Статус', ''].map((x) => h('th', null, x)))),
        h('tbody', null, rows.map((r) => h('tr', null,
          h('td', { class: 'n' }, when(r.opened_at), h('div', { class: 'note' }, r.source === 'report' ? 'из выписки' : 'вручную')),
          h('td', null, h('button', { class: 'link', onclick: () => openTx(r.transaction_id) }, r.player), h('div', { class: 'note' }, `${r.site} · ${r.account}`)),
          h('td', { class: 'n' }, h('b', null, money(r.amount, r.currency)), BigInt(r.fee) ? h('div', { class: 'note' }, `+ комиссия ${money(r.fee, r.currency)}`) : null),
          h('td', null, r.reason_code || '—', r.case_ref ? h('div', { class: 'note' }, r.case_ref) : null),
          h('td', null, deadline(r)),
          h('td', null, h('span', { class: `pill ${CB_STATUS[r.status][1]}` }, CB_STATUS[r.status][0]),
            (r.history || []).length > 1 ? h('details', { class: 'note' }, h('summary', null, 'история'),
              h('ul', { class: 'plain' }, r.history.map((e) => h('li', null, `${when(e.at)} · ${CB_STATUS[e.status][0]}${e.by ? ` · ${e.by}` : ''}${e.note ? ` · ${e.note}` : ''}`)))) : null),
          h('td', null, actions(r))))))) : h('p', { class: 'note' }, all ? 'Чарджбэков не было.' : 'Открытых чарджбэков нет.')));
}

// ---------- сверка с провайдером ----------

async function viewReconciliation(main) {
  const [accounts, imports] = await Promise.all([api('GET', '/admin/v1/accounts'), api('GET', '/admin/v1/reports')]);
  clearInterval(state.timer);
  const rc = state.cache.rc ||= { accountId: accounts[0]?.id || '', file: null, preview: null, selected: imports[0]?.id || null };
  const upload = h('div', { class: 'stack' });
  const detail = h('div');

  const renderPreview = () => {
    const p = rc.preview;
    if (!p) return put(upload);
    const sel = (f) => h('select', { name: f.key, onchange: (e) => { p.mapping[f.key] = e.target.value || null; } },
      h('option', { value: '' }, '— нет в файле —'),
      p.headers.map((hd) => { const o = h('option', { value: hd }, hd); if (p.mapping[f.key] === hd) o.selected = true; return o; }));
    const kindRu = { payment: 'оплата', refund: 'возврат', chargeback: 'чарджбэк', fee: 'комиссия', other: 'другое' };
    const out = h('div');
    put(upload,
      h('div', { class: 'note' }, `${rc.file.name}: ${p.rowCount} строк. ${p.remembered ? 'Колонки подставлены из прошлой загрузки для этого провайдера.' : 'Колонки распознаны по названиям — проверь.'}`),
      h('div', { class: 'form' }, p.fields.map((f) => field(f.title + (f.required ? ' *' : ''), sel(f))),
        field('Суммы в файле', h('select', { onchange: (e) => { p.amountUnit = e.target.value; } },
          [['major', 'в единицах валюты (12.50)'], ['minor', 'в центах (1250)']].map(([v, t]) => { const o = h('option', { value: v }, t); if (p.amountUnit === v) o.selected = true; return o; })))),
      h('details', null, h('summary', null, 'Как система поняла первые строки'),
        h('div', { class: 'tbl' }, h('table', null, h('thead', null, h('tr', null, ['Строка', 'Тип', 'Статус', 'ID у провайдера', 'Сумма', 'Комиссия'].map((x) => h('th', null, x)))),
          h('tbody', null, p.sample.map((r) => h('tr', null, h('td', { class: 'n' }, r.lineNo), h('td', null, kindRu[r.kind]), h('td', null, r.status),
            h('td', { class: 'n' }, r.ref || '—'), h('td', { class: 'n' }, r.amount ? money(r.amount, r.currency) : '?'), h('td', { class: 'n' }, money(r.fee, r.currency)))))))),
      h('div', { class: 'row start' }, h('button', { class: 'primary', onclick: async (e) => {
        e.target.disabled = true; put(out);
        try {
          const r = await api('POST', '/admin/v1/reports/import', { accountId: rc.accountId, filename: rc.file.name, csv: rc.file.text, mapping: p.mapping, amountUnit: p.amountUnit });
          rc.preview = null; rc.file = null; rc.selected = r.id; renderShell();
        } catch (err) { e.target.disabled = false; if (!handleAuthError(err)) put(out, errorBox(err)); }
      } }, 'Сверить'), h('button', { onclick: () => { rc.preview = null; rc.file = null; renderPreview(); } }, 'Отмена')), out);
  };

  const fileInput = h('input', { type: 'file', accept: '.csv,text/csv,text/plain', onchange: async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 5 * 1024 * 1024) return put(upload, h('div', { class: 'msg err' }, 'Файл больше 5 МБ — выгрузи период короче'));
    put(upload, h('p', { class: 'note' }, 'Читаю файл…'));
    try {
      rc.file = { name: f.name, text: await f.text() };
      rc.preview = await api('POST', '/admin/v1/reports/preview', { accountId: rc.accountId, filename: f.name, csv: rc.file.text });
      renderPreview();
    } catch (err) { if (!handleAuthError(err)) put(upload, errorBox(err)); }
  } });

  const SEVR = { bad: ['расхождение', 'bad'], warn: ['проверить', 'warn'], info: ['для сведения', 'm'], ok: ['совпадает', 'ok'] };
  const KIND = { payment: 'оплата', refund: 'возврат', chargeback: 'чарджбэк', fee: 'комиссия', other: 'другое' };
  const showImport = async (id) => {
    if (!id) return put(detail, h('p', { class: 'note' }, 'Загрузок пока не было.'));
    const r = await api('GET', `/admin/v1/reports/${id}`);
    const s = r.summary; const cur = s.currency || '';
    const onlyProblems = state.cache.rcProblems !== false;
    const lines = onlyProblems ? r.lines.filter((l) => l.severity === 'bad' || l.severity === 'warn') : r.lines;
    const feeDiff = BigInt(s.fees.diff);
    put(detail,
      h('div', { class: 'row' }, h('h3', null, `${r.filename} · ${r.account}`),
        h('span', { class: 'note' }, r.period_from ? `${new Date(r.period_from).toLocaleDateString('ru-RU')} — ${new Date(r.period_to).toLocaleDateString('ru-RU')}` : '')),
      h('div', { class: 'kpis' },
        h('div', { class: `kpi ${s.bad ? 'alarm' : ''}` }, h('span', { class: 'kpi-label' }, 'Расхождения'), h('b', { class: 'kpi-value' }, String(s.bad)), h('span', { class: 'kpi-sub' }, 'деньги видим по-разному')),
        h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, 'Проверить'), h('b', { class: 'kpi-value' }, String(s.warn)), h('span', { class: 'kpi-sub' }, 'новые чарджбэки, нет в выписке')),
        h('div', { class: 'kpi money' }, h('span', { class: 'kpi-label' }, 'Совпало'), h('b', { class: 'kpi-value' }, money(s.matchedPayments, cur)), h('span', { class: 'kpi-sub' }, `${s.ok} строк · возвраты ${money(s.matchedRefunds, cur)}`)),
        h('div', { class: `kpi ${feeDiff !== 0n ? 'alarm' : ''}` }, h('span', { class: 'kpi-label' }, 'Комиссия за совпавшие оплаты'), h('b', { class: 'kpi-value' }, money(s.fees.report, cur)),
          h('span', { class: 'kpi-sub' }, (feeDiff === 0n ? 'совпадает со ставкой аккаунта' : `по ставке аккаунта ${money(s.fees.ours, cur)} · разница ${money(s.fees.diff, cur)} — проверь ставку`)
            + (BigInt(s.fees.other || 0) ? ` · прочие комиссии (чарджбэки и др.) ${money(s.fees.other, cur)}` : '')))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: onlyProblems, onchange: (e) => { state.cache.rcProblems = e.target.checked; showImport(id); } }), 'Только то, что требует внимания'),
      lines.length ? h('div', { class: 'tbl' }, h('table', null,
        h('thead', null, h('tr', null, ['Строка', 'Что', 'ID у провайдера', 'Сумма', 'Итог', ''].map((x) => h('th', null, x)))),
        h('tbody', null, lines.map((l) => h('tr', null,
          h('td', { class: 'n' }, l.line_no ?? 'у нас'), h('td', null, KIND[l.kind] || l.kind, l.case_ref ? h('div', { class: 'note' }, l.case_ref) : null),
          h('td', { class: 'n' }, l.transaction_id ? h('button', { class: 'link', onclick: () => openTx(l.transaction_id) }, l.provider_ref || '—') : (l.provider_ref || '—')),
          h('td', { class: 'n' }, l.amount !== null ? money(l.amount, l.currency || cur) : '—'),
          h('td', null, h('span', { class: `pill ${SEVR[l.severity][1]}` }, SEVR[l.severity][0]), h('div', { class: 'note' }, l.details)),
          h('td', null, l.resolved ? h('div', { class: 'note' }, `✓ ${l.resolved_by_email}: ${l.resolution_note}`)
            : (l.severity === 'bad' || l.severity === 'warn') && can('operator') ? actionForm({ class: 'row start' }, [
              h('input', { name: 'note', required: true, minlength: 3, placeholder: 'что сделали', style: 'width:150px' }),
              h('button', { class: 'sm', type: 'submit' }, 'Разобрано')],
              async (v) => { await api('POST', `/admin/v1/reports/lines/${l.id}/resolve`, v); showImport(id); }) : null)))))) : h('p', { class: 'note' }, 'Всё сошлось — расхождений нет.'));
  };

  put(main,
    can('operator') ? h('section', { class: 'panel' },
      h('h2', null, 'Загрузить выписку'),
      h('p', { class: 'note' }, 'Выгрузи в кабинете провайдера операции за период (CSV) и загрузи сюда. Система сопоставит каждую оплату, возврат и чарджбэк с нашими данными и покажет, где деньги расходятся. Чарджбэки из выписки заводятся сами.'),
      h('div', { class: 'form' },
        field('Платёжный аккаунт', h('select', { onchange: (e) => { rc.accountId = e.target.value; rc.preview = null; renderPreview(); } },
          accounts.map((a) => { const o = h('option', { value: a.id }, `${a.name} (${a.provider_code})`); if (a.id === rc.accountId) o.selected = true; return o; })), 'wide'),
        field('Файл выписки (CSV, до 5 МБ)', fileInput, 'wide')),
      upload) : null,
    h('div', { class: 'grid2 rc' },
      h('section', { class: 'panel rc-list' }, h('h2', null, 'Загрузки'),
        imports.length ? h('div', { class: 'tbl' }, h('table', null,
          h('thead', null, h('tr', null, ['Когда', 'Файл', 'Итог'].map((x) => h('th', null, x)))),
          h('tbody', null, imports.map((i) => h('tr', { class: `click ${rc.selected === i.id ? 'sel' : ''}`, tabindex: 0, onclick: (e) => {
            rc.selected = i.id; e.currentTarget.parentNode.querySelectorAll('tr').forEach((x) => x.classList.remove('sel')); e.currentTarget.classList.add('sel'); showImport(i.id); } },
            h('td', { class: 'n' }, when(i.uploaded_at), h('div', { class: 'note' }, i.uploaded_by || '')),
            h('td', null, i.filename, h('div', { class: 'note' }, `${i.account} · ${i.rows_total} строк`)),
            h('td', null, i.open ? h('span', { class: 'pill bad' }, `${i.open} открыто`) : h('span', { class: 'pill ok' }, 'всё сошлось'))))))) : h('p', { class: 'note' }, 'Ещё не загружали.')),
      h('section', { class: 'panel' }, detail)));
  if (state.cache.rc.preview) renderPreview();
  await showImport(rc.selected);
}

// ---------- песочница ----------

function viewSandbox(main) {
  const sb = state.cache.sandbox || (state.cache.sandbox = { key: '', made: [] });
  const made = h('div');
  const renderMade = () => put(made, sb.made.length ? h('table', null,
    h('thead', null, h('tr', null, ['Платёж', 'Сумма', 'Ответ', ''].map((t) => h('th', null, t)))),
    h('tbody', null, sb.made.map((d) => h('tr', null,
      h('td', { class: 'n' }, d.id.slice(0, 8)), h('td', { class: 'n' }, money(d.amount, d.currency)),
      h('td', null, pill(d.status), d.declineCode ? h('div', { class: 'note' }, DECLINE[d.declineCode] || d.declineCode,
        d.declineDetails?.maxAmountNow ? ` · сейчас можно до ${money(d.declineDetails.maxAmountNow, d.currency)}` : '') : null),
      h('td', null, d.paymentUrl ? h('a', { href: d.paymentUrl, target: '_blank', rel: 'noopener' }, 'Открыть страницу оплаты ↗') : null)))))
    : h('p', { class: 'note' }, 'Созданные здесь платежи появятся в этом списке и во вкладке «Платежи».'));
  renderMade();

  put(main, h('section', { class: 'panel' },
    h('h2', null, 'Тестовый платёж'),
    h('p', { class: 'note' }, 'Запрос уходит в тот же публичный API, что используют сайты (POST /v1/deposits), с ключом сайта. Ключ хранится только в этой вкладке до перезагрузки.'),
    actionForm({ class: 'form' }, [
      field('API-ключ сайта', h('input', { name: 'key', required: true, value: sb.key, placeholder: 'ftk_…', autocomplete: 'off' }), 'full'),
      field('Сумма', h('input', { name: 'amount', required: true, value: '25.00', inputmode: 'decimal' })),
      field('Валюта', h('input', { name: 'currency', required: true, value: 'EUR', maxlength: 3 })),
      field('ID игрока', h('input', { name: 'player', required: true, value: 'demo-player-1' })),
      field('Страна', h('input', { name: 'country', required: true, value: 'MT', maxlength: 2 })),
      field('KYC', h('select', { name: 'kyc' }, ['verified', 'none', 'pending', 'rejected'].map((k) => h('option', { value: k }, k)))),
      field('Дневной лимит игрока', h('input', { name: 'limit', placeholder: 'без лимита', inputmode: 'decimal' })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'selfExcluded' }), 'Самоисключён'),
      h('div', null, h('button', { class: 'primary', type: 'submit' }, 'Создать депозит')),
    ], async (v) => {
      sb.key = v.key.trim();
      const amount = toCents(v.amount);
      if (!amount) throw new Error('Сумма — число больше нуля, например 25 или 25.50');
      const limit = v.limit.trim() ? toCents(v.limit) : null;
      const res = await fetch('/v1/deposits', { method: 'POST', headers: {
        'content-type': 'application/json', authorization: `Bearer ${sb.key}`, 'idempotency-key': `sandbox-${crypto.randomUUID()}` },
        body: JSON.stringify({ amount, currency: v.currency.trim().toUpperCase(), returnUrl: location.origin + '/admin#payments',
          player: { id: v.player.trim(), country: v.country.trim().toUpperCase(), kyc: v.kyc, depositLimitDaily: limit, selfExcluded: v.selfExcluded } }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) { const e = new Error(data?.error?.message || `Ошибка ${res.status}`); e.details = data?.error?.details; throw e; }
      sb.made.unshift(data); renderMade();
      return h('pre', { class: 'json' }, JSON.stringify(data, null, 2));
    }),
    h('h2', null, 'Созданные'), made,
    h('h2', null, 'Тестовая выплата'),
    h('p', { class: 'note' }, 'POST /v1/payouts тем же ключом сайта. Сначала деньги возвращаются на карты депозитов игрока, остаток — ручная выплата во вкладке «Выплаты».'),
    actionForm({ class: 'form' }, [
      field('Сумма', h('input', { name: 'amount', required: true, value: '10.00', inputmode: 'decimal' })),
      field('Валюта', h('input', { name: 'currency', required: true, value: 'EUR', maxlength: 3 })),
      field('ID игрока', h('input', { name: 'player', required: true, value: 'demo-player-1' })),
      field('ID вывода в казино', h('input', { name: 'withdrawal', required: true, value: `W-${Date.now().toString(36).toUpperCase()}` })),
      h('div', null, h('button', { class: 'primary', type: 'submit' }, 'Создать выплату')),
    ], async (v) => {
      if (!sb.key) throw new Error('Сначала вставь API-ключ сайта в форму депозита выше');
      const amount = toCents(v.amount);
      if (!amount) throw new Error('Сумма — число больше нуля');
      const res = await fetch('/v1/payouts', { method: 'POST', headers: {
        'content-type': 'application/json', authorization: `Bearer ${sb.key}`, 'idempotency-key': `sandbox-${crypto.randomUUID()}` },
        body: JSON.stringify({ amount, currency: v.currency.trim().toUpperCase(), withdrawalId: v.withdrawal.trim(), player: { id: v.player.trim() } }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) { const e = new Error(data?.error?.message || `Ошибка ${res.status}`); e.details = data?.error?.details; throw e; }
      return h('div', { class: `msg ${data.status === 'declined' ? 'err' : 'ok'}` },
        data.status === 'declined' ? `Отказ: ${DECLINE[data.declineCode] || data.declineCode}`
          : `Возврат на карты: ${money(data.refundAmount, data.currency)} · ручная выплата: ${money(data.manualAmount, data.currency)} · статус: ${STATUS[data.status]?.[1] || data.status}`);
    })));
}

// ---------- ручные выплаты ----------

async function viewManual(main) {
  const all = !!state.cache.manualAll;
  const rows = await api('GET', `/admin/v1/manual-payouts${all ? '?all=true' : ''}`);
  const statusCell = (r) => {
    if (r.status === 'success') return h('div', null, h('span', { class: 'pill ok' }, 'выплачено'),
      h('div', { class: 'note' }, `${r.completed_by || ''} · № ${r.reference || '—'}${r.note ? ` · ${r.note}` : ''}`),
      r.approved_by ? h('div', { class: 'note' }, `одобрил ${r.approved_by}`) : null);
    if (!can('operator')) return h('span', { class: 'pill warn' }, 'ждёт');
    // Сумма от порога оператора: сначала одобряет один сотрудник, выполненной отмечает другой.
    if (r.needs_approval && !r.approved_by) return h('div', { class: 'stack' },
      h('span', { class: 'pill warn' }, 'нужно одобрение'),
      h('div', { class: 'note' }, 'Крупная сумма: одобряет один сотрудник, переводит и отмечает — другой.'),
      actionForm({ class: 'row start' }, [h('button', { class: 'sm primary', type: 'submit' }, 'Одобрить выплату')],
        async () => { await api('POST', `/admin/v1/manual-payouts/${r.id}/approve`); renderShell(); }));
    const mine = r.needs_approval && r.approved_by_id === state.me.id;
    return h('div', { class: 'stack' },
      r.approved_by ? h('div', { class: 'note' }, `✓ одобрил ${r.approved_by} ${when(r.approved_at)}`) : null,
      mine ? h('div', { class: 'note' }, 'Ты одобрил эту выплату — отметить выполненной должен другой сотрудник.')
        : actionForm({ class: 'row start' }, [
          h('input', { name: 'reference', required: true, minlength: 3, placeholder: '№ перевода / платёжки', style: 'width:180px' }),
          h('input', { name: 'note', placeholder: 'Комментарий (необязательно)', style: 'width:180px' }),
          h('button', { class: 'sm primary', type: 'submit' }, 'Выплачено'),
        ], async (v) => { await api('POST', `/admin/v1/manual-payouts/${r.id}/complete`, v); renderShell(); }));
  };
  put(main, h('section', { class: 'panel' },
    h('div', { class: 'row' }, h('h2', null, 'Ручные выплаты'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: all, onchange: (e) => { state.cache.manualAll = e.target.checked; renderShell(); } }), 'Показать выполненные')),
    h('p', { class: 'note' }, 'Выигрыш сверх депозитов игрока нельзя вернуть на карту — его выплачивает оператор сам (перевод на счёт или карту игрока). Переведи деньги и отметь выплату с номером перевода: сайт получит уведомление, что выплата завершена.'),
    rows.length ? h('div', { class: 'tbl' }, h('table', null,
      h('thead', null, h('tr', null, ['Когда', 'Сайт', 'Игрок', 'К выплате', 'Вывод казино', 'Статус'].map((t) => h('th', null, t)))),
      h('tbody', null, rows.map((r) => h('tr', null,
        h('td', { class: 'n' }, when(r.created_at)), h('td', null, r.site), h('td', { class: 'n' }, `${r.player} · ${r.country}`),
        h('td', { class: 'n' }, h('b', null, money(r.amount, r.currency))),
        h('td', { class: 'n dim' }, h('button', { class: 'link', onclick: () => { state.cache.selTx = r.payout_id; state.tab = 'payments'; location.hash = 'payments'; renderShell(); } },
          r.withdrawal_id || money(r.payout_amount, r.currency)), h('div', { class: 'note' }, `всего ${money(r.payout_amount, r.currency)}`)),
        h('td', null, statusCell(r))))))) : h('p', { class: 'note' }, all ? 'Ручных выплат не было.' : 'Нет выплат, ожидающих оператора.')));
}

// ---------- расхождения ----------

async function viewIssues(main) {
  const all = !!state.cache.issuesAll;
  const rows = await api('GET', `/admin/v1/issues${all ? '?all=true' : ''}`);
  const KIND = { late_success: 'Оплата по уже закрытой попытке', status_mismatch: 'Статус не совпадает с провайдером', amount_mismatch: 'Оплачена не та сумма или валюта', unverified_payment: 'Оплата не подтверждена (нет суммы или валюты)', refund_unknown: 'Нет ответа провайдера при возврате' };
  put(main, h('section', { class: 'panel' },
    h('div', { class: 'row' }, h('h2', null, 'Проблемы с платежами'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: all, onchange: (e) => { state.cache.issuesAll = e.target.checked; renderShell(); } }), 'Показать закрытые')),
    h('p', { class: 'note' }, 'Ситуации, которые система не решает сама. Например, провайдер подтвердил оплату по попытке, которую мы уже закрыли отказом: деньги пришли, а платёж ушёл дальше. Проверь у провайдера и реши вручную.'),
    rows.length ? h('div', { class: 'tbl' }, h('table', null,
      h('thead', null, h('tr', null, ['Когда', 'Что', 'Подробности', 'Платёж', 'Статус'].map((t) => h('th', null, t)))),
      h('tbody', null, rows.map((i) => h('tr', null,
        h('td', { class: 'n' }, when(i.created_at)), h('td', null, KIND[i.kind] || i.kind), h('td', { class: 'dim' }, i.details),
        h('td', { class: 'n' }, i.transaction_id ? h('button', { class: 'link', onclick: () => { state.cache.selTx = i.transaction_id; state.tab = 'payments'; location.hash = 'payments'; renderShell(); } }, i.transaction_id.slice(0, 8)) : '—'),
        h('td', null, i.resolved ? h('div', null, h('span', { class: 'pill ok' }, 'закрыто'), h('div', { class: 'note' }, `${i.resolved_by_email}: ${i.resolution_note}`))
          : can('operator') ? actionForm({ class: 'row start' }, [
            h('input', { name: 'note', placeholder: 'Что сделали', required: true, minlength: 3, style: 'width:200px' }),
            h('button', { class: 'sm', type: 'submit' }, 'Закрыть'),
          ], async (v) => { await api('POST', `/admin/v1/issues/${i.id}/resolve`, v); renderShell(); })
          : h('span', { class: 'pill warn' }, 'открыто'))))))) : h('p', { class: 'note' }, all ? 'Расхождений не было.' : 'Открытых расхождений нет.')));
}

// ---------- подключения: операторы → аккаунты и сайты ----------

function copyBox(value, label = 'Копировать') {
  return h('div', { class: 'copybox' },
    h('code', null, value),
    h('button', { class: 'sm', type: 'button', onclick: async (e) => {
      try { await navigator.clipboard.writeText(value); e.target.textContent = 'Скопировано'; }
      catch { e.target.textContent = 'Выдели и скопируй вручную'; }
    } }, label));
}

async function viewConnect(main) {
  if (state.cache.opId) return viewOperator(main, state.cache.opId);
  const ops = await api('GET', '/admin/v1/operators');
  const ready = await Promise.all(ops.map((o) => api('GET', `/admin/v1/operators/${o.id}/readiness`).catch(() => null)));
  put(main, h('section', { class: 'panel' },
    h('h2', null, 'Подключения'),
    h('p', { class: 'note' }, 'Оператор — компания-владелец казино с лицензией. У него свои платёжные аккаунты (куда приходят деньги игроков) и свои сайты, которые подключаются к API. Выбери оператора, чтобы подключить аккаунт или сайт.'),
    ops.length ? h('div', { class: 'ops' }, ops.map((o, i) => {
      const r = ready[i]; const req = r ? r.steps.filter((s) => !s.optional) : [];
      const done = req.filter((s) => s.done).length;
      return h('button', { class: 'op-card', type: 'button', onclick: () => { state.cache.opId = o.id; renderShell(); } },
        h('div', { class: 'row' }, h('b', null, o.name), r?.ready ? h('span', { class: 'pill ok' }, 'готов к работе') : h('span', { class: 'pill warn' }, `${done} из ${req.length} шагов`)),
        h('div', { class: 'tags' }, o.licenses.map((c) => h('span', { class: 'tag' }, c))),
        h('div', { class: 'note' }, `Комиссия платформы: ${o.platform_fee_bps / 100}%`));
    })) : h('p', { class: 'note' }, 'Операторов пока нет — добавь первого.'),
    can('admin') ? h('details', null, h('summary', null, '+ Новый оператор'),
      actionForm({ class: 'form', style: 'margin-top:12px' }, [
        field('Название компании', h('input', { name: 'name', required: true, placeholder: 'Lucky Games Ltd' })),
        field('Страны лицензии', h('input', { name: 'licenses', required: true, placeholder: 'MT, DE, IE' })),
        field('Комиссия платформы, %', h('input', { name: 'fee', type: 'number', min: 0, max: 100, step: 0.01, value: '1.5' })),
        field('KYC обязателен выше', h('input', { name: 'kyc', placeholder: 'например 300', inputmode: 'decimal' })),
        h('div', null, h('button', { class: 'primary', type: 'submit' }, 'Добавить')),
      ], async (v) => {
        const o = await api('POST', '/admin/v1/operators', { name: v.name, licenses: list(v.licenses),
          platformFeeBps: Math.round(Number(v.fee || 0) * 100), kycRequiredAbove: v.kyc.trim() ? toCents(v.kyc) : null });
        state.cache.opId = o.id; renderShell();
      })) : null));
}

async function viewOperator(main, opId) {
  const [ops, readiness, accounts, sites, connectors] = await Promise.all([
    api('GET', '/admin/v1/operators'), api('GET', `/admin/v1/operators/${opId}/readiness`),
    api('GET', '/admin/v1/accounts'), can('admin') ? api('GET', '/admin/v1/sites') : Promise.resolve([]), api('GET', '/admin/v1/connectors'),
  ]);
  const o = ops.find((x) => x.id === opId);
  if (!o) { state.cache.opId = null; return viewConnect(main); }
  const accs = accounts.filter((a) => a.operator_id === opId);
  const mySites = sites.filter((s) => s.operator_id === opId);
  clearInterval(state.timer); // страница с формами — без автообновления
  const goto = (tab) => () => go(tab);

  const checklist = h('ol', { class: 'checklist' }, readiness.steps.map((s) => h('li', { class: s.done ? 'done' : '' },
    h('span', { class: 'mark', 'aria-hidden': 'true' }, s.done ? '✓' : ''),
    h('div', null, h('b', null, s.title), s.optional ? h('span', { class: 'note' }, ' · желательно') : null,
      s.done ? null : h('div', { class: 'note' }, s.hint, s.key === 'deposit' ? [' — ', h('button', { class: 'link', onclick: goto('sandbox') }, 'Тест-платёж')] : null)))));

  const accList = h('div', { class: 'acc-list' }, accs.length ? accs.map((a) => accountConnection(a, connectors, state.cache.openAcc === a.id))
    : h('p', { class: 'note' }, 'Аккаунтов нет. Подключи первый ниже.'));

  put(main, 
    h('button', { class: 'link', onclick: () => { state.cache.opId = null; renderShell(); } }, '← Все операторы'),
    h('section', { class: 'panel' },
      h('div', { class: 'row' }, h('h1', null, o.name), readiness.ready ? h('span', { class: 'pill ok' }, 'готов принимать платежи') : h('span', { class: 'pill warn' }, 'подключение не завершено')),
      h('div', { class: 'row start' }, h('span', { class: 'note' }, 'Лицензия:'), h('div', { class: 'tags' }, o.licenses.map((c) => h('span', { class: 'tag' }, c)))),
      can('admin') ? actionForm({ class: 'row start' }, [
        h('label', { class: 'check' }, 'Комиссия платформы',
          h('input', { name: 'fee', type: 'number', min: 0, max: 100, step: 0.01, value: o.platform_fee_bps / 100, style: 'width:90px' }), '%'),
        h('button', { class: 'sm', type: 'submit' }, 'Сохранить'),
      ], async (v) => { await api('PATCH', `/admin/v1/operators/${opId}`, { platformFeeBps: Math.round(Number(v.fee) * 100) }); renderShell(); }) : null,
      can('admin') ? h('details', null, h('summary', null, 'Правила выплат и ответственной игры'),
        actionForm({ class: 'form', style: 'margin-top:12px' }, [
          field('Максимум одной выплаты', [h('input', { name: 'max', inputmode: 'decimal', placeholder: 'без ограничения', value: o.payout_max_amount ? (Number(o.payout_max_amount) / 100).toString() : '' }),
            h('span', { class: 'help' }, 'Больше — выплата отклоняется (amount_over_limit)')]),
          field('Ручная выплата от суммы — вторым сотрудником', [h('input', { name: 'approval', inputmode: 'decimal', placeholder: 'не требуется', value: o.manual_approval_above !== null && o.manual_approval_above !== undefined ? (Number(o.manual_approval_above) / 100).toString() : '' }),
            h('span', { class: 'help' }, 'Одобряет один, переводит и отмечает другой. 0 — для всех ручных выплат')], 'wide'),
          field('Повышение лимита игрока вступает через, ч', [h('input', { name: 'delay', type: 'number', min: 0, max: 720, value: o.limit_increase_delay_hours ?? 24 }),
            h('span', { class: 'help' }, 'Снижение — сразу. Обычно требуют 24 ч')]),
          h('div', null, h('button', { class: 'primary', type: 'submit' }, 'Сохранить')),
        ], async (v) => {
          const opt = (x) => (x.trim() === '' ? null : x.trim() === '0' ? 0 : toCents(x));
          await api('PATCH', `/admin/v1/operators/${opId}`, { payoutMaxAmount: v.max.trim() === '' ? null : toCents(v.max),
            manualApprovalAbove: opt(v.approval), limitIncreaseDelayHours: Number(v.delay) });
          renderShell();
        })) : null),
    h('section', { class: 'panel' }, h('h2', null, 'Что нужно для приёма платежей'), checklist),
    h('section', { class: 'panel' },
      h('h2', null, 'Платёжные аккаунты'),
      h('p', { class: 'note' }, 'Аккаунты у провайдеров, куда приходят деньги игроков. Ключи вводятся здесь и хранятся в зашифрованном виде; после сохранения их никто не увидит — только последние 4 символа.'),
      accList,
      can('admin') ? newConnectionForm(opId, o, connectors) : null),
    can('admin') ? sitesBlock(opId, mySites) : null);
}

function newConnectionForm(opId, o, connectors) {
  return h('details', { open: state.cache.newAccOpen || null, ontoggle: (e) => { state.cache.newAccOpen = e.target.open; } },
    h('summary', null, '+ Подключить платёжный аккаунт'),
    actionForm({ class: 'form', style: 'margin-top:12px' }, [
      field('Провайдер', h('select', { name: 'adapter', required: true }, connectors.map((c) => h('option', { value: c.name }, c.title))), 'wide'),
      field('Название', h('input', { name: 'name', required: true, placeholder: 'Viva · EUR основной' })),
      field('Валюта', [h('input', { name: 'currencies', required: true, value: 'EUR', maxlength: 3, pattern: '[A-Za-z]{3}' }),
        h('span', { class: 'help' }, 'Одна на аккаунт — лимиты считаются в ней. Другая валюта — отдельный аккаунт.')]),
      field('Страны', h('input', { name: 'countries', required: true, value: o.licenses.join(', ') }), 'wide'),
      field('Мин. платёж', h('input', { name: 'min', required: true, value: '10', inputmode: 'decimal' })),
      field('Макс. платёж', h('input', { name: 'max', required: true, value: '2000', inputmode: 'decimal' })),
      field('Дневной лимит', h('input', { name: 'cap', required: true, value: '10000', inputmode: 'decimal' })),
      field('Комиссия провайдера, %', h('input', { name: 'fee', type: 'number', value: '1.9', step: 0.01, min: 0 })),
      h('div', null, h('button', { class: 'primary', type: 'submit' }, 'Создать и перейти к ключам')),
    ], async (v) => {
      const [min, max, cap] = [toCents(v.min), toCents(v.max), toCents(v.cap)];
      if (!min || !max || !cap) throw new Error('Суммы — числа больше нуля');
      const a = await api('POST', '/admin/v1/connections/accounts', { operatorId: opId, adapter: v.adapter, name: v.name,
        currencies: [v.currencies.trim().toUpperCase()], countries: list(v.countries), minAmount: min, maxAmount: max, dailyCap: cap, feeBps: Math.round(Number(v.fee) * 100) });
      state.cache.openAcc = a.id; state.cache.newAccOpen = false; renderShell();
    }));
}

function accountConnection(a, connectors, open) {
  const body = h('div', { class: 'conn-body' });
  const box = h('details', { class: 'conn', open: open || null, ontoggle: (e) => {
    if (e.target.open) { state.cache.openAcc = a.id; loadConnection(a, body); }
    else if (state.cache.openAcc === a.id) state.cache.openAcc = null;
  } },
    h('summary', null,
      h('b', null, a.name), ' ', h('span', { class: 'note' }, connectors.find((c) => c.name === a.provider_code)?.title || a.provider_code),
      ' ', a.enabled ? h('span', { class: 'pill ok' }, 'включён') : h('span', { class: 'pill m' }, 'выключен')),
    body);
  if (open) loadConnection(a, body);
  return box;
}

const STEP_TITLES = { keys: 'Ключи', check: 'Проверка', webhook: 'Вебхук', live: 'Запуск' };
const HOOK_OUTCOME = { accepted: ['принят', 'ok'], test: ['тест', 'ok'], duplicate: ['повтор', 'm'], challenge: ['проверка адреса', 'n'], rejected: ['отклонён', 'bad'], error: ['ошибка', 'bad'] };

/** Форма полей одного шага (ключи или секрет вебхука). */
function credentialForm(a, c, fields, submitLabel) {
  return actionForm({ class: 'form' }, [
    ...fields.map((f) => {
      const cur = c.values[f.key] || {};
      const input = f.options
        ? h('select', { name: f.key }, f.options.map((opt) => h('option', { value: opt, selected: (cur.value || f.default) === opt }, opt)))
        : h('input', { name: f.key, type: f.secret ? 'password' : 'text', autocomplete: 'off',
            value: f.secret ? '' : (cur.value || (c.source ? '' : f.default) || ''),
            placeholder: f.secret && cur.masked ? `${cur.masked} — оставь пустым, чтобы не менять` : (f.placeholder || '') });
      return field(f.label + (f.required || f.stage === 'webhook' ? '' : ' (необязательно)'), [input, f.help ? h('span', { class: 'help' }, f.help) : null], fields.length > 1 && f.key === 'clientId' ? 'wide' : 'full-sm');
    }),
    h('div', { class: 'full row start' }, can('admin') ? h('button', { class: 'primary', type: 'submit' }, submitLabel) : h('span', { class: 'note' }, 'Ключи вводит администратор')),
  ], async (v) => {
    await api('PUT', `/admin/v1/accounts/${a.id}/credentials`, { values: v });
    state.cache.openAcc = a.id; renderShell();
    return null;
  });
}

async function loadConnection(a, body, quiet) {
  if (!quiet) put(body, h('p', { class: 'note' }, 'Загрузка…'));
  let c;
  try { c = await api('GET', `/admin/v1/accounts/${a.id}/connection`); }
  catch (err) { if (!handleAuthError(err)) put(body, errorBox(err)); return; }
  const order = ['keys', 'check', 'webhook', 'live'];
  const current = order.find((k) => !c.steps[k]) || null;
  const stepBox = (key, n, ...content) => h('section', { class: `step ${c.steps[key] ? 'done' : ''} ${current === key ? 'current' : ''}` },
    h('div', { class: 'step-head' }, h('span', { class: 'step-n', 'aria-hidden': 'true' }, c.steps[key] ? '✓' : String(n)),
      h('h3', null, `${n}. ${STEP_TITLES[key]}`), c.steps[key] ? h('span', { class: 'pill ok' }, 'готово') : current === key ? h('span', { class: 'pill n' }, 'сейчас') : null),
    h('div', { class: 'step-body' }, content));

  // --- шапка: что это за провайдер ---
  const caps = c.capabilities ? [['refunds', 'возвраты'], ['partialRefunds', 'частичные возвраты'], ['amountCheck', 'сверка суммы']]
    .map(([k, label]) => h('span', { class: `tag ${c.capabilities[k] ? 'yes' : 'no'}` }, (c.capabilities[k] ? '✓ ' : '✕ ') + label)) : [];
  const head = h('div', { class: 'prov-head' },
    h('p', null, c.summary),
    h('div', { class: 'tags' }, c.methods.map((m) => h('span', { class: 'tag' }, m)), caps),
    h('div', { class: 'row start' },
      c.links.dashboard ? h('a', { href: c.links.dashboard, target: '_blank', rel: 'noopener noreferrer' }, 'Кабинет провайдера ↗') : null,
      c.links.docs ? h('a', { href: c.links.docs, target: '_blank', rel: 'noopener noreferrer' }, 'Документация ↗') : null),
    h('ol', { class: 'progress', 'aria-label': 'Шаги подключения' }, order.map((k) =>
      h('li', { class: `${c.steps[k] ? 'done' : ''} ${current === k ? 'current' : ''}` }, STEP_TITLES[k]))));

  // --- 1. ключи ---
  const keyFields = c.fields.filter((f) => f.stage !== 'webhook');
  const s1 = stepBox('keys', 1,
    c.source === 'env' ? h('div', { class: 'msg warn' }, 'Сейчас ключи берутся из настроек сервера (.env). Если сохранишь их здесь — будут использоваться эти.') : null,
    keyFields.length ? [h('p', { class: 'note' }, 'Ключи хранятся в зашифрованном виде; после сохранения видны только последние 4 символа.'),
      credentialForm(a, c, keyFields, 'Сохранить ключи')] : h('p', { class: 'note' }, 'Ключи не нужны.'));

  // --- 2. проверка ---
  const checkOut = h('div');
  const renderCheck = (r) => put(checkOut, r ? h('ul', { class: 'checks' }, r.results.map((x) =>
    h('li', { class: x.ok ? 'ok' : 'bad' }, h('span', { 'aria-hidden': 'true' }, x.ok ? '✓' : '✕'), h('div', null, h('b', null, x.name), h('div', { class: 'note' }, x.message))))) : null);
  if (c.lastCheck) renderCheck(c.lastCheck);
  const s2 = stepBox('check', 2,
    h('div', { class: 'row start' }, h('button', { type: 'button', disabled: !c.steps.keys || null, onclick: async (e) => {
      e.target.disabled = true; e.target.textContent = 'Проверяю…';
      try { await api('POST', `/admin/v1/accounts/${a.id}/check`); state.cache.openAcc = a.id; renderShell(); return; }
      catch (err) { if (!handleAuthError(err)) put(checkOut, errorBox(err)); }
      finally { e.target.disabled = false; e.target.textContent = 'Проверить подключение'; }
    } }, 'Проверить подключение'),
      h('span', { class: 'note' }, c.lastCheck ? `последняя проверка: ${when(c.lastCheck.at)}` : c.steps.keys ? 'Проверяет ключи у провайдера, платежей не создаёт' : 'Сначала введи ключи')),
    checkOut);

  // --- 3. вебхук ---
  const w = c.webhook;
  const secretField = w.secretField ? c.fields.find((f) => f.key === w.secretField) : null;
  const status = {
    internal: h('div', { class: 'msg ok' }, w.note || 'Настраивать ничего не нужно.'),
    waiting: h('div', { class: 'hook-status waiting' }, h('span', { class: 'dot' }), h('div', null, h('b', null, 'Ждём первый вебхук'),
      h('div', { class: 'note' }, 'Сделай шаги выше. Если у провайдера есть «Отправить тестовое событие» — нажми: статус здесь обновится сам.'))),
    ok: h('div', { class: 'hook-status ok' }, h('span', { class: 'dot' }), h('div', null, h('b', null, 'Вебхуки приходят'),
      h('div', { class: 'note' }, `последний принят ${when(w.lastOkAt)}`))),
    failing: h('div', { class: 'hook-status bad' }, h('span', { class: 'dot' }), h('div', null, h('b', null, 'Вебхук приходит, но отклоняется'),
      h('div', null, w.lastError?.reason || 'Причина неизвестна'), h('div', { class: 'note' }, when(w.lastError?.at)))),
  }[w.state];
  const logTable = w.log.length ? h('details', { class: 'hook-log' }, h('summary', null, `Журнал вебхуков (${w.log.length})`),
    h('div', { class: 'tbl' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Когда'), h('th', null, 'Итог'), h('th', null, 'Подробности'))),
      h('tbody', null, w.log.map((r) => { const [label, cls] = HOOK_OUTCOME[r.outcome] || [r.outcome, 'm'];
        return h('tr', null, h('td', { class: 'n dim' }, when(r.at)), h('td', null, h('span', { class: `pill ${cls}` }, label)),
          h('td', null, r.reason || '', r.provider_ref ? h('div', { class: 'note' }, `платёж ${r.provider_ref}`) : null)); }))))) : null;
  const s3 = stepBox('webhook', 3,
    w.scheme === 'internal' ? status : [
      h('p', { class: 'note' }, 'Вебхук — это когда провайдер сам сообщает нам об оплате за секунды. Без него статус обновится сверкой примерно через минуту.'),
      h('div', { class: 'hook-url' }, h('span', { class: 'note' }, 'Адрес вебхука для этого аккаунта'), copyBox(w.url, 'Копировать адрес')),
      w.steps.length ? h('ol', { class: 'steps' }, w.steps.map((t) => h('li', null, t))) : null,
      w.events.length ? h('div', { class: 'row start' }, h('span', { class: 'note' }, 'События:'), h('div', { class: 'tags' }, w.events.map((e) => h('span', { class: 'tag' }, e)))) : null,
      w.note ? h('p', { class: 'note' }, w.note) : null,
      secretField ? h('div', { class: 'secret-step' },
        h('b', null, secretField.label, w.secretSet ? h('span', { class: 'pill ok' }, ' введён') : h('span', { class: 'pill warn' }, ' нужен')),
        credentialForm(a, c, [secretField], 'Сохранить секрет')) : null,
      status, logTable,
      can('admin') ? h('details', { class: 'danger-zone' }, h('summary', null, 'Адрес утёк или указан не туда?'),
        h('p', { class: 'note' }, 'Можно выпустить новый адрес. Старый перестанет работать сразу — его придётся заменить в кабинете провайдера.'),
        h('button', { class: 'sm danger', type: 'button', onclick: async () => {
          await api('POST', `/admin/v1/accounts/${a.id}/webhook-token`); state.cache.openAcc = a.id; renderShell();
        } }, 'Выпустить новый адрес')) : null,
    ]);

  // --- 4. запуск ---
  const s4 = stepBox('live', 4,
    h('div', { class: 'row start' },
      c.enabled ? h('span', { class: 'pill ok' }, 'включён в маршрутизацию') : h('span', { class: 'pill m' }, 'выключен — платежи на него не идут'),
      can('operator') ? h('button', { class: c.enabled ? 'sm' : 'primary', type: 'button', disabled: (!c.enabled && !c.steps.keys) || null, onclick: async (e) => {
        e.target.disabled = true;
        try { await api('PATCH', `/admin/v1/accounts/${a.id}`, { enabled: !c.enabled }); state.cache.openAcc = a.id; renderShell(); }
        catch (err) { e.target.disabled = false; if (!handleAuthError(err)) e.target.after(errorBox(err)); }
      } }, c.enabled ? 'Выключить' : 'Включить в маршрутизацию') : null),
    !c.enabled && !c.steps.check ? h('p', { class: 'note' }, 'Совет: включай после зелёной проверки — иначе платежи будут отклоняться и уходить каскадом на другие аккаунты.') : null,
    c.firstSuccessAt ? h('p', { class: 'note' }, `✓ Первый успешный депозит: ${when(c.firstSuccessAt)}`)
      : h('div', { class: 'row start' }, h('span', { class: 'note' }, 'Осталось провести тестовый платёж.'),
          h('button', { class: 'sm', type: 'button', disabled: !c.enabled || null, onclick: () => go('sandbox') }, 'Тест-платёж')));

  // Не перерисовываем, пока человек что-то вводит.
  if (quiet && body.contains(document.activeElement) && document.activeElement !== document.body) return;
  put(body,
    !c.adapterAvailable ? h('div', { class: 'msg err' }, `Интеграция «${c.adapter}» не подключена на сервере`) : null,
    head, s1, s2, s3, s4,
    c.ready ? h('div', { class: 'msg ok' }, 'Аккаунт подключён и принимает платежи.') : null);

  // Пока ждём вебхук — тихо обновляем статус, чтобы зелёный загорелся сам.
  if (w.state === 'waiting' || w.state === 'failing') {
    const sig = `${w.state}|${w.log[0]?.at || ''}`;
    setTimeout(async function poll() {
      if (!body.isConnected || !body.closest('details')?.open) return;
      try {
        const n = await api('GET', `/admin/v1/accounts/${a.id}/connection`);
        if (`${n.webhook.state}|${n.webhook.log[0]?.at || ''}` !== sig) return loadConnection(a, body, true);
      } catch { return; }
      setTimeout(poll, 4000);
    }, 4000);
  }
}

function sitesBlock(opId, mySites) {
  const shown = h('div');
  const rows = mySites.map((s) => {
    const out = h('div');
    const rotate = (kind) => put(out, h('div', { class: 'msg err' },
      kind === 'key' ? 'Старый ключ перестанет работать сразу — сайт получит ошибки, пока не обновит ключ. ' : 'Сайту нужно будет обновить секрет проверки подписи. ',
      h('button', { class: 'sm danger', onclick: async () => {
        try {
          const r = await api('POST', `/admin/v1/sites/${s.id}/rotate-${kind === 'key' ? 'key' : 'webhook-secret'}`);
          put(out, shownOnce(kind === 'key' ? 'Новый API-ключ' : 'Новый секрет вебхуков', [[s.name, r.apiKey || r.webhookSecret]]));
        } catch (err) { if (!handleAuthError(err)) put(out, errorBox(err)); }
      } }, 'Да, перевыпустить'), ' ', h('button', { class: 'sm', onclick: () => put(out, ) }, 'Отмена')));
    return h('div', { class: 'site-row' },
      h('div', { class: 'row' }, h('b', null, s.name), s.enabled ? h('span', { class: 'pill ok' }, 'работает') : h('span', { class: 'pill m' }, 'отключён')),
      actionForm({ class: 'row start' }, [
        h('input', { name: 'webhookUrl', value: s.webhook_url || '', placeholder: 'Адрес вебхука казино: https://…/hooks', style: 'flex:1;min-width:220px', 'aria-label': 'Адрес вебхука' }),
        h('button', { class: 'sm', type: 'submit' }, 'Сохранить'),
      ], async (v) => { await api('PATCH', `/admin/v1/sites/${s.id}`, { webhookUrl: v.webhookUrl.trim() || null }); return h('div', { class: 'msg ok' }, 'Сохранено'); }),
      h('div', { class: 'row start' },
        h('button', { class: 'sm', onclick: () => rotate('key') }, 'Новый API-ключ'),
        h('button', { class: 'sm', onclick: () => rotate('secret') }, 'Новый секрет вебхуков'),
        h('button', { class: 'sm', onclick: async () => { await api('PATCH', `/admin/v1/sites/${s.id}`, { enabled: !s.enabled }).catch(() => {}); renderShell(); } }, s.enabled ? 'Отключить' : 'Включить')),
      out);
  });
  return h('section', { class: 'panel' },
    h('h2', null, 'Сайты'),
    h('p', { class: 'note' }, 'Каждый сайт (казино) ходит в наш API со своим ключом. Ключ и секрет подписи вебхуков показываются один раз — сразу передай их разработчикам казино.'),
    rows.length ? h('div', { class: 'site-list' }, rows) : h('p', { class: 'note' }, 'Сайтов нет.'),
    h('details', null, h('summary', null, '+ Подключить сайт'),
      actionForm({ class: 'form', style: 'margin-top:12px' }, [
        field('Название', h('input', { name: 'name', required: true, placeholder: 'my-casino' })),
        field('Адрес вебхука казино', h('input', { name: 'webhookUrl', placeholder: 'https://…/hooks (можно позже)' }), 'wide'),
        h('div', null, h('button', { class: 'primary', type: 'submit' }, 'Создать')),
      ], async (v) => {
        const s = await api('POST', '/admin/v1/sites', { operatorId: opId, name: v.name, webhookUrl: v.webhookUrl.trim() || null });
        put(shown, shownOnce(`Сайт «${s.name}» создан`, [['API-ключ', s.apiKey], ['Секрет подписи вебхуков', s.webhookSecret]]),
          h('p', { class: 'note' }, 'Пример первого запроса для разработчиков казино:'),
          h('pre', { class: 'json' }, `curl -X POST ${location.origin}/v1/deposits \\\n  -H "Authorization: Bearer ${s.apiKey}" \\\n  -H "Idempotency-Key: order-0001" \\\n  -H "Content-Type: application/json" \\\n  -d '{"amount":2500,"currency":"EUR","player":{"id":"u42","country":"${'MT'}","kyc":"verified"}}'`),
          h('p', { class: 'note' }, 'Полное описание API — docs/API.md в репозитории.'));
        return null;
      })),
    shown);
}

// ---------- пользователи ----------

async function viewUsers(main) {
  const users = await api('GET', '/admin/v1/users');
  const shown = h('div');
  put(main, h('section', { class: 'panel' },
    h('h2', null, 'Команда'),
    h('p', { class: 'note' }, 'viewer — только смотрит; operator — ещё включает аккаунты, меняет лимиты и разбирает проблемы; admin — всё.'),
    h('div', { class: 'tbl' }, h('table', null,
      h('thead', null, h('tr', null, ['Email', 'Роль', '2FA', 'Последний вход', ''].map((t) => h('th', null, t)))),
      h('tbody', null, users.map((u) => {
        const self = u.id === state.me.id;
        const out = h('span');
        const act = async (fn) => { try { await fn(); renderShell(); } catch (err) { if (!handleAuthError(err)) put(out, errorBox(err)); } };
        return h('tr', null,
          h('td', null, u.email, self ? h('span', { class: 'note' }, ' (вы)') : null,
            u.disabled ? h('div', null, h('span', { class: 'pill m' }, 'заблокирован')) : null, u.locked ? h('div', null, h('span', { class: 'pill warn' }, 'временная блокировка')) : null),
          h('td', null, self ? u.role : h('select', { style: 'width:auto', 'aria-label': 'Роль', onchange: (e) => act(() => api('PATCH', `/admin/v1/users/${u.id}`, { role: e.target.value })) },
            ['viewer', 'operator', 'admin'].map((r) => h('option', { value: r, selected: u.role === r }, r)))),
          h('td', null, u.totp_enabled ? h('span', { class: 'pill ok' }, 'включена') : h('span', { class: 'pill warn' }, 'не настроена')),
          h('td', { class: 'n' }, when(u.last_login_at)),
          h('td', null, self ? null : h('div', { class: 'row start' },
            h('button', { class: 'sm', onclick: () => act(() => api('PATCH', `/admin/v1/users/${u.id}`, { disabled: !u.disabled })) }, u.disabled ? 'Разблокировать' : 'Заблокировать'),
            h('button', { class: 'sm', onclick: () => act(() => api('POST', `/admin/v1/users/${u.id}/reset-2fa`)) }, 'Сбросить 2FA'), out)));
      })))),
    h('h2', null, 'Пригласить'),
    actionForm({ class: 'form' }, [
      field('Email', h('input', { name: 'email', type: 'email', required: true })),
      field('Роль', h('select', { name: 'role' }, [['viewer', 'viewer — только просмотр'], ['operator', 'operator — лимиты и расхождения'], ['admin', 'admin — всё']].map(([v, t]) => h('option', { value: v }, t)))),
      h('div', null, h('button', { class: 'primary', type: 'submit' }, 'Создать')),
    ], async (v) => {
      const u = await api('POST', '/admin/v1/users', v);
      put(shown, shownOnce(`Пользователь ${u.email} создан`, [['Временный пароль (при входе — 2FA и смена пароля)', u.temporaryPassword]]));
      return null;
    }), shown));
}

// ---------- журнал ----------

async function viewAudit(main) {
  const rows = await api('GET', '/admin/v1/audit?limit=200');
  const ACTION = {
    'auth.login': 'Вход', 'auth.totp_enabled': 'Первый вход, включена 2FA', 'auth.password_failed': 'Неверный пароль', 'auth.totp_failed': 'Неверный код 2FA',
    'auth.password_changed': 'Смена пароля', 'account.credentials': 'Изменены ключи аккаунта', 'account.update': 'Изменён аккаунт', 'account.create': 'Создан аккаунт', 'site.create': 'Создан сайт',
    'site.update': 'Изменён сайт', 'site.rotate_key': 'Перевыпущен ключ сайта', 'site.rotate_webhook_secret': 'Перевыпущен секрет вебхуков',
    'operator.create': 'Создан оператор', 'operator.update': 'Изменён оператор', 'provider.create': 'Добавлен провайдер',
    'user.create': 'Создан пользователь', 'user.create_cli': 'Создан пользователь (консоль)', 'user.update': 'Изменён пользователь',
    'user.reset_2fa': 'Сброшена 2FA', 'issue.resolve': 'Закрыто расхождение', 'payout.manual_complete': 'Отмечена ручная выплата',
  };
  const diff = (b, a) => {
    if (!b || !a) return a && !b ? h('span', { class: 'note' }, 'создано') : null;
    const keys = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]) && !['used_today', 'reserved_today'].includes(k));
    return keys.length ? h('div', { class: 'diff' }, keys.map((k) => h('div', null, `${k}: `, h('del', null, JSON.stringify(b[k])), ' → ', h('ins', null, JSON.stringify(a[k]))))) : null;
  };
  put(main, h('section', { class: 'panel' },
    h('h2', null, 'Журнал аудита'),
    h('p', { class: 'note' }, 'Каждое изменение и каждый вход. Записи нельзя изменить или удалить.'),
    h('div', { class: 'tbl' }, h('table', null,
      h('thead', null, h('tr', null, ['Когда', 'Кто', 'Действие', 'Объект', 'Изменения', 'IP'].map((t) => h('th', null, t)))),
      h('tbody', null, rows.map((r) => h('tr', null,
        h('td', { class: 'n' }, when(r.created_at)), h('td', null, r.user_email || 'система'), h('td', null, ACTION[r.action] || r.action),
        h('td', { class: 'dim' }, r.entity ? `${r.entity} ${String(r.entity_id || '').slice(0, 8)}` : '—'),
        h('td', null, diff(r.before, r.after)), h('td', { class: 'n dim' }, r.ip || ''))))))));
}

const VIEWS = { overview: viewOverview, analytics: viewAnalytics, stuck: viewStuck, chargebacks: viewChargebacks, reconciliation: viewReconciliation, manual: viewManual, accounts: viewAccounts, payments: viewPayments, sandbox: viewSandbox, issues: viewIssues, connect: viewConnect, users: viewUsers, audit: viewAudit };

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (state.me && id !== state.tab && VIEWS[id] && TABS.some(([t, , r]) => t === id && can(r))) { state.tab = id; renderShell(); }
});
boot();
