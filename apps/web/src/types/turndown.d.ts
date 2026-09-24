/**
 * Minimal declarations for `turndown` and `turndown-plugin-gfm`.
 *
 * Neither ships types and the DefinitelyTyped package is not installed. Declaring only
 * what this project uses keeps the surface honest: if the library changes shape, the
 * compiler reports it here rather than silently accepting `any`.
 */
declare module "turndown" {
  export interface TurndownOptions {
    headingStyle?: "setext" | "atx";
    hr?: string;
    bulletListMarker?: "-" | "+" | "*";
    codeBlockStyle?: "indented" | "fenced";
    fence?: string;
    emDelimiter?: string;
    strongDelimiter?: string;
    linkStyle?: "inlined" | "referenced";
    linkReferenceStyle?: "full" | "collapsed" | "shortcut";
    br?: string;
  }

  export default class TurndownService {
    constructor(options?: TurndownOptions);
    addRule(key: string, rule: Record<string, unknown>): this;
    use(plugin: unknown): this;
    keep(filter: unknown): this;
    remove(filter: unknown): this;
    turndown(input: string | Node): string;
  }
}

declare module "turndown-plugin-gfm" {
  export const gfm: unknown;
  export const tables: unknown;
  export const strikethrough: unknown;
  export const taskListItems: unknown;
}
