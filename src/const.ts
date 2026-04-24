import pkg from "../package.json" with { type: "json" };

export const BASE_URL = atob("aHR0cHM6Ly9uZXRtaW5kLnZpZXR0ZWwudm4v");
export const VERSION: string = pkg.version;

export const HELP_HINT = "Run `codev --help` to see all commands.";
export const HAPPY_CODING = "🎉 Happy coding!";
