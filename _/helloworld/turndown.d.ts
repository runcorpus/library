declare module "@joplin/turndown" {
  import TurndownService = require("turndown");
  export = TurndownService;
}

declare module "@joplin/turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export const gfm: TurndownService.Plugin;
}
