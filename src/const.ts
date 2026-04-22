import pkg from "../package.json" with { type: "json" };

export const BASE_URL = atob("aHR0cHM6Ly9uZXRtaW5kLnZpZXR0ZWwudm4v");
export const VERSION: string = pkg.version;
