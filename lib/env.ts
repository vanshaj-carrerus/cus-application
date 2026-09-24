function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  get mongodbUri() {
    return required("MONGODB_URI");
  },
  get jobApiUrl() {
    return required("JOB_API_URL");
  },
  get jobApiHost() {
    return required("JOB_API_HOST");
  },
  get jobApiKey() {
    return required("JOB_API_KEY");
  },
  get aiApiUrl() {
    return required("AI_API_URL");
  },
  get aiApiKey() {
    return required("AI_API_KEY");
  },
  get aiModel() {
    return process.env.AI_MODEL || "gemini-flash-lite-latest";
  },
  get redisUrl() {
    return process.env.REDIS_URL || "redis://localhost:6379";
  },
  get authSecret() {
    return required("AUTH_SECRET");
  },
  get authCookieName() {
    return process.env.AUTH_COOKIE_NAME || "recruitai_session";
  },
  get encryptionKey() {
    return required("ENCRYPTION_KEY");
  },
  // Stage 2 tailoring engine's fallback chain — each is optional; the chain skips
  // whichever provider has no key configured. Read directly rather than via
  // required() since a missing one shouldn't crash the app, only that provider.
  get geminiApiKey() {
    return process.env.GEMINI_API_KEY;
  },
  get groqApiKey() {
    return process.env.GROQ_API_KEY;
  },
  get mistralApiKey() {
    return process.env.MISTRAL_API_KEY;
  },
  get openrouterApiKey() {
    return process.env.OPENROUTER_API_KEY;
  },
  get captchaApiKey() {
    return process.env.CAPTCHA_API_KEY;
  },
  get googleClientId() {
    return required("GOOGLE_CLIENT_ID");
  },
  get googleClientSecret() {
    return required("GOOGLE_CLIENT_SECRET");
  },
  get googleRedirectUri() {
    return required("GOOGLE_REDIRECT_URI");
  },
  get gmailPubsubTopic() {
    return required("GMAIL_PUBSUB_TOPIC");
  },
  get gmailPubsubVerificationToken() {
    return required("GMAIL_PUBSUB_VERIFICATION_TOKEN");
  },
};
