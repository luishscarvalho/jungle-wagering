import { Global, Module } from "@nestjs/common";

export const APP_CONFIG = Symbol("APP_CONFIG");

export interface AppConfig {
  port: number;
  databaseUrl: string;
  sqs: {
    region: string;
    endpoint: string;
    queueName: string;
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  };

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }

  return {
    port,
    databaseUrl: required("DATABASE_URL"),
    sqs: {
      region: required("AWS_REGION"),
      endpoint: required("SQS_ENDPOINT"),
      queueName: required("SQS_QUEUE_NAME"),
    },
  };
}

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
