-- Сверка по отчётам провайдера: загруженная выписка (CSV из кабинета) сопоставляется с нашими данными.
CREATE TABLE report_imports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_account_id uuid NOT NULL REFERENCES merchant_accounts(id),
  filename            text NOT NULL,
  uploaded_by         uuid REFERENCES admin_users(id),
  uploaded_at         timestamptz NOT NULL DEFAULT now(),
  period_from         timestamptz,
  period_to           timestamptz,
  rows_total          int NOT NULL,
  mapping             jsonb NOT NULL,
  summary             jsonb NOT NULL
);

-- Строки выписки и наши записи, которых нет в выписке. result — итог сопоставления.
CREATE TABLE report_lines (
  id              bigserial PRIMARY KEY,
  import_id       uuid NOT NULL REFERENCES report_imports(id),
  line_no         int,                    -- номер строки в файле (NULL — запись только у нас)
  kind            text NOT NULL,          -- payment / refund / chargeback / fee / other
  status          text NOT NULL,          -- success / failed / other
  provider_ref    text,
  operation_id    text,
  amount          bigint,
  currency        char(3),
  fee             bigint,
  occurred_at     timestamptz,
  case_ref        text,
  result          text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('ok', 'info', 'warn', 'bad')),
  details         text,
  transaction_id  uuid REFERENCES transactions(id),
  resolved        boolean NOT NULL DEFAULT false,
  resolved_by     uuid REFERENCES admin_users(id),
  resolved_at     timestamptz,
  resolution_note text
);
CREATE INDEX report_lines_import_idx ON report_lines (import_id, severity);
CREATE INDEX report_lines_open_idx ON report_lines (severity) WHERE NOT resolved AND severity IN ('warn', 'bad');

-- Запомненное сопоставление колонок отчёта для провайдера: в следующий раз не настраивать заново.
CREATE TABLE report_mappings (
  provider_id  uuid PRIMARY KEY REFERENCES providers(id),
  mapping      jsonb NOT NULL,
  amount_unit  text NOT NULL DEFAULT 'major' CHECK (amount_unit IN ('major', 'minor')),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
