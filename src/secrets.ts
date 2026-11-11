/**
 * Секреты провайдеров (ключи API, секреты подписи вебхуков). В базе у аккаунта хранится только
 * ссылка credentials_ref, сам секрет — здесь. Сейчас — переменные окружения PROVIDER_SECRET_<REF>;
 * в проде этот интерфейс реализуется поверх хранилища секретов (AWS Secrets Manager, Vault, Doppler).
 */
export interface SecretStore {
  get(ref: string): Promise<string>;
}

export class EnvSecretStore implements SecretStore {
  constructor(private env: NodeJS.ProcessEnv = process.env) {}
  async get(ref: string): Promise<string> {
    const name = `PROVIDER_SECRET_${ref.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const v = this.env[name];
    if (!v) throw new Error(`Секрет ${name} не задан`);
    return v;
  }
}

export class MapSecretStore implements SecretStore {
  constructor(private map: Record<string, string>) {}
  async get(ref: string): Promise<string> {
    const v = this.map[ref];
    if (!v) throw new Error(`Секрет ${ref} не задан`);
    return v;
  }
}
