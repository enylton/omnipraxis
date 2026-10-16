export type PortalConfig = {
  mode: 'emulator' | 'firebase';
  firebase: {
    apiKey: string;
    projectId: string;
    authDomain: string;
    storageBucket: string;
    appId: string;
  };
  allowedOrigins: string[];
};

export function parseProductionConfig(value: unknown): PortalConfig {
  const config = value as PortalConfig;
  if (
    !config ||
    config.mode !== 'firebase' ||
    config.firebase?.projectId !== 'omnipraxis-f8141' ||
    !['apiKey', 'appId', 'storageBucket', 'authDomain'].every(
      (key) =>
        typeof config.firebase[key as keyof PortalConfig['firebase']] === 'string' &&
        /^[A-Za-z0-9._:-]{6,200}$/.test(config.firebase[key as keyof PortalConfig['firebase']]) &&
        !/replace|example|placeholder/i.test(
          config.firebase[key as keyof PortalConfig['firebase']],
        ),
    ) ||
    config.firebase.authDomain !== 'omnipraxis-f8141.firebaseapp.com' ||
    !Array.isArray(config.allowedOrigins) ||
    !config.allowedOrigins.length ||
    config.allowedOrigins.length > 10 ||
    config.allowedOrigins.some((origin) => {
      try {
        const url = new URL(origin);
        return (
          url.protocol !== 'https:' ||
          url.origin !== origin ||
          Boolean(url.username || url.password)
        );
      } catch {
        return true;
      }
    })
  )
    throw new Error('A reviewed production portal configuration is required.');
  return structuredClone(config);
}
