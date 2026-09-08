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
};
